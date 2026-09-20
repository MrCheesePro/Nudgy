use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::queries;
use crate::error::{AppError, CmdResult};
use crate::integrations::canvas::CanvasClient;
use crate::integrations::travel::{self, TravelProvider};
use crate::integrations::{calendar, LmsProvider};
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

/* --------------------------------------------------------------- places */

#[tauri::command]
pub fn get_places(state: State<'_, AppState>) -> CmdResult<Vec<models::Place>> {
    with_db(&state, queries::load_places)
}

/// Adds a place. The first one added becomes the base, because a list of places with
/// nothing to measure from cannot answer any question the planner asks.
#[tauri::command]
pub fn add_place(state: State<'_, AppState>, name: String, address: String) -> CmdResult<i64> {
    let name = name.trim().to_string();
    let address = address.trim().to_string();
    if name.is_empty() {
        return Err(AppError::msg("a place needs a name"));
    }
    // An address is only needed to *look up* travel. Someone typing their own commute
    // in minutes never needs one, so requiring it here would make the maps key mandatory
    // by the back door.

    let now = chrono::Utc::now().timestamp();
    let mut conn = state
        .db
        .lock()
        .map_err(|_| AppError::msg("database lock poisoned"))?;

    let first = queries::load_places(&conn)?.is_empty();
    let id = queries::insert_place(&conn, &name, &address, now)
        .map_err(|_| AppError::msg(format!("a place called `{name}` already exists")))?;
    if first {
        queries::set_base_place(&mut conn, id)?;
    }
    Ok(id)
}

#[tauri::command]
pub fn update_place(
    state: State<'_, AppState>,
    id: i64,
    name: String,
    address: String,
) -> CmdResult<()> {
    let name = name.trim().to_string();
    let address = address.trim().to_string();
    if name.is_empty() {
        return Err(AppError::msg("a place needs a name"));
    }
    with_db(&state, |conn| queries::update_place(conn, id, &name, &address))
}

#[tauri::command]
pub fn delete_place(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    with_db(&state, |conn| queries::delete_place(conn, id))
}

#[tauri::command]
pub fn set_base_place(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| AppError::msg("database lock poisoned"))?;
    queries::set_base_place(&mut conn, id).map_err(AppError::from)
}

/// Every travel time already known, as `[originId, destinationId, mode, seconds]`.
/// The planner pads a whole week from this in one call rather than asking per pair.
#[tauri::command]
pub fn get_travel_times(state: State<'_, AppState>) -> CmdResult<Vec<(i64, i64, String, i64)>> {
    with_db(&state, queries::all_travel)
}

/// The name Nudgy gives the place it detected, so re-detecting updates it in place
/// rather than piling up a list of stale doorsteps.
const HERE: &str = "Where I am";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedLocation {
    pub place_id: i64,
    pub address: String,
    /// True when the address is really a lat,lng pair — reverse geocoding could not name
    /// it, which routes fine but reads badly.
    pub coarse: bool,
}

/// Works out where you are and makes that the base.
///
/// Three sources, best first, and the order matters more than any of them individually:
///
/// 1. **The operating system.** CoreLocation on macOS, `Windows.Devices.Geolocation` on
///    Windows. A permission prompt, then precise coordinates, with no key, no network and
///    no per-call cost. Locating is a device capability; paying a routing service to
///    answer it was the wrong instinct.
/// 2. **The browser**, when the caller managed to get a fix out of the webview.
/// 3. **The network**, inferred by Google. Needs a Google key, so it is genuinely the
///    last resort rather than a fallback the default provider can even reach.
///
/// Naming the coordinates is a separate, failable step: a lat/lng routes perfectly well
/// and only reads badly, so losing the name never loses the location.
#[tauri::command]
pub async fn detect_current_location(
    app: AppHandle,
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> CmdResult<DetectedLocation> {
    let mut source = "os";

    // CoreLocation polls for a fix for up to eight seconds. Parking a Tokio worker for
    // that long would stall every other command, so it runs on a blocking thread.
    let os_fix = tauri::async_runtime::spawn_blocking(crate::location::current)
        .await
        .map_err(|error| AppError::msg(format!("location task failed: {error}")))?;

    let (lat, lng) = match os_fix {
        Ok(fix) => (fix.latitude, fix.longitude),
        Err(os_error) => match (latitude, longitude) {
            (Some(lat), Some(lng)) => {
                source = "browser";
                (lat, lng)
            }
            _ => {
                log::info!("no OS location ({os_error}); falling back to a network lookup");
                source = "network";
                // Only Google offers this, and only with a key. When neither is
                // available the OS error is the useful one to show — it is the thing
                // the user can actually act on.
                let key = maps_key().map_err(|_| AppError::msg(os_error.to_string()))?;
                let located = travel::geolocate(&key)
                    .await
                    .map_err(|_| AppError::msg(os_error.to_string()))?;
                (located.latitude, located.longitude)
            }
        },
    };

    let named = match name_coordinates(&app, lat, lng).await {
        Ok(address) => Some(address),
        Err(error) => {
            log::warn!("could not name the detected location: {error}");
            None
        }
    };
    let coarse = named.is_none() || source == "network";
    let address = named.unwrap_or_else(|| format!("{lat:.5},{lng:.5}"));

    let now = chrono::Utc::now().timestamp();
    let state = app.state::<AppState>();
    let mut conn = state
        .db
        .lock()
        .map_err(|_| AppError::msg("database lock poisoned"))?;

    // Moving house should not orphan every travel time, and it should not keep the old
    // ones either — `update_place` drops the cache when the address actually changes.
    let existing = queries::load_places(&conn)?
        .into_iter()
        .find(|place| place.name == HERE);

    let place_id = match existing {
        Some(place) => {
            queries::update_place(&conn, place.id, HERE, &address)?;
            place.id
        }
        None => queries::insert_place(&conn, HERE, &address, now)?,
    };
    queries::set_base_place(&mut conn, place_id)?;

    Ok(DetectedLocation {
        place_id,
        address,
        coarse,
    })
}

/// Coordinates to a human address, through whichever provider is configured.
async fn name_coordinates(app: &AppHandle, latitude: f64, longitude: f64) -> anyhow::Result<String> {
    let (name, key) = {
        let state = app.state::<AppState>();
        let name = provider_name(&state).map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let key = maps_key().map_err(|error| anyhow::anyhow!(error.to_string()))?;
        (name, key)
    };

    if name == PROVIDER_GOOGLE {
        travel::reverse_geocode(&key, latitude, longitude).await
    } else {
        travel::OpenRouteService::new(key)
            .reverse(latitude, longitude)
            .await
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressEstimate {
    pub place_id: i64,
    pub name: String,
    pub address: String,
    /// Seconds from the base. Null when there is no base yet, or the route failed.
    pub seconds: Option<i64>,
    /// Why there is no number, in a sentence the UI can show as-is.
    pub note: Option<String>,
}

/// Takes an address someone typed, turns it into a place, and says how far away it is.
///
/// This is what makes the places list a record rather than a form: you type where you are
/// going, and the list fills itself in. A repeated address reuses its place instead of
/// creating a second one, so the travel already looked up still applies.
#[tauri::command]
pub async fn estimate_address(
    app: AppHandle,
    address: String,
    name: Option<String>,
    mode: Option<String>,
) -> CmdResult<AddressEstimate> {
    let address = address.trim().to_string();
    if address.is_empty() {
        return Err(AppError::msg("type an address first"));
    }
    let mode = mode.unwrap_or_else(|| models::TRAVEL_MODE_DEFAULT.to_string());
    if !models::is_valid_travel_mode(&mode) {
        return Err(AppError::msg(format!("unknown travel mode `{mode}`")));
    }
    // A name nobody chose is the first line of the address — "400 College Ave" reads far
    // better in a dropdown than the whole postal string.
    let name = name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            address
                .split(',')
                .next()
                .unwrap_or(&address)
                .trim()
                .to_string()
        });

    let now = chrono::Utc::now().timestamp();

    let (place_id, base) = {
        let state = app.state::<AppState>();
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::msg("database lock poisoned"))?;

        let places = queries::load_places(&conn)?;
        let base = places.iter().find(|place| place.is_base).cloned();

        // Same address typed twice is the same place, whatever it got called.
        let existing = places
            .iter()
            .find(|place| place.address.eq_ignore_ascii_case(&address))
            .cloned();

        let place_id = match existing {
            Some(place) => place.id,
            None => {
                // A name collision is not worth failing over: disambiguate and move on.
                let unique = if places.iter().any(|place| place.name == name) {
                    format!("{name} ({})", places.len() + 1)
                } else {
                    name.clone()
                };
                queries::insert_place(&conn, &unique, &address, now)?
            }
        };
        (place_id, base)
    };

    let Some(base) = base else {
        return Ok(AddressEstimate {
            place_id,
            name,
            address,
            seconds: None,
            note: Some("Saved. Set where you are first and Nudgy can time the trip.".into()),
        });
    };

    if base.id == place_id {
        return Ok(AddressEstimate {
            place_id,
            name,
            address,
            seconds: Some(0),
            note: Some("That is where you already are.".into()),
        });
    }

    let cached = {
        let state = app.state::<AppState>();
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::msg("database lock poisoned"))?;
        queries::cached_travel(&conn, base.id, place_id, &mode)?
    };
    if let Some(seconds) = cached {
        return Ok(AddressEstimate {
            place_id,
            name,
            address,
            seconds: Some(seconds),
            note: None,
        });
    }

    let name = {
        let state = app.state::<AppState>();
        provider_name(&state)?
    };
    let provider = build_provider(&name, maps_key()?);
    match provider
        .travel_seconds(&base.address, &address, &mode)
        .await
    {
        Ok(seconds) => {
            let state = app.state::<AppState>();
            let conn = state
                .db
                .lock()
                .map_err(|_| AppError::msg("database lock poisoned"))?;
            queries::store_travel(&conn, base.id, place_id, &mode, seconds, now)?;
            Ok(AddressEstimate {
                place_id,
                name,
                address,
                seconds: Some(seconds),
                note: None,
            })
        }
        // The place is saved either way. A route that could not be found is worth saying
        // out loud, not worth losing the address over.
        Err(error) => Ok(AddressEstimate {
            place_id,
            name,
            address,
            seconds: None,
            note: Some(format!("Saved, but the trip could not be timed: {error}")),
        }),
    }
}

pub const SETTING_TRAVEL_PROVIDER: &str = "travel_provider";
pub const PROVIDER_ORS: &str = "openrouteservice";
pub const PROVIDER_GOOGLE: &str = "google";

fn maps_key() -> CmdResult<String> {
    secrets::get(secrets::MAPS_API_KEY)
        .map_err(AppError::from)?
        .ok_or_else(|| {
            AppError::msg("add a routing API key in Settings — timing a trip needs one")
        })
}

/// Which routing service to ask. OpenRouteService is the default because it costs an
/// email address rather than a credit card; Google is there for anyone who already has
/// a key and wants traffic-aware times.
fn provider_name(state: &State<'_, AppState>) -> CmdResult<String> {
    let settings: std::collections::HashMap<String, String> =
        with_db(state, queries::all_settings)?.into_iter().collect();
    Ok(settings
        .get(SETTING_TRAVEL_PROVIDER)
        .cloned()
        .unwrap_or_else(|| PROVIDER_ORS.to_string()))
}

fn build_provider(name: &str, key: String) -> Box<dyn TravelProvider> {
    match name {
        PROVIDER_GOOGLE => Box::new(travel::GoogleDistanceMatrix::new(key)),
        _ => Box::new(travel::OpenRouteService::new(key)),
    }
}

/// Records a travel time the user typed, in minutes.
///
/// This is why a maps key is optional. Someone who knows their own commute can say so,
/// and the planner cannot tell the difference — the cache is the interface, and a looked
/// up number and a typed one land in the same row.
#[tauri::command]
pub fn set_travel_time(
    state: State<'_, AppState>,
    origin_id: i64,
    destination_id: i64,
    minutes: i64,
    mode: Option<String>,
) -> CmdResult<()> {
    let mode = mode.unwrap_or_else(|| models::TRAVEL_MODE_DEFAULT.to_string());
    if !models::is_valid_travel_mode(&mode) {
        return Err(AppError::msg(format!("unknown travel mode `{mode}`")));
    }
    if origin_id == destination_id {
        return Err(AppError::msg("a place is no distance from itself"));
    }
    // Same guard the provider's answers go through: a typo is as capable of eating the
    // day as a misread address.
    let seconds = travel::validate_seconds(minutes * 60).map_err(AppError::from)?;

    with_db(&state, |conn| {
        queries::store_travel(
            conn,
            origin_id,
            destination_id,
            &mode,
            seconds,
            chrono::Utc::now().timestamp(),
        )
    })
}

/// Looks up one leg, cache first.
///
/// The cache is the point, not an optimisation: addresses do not move, so a pair asked
/// once is answered forever, offline included. `refresh` is how a changed commute or a
/// different time of day gets a new number.
#[tauri::command]
pub async fn lookup_travel(
    app: AppHandle,
    origin_id: i64,
    destination_id: i64,
    mode: Option<String>,
    refresh: Option<bool>,
) -> CmdResult<models::TravelEstimate> {
    let mode = mode.unwrap_or_else(|| models::TRAVEL_MODE_DEFAULT.to_string());
    if !models::is_valid_travel_mode(&mode) {
        return Err(AppError::msg(format!("unknown travel mode `{mode}`")));
    }
    // Nothing to travel: the same room is zero minutes away, and asking a provider about
    // it would burn quota to be told so.
    if origin_id == destination_id {
        return Ok(models::TravelEstimate {
            origin_id,
            destination_id,
            seconds: 0,
            mode,
            cached: true,
        });
    }

    let (cached, origin, destination) = {
        let state = app.state::<AppState>();
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::msg("database lock poisoned"))?;
        (
            queries::cached_travel(&conn, origin_id, destination_id, &mode)?,
            queries::load_place(&conn, origin_id)?,
            queries::load_place(&conn, destination_id)?,
        )
    };

    if let Some(seconds) = cached {
        if refresh != Some(true) {
            return Ok(models::TravelEstimate {
                origin_id,
                destination_id,
                seconds,
                mode,
                cached: true,
            });
        }
    }

    let origin = origin.ok_or_else(|| AppError::msg("no such origin place"))?;
    let destination = destination.ok_or_else(|| AppError::msg("no such destination place"))?;

    let name = {
        let state = app.state::<AppState>();
        provider_name(&state)?
    };
    let provider = build_provider(&name, maps_key()?);
    let seconds = provider
        .travel_seconds(&origin.address, &destination.address, &mode)
        .await
        .map_err(AppError::from)?;

    // Names the place, never the address: a log line is the one place a home address
    // would sit in plain text long after the request that needed it.
    log::info!(
        "{}: {} → {} by {mode} is {}m",
        provider.provider_id(),
        origin.name,
        destination.name,
        seconds / 60
    );

    {
        let state = app.state::<AppState>();
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::msg("database lock poisoned"))?;
        queries::store_travel(
            &conn,
            origin_id,
            destination_id,
            &mode,
            seconds,
            chrono::Utc::now().timestamp(),
        )?;
    }

    Ok(models::TravelEstimate {
        origin_id,
        destination_id,
        seconds,
        mode,
        cached: false,
    })
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
