//! How long it takes to get from one address to another.
//!
//! The trait exists for the same reason `LmsProvider` does: the planner asks a question
//! and must not learn whose API answered it. Google's Distance Matrix is the first
//! implementation because it takes plain address strings, so nothing here has to geocode.
//!
//! Two things are deliberate. Addresses leave the machine only when a lookup actually
//! happens — a cached pair never touches the network. And a failed lookup is not an
//! error the user has to clear: the planner falls back to no travel, which is the
//! behaviour it had before any of this existed.

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const USER_AGENT: &str = concat!("Nudgy/", env!("CARGO_PKG_VERSION"));
const DISTANCE_MATRIX_URL: &str = "https://maps.googleapis.com/maps/api/distancematrix/json";

/// An upper bound on what will be believed. A provider returning eleven hours for a
/// campus trip has misread the address, and padding the day by eleven hours would erase
/// it — so the answer is rejected rather than applied.
pub const MAX_PLAUSIBLE_TRAVEL_SECONDS: i64 = 6 * 60 * 60;

#[async_trait]
pub trait TravelProvider: Send + Sync {
    fn provider_id(&self) -> &'static str;

    /// Seconds from `origin` to `destination` by `mode`, both as free-text addresses.
    async fn travel_seconds(&self, origin: &str, destination: &str, mode: &str) -> Result<i64>;
}

pub struct GoogleDistanceMatrix {
    api_key: String,
}

impl GoogleDistanceMatrix {
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }
}

#[derive(Debug, Deserialize)]
struct MatrixResponse {
    #[serde(default)]
    status: String,
    #[serde(default)]
    error_message: Option<String>,
    #[serde(default)]
    rows: Vec<MatrixRow>,
}

#[derive(Debug, Deserialize)]
struct MatrixRow {
    #[serde(default)]
    elements: Vec<MatrixElement>,
}

#[derive(Debug, Deserialize)]
struct MatrixElement {
    #[serde(default)]
    status: String,
    #[serde(default)]
    duration: Option<MatrixValue>,
    /// Present only when departure time is given; preferred when it is, because a
    /// 25-minute drive at 8am is not a 25-minute drive.
    #[serde(default)]
    duration_in_traffic: Option<MatrixValue>,
}

#[derive(Debug, Deserialize)]
struct MatrixValue {
    #[serde(default)]
    value: i64,
}

#[async_trait]
impl TravelProvider for GoogleDistanceMatrix {
    fn provider_id(&self) -> &'static str {
        "google"
    }

    async fn travel_seconds(&self, origin: &str, destination: &str, mode: &str) -> Result<i64> {
        if origin.trim().is_empty() || destination.trim().is_empty() {
            return Err(anyhow!("both places need an address before travel can be looked up"));
        }

        let http = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .context("building HTTP client")?;

        let url = format!(
            "{DISTANCE_MATRIX_URL}?origins={}&destinations={}&mode={}&units=metric&key={}",
            encode(origin.trim()),
            encode(destination.trim()),
            encode(mode),
            encode(&self.api_key),
        );

        let response = http
            .get(&url)
            .send()
            .await
            .context("calling the maps provider")?;

        if !response.status().is_success() {
            return Err(anyhow!(
                "maps provider returned {}",
                response.status().as_u16()
            ));
        }

        let parsed: MatrixResponse = response.json().await.context("decoding maps response")?;
        if parsed.status != "OK" {
            let hint = match parsed.status.as_str() {
                "REQUEST_DENIED" => " (check the maps API key in Settings)",
                "OVER_QUERY_LIMIT" => " (the key is over its quota)",
                _ => "",
            };
            return Err(anyhow!(
                "maps provider said {}{hint}{}",
                parsed.status,
                parsed
                    .error_message
                    .map(|message| format!(": {message}"))
                    .unwrap_or_default()
            ));
        }

        let element = parsed
            .rows
            .into_iter()
            .next()
            .and_then(|row| row.elements.into_iter().next())
            .ok_or_else(|| anyhow!("maps provider returned no route"))?;

        if element.status != "OK" {
            // ZERO_RESULTS on transit usually means "not at this hour", which is a real
            // answer about the route rather than a broken request.
            return Err(anyhow!(
                "no {mode} route between those addresses ({})",
                element.status
            ));
        }

        let seconds = element
            .duration_in_traffic
            .or(element.duration)
            .map(|value| value.value)
            .ok_or_else(|| anyhow!("maps provider returned no duration"))?;

        validate_seconds(seconds)
    }
}

const ORS_BASE: &str = "https://api.openrouteservice.org";

/// OpenRouteService: an email address and a token, no credit card.
///
/// It routes between *coordinates*, not addresses, so each lookup is geocode-geocode-
/// matrix rather than one call. That is three requests where Google needs one, which is
/// why the results are cached as hard as they are — and why `Place` carries its
/// coordinates once they are known, so the geocoding half is paid only the first time an
/// address is ever seen.
pub struct OpenRouteService {
    api_key: String,
}

impl OpenRouteService {
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }

    /// ORS names its profiles after the vehicle. There is no usable public-transport
    /// profile on the free tier, so transit falls back to driving rather than failing —
    /// a wrong-but-close number beats refusing to plan the day.
    fn profile(mode: &str) -> &'static str {
        match mode {
            "walking" => "foot-walking",
            "bicycling" => "cycling-regular",
            _ => "driving-car",
        }
    }

    /// Address to coordinates, via the bundled Pelias geocoder.
    pub async fn geocode(&self, address: &str) -> Result<(f64, f64)> {
        let url = format!(
            "{ORS_BASE}/geocode/search?api_key={}&size=1&text={}",
            encode(&self.api_key),
            encode(address.trim())
        );
        let response = client()?
            .get(&url)
            .send()
            .await
            .context("looking up that address")?;

        if !response.status().is_success() {
            return Err(anyhow!(
                "the routing provider returned {} looking up `{address}`",
                response.status().as_u16()
            ));
        }

        let parsed: PeliasResponse = response.json().await.context("decoding the address")?;
        let feature = parsed
            .features
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("no place matched `{address}`"))?;
        let coordinates = feature.geometry.coordinates;
        if coordinates.len() < 2 {
            return Err(anyhow!("no place matched `{address}`"));
        }
        // GeoJSON is [longitude, latitude]. Getting this backwards puts a campus in the
        // ocean and yields a travel time nobody can explain, so it is spelled out.
        Ok((coordinates[1], coordinates[0]))
    }

    pub async fn reverse(&self, latitude: f64, longitude: f64) -> Result<String> {
        let url = format!(
            "{ORS_BASE}/geocode/reverse?api_key={}&size=1&point.lat={latitude}&point.lon={longitude}",
            encode(&self.api_key)
        );
        let parsed: PeliasResponse = client()?
            .get(&url)
            .send()
            .await
            .context("naming your location")?
            .json()
            .await
            .context("decoding the address")?;

        parsed
            .features
            .into_iter()
            .find_map(|feature| feature.properties.label)
            .ok_or_else(|| anyhow!("no address for those coordinates"))
    }
}

#[derive(Debug, Deserialize)]
struct PeliasResponse {
    #[serde(default)]
    features: Vec<PeliasFeature>,
}

#[derive(Debug, Deserialize)]
struct PeliasFeature {
    #[serde(default)]
    geometry: PeliasGeometry,
    #[serde(default)]
    properties: PeliasProperties,
}

#[derive(Debug, Default, Deserialize)]
struct PeliasGeometry {
    #[serde(default)]
    coordinates: Vec<f64>,
}

#[derive(Debug, Default, Deserialize)]
struct PeliasProperties {
    #[serde(default)]
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MatrixDurations {
    #[serde(default)]
    durations: Vec<Vec<Option<f64>>>,
}

#[async_trait]
impl TravelProvider for OpenRouteService {
    fn provider_id(&self) -> &'static str {
        "openrouteservice"
    }

    async fn travel_seconds(&self, origin: &str, destination: &str, mode: &str) -> Result<i64> {
        let (from_lat, from_lon) = self.geocode(origin).await?;
        let (to_lat, to_lon) = self.geocode(destination).await?;

        let url = format!("{ORS_BASE}/v2/matrix/{}", Self::profile(mode));
        let response = client()?
            .post(&url)
            .header("Authorization", &self.api_key)
            .json(&serde_json::json!({
                "locations": [[from_lon, from_lat], [to_lon, to_lat]],
                "sources": [0],
                "destinations": [1],
                "metrics": ["duration"],
            }))
            .send()
            .await
            .context("asking the routing provider")?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let hint = match status {
                401 | 403 => " (check the routing API key in Settings)",
                429 => " (the free tier's daily limit is used up — try again tomorrow, or type the minutes)",
                _ => "",
            };
            return Err(anyhow!("routing provider returned {status}{hint}"));
        }

        let parsed: MatrixDurations = response.json().await.context("decoding the route")?;
        let seconds = parsed
            .durations
            .into_iter()
            .next()
            .and_then(|row| row.into_iter().next())
            .flatten()
            .ok_or_else(|| anyhow!("no {mode} route between those addresses"))?;

        validate_seconds(seconds.round() as i64)
    }
}

const GEOLOCATE_URL: &str = "https://www.googleapis.com/geolocation/v1/geolocate";
const GEOCODE_URL: &str = "https://maps.googleapis.com/maps/api/geocode/json";

/// Coordinates only. Naming them is `reverse_geocode`'s job, and a separate step because
/// it is allowed to fail without the location being lost — a lat/lng routes perfectly
/// well, it just reads badly.
pub struct Located {
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Deserialize)]
struct GeolocateResponse {
    location: Option<LatLng>,
}

#[derive(Debug, Deserialize)]
struct LatLng {
    lat: f64,
    lng: f64,
}

#[derive(Debug, Deserialize)]
struct GeocodeResponse {
    #[serde(default)]
    status: String,
    #[serde(default)]
    results: Vec<GeocodeResult>,
}

#[derive(Debug, Deserialize)]
struct GeocodeResult {
    #[serde(default)]
    formatted_address: Option<String>,
}

fn client() -> Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .context("building HTTP client")
}

/// Asks the provider where this machine is, from its network surroundings.
///
/// This is the fallback path. It needs no OS permission and no prompt, and it is accurate
/// to roughly a neighbourhood — good enough to say a class is twenty minutes away, not
/// good enough to route from a doorstep. The browser's own geolocation is tried first and
/// is far more precise when the webview will give it.
pub async fn geolocate(api_key: &str) -> Result<Located> {
    let url = format!("{GEOLOCATE_URL}?key={}", encode(api_key));
    // An empty body tells Google to infer from the request's own network position.
    let response = client()?
        .post(&url)
        .json(&serde_json::json!({ "considerIp": true }))
        .send()
        .await
        .context("asking the maps provider where we are")?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "could not work out where you are ({}). Type an address instead.",
            response.status().as_u16()
        ));
    }

    let parsed: GeolocateResponse = response.json().await.context("decoding location")?;
    let location = parsed
        .location
        .ok_or_else(|| anyhow!("the maps provider returned no location"))?;

    Ok(Located {
        latitude: location.lat,
        longitude: location.lng,
    })
}

/// Turns coordinates into something a person recognises.
///
/// A failure here is not a failure of locating: the coordinates still route. So the
/// caller keeps them and simply shows a blunter label.
pub async fn reverse_geocode(api_key: &str, latitude: f64, longitude: f64) -> Result<String> {
    let url = format!(
        "{GEOCODE_URL}?latlng={}&key={}",
        encode(&format!("{latitude},{longitude}")),
        encode(api_key)
    );
    let response = client()?
        .get(&url)
        .send()
        .await
        .context("naming your location")?;

    let parsed: GeocodeResponse = response.json().await.context("decoding the address")?;
    if parsed.status != "OK" {
        return Err(anyhow!("no address for those coordinates ({})", parsed.status));
    }
    parsed
        .results
        .into_iter()
        .find_map(|result| result.formatted_address)
        .ok_or_else(|| anyhow!("no address for those coordinates"))
}

/// Percent-encodes a query value. `reqwest` is built here without its query-string
/// feature, and an address is full of spaces and commas, so this does the escaping
/// rather than the URL being assembled wrong and the provider answering about somewhere
/// else. Everything outside the RFC 3986 unreserved set is escaped.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Guards the one number that reaches the planner. A negative or absurd duration would
/// silently eat the day, so it is refused here rather than cached and trusted forever.
pub fn validate_seconds(seconds: i64) -> Result<i64> {
    if seconds <= 0 {
        return Err(anyhow!("maps provider returned a duration of zero"));
    }
    if seconds > MAX_PLAUSIBLE_TRAVEL_SECONDS {
        return Err(anyhow!(
            "ignoring an implausible travel time of {} hours — check the addresses",
            seconds / 3600
        ));
    }
    Ok(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    // An address is mostly punctuation. Getting this wrong asks the provider about a
    // different place and caches the answer, so it is worth pinning down.
    #[test]
    fn addresses_survive_the_query_string() {
        assert_eq!(
            encode("1 Main St, Apt #4, Springfield"),
            "1%20Main%20St%2C%20Apt%20%234%2C%20Springfield"
        );
        assert_eq!(encode("Caf\u{e9}"), "Caf%C3%A9");
        assert_eq!(encode("plain-name_1.0~x"), "plain-name_1.0~x");
    }

    #[test]
    fn a_sane_duration_passes_through() {
        assert_eq!(validate_seconds(25 * 60).unwrap(), 1500);
    }

    // Both of these would otherwise be cached and then quietly padded onto every day.
    #[test]
    fn nonsense_durations_are_refused() {
        assert!(validate_seconds(0).is_err());
        assert!(validate_seconds(-60).is_err());
        assert!(validate_seconds(MAX_PLAUSIBLE_TRAVEL_SECONDS + 1).is_err());
    }
}
