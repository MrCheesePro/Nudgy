//! Platform-neutral entry points for the tick loop.
//!
//! The loop in `watcher/mod.rs` must contain no `#[cfg]` blocks: every OS difference
//! is resolved here, so adding a platform means adding a module, not editing the loop.

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{foreground, idle_seconds, permission_status, request_screen_recording};

#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::{foreground, idle_seconds, permission_status, request_screen_recording};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[path = "unsupported.rs"]
mod unsupported;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use unsupported::{foreground, idle_seconds, permission_status, request_screen_recording};
