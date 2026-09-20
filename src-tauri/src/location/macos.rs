//! CoreLocation. No key, no network, no cost — a system permission prompt and then
//! coordinates, exactly like the screen-recording permission the watcher already asks for.
//!
//! `CLLocationManager::location` is used rather than a delegate on purpose. The delegate
//! protocol is the right tool for *following* someone around; all Nudgy wants is "where
//! am I, once, now", and the manager caches the most recent fix for precisely that. The
//! cost is that the first call after authorization can come back empty while the fix is
//! still being acquired, which is what the short poll below is for.

use anyhow::{anyhow, Result};
use objc2_core_location::{CLAuthorizationStatus, CLLocationManager};
use std::time::Duration;

use super::Coordinates;

/// How long to wait for a first fix before giving up. Well under the point where a
/// person decides the button is broken.
const FIX_TIMEOUT: Duration = Duration::from_secs(8);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Authorization is read off a manager instance rather than the class: the class method
/// is deprecated, and modern CoreLocation answers per-manager.
fn status_of(manager: &CLLocationManager) -> CLAuthorizationStatus {
    // Safety: a no-argument property read on a live manager.
    unsafe { manager.authorizationStatus() }
}

/// Asks the OS where we are.
///
/// Blocking, and called from a blocking task — the poll is a poll, and parking a worker
/// thread for a few seconds is honest about what is happening.
pub fn current() -> Result<Coordinates> {
    // Safety: standard AppKit-style allocation and init of a CLLocationManager.
    let manager = unsafe { CLLocationManager::new() };

    // Safety: both are no-argument messages on a live manager. Requesting authorization
    // when it is already granted is a no-op rather than a second prompt.
    unsafe {
        manager.requestWhenInUseAuthorization();
        manager.startUpdatingLocation();
    }

    let deadline = std::time::Instant::now() + FIX_TIMEOUT;
    let mut result = None;

    while std::time::Instant::now() < deadline {
        // Safety: `location` returns the last known fix, or nil before one exists.
        if let Some(location) = unsafe { manager.location() } {
            let coordinate = unsafe { location.coordinate() };
            // A fix at exactly 0,0 is the null island — CoreLocation's way of saying it
            // has nothing, not a genuine position in the Gulf of Guinea.
            if coordinate.latitude != 0.0 || coordinate.longitude != 0.0 {
                result = Some(Coordinates {
                    latitude: coordinate.latitude,
                    longitude: coordinate.longitude,
                });
                break;
            }
        }

        // Denied is final: no amount of waiting turns it into a fix, and the caller has a
        // fallback that does not need permission at all.
        let status = status_of(&manager);
        if status == CLAuthorizationStatus::Denied || status == CLAuthorizationStatus::Restricted {
            unsafe { manager.stopUpdatingLocation() };
            return Err(anyhow!(
                "location access is off for Nudgy — turn it on in System Settings › Privacy & Security › Location Services, or type an address instead"
            ));
        }

        std::thread::sleep(POLL_INTERVAL);
    }

    // Safety: stopping updates on a manager that was started.
    unsafe { manager.stopUpdatingLocation() };

    result.ok_or_else(|| anyhow!("no location fix yet — try again in a moment"))
}
