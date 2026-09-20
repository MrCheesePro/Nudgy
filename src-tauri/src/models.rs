use serde::{Deserialize, Serialize};

/// The fixed category vocabulary. Anything not matched by the registry lands in `Neutral`.
pub const CATEGORIES: &[&str] = &[
    "Development",
    "Productivity",
    "Gaming",
    "Creative",
    "Social",
    "Neutral",
    "Idle",
];

pub const CATEGORY_IDLE: &str = "Idle";
pub const CATEGORY_NEUTRAL: &str = "Neutral";

/// Sentinel process name for idle ticks. Idle time is never attributed to a real app.
pub const IDLE_PROCESS: &str = "__idle__";

pub const SOURCE_PASSIVE: &str = "passive";
pub const SOURCE_RPC: &str = "rpc";

/// Seconds of no input after which a tick counts as idle.
pub const IDLE_THRESHOLD_SECONDS: u64 = 180;

/// How often the watcher samples system state.
pub const TICK_SECONDS: u64 = 5;

/// How often the in-memory buffer is drained into SQLite.
pub const FLUSH_SECONDS: u64 = 45;

pub fn is_valid_category(candidate: &str) -> bool {
    CATEGORIES.contains(&candidate)
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
