use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::queries;
use crate::error::{AppError, CmdResult};
use crate::integrations::canvas::CanvasClient;
use crate::integrations::{calendar, lms, LmsProvider};
use crate::categorize;
use crate::models::{
    self, AppRule, AppTotal, LiveStatus, LmsTask, PermissionStatus, RedactionRule, SyncResult,
    UnmappedProcess, UsageBreakdown,
};
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

#[tauri::command]
pub fn list_unmapped_processes(
    state: State<'_, AppState>,
    since_ts: Option<i64>,
) -> CmdResult<Vec<UnmappedProcess>> {
    // Two days, not a week. This list is a to-do — something opened once last Tuesday is
    // not worth a decision, and a long tail of them buries what is actually running.
    let since = since_ts.unwrap_or_else(|| chrono::Utc::now().timestamp() - UNMAPPED_LOOKBACK);
    with_db(&state, |conn| queries::unmapped_processes(conn, since))
}

const UNMAPPED_LOOKBACK: i64 = 48 * 60 * 60;

/// Which LMS the calendar feed belongs to. Drives the label in Settings and the
/// `provider` stored on every task.
pub const SETTING_LMS_PROVIDER: &str = "lms_provider";

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
    ensure_category(&state, &category)?;
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
        // A rule someone wrote by hand outranks every seeded one: they know something the
        // seed file does not.
        priority: models::PRIORITY_USER,
    };

    with_db(&state, |conn| {
        queries::upsert_app_rule(conn, &rule, true)?;
        // Mapping an app is a correction, and a correction that only applies to the future
        // leaves every chart still showing the wrong answer for time already spent.
        queries::recategorize_samples(conn, &rule, &rule.category)
    })?;
    state.reload_registry().map_err(AppError::from)
}

/// Moves an existing rule to another category, and moves the time it already recorded with
/// it. This is the edit path for the registry tab, where `register_app` is the add path.
#[tauri::command]
pub fn set_app_category(state: State<'_, AppState>, id: i64, category: String) -> CmdResult<u64> {
    ensure_category(&state, &category)?;
    let moved = with_db(&state, |conn| {
        let Some(rule) = queries::load_app_rule(conn, id)? else {
            return Ok(0);
        };
        queries::set_app_rule_category(conn, id, &category)?;
        queries::recategorize_samples(conn, &rule, &category)
    })?;
    state.reload_registry()?;
    Ok(moved as u64)
}

#[tauri::command]
pub fn delete_app_rule(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_db(&state, |conn| queries::delete_app_rule(conn, id))?;
    state.reload_registry().map_err(AppError::from)
}

/// Rejects a category that is not in the table. The vocabulary is data now, so this asks
/// the loaded registry rather than a constant — a category added a second ago is valid.
fn ensure_category(state: &State<'_, AppState>, category: &str) -> CmdResult<()> {
    let known = {
        let registry = state
            .registry
            .read()
            .map_err(|_| AppError::msg("registry lock poisoned"))?;
        registry.has_category(category)
    };
    if known {
        Ok(())
    } else {
        Err(AppError::msg(format!("unknown category `{category}`")))
    }
}

#[tauri::command]
pub fn get_categories(state: State<'_, AppState>) -> CmdResult<Vec<models::Category>> {
    with_db(&state, queries::load_categories)
}

#[tauri::command]
pub fn add_category(state: State<'_, AppState>, name: String, color: String) -> CmdResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::msg("a category needs a name"));
    }
    if name.chars().count() > 24 {
        return Err(AppError::msg("keep a category name under 24 characters"));
    }
    let color = color.trim().to_string();
    if !is_hex_color(&color) {
        return Err(AppError::msg("colour must be a hex value like #4fa88c"));
    }

    with_db(&state, |conn| queries::insert_category(conn, &name, &color))
        .map_err(|_| AppError::msg(format!("a category called `{name}` already exists")))?;
    state.reload_registry().map_err(AppError::from)
}

/// Deleting a category keeps everything that was in it — rules, recorded time and any
/// scheduled block fall back to `Neutral`. The time was really spent; only its label goes.
#[tauri::command]
pub fn delete_category(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| AppError::msg("database lock poisoned"))?;

    let Some(category) = queries::load_category(&conn, id)? else {
        return Err(AppError::msg("no such category"));
    };
    if category.is_builtin {
        return Err(AppError::msg(format!(
            "`{}` is built in and cannot be removed",
            category.name
        )));
    }
    queries::delete_category(&mut conn, id, &category.name)?;
    drop(conn);

    state.reload_registry().map_err(AppError::from)
}

/// What `delete_category` would take with it, so the confirmation can name it.
#[tauri::command]
pub fn category_usage(state: State<'_, AppState>, name: String) -> CmdResult<(i64, i64)> {
    with_db(&state, |conn| queries::category_usage(conn, &name))
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|c| c.is_ascii_hexdigit())
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

/// Audio the webview will actually play, and nothing that is only pretending to be.
const SOUND_EXTENSIONS: [&str; 8] = ["mp3", "m4a", "aac", "wav", "aiff", "caf", "mp4", "mov"];

/// A notification sound is seconds long. Ten megabytes is far more than that needs and
/// far less than a file somebody picked by accident.
const MAX_SOUND_BYTES: u64 = 10 * 1024 * 1024;

/// Copies a picked audio file into the app's own data directory and returns its new path.
///
/// Copied rather than referenced, because the file somebody picks lives in Downloads and
/// Downloads gets emptied. A sound that stops working a week later, silently, is worse
/// than one that was never set — the notification still arrives, so there is nothing to
/// notice until you wonder why the app went quiet.
///
/// One file at a time: importing replaces whatever was there, so the directory cannot
/// accumulate sounds nothing references.
#[tauri::command]
pub fn import_sound(app: AppHandle, source: String) -> CmdResult<String> {
    let path = std::path::PathBuf::from(&source);

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !SOUND_EXTENSIONS.contains(&extension.as_str()) {
        return Err(AppError::msg(format!(
            "{extension} is not an audio format Nudgy can play"
        )));
    }

    let size = std::fs::metadata(&path)
        .map_err(|cause| AppError::msg(format!("could not read that file: {cause}")))?
        .len();
    if size > MAX_SOUND_BYTES {
        return Err(AppError::msg("that file is larger than 10 MB"));
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|cause| AppError::msg(format!("no application data directory: {cause}")))?
        .join("sounds");
    std::fs::create_dir_all(&dir).map_err(|cause| AppError::msg(cause.to_string()))?;

    // A fixed name, so the previous import is overwritten rather than orphaned. The
    // extension varies because the webview decides what to decode from it.
    for old in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        if old.file_name().to_string_lossy().starts_with("chime.") {
            let _ = std::fs::remove_file(old.path());
        }
    }

    let destination = dir.join(format!("chime.{extension}"));
    std::fs::copy(&path, &destination)
        .map_err(|cause| AppError::msg(format!("could not copy it: {cause}")))?;

    Ok(destination.to_string_lossy().to_string())
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
pub async fn sync_lms(app: AppHandle) -> CmdResult<SyncResult> {
    let (provider_name, base_url) = {
        let state = app.state::<AppState>();
        let settings: std::collections::HashMap<String, String> =
            with_db(&state, queries::all_settings)?.into_iter().collect();
        (
            settings
                .get(SETTING_LMS_PROVIDER)
                .cloned()
                .unwrap_or_else(|| "canvas".to_string()),
            settings.get(SETTING_CANVAS_BASE_URL).cloned(),
        )
    };

    // The token path is the upgrade, not the default: it is the only one that knows what
    // has been handed in, so it wins whenever it is available. Canvas only — the others
    // have no REST client here.
    let token = secrets::get(secrets::CANVAS_TOKEN).map_err(AppError::from)?;

    // The feed is the list; the token is what knows about it.
    //
    // These answer different questions and neither contains the other. The feed is
    // everything on the calendar — every assignment, dated or not, plus events you added
    // yourself. The API knows what has been handed in, and only ever returned a subset:
    // one assignment where the feed had five. Preferring the API "unless it is empty"
    // therefore lost four of them, because one is not empty.
    //
    // So both are read and merged. The feed supplies the list, the API supplies
    // completion for anything it also knows about, and either alone still works.
    let feed_tasks = match secrets::get(secrets::LMS_FEED_URL).map_err(AppError::from)? {
        Some(url) => {
            log::info!("reading the {provider_name} calendar feed");
            let feed = calendar::fetch_feed(&url).await.map_err(AppError::from)?;
            lms::feed_tasks(&feed, &provider_name).map_err(AppError::from)?
        }
        None => Vec::new(),
    };

    let api_tasks = match (provider_name.as_str(), base_url.as_deref(), token.as_deref()) {
        ("canvas", Some(url), Some(token)) if !url.trim().is_empty() => {
            let client = CanvasClient::new(url, token).map_err(AppError::from)?;
            log::info!("reading the {} API", client.provider_id());
            client.fetch_tasks().await.map_err(AppError::from)?
        }
        _ => Vec::new(),
    };

    if feed_tasks.is_empty() && api_tasks.is_empty() {
        return Err(AppError::msg(
            "No coursework source yet. Add your calendar feed URL in Settings.",
        ));
    }

    // Keyed on `external_id`, which both sources spell the same way since `canonical_id`.
    let mut tasks = feed_tasks;
    for from_api in api_tasks {
        match tasks
            .iter_mut()
            .find(|task| task.external_id == from_api.external_id)
        {
            // The API's answer wins where they overlap: it is the one with a course code
            // it did not have to read out of a title, and the only one that knows whether
            // the work is done.
            Some(existing) => *existing = from_api,
            None => tasks.push(from_api),
        }
    }

    let fetched = tasks.len();
    log::info!("{provider_name} sync fetched {fetched} tasks");

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

/// Proposes a category for an app nobody has classified yet.
///
/// A keyword table over the process name, the bundle id's last segment and the display
/// name. Offline, instant and free — and honest about not knowing: `None` is a real
/// answer, shown as "no idea" rather than filled in with something plausible.
#[tauri::command]
pub fn suggest_category(
    process_name: String,
    app_name: Option<String>,
) -> CmdResult<CategorySuggestion> {
    Ok(match categorize::guess(&process_name, app_name.as_deref()) {
        Some(category) => CategorySuggestion {
            category: Some(category),
            source: categorize::SOURCE_HEURISTIC.to_string(),
        },
        None => CategorySuggestion {
            category: None,
            source: categorize::SOURCE_NONE.to_string(),
        },
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorySuggestion {
    /// `None` when neither the table nor the model could tell — an honest answer, not an
    /// error, and the UI shows it as "no guess" rather than picking something.
    pub category: Option<String>,
    /// `heuristic`, `llm` or `none`, so the UI can say where the guess came from.
    pub source: String,
}

/// The LMSes whose calendar feeds are known to work, for the Settings dropdown.
#[tauri::command]
pub fn get_lms_providers() -> Vec<&'static str> {
    lms::PROVIDERS.to_vec()
}

/// Rejects an LMS the feed reader does not claim to handle, so a typo in the settings
/// table cannot quietly become the `provider` stamped on every task.
#[tauri::command]
pub fn set_lms_provider(state: State<'_, AppState>, provider: String) -> CmdResult<()> {
    if !lms::is_valid_provider(&provider) {
        return Err(AppError::msg(format!("unknown LMS `{provider}`")));
    }
    with_db(&state, |conn| {
        queries::set_setting(conn, SETTING_LMS_PROVIDER, &provider)
    })
}

/* -------------------------------------------------------------- progress */

/// Every category's total, per local day, over a range. The Progress chart is built
/// entirely from this — no new tracking, just a window wider than today.
#[tauri::command]
pub fn get_daily_totals(
    state: State<'_, AppState>,
    start_ts: i64,
    end_ts: i64,
) -> CmdResult<Vec<models::DailyTotal>> {
    with_db(&state, |conn| queries::daily_totals(conn, start_ts, end_ts))
}

#[tauri::command]
pub fn get_category_targets(state: State<'_, AppState>) -> CmdResult<Vec<models::CategoryTarget>> {
    with_db(&state, queries::load_targets)
}

#[tauri::command]
pub fn set_category_target(
    state: State<'_, AppState>,
    category: String,
    direction: String,
    seconds_per_day: i64,
) -> CmdResult<()> {
    ensure_category(&state, &category)?;
    if !models::is_valid_target_direction(&direction) {
        return Err(AppError::msg(format!("unknown direction `{direction}`")));
    }
    // A floor of zero is met by doing nothing and a ceiling of zero can never be kept, so
    // neither is a target anybody meant to set.
    if seconds_per_day <= 0 {
        return Err(AppError::msg("a target needs to be more than zero"));
    }
    if seconds_per_day > 24 * 60 * 60 {
        return Err(AppError::msg("a day only has 24 hours"));
    }

    let target = models::CategoryTarget {
        category,
        direction,
        seconds_per_day,
        created_at: 0,
    };
    with_db(&state, |conn| {
        queries::upsert_target(conn, &target, chrono::Utc::now().timestamp())
    })
}

#[tauri::command]
pub fn clear_category_target(state: State<'_, AppState>, category: String) -> CmdResult<()> {
    with_db(&state, |conn| queries::delete_target(conn, &category))?;
    Ok(())
}

/// Deletes every recorded sample and nothing else.
///
/// The in-memory buffer is drained first: without that, the next 45-second flush would
/// write pre-wipe samples straight back into the table that was just emptied.
#[tauri::command]
pub fn clear_activity_data(app: AppHandle, state: State<'_, AppState>) -> CmdResult<usize> {
    {
        let mut buffer = state
            .buffer
            .lock()
            .map_err(|_| AppError::msg("sample buffer lock poisoned"))?;
        buffer.clear();
    }
    let deleted = with_db(&state, queries::clear_activity_samples)?;
    // Every hook listens for this, so the charts empty together instead of one at a time.
    let _ = app.emit("nudgy://flushed", deleted);
    Ok(deleted)
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

/// Fetches the calendar feed and returns the events overlapping a window. Called by the
/// planner before it works out where the free time is.
#[tauri::command]
pub async fn get_calendar_events(
    start_ts: i64,
    end_ts: i64,
) -> CmdResult<Vec<calendar::CalendarEvent>> {
    // A dedicated calendar feed wins. Without one, the LMS feed is a calendar — it is
    // the same file, and a personal event on it ("gaming, 5:45") is a commitment whether
    // or not the URL was pasted into the box labelled "calendar".
    let url = match secrets::get(secrets::CALENDAR_ICS_URL).map_err(AppError::from)? {
        Some(url) => url,
        None => match secrets::get(secrets::LMS_FEED_URL).map_err(AppError::from)? {
            Some(url) => url,
            None => return Ok(Vec::new()),
        },
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
    with_db(&state, |conn| {
        // The blocks are about to go, so their reminder keys should too — otherwise
        // `settings` accretes a row for every block ever scheduled.
        let block_ids: Vec<i64> = conn
            .prepare("SELECT id FROM schedule_blocks WHERE plan_id = ?1")?
            .query_map([id], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        crate::reminder::forget_blocks(conn, &block_ids)?;
        plans::delete(conn, id)
    })
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
