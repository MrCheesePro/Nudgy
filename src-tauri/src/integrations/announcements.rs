//! A class's announcements, read from its Canvas feed.
//!
//! Canvas gives every enrolment a private Atom feed of its announcements — on the class's
//! Announcements page, the RSS link — so, like the calendar feed, this needs no API token.
//! The link is a credential and lives in the keychain. The announcements themselves are
//! **fetched when looked at and never stored**: they are the instructor's words, shown to
//! the person they were sent to, and there is no reason for a copy to outlive the page.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use regex::Regex;
use reqwest::Client;
use serde::Serialize;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const USER_AGENT: &str = concat!("Nudgy/", env!("CARGO_PKG_VERSION"));
const MAX_FEED_BYTES: usize = 4 * 1024 * 1024;
/// Plenty for a term; the page shows the newest first.
const MAX_ENTRIES: usize = 40;
/// An announcement is a few paragraphs. Past this it is cut, and the Canvas link has the rest.
const MAX_TEXT_CHARS: usize = 4_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    pub title: String,
    pub author: Option<String>,
    /// Epoch seconds, when the feed says.
    pub posted_at: Option<i64>,
    /// The announcement's page on Canvas. Carries no secret — it needs a login to open.
    pub url: Option<String>,
    /// The body as plain text: tags dropped, paragraphs kept.
    pub text: String,
}

pub async fn fetch(url: &str) -> Result<Vec<Announcement>> {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") {
        return Err(anyhow!("the announcements feed link must start with https://"));
    }
    let http = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .context("building HTTP client")?;
    let response = http
        .get(trimmed)
        .header("Cache-Control", "no-cache")
        .send()
        .await
        .context("fetching the announcements feed")?;

    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!(if status.is_server_error() {
            format!("Canvas had a problem ({}). Try again in a minute.", status.as_u16())
        } else {
            format!(
                "Canvas refused the announcements feed ({}). Copy the link again from the class's Announcements page.",
                status.as_u16()
            )
        }));
    }
    let body = response.text().await.context("reading the announcements feed")?;
    if body.len() > MAX_FEED_BYTES {
        return Err(anyhow!("the announcements feed is unreasonably large"));
    }
    if !body.contains("<feed") && !body.contains("<rss") {
        return Err(anyhow!(
            "that link is not an announcements feed — use the RSS link on the class's Announcements page"
        ));
    }
    parse(&body)
}

#[derive(Default)]
struct Draft {
    title: String,
    author: Option<String>,
    posted_at: Option<i64>,
    url: Option<String>,
    body: String,
}

/// Atom (what Canvas serves) and plain RSS 2.0, newest first.
pub fn parse(xml: &str) -> Result<Vec<Announcement>> {
    let mut reader = Reader::from_str(xml);
    let mut path: Vec<String> = Vec::new();
    let mut current: Option<Draft> = None;
    let mut text = String::new();
    let mut out = Vec::new();

    loop {
        match reader.read_event().context("reading the announcements feed")? {
            Event::Start(start) => {
                let name = local(start.name().0);
                if name == "entry" || name == "item" {
                    current = Some(Draft::default());
                }
                if name == "link" {
                    if let Some(draft) = current.as_mut() {
                        if let Some(href) = alternate_href(&start) {
                            draft.url = Some(href);
                        }
                    }
                }
                path.push(name);
                text.clear();
            }
            Event::Empty(empty) => {
                if local(empty.name().0) == "link" {
                    if let Some(draft) = current.as_mut() {
                        if let Some(href) = alternate_href(&empty) {
                            draft.url = Some(href);
                        }
                    }
                }
            }
            Event::Text(chunk) => text.push_str(&chunk.xml10_content()),
            Event::CData(chunk) => text.push_str(&chunk.xml10_content()),
            Event::GeneralRef(reference) => {
                if let Some(character) = reference.resolve_char_ref()? {
                    text.push(character);
                } else {
                    let name = reference.into_inner();
                    match quick_xml::escape::resolve_xml_entity(&name) {
                        Some(resolved) => text.push_str(resolved),
                        None => {
                            text.push('&');
                            text.push_str(&name);
                            text.push(';');
                        }
                    }
                }
            }
            Event::End(end) => {
                let name = local(end.name().0);
                let parent = path.len().checked_sub(2).and_then(|at| path.get(at)).cloned();
                if let Some(draft) = current.as_mut() {
                    let value = text.trim();
                    match name.as_str() {
                        "title" if matches!(parent.as_deref(), Some("entry" | "item")) => {
                            draft.title = value.to_string();
                        }
                        "name" if parent.as_deref() == Some("author") => {
                            draft.author = Some(value.to_string()).filter(|author| !author.is_empty());
                        }
                        "creator" | "author" if matches!(parent.as_deref(), Some("item")) && !value.is_empty() => {
                            draft.author = Some(value.to_string());
                        }
                        "published" | "updated" | "pubDate" => {
                            // `published` wins over `updated`: an edit is not a new post.
                            if name != "updated" || draft.posted_at.is_none() {
                                draft.posted_at = parse_date(value).or(draft.posted_at);
                            }
                        }
                        "link" if draft.url.is_none() && value.starts_with("http") => {
                            draft.url = Some(value.to_string());
                        }
                        // Full content beats a summary when a feed carries both.
                        "content" | "summary" | "description"
                            if !value.is_empty() && (name != "summary" || draft.body.is_empty()) =>
                        {
                            draft.body = value.to_string();
                        }
                        _ => {}
                    }
                }
                if name == "entry" || name == "item" {
                    if let Some(draft) = current.take() {
                        out.push(Announcement {
                            title: if draft.title.is_empty() {
                                "Announcement".to_string()
                            } else {
                                draft.title
                            },
                            author: draft.author,
                            posted_at: draft.posted_at,
                            url: draft.url,
                            text: html_to_text(&draft.body),
                        });
                    }
                }
                path.pop();
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
    }

    out.sort_by_key(|entry| std::cmp::Reverse(entry.posted_at));
    out.truncate(MAX_ENTRIES);
    Ok(out)
}

/// `atom:link` → `link`, `dc:creator` → `creator`.
fn local(name: &str) -> String {
    name.rsplit(':').next().unwrap_or(name).to_string()
}

/// An Atom `<link href>` that points at the page — not `rel="self"` or an enclosure.
fn alternate_href(tag: &quick_xml::events::BytesStart) -> Option<String> {
    let mut href = None;
    let mut rel = None;
    for attribute in tag.attributes().flatten() {
        let value = attribute
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .ok()?
            .to_string();
        match attribute.key.0 {
            "href" => href = Some(value),
            "rel" => rel = Some(value),
            _ => {}
        }
    }
    match rel.as_deref() {
        None | Some("alternate") => href,
        _ => None,
    }
}

fn parse_date(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .or_else(|_| chrono::DateTime::parse_from_rfc2822(value))
        .ok()
        .map(|moment| moment.timestamp())
}

/// Announcement HTML as readable text: block ends become line breaks, tags go, entities
/// are decoded, and runs of blank lines collapse to one.
fn html_to_text(html: &str) -> String {
    let breaks = Regex::new(r"(?i)<\s*br\s*/?>|</\s*(p|div|li|h[1-6]|tr|blockquote)\s*>").unwrap();
    let bullets = Regex::new(r"(?i)<\s*li[^>]*>").unwrap();
    let tags = Regex::new(r"(?s)<[^>]*>").unwrap();
    let blank = Regex::new(r"\n[ \t]*(\n[ \t]*)+").unwrap();

    let text = breaks.replace_all(html, "\n");
    let text = bullets.replace_all(&text, "• ");
    let text = tags.replace_all(&text, "");
    let text = decode_entities(&text);
    let text = text
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n");
    let text = blank.replace_all(text.trim(), "\n\n").to_string();

    if text.chars().count() > MAX_TEXT_CHARS {
        let cut: String = text.chars().take(MAX_TEXT_CHARS).collect();
        format!("{}…", cut.trim_end())
    } else {
        text
    }
}

fn decode_entities(text: &str) -> String {
    let numeric = Regex::new(r"&#(x[0-9a-fA-F]+|[0-9]+);").unwrap();
    let text = numeric.replace_all(text, |captures: &regex::Captures| {
        let raw = &captures[1];
        let code = if let Some(hex) = raw.strip_prefix('x') {
            u32::from_str_radix(hex, 16).ok()
        } else {
            raw.parse().ok()
        };
        code.and_then(char::from_u32).map(String::from).unwrap_or_default()
    });
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&rsquo;", "’")
        .replace("&lsquo;", "‘")
        .replace("&ldquo;", "“")
        .replace("&rdquo;", "”")
        .replace("&ndash;", "–")
        .replace("&mdash;", "—")
        .replace("&hellip;", "…")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    const ATOM: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>CS 100: Announcements</title>
  <link rel="self" href="https://canvas.example.edu/feeds/announcements/enrollment_abc.atom"/>
  <entry>
    <title>Quiz 2 moved to Thursday</title>
    <updated>2026-09-21T18:00:00Z</updated>
    <published>2026-09-20T17:30:00Z</published>
    <link rel="alternate" href="https://canvas.example.edu/courses/1/discussion_topics/9"/>
    <author><name>Dr. Rivera</name></author>
    <content type="html">&lt;p&gt;Hi all,&lt;/p&gt;&lt;p&gt;Quiz&amp;nbsp;2 is now on &lt;b&gt;Thursday&lt;/b&gt;.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Bring ID&lt;/li&gt;&lt;li&gt;No notes&lt;/li&gt;&lt;/ul&gt;</content>
  </entry>
  <entry>
    <title>Welcome!</title>
    <published>2026-09-01T09:00:00Z</published>
    <link href="https://canvas.example.edu/courses/1/discussion_topics/1"/>
    <author><name>Dr. Rivera</name></author>
    <content type="html">Welcome to the class.</content>
  </entry>
</feed>"#;

    #[test]
    fn reads_canvas_atom_newest_first() {
        let entries = parse(ATOM).unwrap();
        assert_eq!(entries.len(), 2);

        let first = &entries[0];
        assert_eq!(first.title, "Quiz 2 moved to Thursday");
        assert_eq!(first.author.as_deref(), Some("Dr. Rivera"));
        // `published`, not the later `updated`.
        assert_eq!(first.posted_at, Some(1_789_925_400));
        assert_eq!(
            first.url.as_deref(),
            Some("https://canvas.example.edu/courses/1/discussion_topics/9")
        );
        assert_eq!(first.text, "Hi all,\nQuiz 2 is now on Thursday.\n• Bring ID\n• No notes");

        assert_eq!(entries[1].title, "Welcome!");
    }

    #[test]
    fn reads_plain_rss_too() {
        let rss = r#"<rss version="2.0"><channel><title>x</title>
          <item><title>Office hours</title><link>https://canvas.example.edu/a/1</link>
            <pubDate>Mon, 21 Sep 2026 10:00:00 +0000</pubDate>
            <description><![CDATA[<p>Moved to <i>room 204</i>.</p>]]></description></item>
        </channel></rss>"#;
        let entries = parse(rss).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, "Moved to room 204.");
        assert_eq!(entries[0].url.as_deref(), Some("https://canvas.example.edu/a/1"));
        assert!(entries[0].posted_at.is_some());
    }

    #[test]
    fn long_bodies_are_cut() {
        let long = "word ".repeat(2_000);
        assert!(html_to_text(&long).ends_with('…'));
    }
}
