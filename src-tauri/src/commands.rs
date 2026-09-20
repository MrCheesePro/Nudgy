use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::queries;
use crate::error::{AppError, CmdResult};
use crate::integrations::canvas::CanvasClient;
use crate::integrations::{calendar, LmsProvider};
use crate::models::{
    is_valid_category, AppRule, AppTotal, LiveStatus, LmsTask, PermissionStatus, RedactionRule,
    SyncResult, UnmappedProcess, UsageBreakdown, WindowTotal,
};
use crate::llm::{self, LlmConfig};
use crate::plans;
use crate::scheduler::{self, ScheduleBlock, VerificationResult};
use crate::secrets;
use crate::state::AppState;
use crate::watcher::{flush, platform, registry};

/// Every command that touches SQLite goes through this helper so the lock-poisoned case
/// is handled once instead of in twenty places.
fn with_db<T>(
    state: &State<'_, AppState>,
    action: impl FnOnce(&rusqlite::Connection) -> anyhow::Result<T>,
) -> CmdResult<T> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AppError::msg("database lock poisoned"))?;
    action(&conn).map_err(AppError::from)
}

#[tauri::command]
pub fn get_live_status(state: State<'_, AppState>) -> CmdResult<Option<LiveStatus>> {
    let current = state
        .current
        .read()
        .map_err(|_| AppError::msg("live status lock poisoned"))?;
    Ok(current.clone())
}

#[tauri::command]
pub fn get_usage_breakdown(
    state: State<'_, AppState>,
    start_ts: i64,
    end_ts: i64,
) -> CmdResult<UsageBreakdown> {
    with_db(&state, |conn| {
        queries::usage_breakdown(conn, start_ts, end_ts)
    })
}

#[tauri::command]
pub fn get_app_totals(
    state: State<'_, AppState>,
    start_ts: i64,
    end_ts: i64,
    limit: Option<i64>,
) -> CmdResult<Vec<AppTotal>> {
    let limit = limit.unwrap_or(12).clamp(1, 200);
    with_db(&state, |conn| {
        queries::app_totals(conn, start_ts, end_ts, limit)
    })
}

/// The window titles behind the app totals — what Chrome was actually showing.
#[tauri::command]
pub fn get_window_totals(
    state: State<'_, AppState>,
    start_ts: i64,
    end_ts: i64,
    limit: Option<i64>,
) -> CmdResult<Vec<WindowTotal>> {
    let limit = limit.unwrap_or(60).clamp(1, 500);
    with_db(&state, |conn| {
        queries::window_totals(conn, start_ts, end_ts, limit)
    })
}

#[tauri::command]
pub fn list_unmapped_processes(
    state: State<'_, AppState>,
    since_ts: Option<i64>,
) -> CmdResult<Vec<UnmappedProcess>> {
    let since = since_ts.unwrap_or_else(|| chrono::Utc::now().timestamp() - 7 * 24 * 60 * 60);
    with_db(&state, |conn| queries::unmapped_processes(conn, since))
}

#[tauri::command]
pub fn get_app_rules(state: State<'_, AppState>) -> CmdResult<Vec<AppRule>> {
    with_db(&state, queries::load_app_rules)
}

/// Registers (or updates) a mapping. Validation happens here rather than in the watcher:
/// a rejected regex is a clear error in the UI instead of a rule that silently never fires.
#[tauri::command]
pub fn register_app(
    state: State<'_, AppState>,
    match_type: String,
    pattern: String,
    display_name: String,
    category: String,
) -> CmdResult<()> {
    if pattern.trim().is_empty() {
        return Err(AppError::msg("pattern cannot be empty"));
    }
    if !is_valid_category(&category) {
        return Err(AppError::msg(format!("unknown category `{category}`")));
    }
    match match_type.as_str() {
        registry::MATCH_EXE => {}
        registry::MATCH_TITLE_REGEX => {
            regex::Regex::new(&pattern)
                .map_err(|error| AppError::msg(format!("invalid regex: {error}")))?;
        }
        other => return Err(AppError::msg(format!("unknown match type `{other}`"))),
    }

    let rule = AppRule {
        id: 0,
        match_type,
        pattern: pattern.trim().to_string(),
        display_name: display_name.trim().to_string(),
        category,
        is_user_defined: true,
    };

    with_db(&state, |conn| queries::upsert_app_rule(conn, &rule, true))?;
    state.reload_registry().map_err(AppError::from)
}

#[tauri::command]
pub fn delete_app_rule(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_db(&state, |conn| queries::delete_app_rule(conn, id))?;
    state.reload_registry().map_err(AppError::from)
}

/// Guesses which app a goal is about, from its wording. Returns nothing when it cannot
/// tell, which is a valid answer — the goal is then verified against any activity.
#[tauri::command]
pub fn resolve_app_for_text(state: State<'_, AppState>, text: String) -> CmdResult<Option<AppRule>> {
    let registry = state
        .registry
        .read()
        .map_err(|_| AppError::msg("registry lock poisoned"))?;
    Ok(registry.resolve_from_text(&text))
}

#[tauri::command]
pub fn get_redaction_rules(state: State<'_, AppState>) -> CmdResult<Vec<RedactionRule>> {
    with_db(&state, queries::load_redaction_rules)
}

#[tauri::command]
pub fn add_redaction_rule(
    state: State<'_, AppState>,
    match_type: String,
    pattern: String,
) -> CmdResult<()> {
    if match_type == registry::MATCH_TITLE_REGEX {
        regex::Regex::new(&pattern)
            .map_err(|error| AppError::msg(format!("invalid regex: {error}")))?;
    }
    with_db(&state, |conn| {
        queries::upsert_redaction_rule(conn, &match_type, &pattern)
    })?;
    state.reload_registry().map_err(AppError::from)
}

#[tauri::command]
pub fn delete_redaction_rule(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_db(&state, |conn| queries::delete_redaction_rule(conn, id))?;
    state.reload_registry().map_err(AppError::from)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<Vec<(String, String)>> {
    with_db(&state, queries::all_settings)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    with_db(&state, |conn| queries::set_setting(conn, &key, &value))
}

pub const SETTING_CANVAS_BASE_URL: &str = "canvas_base_url";

/// Whether a secret is present — never its value. The frontend has no route to the
/// token itself, by construction.
#[tauri::command]
pub fn has_secret(key: String) -> bool {
    secrets::has(&key)
}

#[tauri::command]
pub fn set_secret(key: String, value: String) -> CmdResult<()> {
    secrets::set(&key, &value).map_err(AppError::from)
}

#[tauri::command]
pub fn clear_secret(key: String) -> CmdResult<()> {
    secrets::clear(&key).map_err(AppError::from)
}

#[tauri::command]
pub fn get_tasks(state: State<'_, AppState>, include_completed: Option<bool>) -> CmdResult<Vec<LmsTask>> {
    let include = include_completed.unwrap_or(false);
    with_db(&state, |conn| queries::load_tasks(conn, include))
}

#[tauri::command]
pub fn set_task_completed(state: State<'_, AppState>, id: i64, completed: bool) -> CmdResult<()> {
    with_db(&state, |conn| {
        queries::set_task_completed(conn, id, completed)
    })?;
    Ok(())
}

/// Pulls Canvas deadlines into the local database. Credentials are read here, used, and
/// dropped — they are never stored alongside the data they fetched.
#[tauri::command]
pub async fn sync_canvas(app: AppHandle) -> CmdResult<SyncResult> {
    let base_url = {
        let state = app.state::<AppState>();
        with_db(&state, |conn| {
            queries::get_setting(conn, SETTING_CANVAS_BASE_URL)
        })?
        .ok_or_else(|| AppError::msg("Canvas base URL is not set"))?
    };

    let token = secrets::get(secrets::CANVAS_TOKEN)
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::msg("Canvas API token is not set"))?;

    let client = CanvasClient::new(&base_url, &token).map_err(AppError::from)?;
    let provider = client.provider_id();
    let tasks = client.fetch_tasks().await.map_err(AppError::from)?;
    let fetched = tasks.len();
    log::info!("{provider} sync fetched {fetched} tasks");

    let stored = {
        let state = app.state::<AppState>();
        let mut conn = state
            .db
            .lock()
            .map_err(|_| AppError::msg("database lock poisoned"))?;
        queries::upsert_tasks(&mut conn, &tasks).map_err(AppError::from)?
    };

    let result = SyncResult { fetched, stored };
    let _ = app.emit("nudgy://sync-complete", &result);
    Ok(result)
}

const SETTING_LLM_BASE_URL: &str = "llm_base_url";
const SETTING_LLM_MODEL: &str = "llm_model";

const AGENDA_SYSTEM_PROMPT: &str = "\
You are a scheduling assistant. You are given free time slots and the user's goals and \
deadlines. Place goals into the given slots. Never invent time outside the slots you \
were given, never overlap blocks, and prefer earlier slots for work with nearer \
deadlines. Keep labels short and concrete. Respond with JSON only.";

#[tauri::command]
pub fn get_schedule(state: State<'_, AppState>, day: String) -> CmdResult<Vec<ScheduleBlock>> {
    with_db(&state, |conn| scheduler::load_day(conn, &day))
}

#[tauri::command]
pub fn get_schedule_range(
    state: State<'_, AppState>,
    start_day: String,
    end_day: String,
) -> CmdResult<Vec<ScheduleBlock>> {
    with_db(&state, |conn| {
        scheduler::load_range(conn, &start_day, &end_day)
    })
}

#[tauri::command]
pub fn save_schedule(
    state: State<'_, AppState>,
    day: String,
    blocks: Vec<ScheduleBlock>,
) -> CmdResult<usize> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| AppError::msg("database lock poisoned"))?;
    scheduler::save_day(&mut conn, &day, &blocks).map_err(AppError::from)
}

/// Re-checks every block for a day against recorded activity and returns the verdicts.
#[tauri::command]
pub fn verify_schedule(
    state: State<'_, AppState>,
    day: String,
) -> CmdResult<Vec<VerificationResult>> {
    let now = chrono::Utc::now().timestamp();
    with_db(&state, |conn| scheduler::verify_day(conn, &day, now))
}

/// Verifies one goal directly, without a stored block behind it.
#[tauri::command]
pub fn verify_goal(
    state: State<'_, AppState>,
    process_name: String,
    start_ts: i64,
    end_ts: i64,
    target_seconds: i64,
) -> CmdResult<VerificationResult> {
    let accumulated = with_db(&state, |conn| {
        queries::active_seconds_for_process(conn, &process_name, start_ts, end_ts)
    })?;
    let met = accumulated >= target_seconds;
    Ok(VerificationResult {
        block_id: 0,
        accumulated_seconds: accumulated,
        target_seconds,
        met,
        state: if met {
            scheduler::STATE_MET.to_string()
        } else if chrono::Utc::now().timestamp() < end_ts {
            scheduler::STATE_PENDING.to_string()
        } else {
            scheduler::STATE_MISSED.to_string()
        },
    })
}

/// Sends the prompt payload the frontend assembled and returns the model's raw JSON.
///
/// Deliberately does not write anything: the caller validates the proposal against the
/// slots it sent before any of it reaches the database. The model chooses what goes
/// where; it does not get to decide what is allowed.
#[tauri::command]
pub async fn generate_agenda(
    app: AppHandle,
    payload: serde_json::Value,
    schema: serde_json::Value,
) -> CmdResult<serde_json::Value> {
    let (base_url, model) = {
        let state = app.state::<AppState>();
        let settings: std::collections::HashMap<String, String> =
            with_db(&state, queries::all_settings)?.into_iter().collect();
        (
            settings
                .get(SETTING_LLM_BASE_URL)
                .cloned()
                .unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
            settings
                .get(SETTING_LLM_MODEL)
                .cloned()
                .unwrap_or_else(|| "gpt-4o-mini".to_string()),
        )
    };

    let config = LlmConfig {
        base_url,
        model,
        // Local servers (Ollama, LM Studio) need no key; remote ones do.
        api_key: secrets::get(secrets::LLM_API_KEY).map_err(AppError::from)?,
    };

    let user_prompt = serde_json::to_string_pretty(&payload)
        .map_err(|error| AppError::msg(error.to_string()))?;

    llm::complete_json(&config, AGENDA_SYSTEM_PROMPT, &user_prompt, schema)
        .await
        .map_err(AppError::from)
}

/// Fetches the calendar feed and returns the events overlapping a window. Called by the
/// planner before it works out where the free time is.
#[tauri::command]
pub async fn get_calendar_events(
    start_ts: i64,
    end_ts: i64,
) -> CmdResult<Vec<calendar::CalendarEvent>> {
    let Some(url) = secrets::get(secrets::CALENDAR_ICS_URL).map_err(AppError::from)? else {
        return Ok(Vec::new());
    };

    let feed = calendar::fetch_feed(&url).await.map_err(AppError::from)?;
    calendar::events_in_window(&feed, start_ts, end_ts).map_err(AppError::from)
}

/// Creates a plan and places its blocks in one transaction, so a plan never exists with
/// no blocks or blocks with no plan.
#[tauri::command]
pub fn create_plan(
    state: State<'_, AppState>,
    plan: plans::Plan,
    day: String,
    blocks: Vec<ScheduleBlock>,
) -> CmdResult<i64> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| AppError::msg("database lock poisoned"))?;

    let tx = conn
        .transaction()
        .map_err(|error| AppError::msg(error.to_string()))?;

    let plan_id = plans::create(&tx, &plan).map_err(AppError::from)?;
    scheduler::append_day(&tx, &day, &blocks, Some(plan_id)).map_err(AppError::from)?;

    tx.commit().map_err(|error| AppError::msg(error.to_string()))?;
    Ok(plan_id)
}

#[tauri::command]
pub fn get_plans(state: State<'_, AppState>) -> CmdResult<Vec<plans::PlanProgress>> {
    with_db(&state, plans::all_progress)
}

#[tauri::command]
pub fn respond_checkin(
    state: State<'_, AppState>,
    response: plans::CheckinResponse,
) -> CmdResult<plans::PlanProgress> {
    with_db(&state, |conn| plans::respond(conn, &response))
}

#[tauri::command]
pub fn delete_plan(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_db(&state, |conn| plans::delete(conn, id))
}

#[tauri::command]
pub fn get_paused(state: State<'_, AppState>) -> bool {
    state.paused.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_paused(app: AppHandle, paused: bool) -> CmdResult<()> {
    crate::tray::apply_paused(&app, paused).map_err(AppError::from)
}

#[tauri::command]
pub fn check_macos_permissions() -> PermissionStatus {
    platform::permission_status()
}

#[tauri::command]
pub fn request_screen_recording_access() -> bool {
    platform::request_screen_recording()
}

/// Forces a buffer drain. The dashboard calls this before reading today's totals so a
/// freshly tracked minute is not missing from the chart.
#[tauri::command]
pub fn flush_samples(app: AppHandle) -> CmdResult<usize> {
    flush::flush_now(&app).map_err(AppError::from)
}

#[tauri::command]
pub fn get_database_path(app: AppHandle) -> CmdResult<String> {
    let path = crate::database_path(&app).map_err(AppError::from)?;
    Ok(path.to_string_lossy().to_string())
}

/// Used by the permissions banner to deep-link into the right System Settings pane.
#[tauri::command]
pub fn open_privacy_settings(app: AppHandle, pane: String) -> CmdResult<()> {
    let url = match pane.as_str() {
        "accessibility" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        "screen_recording" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        other => return Err(AppError::msg(format!("unknown settings pane `{other}`"))),
    };
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<&str>)
        .map_err(|error| AppError::msg(error.to_string()))
}
