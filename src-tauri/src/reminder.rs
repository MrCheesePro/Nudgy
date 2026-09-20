//! "You have something starting soon."
//!
//! The one notification that has to arrive *before* the thing it is about. A check-in
//! asks how it went and a ceiling says you have gone past — both are about now. This is
//! the only one whose whole value is being early.
//!
//! Fires once per block, recorded in `settings` as `reminded:<block_id>` so a restart
//! does not announce the same block twice. Re-planning is safe without any extra work:
//! a confirmed edit drops the plan's blocks and lays down new ones, so the replacement
//! has a new id and is reminded again rather than staying silenced under the old key.

use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db::queries;
use crate::state::AppState;

const POLL_SECONDS: u64 = 60;

/// How late a reminder may still be worth sending.
///
/// The tick will not land on the exact second, and a laptop asleep across the moment
/// would skip it entirely if this were an equality check. A window gives the tick
/// somewhere to land while staying far short of the block itself — a reminder slightly
/// late is useful, one that never arrives is the failure worth designing against.
const WINDOW_SECONDS: i64 = 90;

/// Used when a block has no opinion of its own.
pub const DEFAULT_LEAD_SECONDS: i64 = 10 * 60;

pub const SETTING_ENABLED: &str = "notifications_enabled";
pub const SETTING_LEAD: &str = "reminder_lead_seconds";

fn reminded_key(block_id: i64) -> String {
    format!("reminded:{block_id}")
}

/// Whether the user wants to hear from Nudgy at all. Absent means yes — notifications
/// are on until switched off, and a missing row must not silence the app.
pub fn enabled(conn: &rusqlite::Connection) -> bool {
    queries::all_settings(conn)
        .map(|settings| {
            settings
                .into_iter()
                .find(|(key, _)| key == SETTING_ENABLED)
                .map(|(_, value)| value != "0")
                .unwrap_or(true)
        })
        .unwrap_or(true)
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(POLL_SECONDS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // the first tick is immediate; skip it

        loop {
            ticker.tick().await;
            match due(&app) {
                Ok(blocks) => {
                    for (label, starts_in) in blocks {
                        announce(&app, &label, starts_in);
                    }
                }
                Err(error) => log::error!("reminder poll failed: {error}"),
            }
        }
    });
}

/// Blocks whose lead time has just come up. Marks them in the same pass: a notification
/// that fails to display is still one the user does not want twice.
fn due(app: &AppHandle) -> anyhow::Result<Vec<(String, i64)>> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .map_err(|_| anyhow::anyhow!("database lock poisoned"))?;

    if !enabled(&conn) {
        return Ok(Vec::new());
    }

    let settings: std::collections::HashMap<String, String> =
        queries::all_settings(&conn)?.into_iter().collect();
    let default_lead = settings
        .get(SETTING_LEAD)
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(DEFAULT_LEAD_SECONDS);

    let now = chrono::Utc::now().timestamp();
    // Only blocks starting soon are candidates, which keeps the scan small however long
    // the schedule is.
    let horizon = now + default_lead.max(24 * 60 * 60) + WINDOW_SECONDS;

    let mut stmt = conn.prepare_cached(
        "SELECT id, label, start_ts, reminder_lead_seconds
           FROM schedule_blocks
          WHERE start_ts > ?1 AND start_ts <= ?2
          ORDER BY start_ts",
    )?;
    let candidates = stmt
        .query_map(rusqlite::params![now, horizon], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut ready = Vec::new();
    for (id, label, start_ts, lead) in candidates {
        let lead = lead.unwrap_or(default_lead).max(0);
        let fire_at = start_ts - lead;

        // The window, not an instant.
        if !(fire_at <= now && now < fire_at + WINDOW_SECONDS) {
            continue;
        }
        if settings.contains_key(&reminded_key(id)) {
            continue;
        }

        queries::set_setting(&conn, &reminded_key(id), &now.to_string())?;
        ready.push((label, start_ts - now));
    }
    Ok(ready)
}

fn announce(app: &AppHandle, label: &str, starts_in: i64) {
    let minutes = (starts_in + 59) / 60;
    let body = if minutes <= 1 {
        format!("{label} starts now.")
    } else {
        format!("{label} starts in {minutes} minutes.")
    };

    if let Err(error) = app
        .notification()
        .builder()
        .title("Coming up")
        .body(&body)
        .show()
    {
        log::warn!("could not show reminder: {error}");
    }

    // The window may well be open, and it plays the chosen sound — the OS notification
    // carries the words, the app carries the noise.
    let _ = app.emit("nudgy://reminder", &body);
}

/// Forgets the keys for blocks that no longer exist, so `settings` does not accrete a row
/// per block ever scheduled.
pub fn forget_blocks(conn: &rusqlite::Connection, block_ids: &[i64]) -> anyhow::Result<()> {
    for id in block_ids {
        queries::delete_setting(conn, &reminded_key(*id))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rule the worker applies, isolated from the database so it can be checked at
    /// the boundaries — which is where an equality check would have failed.
    fn should_fire(now: i64, start_ts: i64, lead: i64) -> bool {
        let fire_at = start_ts - lead;
        fire_at <= now && now < fire_at + WINDOW_SECONDS
    }

    #[test]
    fn fires_once_the_lead_time_is_reached() {
        let start = 10_000;
        assert!(should_fire(start - 600, start, 600));
    }

    // A one-minute tick never lands on the exact second, so the window is the whole point.
    #[test]
    fn fires_for_a_tick_that_lands_late() {
        let start = 10_000;
        assert!(should_fire(start - 600 + 45, start, 600));
        assert!(should_fire(start - 600 + 89, start, 600));
    }

    #[test]
    fn does_not_fire_before_the_lead_time() {
        let start = 10_000;
        assert!(!should_fire(start - 601, start, 600));
    }

    // Past the window the moment has gone; a reminder ten minutes late for a ten-minute
    // warning is just noise about something already underway.
    #[test]
    fn stops_firing_once_the_window_has_passed() {
        let start = 10_000;
        assert!(!should_fire(start - 600 + WINDOW_SECONDS, start, 600));
        assert!(!should_fire(start - 60, start, 600));
    }

    #[test]
    fn a_zero_lead_fires_as_the_block_begins() {
        let start = 10_000;
        assert!(!should_fire(start - 1, start, 0));
        assert!(should_fire(start, start, 0));
    }
}
