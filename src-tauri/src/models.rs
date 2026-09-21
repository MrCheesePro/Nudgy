use serde::{Deserialize, Serialize};

pub const CATEGORY_IDLE: &str = "Idle";
pub const CATEGORY_NEUTRAL: &str = "Neutral";

/// Sentinel process name for idle ticks. Idle time is never attributed to a real app.
pub const IDLE_PROCESS: &str = "__idle__";

pub const SOURCE_PASSIVE: &str = "passive";
pub const SOURCE_RPC: &str = "rpc";

/// Seconds of no input after which a tick counts as idle.
pub const IDLE_THRESHOLD_SECONDS: u64 = 180;

/// How often the watcher samples system state.
///
/// Three, not one. This is the granularity of every stored row *and* how long the header
/// can lag an app switch, so it trades responsiveness against volume — at three seconds a
/// busy day is roughly 28k samples rather than 17k, which SQLite does not notice.
///
/// Not lower: the macOS foreground probe hops to the main thread and gives up after two
/// seconds (`MAIN_THREAD_TIMEOUT`). A tick interval at or under that would let a slow
/// probe still be running when the next one starts.
pub const TICK_SECONDS: u64 = 3;

/// How often the in-memory buffer is drained into SQLite.
///
/// This is the floor on how stale anything measured can be. Plan progress, the day's
/// totals and goal verification are all read back out of the table, so at 45 seconds a
/// block could be a minute underway before it admitted to a single second of work.
///
/// The row count does not depend on this — that is `TICK_SECONDS` — so a shorter interval
/// buys freshness for the cost of more, smaller transactions, which is what a WAL is for.
pub const FLUSH_SECONDS: u64 = 5;

/// One bucket in the category vocabulary. The vocabulary lives in the `categories` table
/// rather than in this file, so a person can add one without a rebuild — which means
/// "is this a real category?" is a question for the loaded `Registry`, not a const lookup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    /// Hex, as the chart reads it — `#4fa88c`.
    pub color: String,
    #[serde(default)]
    pub sort_order: i64,
    /// Built-ins cannot be deleted: `Neutral` is where everything unmatched lands and
    /// `Idle` is how absence is recorded, so neither is the user's to remove.
    #[serde(default)]
    pub is_builtin: bool,
}

/// One 5-second slice of measured time. This is the only row type the watcher writes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivitySample {
    pub ts: i64,
    pub duration_seconds: i64,
    pub process_name: String,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub category: String,
    pub source: String,
    pub client_id: Option<String>,
    pub is_idle: bool,
}

/// What the foreground probe reports, before categorization or redaction.
#[derive(Debug, Clone)]
pub struct Foreground {
    pub process_name: String,
    pub app_name: Option<String>,
    pub title: Option<String>,
}

/// Pushed to the frontend on every tick via the `nudgy://tick` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStatus {
    pub process_name: String,
    pub app_name: String,
    pub window_title: Option<String>,
    pub category: String,
    pub source: String,
    pub is_idle: bool,
    pub idle_seconds: i64,
    pub session_started_at: i64,
    pub session_seconds: i64,
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTotal {
    pub category: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTotal {
    pub process_name: String,
    pub app_name: String,
    /// Short site label inside the app — "YouTube" under Google Chrome — or None.
    pub context: Option<String>,
    pub category: String,
    pub seconds: i64,
}

/// A row in the Discord-style application registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRule {
    #[serde(default)]
    pub id: i64,
    /// `exe` (exact executable or bundle id) or `title_regex`.
    pub match_type: String,
    pub pattern: String,
    pub display_name: String,
    pub category: String,
    #[serde(default)]
    pub is_user_defined: bool,
    /// Higher wins when two title rules match the same window. School work (200) outranks
    /// something playing in another tab (100); anything hand-written (300) outranks both.
    #[serde(default = "default_priority")]
    pub priority: i64,
}

pub const PRIORITY_DEFAULT: i64 = 100;
pub const PRIORITY_USER: i64 = 300;

fn default_priority() -> i64 {
    PRIORITY_DEFAULT
}

/// One category's total on one local day. The unit the Progress chart is built from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyTotal {
    /// Local `YYYY-MM-DD`, resolved by SQLite against this machine's timezone.
    pub day: String,
    pub category: String,
    pub seconds: i64,
}

/// What a good day looks like for one category.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTarget {
    pub category: String,
    /// `at_least` (a floor) or `at_most` (a ceiling).
    pub direction: String,
    pub seconds_per_day: i64,
    #[serde(default)]
    pub created_at: i64,
}

pub const TARGET_AT_LEAST: &str = "at_least";
pub const TARGET_AT_MOST: &str = "at_most";

pub fn is_valid_target_direction(candidate: &str) -> bool {
    candidate == TARGET_AT_LEAST || candidate == TARGET_AT_MOST
}

/// A title/executable pattern whose window titles are stored as `[Private]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionRule {
    #[serde(default)]
    pub id: i64,
    pub match_type: String,
    pub pattern: String,
    #[serde(default)]
    pub is_user_defined: bool,
}

/// A process seen recently that no registry rule matches — the "register this app" feed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmappedProcess {
    pub process_name: String,
    pub app_name: String,
    pub seconds: i64,
    pub last_seen: i64,
}

/// A task pulled from a learning management system. Descriptions are deliberately not
/// part of this type — Nudgy stores what it needs to schedule around a deadline and
/// nothing else.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LmsTask {
    #[serde(default)]
    pub id: i64,
    pub provider: String,
    pub external_id: String,
    pub course_code: Option<String>,
    pub title: String,
    pub due_at: Option<i64>,
    pub html_url: Option<String>,
    #[serde(default)]
    pub completed: bool,
    /// When it was ticked off here. Canvas does not tell us, so this is local.
    #[serde(default)]
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub fetched: usize,
    pub stored: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub screen_recording: bool,
    /// False on platforms where these permissions do not exist.
    pub applicable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdown {
    pub categories: Vec<CategoryTotal>,
    pub total_seconds: i64,
    pub active_seconds: i64,
    pub idle_seconds: i64,
}
