pub mod browser;
pub mod flush;
pub mod platform;
pub mod registry;

use anyhow::{anyhow, Result};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::models::{
    ActivitySample, Foreground, LiveStatus, CATEGORY_IDLE, CATEGORY_NEUTRAL, IDLE_PROCESS,
    IDLE_THRESHOLD_SECONDS, SOURCE_PASSIVE, SOURCE_RPC, TICK_SECONDS,
};
use crate::rpc::{self, RpcPresence};
use crate::state::AppState;
use registry::REDACTED_TITLE;

/// Tracks the run of consecutive ticks on the same thing, for the header's session timer.
#[derive(Default)]
struct SessionTracker {
    key: Option<String>,
    started_at: i64,
}

impl SessionTracker {
    fn observe(&mut self, key: &str, now: i64) -> i64 {
        if self.key.as_deref() != Some(key) {
            self.key = Some(key.to_string());
            self.started_at = now;
        }
        self.started_at
    }

    /// Adopts a start time decided elsewhere — used when resuming from a pause, so the
    /// tracker agrees with the number the header is about to show.
    fn resume_at(&mut self, key: &str, started_at: i64) {
        self.key = Some(key.to_string());
        self.started_at = started_at;
    }

    fn reset(&mut self) {
        self.key = None;
        self.started_at = 0;
    }
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(TICK_SECONDS));
        // A laptop waking from sleep must not fire a burst of catch-up ticks and inflate
        // the day's totals with time nobody was at the machine.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        let mut session = SessionTracker::default();

        loop {
            ticker.tick().await;
            if let Err(error) = tick(&app, &mut session).await {
                log::warn!("watcher tick failed: {error}");
            }
        }
    });
}

async fn tick(app: &AppHandle, session: &mut SessionTracker) -> Result<()> {
    let state = app.state::<AppState>();
    let now = chrono::Utc::now().timestamp();

    if state.paused.load(Ordering::Relaxed) {
        session.reset();
        publish(app, &state, None);
        return Ok(());
    }

    let idle_seconds = platform::idle_seconds().unwrap_or(0);

    // An RPC client reports when its activity began, which is more accurate than the
    // run of ticks we can observe; that start time wins when a claim is active.
    let mut claimed_session_start: Option<i64> = None;

    // Step 1 — idle wins over everything. Time with no input is never credited to
    // whatever happens to be in the foreground.
    let sample = if idle_seconds > IDLE_THRESHOLD_SECONDS {
        ActivitySample {
            ts: now,
            duration_seconds: TICK_SECONDS as i64,
            process_name: IDLE_PROCESS.to_string(),
            app_name: Some("Idle".to_string()),
            window_title: None,
            category: CATEGORY_IDLE.to_string(),
            source: SOURCE_PASSIVE.to_string(),
            client_id: None,
            is_idle: true,
        }
    } else {
        // Step 2 — the passive probe runs either way, because an RPC claim still wants
        // to know which app it belongs to.
        let foreground = platform::foreground(app).await?;

        // Step 3 — explicit beats guessed. A client that says "Writing Lab Report"
        // outranks a window title we inferred, for as long as it keeps saying so.
        match rpc::active_presence(&state.presence, now) {
            Some(presence) => {
                claimed_session_start = Some(presence.started_at.min(now));
                build_rpc_sample(presence, foreground, now)
            }
            None => {
                let Some(foreground) = foreground else {
                    publish(app, &state, None);
                    return Ok(());
                };
                build_passive_sample(&state, foreground, now)?
            }
        }
    };

    let tracked_start = session.observe(&sample.process_name, now);
    let mut session_started_at = claimed_session_start.unwrap_or(tracked_start);

    // Coming back from a pause: shift the start forward so the counter carries on from
    // where it was held rather than from zero. Taken once — the freeze is then cleared.
    if let Ok(mut frozen) = state.session_freeze.lock() {
        if let Some(seconds) = frozen.take() {
            session_started_at = now - seconds;
            session.resume_at(&sample.process_name, session_started_at);
        }
    }

    let live = LiveStatus {
        process_name: sample.process_name.clone(),
        app_name: sample
            .app_name
            .clone()
            .unwrap_or_else(|| sample.process_name.clone()),
        window_title: sample.window_title.clone(),
        category: sample.category.clone(),
        source: sample.source.clone(),
        is_idle: sample.is_idle,
        idle_seconds: idle_seconds as i64,
        session_started_at,
        session_seconds: now - session_started_at + TICK_SECONDS as i64,
        paused: false,
    };

    {
        let mut buffer = state
            .buffer
            .lock()
            .map_err(|_| anyhow!("sample buffer lock poisoned"))?;
        buffer.push(sample);
    }

    publish(app, &state, Some(live));
    Ok(())
}

/// An RPC claim decorates the foreground app rather than replacing it: the process name
/// stays whatever is actually focused, so per-app totals still add up, while the activity
/// string and category come from the client. A claim with nothing focused (a CLI task,
/// say) falls back to the client id as the process.
fn build_rpc_sample(
    presence: RpcPresence,
    foreground: Option<Foreground>,
    now: i64,
) -> ActivitySample {
    let (process_name, app_name) = match &foreground {
        Some(front) => (
            front.process_name.clone(),
            front
                .app_name
                .clone()
                .unwrap_or_else(|| front.process_name.clone()),
        ),
        None => (presence.client_id.clone(), presence.client_id.clone()),
    };

    ActivitySample {
        ts: now,
        duration_seconds: TICK_SECONDS as i64,
        process_name,
        app_name: Some(app_name),
        window_title: Some(presence.activity),
        category: presence
            .category
            .unwrap_or_else(|| CATEGORY_NEUTRAL.to_string()),
        source: SOURCE_RPC.to_string(),
        client_id: Some(presence.client_id),
        is_idle: false,
    }
}

fn build_passive_sample(
    state: &tauri::State<'_, AppState>,
    foreground: Foreground,
    now: i64,
) -> Result<ActivitySample> {
    let registry = state
        .registry
        .read()
        .map_err(|_| anyhow!("registry lock poisoned"))?;

    let resolved = registry.resolve(&foreground);

    // What is stored is a short label from a rule — "YouTube" — never the page's own
    // title. A title that matches no rule leaves nothing behind at all, so the raw text
    // is never held in memory past this function, never flushed, never recoverable.
    let window_title = if registry.is_redacted(&foreground) {
        Some(REDACTED_TITLE.to_string())
    } else {
        resolved.context
    };

    Ok(ActivitySample {
        ts: now,
        duration_seconds: TICK_SECONDS as i64,
        process_name: foreground.process_name,
        app_name: Some(resolved.display_name),
        window_title,
        category: resolved.category,
        source: SOURCE_PASSIVE.to_string(),
        client_id: None,
        is_idle: false,
    })
}

/// Stores the live status and pushes it to the dashboard. A `None` status means the
/// watcher has nothing to report (paused, or no foreground window).
fn publish(app: &AppHandle, state: &tauri::State<'_, AppState>, live: Option<LiveStatus>) {
    let paused = state.paused.load(Ordering::Relaxed);

    // Pausing holds the picture still. The header keeps the app, the category and the
    // session it was showing, flagged paused — because "what was I doing when I stopped?"
    // is the question a pause leaves you with, and answering it with `Idle · 0s` throws
    // away the very thing worth keeping. Only the seconds stop moving.
    let frozen = state.session_freeze.lock().ok().and_then(|held| *held);
    let held = if paused {
        state.current.read().ok().and_then(|current| {
            current.as_ref().map(|last| LiveStatus {
                session_seconds: frozen.unwrap_or(last.session_seconds),
                paused: true,
                ..last.clone()
            })
        })
    } else {
        None
    };

    let payload = held.or(live).or_else(|| {
        Some(LiveStatus {
            process_name: String::new(),
            app_name: if paused {
                "Paused".to_string()
            } else {
                "Nothing in focus".to_string()
            },
            window_title: None,
            category: CATEGORY_IDLE.to_string(),
            source: SOURCE_PASSIVE.to_string(),
            is_idle: true,
            idle_seconds: 0,
            session_started_at: 0,
            session_seconds: frozen.unwrap_or(0),
            paused,
        })
    });

    if let Ok(mut current) = state.current.write() {
        current.clone_from(&payload);
    }
    if let Some(payload) = payload {
        let _ = app.emit("nudgy://tick", payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The session timer is a run of ticks on one thing. Pausing used to report zero, so
    // the header fell to `0s` and came back counting from scratch — as though the sitting
    // had been thrown away rather than held.
    #[test]
    fn a_session_runs_from_its_first_tick() {
        let mut session = SessionTracker::default();
        assert_eq!(session.observe("code", 1_000), 1_000);
        assert_eq!(session.observe("code", 1_005), 1_000);
    }

    #[test]
    fn switching_apps_starts_a_new_session() {
        let mut session = SessionTracker::default();
        session.observe("code", 1_000);
        assert_eq!(session.observe("chrome", 1_010), 1_010);
    }

    /// Resuming shifts the start back by however long was held, so the next tick reports
    /// the frozen number plus the time since — continuing rather than restarting.
    #[test]
    fn resuming_continues_from_the_frozen_value() {
        let mut session = SessionTracker::default();
        session.observe("code", 1_000);

        let frozen = 20; // what the header showed when pause was pressed
        let resumed_at = 5_000; // much later, after a long pause
        let started_at = resumed_at - frozen;
        session.resume_at("code", started_at);

        assert_eq!(session.observe("code", resumed_at), started_at);
        // One tick further on, the counter reads the held value plus the elapsed second.
        assert_eq!(resumed_at + 5 - session.observe("code", resumed_at + 5), frozen + 5);
    }

    #[test]
    fn a_reset_session_starts_again_on_the_next_tick() {
        let mut session = SessionTracker::default();
        session.observe("code", 1_000);
        session.reset();
        assert_eq!(session.observe("code", 2_000), 2_000);
    }
}
