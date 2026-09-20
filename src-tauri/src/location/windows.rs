//! Windows location — **not implemented**.
//!
//! `Windows.Devices.Geolocation` is the right API and the shape below is roughly correct,
//! but it is async: `Geolocator::GetGeopositionAsync` returns an `IAsyncOperation`, and in
//! `windows` 0.62 the blocking `get()` that older versions offered has moved out to the
//! `windows-future` crate. Wiring it up properly means either taking that dependency or
//! making `location::current` async, and the macOS side is a blocking poll — so the two
//! platforms would need different signatures.
//!
//! That is a real piece of work, and it is not worth doing blind. This file cannot be
//! compiled on the machine Nudgy is developed on, so the only feedback loop is a CI run
//! per attempt. It is also unreachable right now: the whole places-and-travel feature is
//! mothballed (see CLAUDE.md), and `detect_current_location` is the only caller.
//!
//! So it returns the honest answer instead. The caller already handles it — a failed OS
//! lookup falls back to the browser, then to the provider's network lookup, neither of
//! which needs this.
//!
//! To finish it: add `windows-future` with its blocking feature, call
//! `Geolocator::RequestAccessAsync()?.get()?` and check for `GeolocationAccessStatus::Allowed`,
//! then `Geolocator::new()?.GetGeopositionAsync()?.get()?.Coordinate()?.Point()?.Position()`
//! for the latitude and longitude.

use anyhow::{anyhow, Result};

use super::Coordinates;

pub fn current() -> Result<Coordinates> {
    Err(anyhow!(
        "Nudgy cannot read your location on Windows yet — type an address instead"
    ))
}
