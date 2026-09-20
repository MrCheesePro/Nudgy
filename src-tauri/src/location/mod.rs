//! Where the machine is, asked of the operating system.
//!
//! The one place `#[cfg(target_os)]` appears for location, mirroring
//! `watcher/platform.rs`: callers get `current()` and never learn which framework
//! answered. Adding a platform means adding a module, not editing a caller.
//!
//! This is deliberately separate from `integrations/travel.rs`. Locating is a *device*
//! capability — free, offline, permission-gated — while routing is a *service* that
//! costs money and needs a key. Conflating them is what made an earlier version of this
//! spend an API call to answer a question the OS already knew.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;

#[cfg(target_os = "macos")]
pub use macos::current;
#[cfg(target_os = "windows")]
pub use windows::current;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use unsupported::current;

#[derive(Debug, Clone, Copy)]
pub struct Coordinates {
    pub latitude: f64,
    pub longitude: f64,
}
