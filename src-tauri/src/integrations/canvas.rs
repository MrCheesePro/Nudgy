//! Canvas LMS REST client.
//!
//! Reads two endpoints: the user's to-do list, and upcoming assignments per active
//! course. The two overlap; results are merged on the assignment id.

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use reqwest::{Client, Response, StatusCode};
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;

use super::LmsProvider;
use crate::models::LmsTask;

pub const PROVIDER_ID: &str = "canvas";

const USER_AGENT: &str = concat!("Nudgy/", env!("CARGO_PKG_VERSION"));
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_ATTEMPTS: u32 = 5;
const MAX_TITLE_CHARS: usize = 200;
/// Guard against a misconfigured instance paginating forever.
const MAX_PAGES: usize = 20;

pub struct CanvasClient {
    base_url: String,
    token: String,
    http: Client,
}

impl CanvasClient {
    pub fn new(base_url: &str, token: &str) -> Result<Self> {
        let base_url = normalize_base_url(base_url)?;
        let http = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .context("building HTTP client")?;

        Ok(Self {
            base_url,
            token: token.trim().to_string(),
            http,
        })
    }

    /// One request with retries. Canvas rate-limits with 429 and answers 5xx under load;
    /// both are transient, so they back off rather than fail the whole sync.
    async fn get(&self, url: &str) -> Result<Response> {
        let mut delay = Duration::from_secs(1);

        for attempt in 1..=MAX_ATTEMPTS {
            let response = self
                .http
                .get(url)
                .bearer_auth(&self.token)
                .send()
                .await
                .with_context(|| format!("requesting {}", redact(url)))?;

            let status = response.status();

            if status.is_success() {
                return Ok(response);
            }

            if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                return Err(anyhow!(
                    "Canvas rejected the API token ({}). Check the token and its scopes.",
                    status.as_u16()
                ));
            }

            let retryable = status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
            if !retryable || attempt == MAX_ATTEMPTS {
                return Err(anyhow!(
                    "Canvas returned {} for {}",
                    status.as_u16(),
                    redact(url)
                ));
            }

            // Honour the server's own pacing when it offers one.
            let wait = retry_after(&response).unwrap_or(delay);
            log::warn!(
                "Canvas {} on attempt {attempt}; retrying in {:?}",
                status.as_u16(),
                wait
            );
            tokio::time::sleep(wait).await;
            delay = (delay * 2).min(Duration::from_secs(30));
        }

        Err(anyhow!("exhausted retries for {}", redact(url)))
    }

    /// Follows `Link: rel="next"` until the pages run out.
    async fn get_paged<T: for<'de> Deserialize<'de>>(&self, first_url: String) -> Result<Vec<T>> {
        let mut url = Some(first_url);
        let mut items = Vec::new();
        let mut pages = 0usize;

        while let Some(current) = url.take() {
            let response = self.get(&current).await?;
            let next = next_page_url(response.headers().get(reqwest::header::LINK));
            let page: Vec<T> = response
                .json()
                .await
                .with_context(|| format!("decoding {}", redact(&current)))?;

            items.extend(page);
            pages += 1;
            if pages >= MAX_PAGES {
                log::warn!("stopping pagination at {MAX_PAGES} pages");
                break;
            }
            url = next;
        }

        Ok(items)
    }

    async fn active_courses(&self) -> Result<Vec<CanvasCourse>> {
        self.get_paged(format!(
            "{}/api/v1/courses?enrollment_state=active&per_page=50",
            self.base_url
        ))
        .await
    }

    async fn todo_items(&self) -> Result<Vec<CanvasTodo>> {
        self.get_paged(format!("{}/api/v1/users/self/todo", self.base_url))
            .await
    }

    /// Assignments with their submission state, bounded to what is still worth showing.
    ///
    /// No `bucket=upcoming` any more: that filter is about due dates, and an assignment
    /// submitted last week is exactly the one whose submission state we came for. Without
    /// it a whole term arrives, so the window below throws away anything long past.
    ///
    /// `include[]=submission` is what carries "handed in" — the only thing the API knows
    /// that the calendar feed cannot.
    async fn assignments_with_submissions(&self, course_id: i64) -> Result<Vec<CanvasAssignment>> {
        self.get_paged(format!(
            "{}/api/v1/courses/{course_id}/assignments?include[]=submission&per_page=50",
            self.base_url
        ))
        .await
    }
}

#[async_trait]
impl LmsProvider for CanvasClient {
    fn provider_id(&self) -> &'static str {
        PROVIDER_ID
    }

    async fn fetch_tasks(&self) -> Result<Vec<LmsTask>> {
        let courses = self.active_courses().await?;
        let course_codes: HashMap<i64, String> = courses
            .iter()
            .map(|course| {
                let label = course
                    .course_code
                    .clone()
                    .or_else(|| course.name.clone())
                    .unwrap_or_else(|| format!("Course {}", course.id));
                (course.id, sanitize(&label, 40))
            })
            .collect();

        // Keyed by assignment id so the to-do list and the per-course listing merge
        // instead of producing duplicates.
        let mut merged: HashMap<i64, LmsTask> = HashMap::new();

        for todo in self.todo_items().await? {
            if let Some(assignment) = todo.assignment {
                if let Some(task) = to_task(assignment, &course_codes) {
                    merged.insert(task_key(&task), task);
                }
            }
        }

        // Far enough back to catch work handed in recently, not so far that a term's
        // history lands in a list of what is due.
        let horizon = chrono::Utc::now().timestamp() - RECENT_WINDOW_SECONDS;

        for course in &courses {
            match self.assignments_with_submissions(course.id).await {
                Ok(assignments) => {
                    for assignment in assignments {
                        let Some(task) = to_task(assignment, &course_codes) else {
                            continue;
                        };
                        // Undated work stays: it has no due date to be past.
                        if task.due_at.is_some_and(|due| due < horizon) {
                            continue;
                        }
                        // `insert`, not `or_insert`: this one carries submission state and
                        // the to-do list's copy does not.
                        merged.insert(task_key(&task), task);
                    }
                }
                // One inaccessible course (concluded, restricted) must not sink the sync.
                Err(error) => log::warn!("skipping course {}: {error}", course.id),
            }
        }

        let mut tasks: Vec<LmsTask> = merged.into_values().collect();
        tasks.sort_by_key(|task| task.due_at.unwrap_or(i64::MAX));
        Ok(tasks)
    }
}

fn task_key(task: &LmsTask) -> i64 {
    task.external_id
        .rsplit(':')
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn to_task(
    assignment: CanvasAssignment,
    course_codes: &HashMap<i64, String>,
) -> Option<LmsTask> {
    let title = sanitize(assignment.name.as_deref()?, MAX_TITLE_CHARS);
    if title.is_empty() {
        return None;
    }

    let completed = assignment
        .submission
        .as_ref()
        .is_some_and(CanvasSubmission::handed_in);

    Some(LmsTask {
        id: 0,
        provider: PROVIDER_ID.to_string(),
        external_id: format!("assignment:{}", assignment.id),
        course_code: assignment
            .course_id
            .and_then(|id| course_codes.get(&id).cloned()),
        title,
        due_at: assignment.due_at.as_deref().and_then(parse_timestamp),
        html_url: assignment.html_url,
        // What Canvas says, which `upsert_tasks` applies in one direction only: handing
        // something in marks it done here, and nothing here un-hands it in.
        completed,
        completed_at: None,
        // Set aside is a local decision; a sync never makes or unmakes one.
        dismissed_at: None,
    })
}

/// Canvas titles can carry HTML entities and stray whitespace. Nothing here is rendered
/// as HTML, but a title is user-visible text and should read as text.
fn sanitize(value: &str, max_chars: usize) -> String {
    let unescaped = value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");

    let collapsed = unescaped.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(max_chars).collect()
}

fn parse_timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp())
}

fn normalize_base_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(anyhow!("Canvas base URL is not set"));
    }
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err(anyhow!("Canvas base URL must start with https://"));
    }
    Ok(trimmed.to_string())
}

fn retry_after(response: &Response) -> Option<Duration> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(|seconds| Duration::from_secs(seconds.min(60)))
}

fn next_page_url(header: Option<&reqwest::header::HeaderValue>) -> Option<String> {
    let raw = header?.to_str().ok()?;
    for part in raw.split(',') {
        let mut pieces = part.split(';');
        let url = pieces.next()?.trim().trim_start_matches('<').trim_end_matches('>');
        if pieces.any(|piece| piece.trim() == "rel=\"next\"") {
            return Some(url.to_string());
        }
    }
    None
}

/// URLs are logged on failure; the token lives in a header, but query strings on some
/// instances carry `access_token`. Strip it rather than trust that they do not.
fn redact(url: &str) -> String {
    match url.split_once("access_token=") {
        Some((head, _)) => format!("{head}access_token=[redacted]"),
        None => url.to_string(),
    }
}

#[derive(Debug, Deserialize)]
struct CanvasCourse {
    id: i64,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    course_code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CanvasTodo {
    #[serde(default)]
    assignment: Option<CanvasAssignment>,
}

#[derive(Debug, Deserialize)]
struct CanvasAssignment {
    id: i64,
    #[serde(default)]
    submission: Option<CanvasSubmission>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    due_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    course_id: Option<i64>,
}

/// What `include[]=submission` adds. Only enough of it to answer "has this been handed
/// in?" — a grade is a different question and not one this app asks.
#[derive(Debug, Clone, serde::Deserialize)]
struct CanvasSubmission {
    #[serde(default)]
    submitted_at: Option<String>,
    #[serde(default)]
    workflow_state: Option<String>,
}

impl CanvasSubmission {
    /// Handed in, however Canvas phrases it.
    ///
    /// `submitted_at` is the plain answer; `workflow_state` covers the kinds of work that
    /// are marked done without an upload — an on-paper assignment a marker graded, say.
    fn handed_in(&self) -> bool {
        self.submitted_at.is_some()
            || matches!(
                self.workflow_state.as_deref(),
                Some("submitted") | Some("graded") | Some("pending_review") | Some("complete")
            )
    }
}

/// How far back a submitted assignment is still worth reporting.
const RECENT_WINDOW_SECONDS: i64 = 30 * 24 * 3600;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_must_be_absolute_and_loses_its_trailing_slash() {
        assert_eq!(
            normalize_base_url("https://canvas.school.edu/").unwrap(),
            "https://canvas.school.edu"
        );
        assert!(normalize_base_url("canvas.school.edu").is_err());
        assert!(normalize_base_url("   ").is_err());
    }

    #[test]
    fn sanitize_unescapes_entities_and_collapses_whitespace() {
        assert_eq!(sanitize("Lab  &amp;\n Report ", 100), "Lab & Report");
    }

    #[test]
    fn sanitize_truncates_to_the_character_limit() {
        assert_eq!(sanitize(&"x".repeat(500), 10).chars().count(), 10);
    }

    #[test]
    fn next_page_is_read_from_the_link_header() {
        let header = reqwest::header::HeaderValue::from_static(
            "<https://c.edu/api/v1/courses?page=1>; rel=\"current\", \
             <https://c.edu/api/v1/courses?page=2>; rel=\"next\"",
        );
        assert_eq!(
            next_page_url(Some(&header)).as_deref(),
            Some("https://c.edu/api/v1/courses?page=2")
        );
        assert_eq!(next_page_url(None), None);
    }

    #[test]
    fn timestamps_parse_from_rfc3339() {
        assert_eq!(parse_timestamp("2026-09-18T23:59:00Z"), Some(1789775940));
        assert_eq!(parse_timestamp("not a date"), None);
    }

    #[test]
    fn redact_strips_a_token_in_the_query_string() {
        assert!(!redact("https://c.edu/api?access_token=sekrit").contains("sekrit"));
    }
}
