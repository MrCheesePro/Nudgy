use anyhow::{anyhow, Result};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::queries;
use crate::models::{ActivitySample, FLUSH_SECONDS};
use crate::state::AppState;

/// Batch writer. Keeping writes to one transaction every 45 seconds is what keeps a
/// always-on tracker from thrashing the disk.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(FLUSH_SECONDS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick fires immediately; skip it so we do not flush an empty buffer.
        ticker.tick().await;

        loop {
            ticker.tick().await;
            match flush_now(&app) {
                Ok(0) => {}
                Ok(count) => {
                    log::debug!("flushed {count} samples");
                    let _ = app.emit("nudgy://flushed", count);
                }
                Err(error) => log::error!("flush failed: {error}"),
            }
        }
    });
}

/// Drains the buffer into SQLite. On failure the samples go back on the front of the
/// buffer and are retried next cycle — a failed write must not silently lose the day.
pub fn flush_now(app: &AppHandle) -> Result<usize> {
    let state = app.state::<AppState>();

    let pending: Vec<ActivitySample> = {
        let mut buffer = state
            .buffer
            .lock()
            .map_err(|_| anyhow!("sample buffer lock poisoned"))?;
        std::mem::take(&mut *buffer)
    };

    if pending.is_empty() {
        return Ok(0);
    }

    let result = {
        let mut conn = state
            .db
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        queries::insert_samples(&mut conn, &pending)
    };

    match result {
        Ok(count) => Ok(count),
        Err(error) => {
            let mut buffer = state
                .buffer
                .lock()
                .map_err(|_| anyhow!("sample buffer lock poisoned"))?;
            // Put the failed batch back in front of anything recorded meanwhile.
            let mut restored = pending;
            restored.append(&mut buffer);
            *buffer = restored;
            Err(error)
        }
    }
}
