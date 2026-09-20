//! `Windows.Devices.Geolocation`. Same bargain as CoreLocation: a system permission
//! prompt, then coordinates, with no key and no per-call cost.
//!
//! **Never compiled on the development machine** — like `watcher/windows.rs`, this path
//! is exercised in CI only, so treat changes here as unverified until a Windows build
//! runs.

use anyhow::{anyhow, Result};
use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator};

use super::Coordinates;

pub fn current() -> Result<Coordinates> {
    let access = Geolocator::RequestAccessAsync()
        .and_then(|operation| operation.get())
        .map_err(|error| anyhow!("asking for location access: {error}"))?;

    if access != GeolocationAccessStatus::Allowed {
        return Err(anyhow!(
            "location access is off for Nudgy — turn it on in Settings › Privacy & security › Location, or type an address instead"
        ));
    }

    let locator = Geolocator::new().map_err(|error| anyhow!("opening the locator: {error}"))?;
    let position = locator
        .GetGeopositionAsync()
        .and_then(|operation| operation.get())
        .map_err(|error| anyhow!("reading your position: {error}"))?;

    let point = position
        .Coordinate()
        .and_then(|coordinate| coordinate.Point())
        .map_err(|error| anyhow!("reading the coordinates: {error}"))?;
    let position = point
        .Position()
        .map_err(|error| anyhow!("reading the coordinates: {error}"))?;

    Ok(Coordinates {
        latitude: position.Latitude,
        longitude: position.Longitude,
    })
}
