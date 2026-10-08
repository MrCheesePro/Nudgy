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
        // `prev_end` is when the previous sitting of the same plan finishes, if any.
        // A zero lead fires at the start itself, so a block that began within the window
        // is still a candidate.
        "SELECT b.id, b.label, b.start_ts, b.reminder_lead_seconds,
                (SELECT MAX(p.end_ts) FROM schedule_blocks p
                  WHERE p.plan_id = b.plan_id AND p.id <> b.id AND p.end_ts <= b.start_ts)
           FROM schedule_blocks b
          WHERE b.start_ts > ?1 - ?3 AND b.start_ts <= ?2
          ORDER BY b.start_ts",
    )?;
    let candidates = stmt
        .query_map(rusqlite::params![now, horizon, WINDOW_SECONDS], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut ready = Vec::new();
    for (id, label, start_ts, lead, prev_end) in candidates {
        let lead = lead_for(lead.unwrap_or(default_lead), start_ts, prev_end);
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

/// A sitting that follows another of the same plan by less than the lead time is the end
/// of a break, not something coming up: warning ten minutes ahead of it lands in the
/// middle of the sitting before, which is the one thing a focus block must not do. It is
/// announced as it begins instead.
fn lead_for(lead: i64, start_ts: i64, prev_end: Option<i64>) -> i64 {
    match prev_end {
        Some(end) if start_ts - end < lead => 0,
        _ => lead.max(0),
    }
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

    // 09:20–09:45, five-minute break, next sitting 09:50: the ten-minute warning would
    // have gone off at 09:40, mid-session. It fires at 09:50 instead.
    #[test]
    fn a_sitting_after_a_short_break_is_announced_as_it_begins() {
        let start = 10_000;
        let lead = lead_for(600, start, Some(start - 300));
        assert_eq!(lead, 0);
        assert!(!should_fire(start - 600, start, lead));
        assert!(should_fire(start, start, lead));
        // A first sitting, or one after a long gap, keeps its warning.
        assert_eq!(lead_for(600, start, None), 600);
        assert_eq!(lead_for(600, start, Some(start - 3_600)), 600);
    }

    #[test]
    fn a_zero_lead_fires_as_the_block_begins() {
        let start = 10_000;
        assert!(!should_fire(start - 1, start, 0));
        assert!(should_fire(start, start, 0));
    }
}
