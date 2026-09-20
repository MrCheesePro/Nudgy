use anyhow::Result;
use rusqlite::{params, Connection};

use crate::models::{
    ActivitySample, AppRule, AppTotal, CategoryTotal, LmsTask, RedactionRule, UnmappedProcess,
    UsageBreakdown, CATEGORY_IDLE,
};
use crate::watcher::registry::REDACTED_TITLE;

/// Writes a batch in one transaction. Returns the number of rows written.
pub fn insert_samples(conn: &mut Connection, samples: &[ActivitySample]) -> Result<usize> {
    if samples.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO activity_samples
                (ts, duration_seconds, process_name, app_name, window_title,
                 category, source, client_id, is_idle)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        for sample in samples {
            stmt.execute(params![
                sample.ts,
                sample.duration_seconds,
                sample.process_name,
                sample.app_name,
                sample.window_title,
                sample.category,
                sample.source,
                sample.client_id,
                sample.is_idle as i64,
            ])?;
        }
    }
    tx.commit()?;
    Ok(samples.len())
}

pub fn usage_breakdown(conn: &Connection, start_ts: i64, end_ts: i64) -> Result<UsageBreakdown> {
    let mut stmt = conn.prepare_cached(
        "SELECT category, SUM(duration_seconds) AS seconds
           FROM activity_samples
          WHERE ts >= ?1 AND ts < ?2
          GROUP BY category
          ORDER BY seconds DESC",
    )?;
    let categories: Vec<CategoryTotal> = stmt
        .query_map(params![start_ts, end_ts], |row| {
            Ok(CategoryTotal {
                category: row.get(0)?,
                seconds: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let total_seconds: i64 = categories.iter().map(|entry| entry.seconds).sum();
    let idle_seconds: i64 = categories
        .iter()
        .filter(|entry| entry.category == CATEGORY_IDLE)
        .map(|entry| entry.seconds)
        .sum();

    Ok(UsageBreakdown {
        categories,
        total_seconds,
        active_seconds: total_seconds - idle_seconds,
        idle_seconds,
    })
}

pub fn app_totals(
    conn: &Connection,
    start_ts: i64,
    end_ts: i64,
    limit: i64,
) -> Result<Vec<AppTotal>> {
    // Grouped by the site label as well as the app, so Chrome on YouTube and Chrome on
    // Canvas are two rows in two categories rather than one undifferentiated hour. The
    // label is a short rule name, never a page title, so the row count stays bounded.
    let mut stmt = conn.prepare_cached(
        "SELECT process_name,
                COALESCE(MAX(app_name), process_name) AS app_name,
                CASE WHEN window_title = ?4 THEN NULL ELSE window_title END AS context,
                category,
                SUM(duration_seconds) AS seconds
           FROM activity_samples
          WHERE ts >= ?1 AND ts < ?2 AND is_idle = 0
          GROUP BY process_name, category, context
          ORDER BY seconds DESC
          LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![start_ts, end_ts, limit, REDACTED_TITLE], |row| {
            Ok(AppTotal {
                process_name: row.get(0)?,
                app_name: row.get(1)?,
                context: row.get(2)?,
                category: row.get(3)?,
                seconds: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Seconds a process accumulated while the user was actually present. `is_idle = 0` is
/// the load-bearing clause: leaving an app open while away must not verify a goal.
#[allow(dead_code)] // wired up by the goal verifier in M4
pub fn active_seconds_for_process(
    conn: &Connection,
    process_name: &str,
    start_ts: i64,
    end_ts: i64,
) -> Result<i64> {
    let seconds: i64 = conn.query_row(
        "SELECT COALESCE(SUM(duration_seconds), 0)
           FROM activity_samples
          WHERE process_name = ?1 AND is_idle = 0 AND ts >= ?2 AND ts < ?3",
        params![process_name, start_ts, end_ts],
        |row| row.get(0),
    )?;
    Ok(seconds)
}

/// Processes seen recently with no exact registry entry. Title-regex rules are not
/// evaluated here — this list exists to drive "register this app", and an app already
/// covered by a regex is still worth offering an explicit mapping for.
pub fn unmapped_processes(conn: &Connection, since_ts: i64) -> Result<Vec<UnmappedProcess>> {
    let mut stmt = conn.prepare_cached(
        "SELECT s.process_name,
                COALESCE(MAX(s.app_name), s.process_name) AS app_name,
                SUM(s.duration_seconds) AS seconds,
                MAX(s.ts) AS last_seen
           FROM activity_samples s
          WHERE s.ts >= ?1
            AND s.is_idle = 0
            AND NOT EXISTS (
                -- NOCASE to match the categorizer, which lowercases both sides. Without
                -- it, mapping `Code.exe` would leave `code.exe` listed as unrecognised.
                SELECT 1 FROM known_apps k
                 WHERE k.match_type = 'exe'
                   AND k.pattern = s.process_name COLLATE NOCASE
            )
          GROUP BY s.process_name
          ORDER BY seconds DESC",
    )?;
    let rows = stmt
        .query_map(params![since_ts], |row| {
            Ok(UnmappedProcess {
                process_name: row.get(0)?,
                app_name: row.get(1)?,
                seconds: row.get(2)?,
                last_seen: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn load_app_rules(conn: &Connection) -> Result<Vec<AppRule>> {
    let mut stmt = conn.prepare(
        "SELECT id, match_type, pattern, display_name, category, is_user_defined
           FROM known_apps
          ORDER BY match_type, pattern",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(AppRule {
                id: row.get(0)?,
                match_type: row.get(1)?,
                pattern: row.get(2)?,
                display_name: row.get(3)?,
                category: row.get(4)?,
                is_user_defined: row.get::<_, i64>(5)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Upsert by pattern. Seeding uses `is_user_defined = 0` and must not clobber a rule the
/// user edited, so the seed path passes `overwrite = false`.
pub fn upsert_app_rule(conn: &Connection, rule: &AppRule, overwrite: bool) -> Result<()> {
    if overwrite {
        conn.execute(
            "INSERT INTO known_apps (match_type, pattern, display_name, category, is_user_defined)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(pattern) DO UPDATE SET
                match_type = excluded.match_type,
                display_name = excluded.display_name,
                category = excluded.category,
                is_user_defined = excluded.is_user_defined",
            params![
                rule.match_type,
                rule.pattern,
                rule.display_name,
                rule.category,
                rule.is_user_defined as i64
            ],
        )?;
    } else {
        conn.execute(
            "INSERT OR IGNORE INTO known_apps
                (match_type, pattern, display_name, category, is_user_defined)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                rule.match_type,
                rule.pattern,
                rule.display_name,
                rule.category,
                rule.is_user_defined as i64
            ],
        )?;
    }
    Ok(())
}

pub fn delete_app_rule(conn: &Connection, id: i64) -> Result<usize> {
    Ok(conn.execute("DELETE FROM known_apps WHERE id = ?1", params![id])?)
}

pub fn load_redaction_patterns(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT match_type, pattern FROM redaction_rules")?;
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn load_redaction_rules(conn: &Connection) -> Result<Vec<RedactionRule>> {
    let mut stmt = conn.prepare(
        "SELECT id, match_type, pattern, is_user_defined
           FROM redaction_rules ORDER BY match_type, pattern",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RedactionRule {
                id: row.get(0)?,
                match_type: row.get(1)?,
                pattern: row.get(2)?,
                is_user_defined: row.get::<_, i64>(3)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn upsert_redaction_rule(conn: &Connection, match_type: &str, pattern: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO redaction_rules (match_type, pattern, is_user_defined)
         VALUES (?1, ?2, 1)",
        params![match_type, pattern],
    )?;
    Ok(())
}

pub fn delete_redaction_rule(conn: &Connection, id: i64) -> Result<usize> {
    Ok(conn.execute("DELETE FROM redaction_rules WHERE id = ?1", params![id])?)
}

#[allow(dead_code)] // used by the Canvas and LLM settings paths in M3/M4
/// Upserts synced tasks. `completed` is written on insert only: a box the user ticked
/// locally must survive the next sync, which would otherwise un-tick it every time.
pub fn upsert_tasks(conn: &mut Connection, tasks: &[LmsTask]) -> Result<usize> {
    if tasks.is_empty() {
        return Ok(0);
    }
    let now = chrono::Utc::now().timestamp();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO tasks
                (provider, external_id, course_code, title, due_at, html_url, completed, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
             ON CONFLICT(provider, external_id) DO UPDATE SET
                course_code = excluded.course_code,
                title       = excluded.title,
                due_at      = excluded.due_at,
                html_url    = excluded.html_url,
                synced_at   = excluded.synced_at",
        )?;
        for task in tasks {
            stmt.execute(params![
                task.provider,
                task.external_id,
                task.course_code,
                task.title,
                task.due_at,
                task.html_url,
                now,
            ])?;
        }
    }
    tx.commit()?;
    Ok(tasks.len())
}

pub fn load_tasks(conn: &Connection, include_completed: bool) -> Result<Vec<LmsTask>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, provider, external_id, course_code, title, due_at, html_url, completed,
                completed_locally_at
           FROM tasks
          WHERE (?1 = 1 OR completed = 0)
          ORDER BY completed ASC, COALESCE(due_at, 9223372036854775807) ASC, title ASC",
    )?;
    let rows = stmt
        .query_map(params![include_completed as i64], |row| {
            Ok(LmsTask {
                id: row.get(0)?,
                provider: row.get(1)?,
                external_id: row.get(2)?,
                course_code: row.get(3)?,
                title: row.get(4)?,
                due_at: row.get(5)?,
                html_url: row.get(6)?,
                completed: row.get::<_, i64>(7)? != 0,
                completed_at: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn set_task_completed(conn: &Connection, id: i64, completed: bool) -> Result<usize> {
    let now = chrono::Utc::now().timestamp();
    Ok(conn.execute(
        "UPDATE tasks SET completed = ?2, completed_locally_at = ?3 WHERE id = ?1",
        params![id, completed as i64, if completed { Some(now) } else { None }],
    )?)
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let value = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok();
    Ok(value)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn all_settings(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
