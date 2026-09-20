pub mod migrations;
pub mod queries;

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::Path;

/// Opens the single writer connection. WAL keeps the 45-second flush from blocking
/// reads issued by dashboard commands; `synchronous=NORMAL` is the right trade for a
/// log we can afford to lose the last few seconds of after a hard power cut.
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating data directory {}", parent.display()))?;
    }

    let conn = Connection::open(path)
        .with_context(|| format!("opening database {}", path.display()))?;

    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )
    .context("applying connection pragmas")?;

    migrations::run_migrations(&conn).context("running migrations")?;
    Ok(conn)
}
