//! Fallback so the crate still builds on platforms Nudgy does not track on (Linux, CI
//! containers). Tracking reports nothing rather than failing to compile.

use anyhow::Result;
use tauri::AppHandle;

use crate::models::{Foreground, PermissionStatus};

pub async fn foreground(_app: &AppHandle) -> Result<Option<Foreground>> {
    Ok(None)
}

pub fn idle_seconds() -> Result<u64> {
    Ok(0)
}

pub fn permission_status() -> PermissionStatus {
    PermissionStatus {
        accessibility: false,
        screen_recording: false,
        applicable: false,
    }
}

pub fn request_screen_recording() -> bool {
    false
}
