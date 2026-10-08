//! Sends a person's app registry to the maintainer's Google Sheet, one tab per sender.
//!
//! The receiving end is a Google Apps Script web app — `scripts/registry-sheet.gs` — and
//! this only posts to it. Nothing is sent until somebody presses the button in Settings,
//! and what is sent is the registry and the name they typed: patterns, display names and
//! categories. No activity, no titles, no time.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::Serialize;

use crate::models::AppRule;

/// The Apps Script web app's `/exec` URL. Empty until it is deployed — see the setup notes
/// at the top of `scripts/registry-sheet.gs`.
pub const ENDPOINT: &str = "https://script.google.com/macros/s/AKfycbwnjxooiCH9S4ksrfik56bijwC1Bs3ffq6z9LacfsdFLUSW3hV12Isd0QsGWsWwAU8XyA/exec";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const USER_AGENT: &str = concat!("Nudgy/", env!("CARGO_PKG_VERSION"));

/// Long enough for a name, short enough to be a sheet tab.
pub const MAX_NAME: usize = 40;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry<'a> {
    match_type: &'a str,
    pattern: &'a str,
    display_name: &'a str,
    category: &'a str,
}

#[derive(Serialize)]
struct Payload<'a> {
    sender: &'a str,
    version: &'static str,
    apps: Vec<Entry<'a>>,
}

/// Posts the rules. Returns how many were sent.
pub async fn send(sender: &str, rules: &[AppRule]) -> Result<usize> {
    if ENDPOINT.is_empty() {
        return Err(anyhow!("sharing is not set up in this build yet"));
    }
    let sender = sender.trim();
    if sender.is_empty() {
        return Err(anyhow!("add your name first, so your apps land on your own tab"));
    }
    if sender.chars().count() > MAX_NAME {
        return Err(anyhow!("keep the name under {MAX_NAME} characters"));
    }

    let payload = Payload {
        sender,
        version: env!("CARGO_PKG_VERSION"),
        apps: rules
            .iter()
            .map(|rule| Entry {
                match_type: &rule.match_type,
                pattern: &rule.pattern,
                display_name: &rule.display_name,
                category: &rule.category,
            })
            .collect(),
    };

    let http = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        // Apps Script answers a POST with a redirect to where its output lives; the
        // script has already run by then, so following it is only reading the reply.
        .redirect(reqwest::redirect::Policy::limited(5))
        .https_only(true)
        .build()
        .context("building HTTP client")?;

    let response = http
        .post(ENDPOINT)
        .json(&payload)
        .send()
        .await
        .context("sending the registry")?;
    if !response.status().is_success() {
        return Err(anyhow!("the sheet refused it ({})", response.status()));
    }
    let body = response.text().await.unwrap_or_default();
    if !body.contains("\"ok\":true") {
        return Err(anyhow!("the sheet did not confirm it"));
    }
    Ok(payload.apps.len())
}
