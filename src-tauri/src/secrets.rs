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
/// Secret iCal feed URL. Read-only, but anyone holding it can read the calendar, so it
/// is treated as a credential rather than a setting.
pub const CALENDAR_ICS_URL: &str = "calendar_ics_url";
/// The LMS coursework feed. Read-only like the calendar one, and a credential for the
/// same reason: anyone holding it can read your coursework.
pub const LMS_FEED_URL: &str = "lms_feed_url";
pub const KNOWN_KEYS: &[&str] = &[
    CANVAS_TOKEN,
    CALENDAR_ICS_URL,
    LMS_FEED_URL,
];

/// One class's Canvas announcements feed. Per course, because Canvas gives each enrolment
/// its own; a credential like the others, because the link alone reads the announcements.
pub fn announcements_key(course_id: i64) -> String {
    format!("{ANNOUNCEMENTS_PREFIX}{course_id}")
}
const ANNOUNCEMENTS_PREFIX: &str = "announcements_feed:";

fn is_announcements_key(key: &str) -> bool {
    key.strip_prefix(ANNOUNCEMENTS_PREFIX)
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
}

fn entry(key: &str) -> Result<Entry> {
    if !KNOWN_KEYS.contains(&key) && !is_announcements_key(key) {
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
