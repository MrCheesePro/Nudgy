//! Keychain-backed secret storage.
//!
//! Tokens never touch SQLite, never appear in a log line, and never travel to the
//! frontend. The UI may ask *whether* a secret is set; only Rust ever reads its value,
//! at the moment of the request that needs it.

use anyhow::{anyhow, Result};
use keyring::Entry;

const SERVICE: &str = "com.nudgy.app";

/// Canvas API bearer token.
pub const CANVAS_TOKEN: &str = "canvas_token";
/// API key for the OpenAI-compatible scheduler endpoint.
pub const LLM_API_KEY: &str = "llm_api_key";
/// Secret iCal feed URL. Read-only, but anyone holding it can read the calendar, so it
/// is treated as a credential rather than a setting.
pub const CALENDAR_ICS_URL: &str = "calendar_ics_url";

pub const KNOWN_KEYS: &[&str] = &[CANVAS_TOKEN, LLM_API_KEY, CALENDAR_ICS_URL];

fn entry(key: &str) -> Result<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return Err(anyhow!("unknown secret `{key}`"));
    }
    Entry::new(SERVICE, key).map_err(|error| anyhow!("opening keychain entry: {error}"))
}

pub fn set(key: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(anyhow!("refusing to store an empty secret"));
    }
    entry(key)?
        .set_password(value.trim())
        .map_err(|error| anyhow!("writing to keychain: {error}"))
}

pub fn get(key: &str) -> Result<Option<String>> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(anyhow!("reading from keychain: {error}")),
    }
}

pub fn has(key: &str) -> bool {
    matches!(get(key), Ok(Some(_)))
}

pub fn clear(key: &str) -> Result<()> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(anyhow!("removing from keychain: {error}")),
    }
}
