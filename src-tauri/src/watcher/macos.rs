//! macOS foreground + idle probe.
//!
//! Two sources, deliberately separated by the permission they need:
//!   * app identity  — `NSWorkspace.frontmostApplication`, no permission required
//!   * window title  — `CGWindowListCopyWindowInfo`, needs Screen Recording
//!
//! Missing Screen Recording therefore degrades to app-level tracking instead of failing.

use anyhow::{anyhow, Result};
use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};
use std::ffi::c_void;
use std::time::Duration;
use tauri::AppHandle;

use crate::models::{Foreground, PermissionStatus};

const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
const K_CG_NULL_WINDOW_ID: u32 = 0;

/// kCGEventSourceStateCombinedSessionState
const K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE: i32 = 0;
/// kCGAnyInputEventType
const K_CG_ANY_INPUT_EVENT_TYPE: u32 = 0xFFFF_FFFF;

/// How long the tick will wait for the main thread before giving up on this sample.
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(2);

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

/// Seconds since the last keyboard/mouse/tablet event anywhere in the session.
/// This is the only input signal Nudgy reads — never the events themselves.
pub fn idle_seconds() -> Result<u64> {
    let seconds = unsafe {
        CGEventSourceSecondsSinceLastEventType(
            K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE,
            K_CG_ANY_INPUT_EVENT_TYPE,
        )
    };
    if !seconds.is_finite() || seconds < 0.0 {
        return Ok(0);
    }
    Ok(seconds as u64)
}

pub async fn foreground(app: &AppHandle) -> Result<Option<Foreground>> {
    let Some(front) = frontmost_app(app).await? else {
        return Ok(None);
    };

    // Title lookup is best-effort: without Screen Recording this is always None, which
    // is a supported state, not an error.
    let title = window_title_for_pid(front.pid);

    Ok(Some(Foreground {
        process_name: front.process_name,
        app_name: front.app_name,
        title,
    }))
}

struct FrontmostApp {
    process_name: String,
    app_name: Option<String>,
    pid: i32,
}

/// AppKit is main-thread-affine. Hopping through Tauri's main-thread queue is what keeps
/// this from being an intermittent crash under load.
async fn frontmost_app(app: &AppHandle) -> Result<Option<FrontmostApp>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();

    app.run_on_main_thread(move || {
        let result = read_frontmost_app();
        // Receiver dropped means the tick timed out; nothing to do about it.
        let _ = sender.send(result);
    })
    .map_err(|error| anyhow!("dispatching to main thread: {error}"))?;

    match tokio::time::timeout(MAIN_THREAD_TIMEOUT, receiver).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Ok(None),
        Err(_) => {
            log::warn!("main thread did not answer within {MAIN_THREAD_TIMEOUT:?}");
            Ok(None)
        }
    }
}

fn read_frontmost_app() -> Option<FrontmostApp> {
    let workspace = NSWorkspace::sharedWorkspace();
    let running = workspace.frontmostApplication()?;

    // Only apps a person could click in the Dock get tracked. macOS marks background
    // agents and system UI — loginwindow, SecurityAgent, coreautha, the screen saver —
    // as Accessory or Prohibited, so this single check excludes all of them without a
    // blocklist anyone has to maintain. A filtered tick records nothing at all, which is
    // the honest answer: a password prompt is not work you did.
    if running.activationPolicy() != NSApplicationActivationPolicy::Regular {
        return None;
    }

    let bundle_id = running.bundleIdentifier().map(|value| value.to_string());
    let localized = running.localizedName().map(|value| value.to_string());
    let pid = running.processIdentifier();

    // Bundle id is the stable key; the localized name is what a human reads.
    let process_name = bundle_id.or_else(|| localized.clone())?;

    Some(FrontmostApp {
        process_name,
        app_name: localized,
        pid,
    })
}

/// Reads the on-screen window list and returns the first window belonging to `pid`.
/// Returns None without Screen Recording permission.
fn window_title_for_pid(pid: i32) -> Option<String> {
    let options =
        K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS;

    let array_ref = unsafe { CGWindowListCopyWindowInfo(options, K_CG_NULL_WINDOW_ID) };
    if array_ref.is_null() {
        return None;
    }
    let windows: CFArray<*const c_void> = unsafe { CFArray::wrap_under_create_rule(array_ref) };

    let pid_key = CFString::from_static_string("kCGWindowOwnerPID");
    let name_key = CFString::from_static_string("kCGWindowName");

    for item in windows.iter() {
        let dictionary: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };

        let owner_pid = dictionary
            .find(&pid_key)
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|number| number.to_i64());

        if owner_pid != Some(pid as i64) {
            continue;
        }

        let title = dictionary
            .find(&name_key)
            .and_then(|value| value.downcast::<CFString>())
            .map(|value| value.to_string())
            .filter(|value| !value.is_empty());

        if title.is_some() {
            return title;
        }
    }

    None
}

pub fn permission_status() -> PermissionStatus {
    PermissionStatus {
        accessibility: unsafe { AXIsProcessTrusted() } != 0,
        screen_recording: unsafe { CGPreflightScreenCaptureAccess() },
        applicable: true,
    }
}

/// Triggers the system prompt once per app install; afterwards macOS ignores it and the
/// user has to toggle the switch in System Settings, which is what the UI links to.
pub fn request_screen_recording() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}
