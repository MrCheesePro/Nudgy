use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

use crate::models::{ActivitySample, LiveStatus};
use crate::rpc::PresenceMap;
use crate::watcher::registry::Registry;

/// Shared application state, owned by Tauri and reachable from commands and workers.
///
/// These are `std` locks on purpose: a `std` guard is `!Send`, so holding one across an
/// `.await` is a compile error rather than a deadlock discovered in production.
pub struct AppState {
    /// The single writer connection. Every SQLite access in the app goes through here.
    pub db: Mutex<Connection>,
    /// Samples waiting to be flushed. Drained every `FLUSH_SECONDS`.
    pub buffer: Arc<Mutex<Vec<ActivitySample>>>,
    /// Tray toggle. When true the watcher records nothing at all — no gap filling.
    pub paused: Arc<AtomicBool>,
    /// Live Rich Presence claims, keyed by client id. Entries expire after
    /// `rpc::PRESENCE_TTL_SECONDS` without a message.
    pub presence: PresenceMap,
    /// Compiled categorizer + redaction rules; rebuilt when a rule changes.
    pub registry: Arc<RwLock<Registry>>,
    /// Last tick, for the live header and for the tray tooltip.
    pub current: Arc<RwLock<Option<LiveStatus>>>,
}

impl AppState {
    pub fn new(db: Connection, registry: Registry) -> Self {
        Self {
            db: Mutex::new(db),
            buffer: Arc::new(Mutex::new(Vec::new())),
            paused: Arc::new(AtomicBool::new(false)),
            presence: Arc::new(RwLock::new(HashMap::new())),
            registry: Arc::new(RwLock::new(registry)),
            current: Arc::new(RwLock::new(None)),
        }
    }

    /// Rebuilds the compiled registry from the database. Called after any rule change.
    pub fn reload_registry(&self) -> anyhow::Result<()> {
        let rebuilt = {
            let conn = self
                .db
                .lock()
                .map_err(|_| anyhow::anyhow!("database lock poisoned"))?;
            Registry::load(&conn)?
        };
        let mut registry = self
            .registry
            .write()
            .map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
        *registry = rebuilt;
        Ok(())
    }
}
