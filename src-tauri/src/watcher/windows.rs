//! Windows foreground + idle probe.
//!
//! Note: this file cannot be compiled on the macOS development machine. It is checked by
//! the `windows-latest` job in CI — treat a green run there as the real verification.

use anyhow::{anyhow, Result};
use tauri::AppHandle;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
};

use crate::models::{Foreground, PermissionStatus};

/// Closes the process handle however the function exits — including the error paths,
/// which is where handle leaks in trackers usually come from.
struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// Milliseconds since the last input event, from the OS. No hooks, no event contents.
pub fn idle_seconds() -> Result<u64> {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };

    unsafe { GetLastInputInfo(&mut info) }
        .ok()
        .map_err(|error| anyhow!("GetLastInputInfo failed: {error}"))?;

    // GetTickCount64, not GetTickCount: the 32-bit counter wraps after 49.7 days and
    // would report a wildly wrong idle time on a long-uptime machine.
    let now_ms = unsafe { GetTickCount64() };
    let last_ms = info.dwTime as u64;

    // dwTime is a 32-bit tick value; rebase it onto the 64-bit counter's current epoch.
    let elapsed_ms = now_ms.wrapping_sub(last_ms) & 0xFFFF_FFFF;
    Ok(elapsed_ms / 1000)
}

pub async fn foreground(_app: &AppHandle) -> Result<Option<Foreground>> {
    let Some((hwnd, process_name, title)) = foreground_window() else {
        return Ok(None);
    };

    // Windows has no Apple events, so the address is read off the address bar itself
    // through UI Automation. Same contract as macOS: only the host survives, and a browser
    // that will not answer leaves this None and the title rules take over.
    let host = if crate::watcher::browser::is_browser(&process_name) {
        crate::watcher::browser::active_host_for_window(hwnd, title.as_deref()).await
    } else {
        None
    };

    Ok(Some(Foreground {
        app_name: Some(process_name.trim_end_matches(".exe").to_string()),
        process_name,
        title,
        host,
    }))
}

/// The focused window as a plain integer, its process name and its title.
///
/// Kept apart from `foreground` because an `HWND` is a raw pointer and not `Send`: one
/// alive across the `.await` above makes the whole tick loop unspawnable.
fn foreground_window() -> Option<(isize, String, Option<String>)> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        // Nothing focused (lock screen, desktop switch) is a normal state, not an error.
        return None;
    }

    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return None;
    }

    let process_path = executable_path(pid);
    let process_name = process_path
        .as_deref()
        .and_then(|path| {
            std::path::Path::new(path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| format!("pid:{pid}"));

    // The Windows counterpart to the macOS activation-policy filter: shell surfaces that
    // take focus but are not apps the user chose to work in.
    if is_system_shell(&process_name) {
        return None;
    }

    let title = window_title(hwnd);
    Some((hwnd.0 as isize, process_name, title))
}

/// Windows has no activation-policy equivalent, so these are named directly. All of them
/// are OS chrome that can hold the foreground: the lock screen, the sign-in UI, the Start
/// menu, the search flyout, the IME candidate window.
fn is_system_shell(process_name: &str) -> bool {
    const SYSTEM_SHELL: &[&str] = &[
        "LockApp.exe",
        "LogonUI.exe",
        "SearchHost.exe",
        "SearchApp.exe",
        "ShellExperienceHost.exe",
        "StartMenuExperienceHost.exe",
        "TextInputHost.exe",
        "SystemSettingsBroker.exe",
        "CredentialUIBroker.exe",
        "Widgets.exe",
    ];
    SYSTEM_SHELL
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(process_name))
}

fn executable_path(pid: u32) -> Option<String> {
    // QUERY_LIMITED_INFORMATION is the least privilege that answers the question, and
    // unlike QUERY_INFORMATION it works against elevated processes.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let guard = OwnedHandle(handle);

    let mut buffer = vec![0u16; 1024];
    let mut length = buffer.len() as u32;

    unsafe {
        QueryFullProcessImageNameW(
            guard.0,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    }
    .ok()?;

    buffer.truncate(length as usize);
    Some(String::from_utf16_lossy(&buffer))
}

fn window_title(hwnd: HWND) -> Option<String> {
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length <= 0 {
        return None;
    }

    // +1 for the terminating null GetWindowTextW writes.
    let mut buffer = vec![0u16; length as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    if copied <= 0 {
        return None;
    }

    let title = String::from_utf16_lossy(&buffer[..copied as usize]);
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

/// Windows has no equivalent of the macOS Accessibility / Screen Recording gates, so
/// there is nothing to pre-flight and the banner never shows.
pub fn permission_status() -> PermissionStatus {
    PermissionStatus {
        accessibility: true,
        screen_recording: true,
        applicable: false,
    }
}

pub fn request_screen_recording() -> bool {
    true
}
