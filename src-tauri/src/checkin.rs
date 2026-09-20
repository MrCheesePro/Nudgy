//! The check-in worker.
//!
//! Once a minute it asks the database whether any plan has crossed its next check-in
//! threshold, and if so fires a system notification and tells the dashboard to put the
//! question on screen. It never decides anything itself — the user answers, and
//! `plans::respond` records what they said.

use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::plans::{self, PlanProgress};
use crate::state::AppState;

/// One minute is frequent enough: the threshold is measured in worked time, which only
/// advances five seconds per tick anyway.
const POLL_SECONDS: u64 = 60;

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(POLL_SECONDS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // the first tick is immediate; skip it

        loop {
            ticker.tick().await;
            match due_checkins(&app) {
                Ok(due) => {
                    for progress in due {
                        announce(&app, &progress);
                    }
                }
                Err(error) => log::error!("check-in poll failed: {error}"),
            }
        }
    });
}

fn due_checkins(app: &AppHandle) -> anyhow::Result<Vec<PlanProgress>> {
    let state = app.state::<AppState>();
    let conn = state
        .db
        .lock()
        .map_err(|_| anyhow::anyhow!("database lock poisoned"))?;

    // One switch, honoured everywhere. A check-in that still fires with notifications
    // off would make the toggle a lie.
    if !crate::reminder::enabled(&conn) {
        return Ok(Vec::new());
    }
    plans::take_due_checkins(&conn)
}

fn announce(app: &AppHandle, progress: &PlanProgress) {
    let worked = format_hours(progress.worked_seconds);
    let estimate = format_hours(progress.plan.estimate_seconds);

    let body = format!(
        "{worked} of {estimate} done. Still on track, or will it take longer?",
    );

    // A notification the user may not be looking at, and an in-app prompt they will see
    // when they come back. Both are fire-and-forget; the state that matters is the NULL
    // `next_checkin_seconds` already written to the database.
    if let Err(error) = app
        .notification()
        .builder()
        .title(&progress.plan.title)
        .body(&body)
        .show()
    {
        log::warn!("could not show check-in notification: {error}");
    }

    let _ = app.emit("nudgy://checkin", progress);
    log::info!(
        "check-in for plan {} at {worked}/{estimate}",
        progress.plan.id
    );
}

fn format_hours(seconds: i64) -> String {
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    if hours > 0 {
        format!("{hours}h {minutes:02}m")
    } else {
        format!("{minutes}m")
    }
}
