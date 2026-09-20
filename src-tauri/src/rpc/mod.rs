//! Discord-style Rich Presence over a local socket.
//!
//! One listener, two transports: a named pipe on Windows, a Unix domain socket on macOS.
//! `interprocess` hides the difference, so the protocol below is identical on both.
//!
//! Protocol: newline-delimited JSON, one connection per client. A connection *is* the
//! session — when it drops, so does the presence.
//!
//! This socket is deliberately unauthenticated, exactly like Discord's. Any process
//! running as the user can claim activity. The defences here are about blast radius,
//! not trust: a 0600 socket file, a hard payload cap, strict validation, and a TTL so a
//! crashed client cannot hold the foreground forever.

use anyhow::{anyhow, Result};
use interprocess::local_socket::tokio::prelude::*;
use interprocess::local_socket::{ListenerOptions, Name};
#[cfg(windows)]
use interprocess::local_socket::GenericNamespaced;
#[cfg(unix)]
use interprocess::local_socket::GenericFilePath;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::models::is_valid_category;
use crate::state::AppState;

/// Windows: `\\.\pipe\nudgy-rpc`.
#[cfg(windows)]
const PIPE_NAME: &str = "nudgy-rpc";
/// macOS/Unix: a socket file we own and recreate on every start.
#[cfg(unix)]
const SOCKET_PATH: &str = "/tmp/nudgy-rpc.sock";

/// Longest accepted JSON line. Anything bigger is a bug or an attack, not a presence.
const MAX_LINE_BYTES: usize = 8 * 1024;
const MAX_CLIENT_ID_CHARS: usize = 64;
const MAX_ACTIVITY_CHARS: usize = 128;

/// How long a presence survives without another message from its client.
pub const PRESENCE_TTL_SECONDS: i64 = 60;

/// A client's currently claimed activity.
#[derive(Debug, Clone)]
pub struct RpcPresence {
    pub client_id: String,
    pub activity: String,
    pub category: Option<String>,
    pub started_at: i64,
    pub last_seen: i64,
}

pub type PresenceMap = Arc<RwLock<HashMap<String, RpcPresence>>>;

#[derive(Debug, Deserialize)]
struct PresencePayload {
    client_id: String,
    activity: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    started_at: Option<i64>,
    /// Optional explicit teardown so a client can clear presence without disconnecting.
    #[serde(default)]
    clear: bool,
}

/// Returns the most recent presence that has not expired. Ties break on `last_seen`, so
/// the client that spoke most recently wins — an editor that is actually being typed in
/// beats one left open in the background.
pub fn active_presence(presence: &PresenceMap, now: i64) -> Option<RpcPresence> {
    let map = presence.read().ok()?;
    map.values()
        .filter(|entry| now - entry.last_seen <= PRESENCE_TTL_SECONDS)
        .max_by_key(|entry| entry.last_seen)
        .cloned()
}

/// Chosen by platform rather than by `is_supported()`: on macOS the namespaced variant
/// is "supported" but resolves to a path of its own choosing, which would silently move
/// the socket away from the one documented for clients.
#[cfg(windows)]
fn socket_name() -> Result<Name<'static>> {
    Ok(PIPE_NAME.to_ns_name::<GenericNamespaced>()?)
}

#[cfg(unix)]
fn socket_name() -> Result<Name<'static>> {
    Ok(SOCKET_PATH.to_fs_name::<GenericFilePath>()?)
}

/// What clients should connect to, for logs and error messages.
fn endpoint_label() -> String {
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\{PIPE_NAME}")
    }
    #[cfg(unix)]
    {
        SOCKET_PATH.to_string()
    }
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(app).await {
            log::error!("rich presence listener stopped: {error}");
        }
    });
}

async fn serve(app: AppHandle) -> Result<()> {
    // A socket file left behind by a crash would make bind fail forever. But a socket
    // that still answers belongs to a live instance, and stealing it would leave two
    // Nudgys fighting over every client.
    #[cfg(unix)]
    if std::path::Path::new(SOCKET_PATH).exists() {
        match std::os::unix::net::UnixStream::connect(SOCKET_PATH) {
            Ok(_) => {
                return Err(anyhow!(
                    "another Nudgy instance is already listening on {SOCKET_PATH}"
                ))
            }
            Err(_) => {
                let _ = std::fs::remove_file(SOCKET_PATH);
            }
        }
    }

    let listener = ListenerOptions::new()
        .name(socket_name()?)
        .create_tokio()
        .map_err(|error| anyhow!("binding rich presence socket: {error}"))?;

    // Owner-only. The socket carries no secrets, but nothing else on the machine has any
    // business writing to it either.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(SOCKET_PATH, std::fs::Permissions::from_mode(0o600));
    }

    log::info!("rich presence listening on {}", endpoint_label());

    loop {
        let stream = match listener.accept().await {
            Ok(stream) => stream,
            Err(error) => {
                log::warn!("rich presence accept failed: {error}");
                continue;
            }
        };

        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = handle_client(app, stream).await {
                log::debug!("rich presence client ended: {error}");
            }
        });
    }
}

async fn handle_client(
    app: AppHandle,
    stream: interprocess::local_socket::tokio::Stream,
) -> Result<()> {
    let presence: PresenceMap = app.state::<AppState>().presence.clone();
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    // Remembered so the presence can be dropped when this connection closes.
    let mut owned_client: Option<String> = None;

    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line).await?;
        if read == 0 {
            break; // client disconnected
        }
        if line.len() > MAX_LINE_BYTES {
            return Err(anyhow!("payload exceeded {MAX_LINE_BYTES} bytes"));
        }

        let text = String::from_utf8_lossy(&line);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }

        let payload: PresencePayload = match serde_json::from_str(trimmed) {
            Ok(payload) => payload,
            Err(error) => {
                log::warn!("rejecting malformed presence payload: {error}");
                continue;
            }
        };

        match validate(payload) {
            Ok(Command::Set(entry)) => {
                owned_client = Some(entry.client_id.clone());
                if let Ok(mut map) = presence.write() {
                    map.insert(entry.client_id.clone(), entry);
                }
            }
            Ok(Command::Clear(client_id)) => {
                if let Ok(mut map) = presence.write() {
                    map.remove(&client_id);
                }
                owned_client = None;
            }
            Err(error) => log::warn!("rejecting presence payload: {error}"),
        }
    }

    // The connection is the session: closing it retires the presence immediately rather
    // than leaving it to time out.
    if let Some(client_id) = owned_client {
        if let Ok(mut map) = presence.write() {
            map.remove(&client_id);
        }
    }
    Ok(())
}

enum Command {
    Set(RpcPresence),
    Clear(String),
}

fn validate(payload: PresencePayload) -> Result<Command> {
    let client_id = payload.client_id.trim().to_string();
    if client_id.is_empty() || client_id.chars().count() > MAX_CLIENT_ID_CHARS {
        return Err(anyhow!("client_id must be 1..={MAX_CLIENT_ID_CHARS} chars"));
    }

    if payload.clear {
        return Ok(Command::Clear(client_id));
    }

    let activity = payload.activity.trim().to_string();
    if activity.is_empty() || activity.chars().count() > MAX_ACTIVITY_CHARS {
        return Err(anyhow!("activity must be 1..={MAX_ACTIVITY_CHARS} chars"));
    }

    let category = match payload.category {
        Some(value) if is_valid_category(&value) => Some(value),
        Some(value) => return Err(anyhow!("unknown category `{value}`")),
        None => None,
    };

    let now = chrono::Utc::now().timestamp();
    // A start time in the future would produce a negative session length in the UI.
    let started_at = match payload.started_at {
        Some(value) if value > 0 && value <= now + 60 => value,
        _ => now,
    };

    Ok(Command::Set(RpcPresence {
        client_id,
        activity,
        category,
        started_at,
        last_seen: now,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(client_id: &str, activity: &str, category: Option<&str>) -> PresencePayload {
        PresencePayload {
            client_id: client_id.to_string(),
            activity: activity.to_string(),
            category: category.map(str::to_string),
            started_at: None,
            clear: false,
        }
    }

    #[test]
    fn accepts_a_well_formed_payload() {
        let result = validate(payload("vscode-extension", "Writing Lab Report", Some("Productivity")));
        assert!(matches!(result, Ok(Command::Set(_))));
    }

    #[test]
    fn rejects_unknown_category() {
        assert!(validate(payload("cli", "Doing things", Some("Slacking"))).is_err());
    }

    #[test]
    fn rejects_empty_and_oversized_fields() {
        assert!(validate(payload("", "Writing", None)).is_err());
        let long = "x".repeat(MAX_ACTIVITY_CHARS + 1);
        assert!(validate(payload("cli", &long, None)).is_err());
    }

    #[test]
    fn clamps_a_future_start_time_to_now() {
        let mut input = payload("cli", "Writing", None);
        input.started_at = Some(chrono::Utc::now().timestamp() + 10_000);
        let Ok(Command::Set(entry)) = validate(input) else {
            panic!("expected a set command");
        };
        assert!(entry.started_at <= chrono::Utc::now().timestamp() + 1);
    }

    #[test]
    fn expired_presence_is_not_active() {
        let now = chrono::Utc::now().timestamp();
        let map: PresenceMap = Arc::new(RwLock::new(HashMap::from([(
            "stale".to_string(),
            RpcPresence {
                client_id: "stale".to_string(),
                activity: "Old news".to_string(),
                category: None,
                started_at: now - 9_000,
                last_seen: now - PRESENCE_TTL_SECONDS - 1,
            },
        )])));
        assert!(active_presence(&map, now).is_none());
    }
}
