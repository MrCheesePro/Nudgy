//! The ceiling nudge.
//!
//! A floor needs no interruption — you find out you missed it at the end of the day, and
//! being told at 3pm that you are behind on Development helps nobody. A *ceiling* is the
//! opposite: the whole value is being told while it is still happening, because the point
//! is to stop.
//!
//! Once per category per day. A nudge that repeats becomes noise, and noise gets muted,
//! which costs the one nudge that mattered. The day it last fired is written to `settings`
//! rather than held in memory so a restart does not re-announce a ceiling already passed.

use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db::queries;
use crate::models::{CategoryTarget, TARGET_AT_MOST};
use crate::state::AppState;

/// Five minutes. A ceiling is hours wide, so a tighter poll would burn wakeups to learn
/// nothing — and the sample buffer only reaches SQLite every 45 seconds anyway.
const POLL_SECONDS: u64 = 5 * 60;

/// Settings key holding the local day a category was last nudged about.
fn nudged_key(category: &str) -> String {
    format!("nudged:{category}")
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(POLL_SECONDS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // the first tick is immediate; skip it

        loop {
            ticker.tick().await;
            match passed_ceilings(&app) {
                Ok(passed) => {
                    for (target, seconds) in passed {
                        announce(&app, &target, seconds);
                    }
                }
                Err(error) => log::error!("ceiling poll failed: {error}"),
            }
        }
    });
}

/// Ceilings passed today that have not already been announced today.
///
/// Marks them as announced in the same pass: a notification that fails to display is still
/// a notification the user does not want twice, and re-announcing on the next tick would
/// be worse than missing one.
fn passed_ceilings(app: &AppHandle) -> anyhow::Result<Vec<(CategoryTarget, i64)>> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .map_err(|_| anyhow::anyhow!("database lock poisoned"))?;

    let targets = queries::load_targets(&conn)?;
    if targets.is_empty() {
        return Ok(Vec::new());
    }

    // The same local day the charts use, resolved by SQLite against this machine's zone.
    let today: String = conn.query_row(
        "SELECT date('now', 'localtime')",
        [],
        |row| row.get(0),
    )?;
    let settings: std::collections::HashMap<String, String> =
        queries::all_settings(&conn)?.into_iter().collect();

    let totals: std::collections::HashMap<String, i64> = conn
        .prepare_cached(
            "SELECT category, SUM(duration_seconds)
               FROM activity_samples
              WHERE date(ts, 'unixepoch', 'localtime') = ?1
              GROUP BY category",
        )?
        .query_map([&today], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;

    let mut passed = Vec::new();
    for target in targets {
        if target.direction != TARGET_AT_MOST {
            continue;
        }
        let seconds = totals.get(&target.category).copied().unwrap_or(0);
        if seconds < target.seconds_per_day {
            continue;
        }
        if settings.get(&nudged_key(&target.category)) == Some(&today) {
            continue;
        }
        queries::set_setting(&conn, &nudged_key(&target.category), &today)?;
        passed.push((target, seconds));
    }
    Ok(passed)
}

fn announce(app: &AppHandle, target: &CategoryTarget, seconds: i64) {
    let over = seconds.saturating_sub(target.seconds_per_day);
    let body = if over < 60 {
        format!("You have hit your {} limit for today.", target.category)
    } else {
        format!(
            "{} of {} today — {} past your limit.",
            humanize(seconds),
            target.category,
            humanize(over)
        )
    };

    if let Err(error) = app
        .notification()
        .builder()
        .title("Nudgy")
        .body(&body)
        .show()
    {
        log::warn!("could not show ceiling notification: {error}");
    }

    // The dashboard may well be open; refreshing it is how the number on screen agrees
    // with the notification that just appeared.
    let _ = app.emit("nudgy://target-passed", &target.category);
}

/// `2h 10m`, `45m`. Mirrors `formatDuration` in the frontend so a notification and the
/// card behind it read the same way.
fn humanize(seconds: i64) -> String {
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest == 0 {
        format!("{hours}h")
    } else {
        format!("{hours}h {rest}m")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_read_like_the_dashboard() {
        assert_eq!(humanize(45 * 60), "45m");
        assert_eq!(humanize(2 * 3600), "2h");
        assert_eq!(humanize(2 * 3600 + 10 * 60), "2h 10m");
        assert_eq!(humanize(30), "0m");
    }
}
