use anyhow::Result;
use rusqlite::{params, Connection};

use crate::models::{
    ActivitySample, AppRule, AppTotal, Category, CategoryTarget, CategoryTotal, DailyTotal,
    LmsTask, RedactionRule, UnmappedProcess, UsageBreakdown, CATEGORY_IDLE,
    CATEGORY_NEUTRAL,
};
use crate::watcher::registry::{MATCH_EXE, REDACTED_TITLE};

/// Writes a batch in one transaction. Returns the number of rows written.
///
/// `OR IGNORE` against the unique index on `(ts, process_name)`: one second of one app is
/// one row, and a second already recorded is dropped rather than added to. A tick is the
/// only thing that writes here, so a collision means the same moment reached the table
/// twice — a flush replayed after a crash, or a second copy of Nudgy running. Either way
/// the honest total is one, and summing both is how a day grows past twenty-four hours.
pub fn insert_samples(conn: &mut Connection, samples: &[ActivitySample]) -> Result<usize> {
    if samples.is_empty() {
        return Ok(0);
    }
    let mut written = 0usize;
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT OR IGNORE INTO activity_samples
                (ts, duration_seconds, process_name, app_name, window_title,
                 category, source, client_id, is_idle)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        for sample in samples {
            // What landed, not what was offered — an ignored duplicate is not a write.
            written += stmt.execute(params![
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
    Ok(written)
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
    // The registry, lowercased, read once.
    //
    // This used to be a correlated `NOT EXISTS` with `LOWER()` on both sides, evaluated
    // per sample: no index can serve that, so it scanned the window and then ran a second
    // scan of `known_apps` for every row in it — the single slowest thing the App registry
    // tab did, and the reason opening it stalled. There are a few hundred rules and one
    // grouped row per process; doing the comparison here is the same answer in a fraction
    // of the time.
    //
    // Still `LOWER()` on both sides, matching what the categorizer does, so a rule typed
    // as `Code.exe` retires `code.exe` the moment it is saved.
    let known: std::collections::HashSet<String> = conn
        .prepare_cached("SELECT LOWER(pattern) FROM known_apps WHERE match_type = 'exe'")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<_, _>>()?;

    let mut stmt = conn.prepare_cached(
        "SELECT process_name,
                COALESCE(MAX(app_name), process_name) AS app_name,
                SUM(duration_seconds) AS seconds,
                MAX(ts) AS last_seen
           FROM activity_samples
          WHERE ts >= ?1 AND is_idle = 0
          GROUP BY process_name
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
        .filter(|row| match row {
            Ok(entry) => !known.contains(&entry.process_name.to_lowercase()),
            Err(_) => true,
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Ordered so the compiled registry can take the first matching title rule and be right:
/// higher `priority` first, so a coursework rule beats whatever is playing in another tab,
/// and a rule the user wrote beats every seeded one.
pub fn load_app_rules(conn: &Connection) -> Result<Vec<AppRule>> {
    let mut stmt = conn.prepare(
        "SELECT id, match_type, pattern, display_name, category, is_user_defined, priority
           FROM known_apps
          ORDER BY match_type, priority DESC, pattern",
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
                priority: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn load_app_rule(conn: &Connection, id: i64) -> Result<Option<AppRule>> {
    let mut stmt = conn.prepare(
        "SELECT id, match_type, pattern, display_name, category, is_user_defined, priority
           FROM known_apps WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(AppRule {
            id: row.get(0)?,
            match_type: row.get(1)?,
            pattern: row.get(2)?,
            display_name: row.get(3)?,
            category: row.get(4)?,
            is_user_defined: row.get::<_, i64>(5)? != 0,
            priority: row.get(6)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

/// Moves the time a rule has *already* recorded into its new category.
///
/// Without this a correction only steers the future, and every chart keeps showing the
/// old answer for work that was mis-filed — which reads as the app ignoring you. The two
/// shapes are not interchangeable:
///
/// * An `exe` rule owns the rows it named, but **only those with no site label**. A row
///   carrying a label was categorized by the site, not by the browser, so re-filing Chrome
///   must not drag an hour of YouTube along with it.
/// * A `title_regex` rule owns exactly the rows stamped with its display name. That is an
///   equality check rather than a re-run of the regex: `app_totals` already treats
///   `window_title` as the rule's own short label, never the page's words.
///
/// Idle rows are never touched, for the same reason idle time is never attributed to an
/// app in the first place.
pub fn recategorize_samples(conn: &Connection, rule: &AppRule, new_category: &str) -> Result<usize> {
    let changed = if rule.match_type == MATCH_EXE {
        conn.execute(
            "UPDATE activity_samples
                SET category = ?1
              WHERE LOWER(process_name) = LOWER(?2)
                AND is_idle = 0
                AND (window_title IS NULL OR window_title = ?3)",
            params![new_category, rule.pattern, REDACTED_TITLE],
        )?
    } else {
        conn.execute(
            "UPDATE activity_samples
                SET category = ?1
              WHERE window_title = ?2 AND is_idle = 0",
            params![new_category, rule.display_name],
        )?
    };
    Ok(changed)
}

pub fn load_categories(conn: &Connection) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, sort_order, is_builtin
           FROM categories ORDER BY sort_order, name",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                sort_order: row.get(3)?,
                is_builtin: row.get::<_, i64>(4)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn category_names(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM categories")?;
    let rows = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// New categories sort after every built-in, in the order they were added.
pub fn insert_category(conn: &Connection, name: &str, color: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO categories (name, color, sort_order, is_builtin)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM categories), 0)",
        params![name, color],
    )?;
    Ok(())
}

pub fn load_category(conn: &Connection, id: i64) -> Result<Option<Category>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, sort_order, is_builtin FROM categories WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(Category {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            sort_order: row.get(3)?,
            is_builtin: row.get::<_, i64>(4)? != 0,
        })
    })?;
    Ok(rows.next().transpose()?)
}

/// How much would be reassigned if this category went away — the numbers
/// `ConfirmDialog` has to name before the button is pressed.
pub fn category_usage(conn: &Connection, name: &str) -> Result<(i64, i64)> {
    let rules: i64 = conn.query_row(
        "SELECT COUNT(*) FROM known_apps WHERE category = ?1",
        params![name],
        |row| row.get(0),
    )?;
    let seconds: i64 = conn.query_row(
        "SELECT COALESCE(SUM(duration_seconds), 0) FROM activity_samples WHERE category = ?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok((rules, seconds))
}

/// Deleting a category does not delete what was in it. Rules and recorded time fall back
/// to `Neutral`, because time that was really spent must not vanish because its label did.
pub fn delete_category(conn: &mut Connection, id: i64, name: &str) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE known_apps SET category = ?1 WHERE category = ?2",
        params![CATEGORY_NEUTRAL, name],
    )?;
    tx.execute(
        "UPDATE activity_samples SET category = ?1 WHERE category = ?2",
        params![CATEGORY_NEUTRAL, name],
    )?;
    tx.execute(
        "UPDATE schedule_blocks SET category = ?1 WHERE category = ?2",
        params![CATEGORY_NEUTRAL, name],
    )?;
    tx.execute(
        "DELETE FROM category_targets WHERE category = ?1",
        params![name],
    )?;
    tx.execute("DELETE FROM categories WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// Every category's total, per local day, over a range.
///
/// `localtime` is doing real work: SQLite resolves it against this machine's own timezone,
/// DST included, which is the same boundary `dayBounds()` uses in the frontend. A fixed UTC
/// offset would quietly misfile an hour twice a year and nobody would notice until a
/// streak broke for no reason.
///
/// Idle rows are kept. `Idle` is a category like any other here, and a chart that hides it
/// would draw a day of nothing as a day of nothing happening — which are different claims.
pub fn daily_totals(conn: &Connection, start_ts: i64, end_ts: i64) -> Result<Vec<DailyTotal>> {
    let mut stmt = conn.prepare_cached(
        "SELECT date(ts, 'unixepoch', 'localtime') AS day,
                category,
                SUM(duration_seconds) AS seconds
           FROM activity_samples
          WHERE ts >= ?1 AND ts < ?2
          GROUP BY day, category
          ORDER BY day, seconds DESC",
    )?;
    let rows = stmt
        .query_map(params![start_ts, end_ts], |row| {
            Ok(DailyTotal {
                day: row.get(0)?,
                category: row.get(1)?,
                seconds: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn load_targets(conn: &Connection) -> Result<Vec<CategoryTarget>> {
    let mut stmt = conn.prepare(
        "SELECT category, direction, seconds_per_day, created_at
           FROM category_targets ORDER BY category",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CategoryTarget {
                category: row.get(0)?,
                direction: row.get(1)?,
                seconds_per_day: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn upsert_target(conn: &Connection, target: &CategoryTarget, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO category_targets (category, direction, seconds_per_day, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(category) DO UPDATE SET
            direction = excluded.direction,
            seconds_per_day = excluded.seconds_per_day",
        params![
            target.category,
            target.direction,
            target.seconds_per_day,
            now
        ],
    )?;
    Ok(())
}

pub fn delete_target(conn: &Connection, category: &str) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM category_targets WHERE category = ?1",
        params![category],
    )?)
}

/// Wipes measured activity and nothing else. Plans, schedule, tasks and the registry are
/// answers to different questions and survive.
pub fn clear_activity_samples(conn: &Connection) -> Result<usize> {
    let deleted = conn.execute("DELETE FROM activity_samples", [])?;
    conn.execute_batch("VACUUM")?;
    Ok(deleted)
}

/// Upsert by pattern. Seeding uses `is_user_defined = 0` and must not clobber a rule the
/// user edited, so the seed path passes `overwrite = false`.
pub fn upsert_app_rule(conn: &Connection, rule: &AppRule, overwrite: bool) -> Result<()> {
    if overwrite {
        conn.execute(
            "INSERT INTO known_apps
                (match_type, pattern, display_name, category, is_user_defined, priority)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(pattern) DO UPDATE SET
                match_type = excluded.match_type,
                display_name = excluded.display_name,
                category = excluded.category,
                is_user_defined = excluded.is_user_defined,
                priority = excluded.priority",
            params![
                rule.match_type,
                rule.pattern,
                rule.display_name,
                rule.category,
                rule.is_user_defined as i64,
                rule.priority
            ],
        )?;
    } else {
        conn.execute(
            "INSERT OR IGNORE INTO known_apps
                (match_type, pattern, display_name, category, is_user_defined, priority)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                rule.match_type,
                rule.pattern,
                rule.display_name,
                rule.category,
                rule.is_user_defined as i64,
                rule.priority
            ],
        )?;
    }
    Ok(())
}

/// Moves one rule to another category, leaving its pattern and name alone. The caller
/// pairs this with `recategorize_samples` so the correction reaches the past too.
pub fn set_app_rule_category(conn: &Connection, id: i64, category: &str) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE known_apps SET category = ?1 WHERE id = ?2",
        params![category, id],
    )?)
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
                (provider, external_id, course_code, title, due_at, html_url, completed,
                 completed_locally_at, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(provider, external_id) DO UPDATE SET
                course_code = excluded.course_code,
                title       = excluded.title,
                due_at      = excluded.due_at,
                html_url    = excluded.html_url,
                synced_at   = excluded.synced_at,
                -- One direction only. The provider saying an assignment is handed in
                -- marks it done here; the provider not knowing — which is every task from
                -- a calendar feed — must never un-tick something ticked by hand.
                completed = CASE WHEN excluded.completed = 1 THEN 1 ELSE tasks.completed END,
                -- When it was first seen as done, so the Completed list can date it. Kept
                -- if it is already set, or re-syncing would reset the date every time.
                completed_locally_at = CASE
                    WHEN excluded.completed = 1
                    THEN COALESCE(tasks.completed_locally_at, excluded.synced_at)
                    ELSE tasks.completed_locally_at
                END",
        )?;
        for task in tasks {
            stmt.execute(params![
                task.provider,
                task.external_id,
                task.course_code,
                task.title,
                task.due_at,
                task.html_url,
                task.completed as i64,
                if task.completed { Some(now) } else { None },
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


pub fn delete_setting(conn: &Connection, key: &str) -> Result<usize> {
    Ok(conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ActivitySample, TARGET_AT_MOST};

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run_migrations(&conn).unwrap();
        conn
    }

    fn sample(ts: i64, category: &str, seconds: i64) -> ActivitySample {
        ActivitySample {
            ts,
            duration_seconds: seconds,
            process_name: "thing".to_string(),
            app_name: None,
            window_title: None,
            category: category.to_string(),
            source: "passive".to_string(),
            client_id: None,
            is_idle: false,
        }
    }

    /// Local midnight for a day `days_ago`, as a UTC timestamp — the same boundary
    /// `date(ts,'unixepoch','localtime')` will resolve against.
    fn local_midnight(conn: &Connection, days_ago: i64) -> i64 {
        conn.query_row(
            "SELECT unixepoch(date('now', 'localtime', ?1 || ' days'), 'utc')",
            params![-days_ago],
            |row| row.get(0),
        )
        .unwrap()
    }

    // Handing something in on Canvas has to reach the Completed list; ticking something
    // off here must survive a feed that has no idea either way.
    #[test]
    fn a_resync_can_complete_a_task_but_never_uncomplete_one() {
        let mut conn = memory_db();

        let task = |completed: bool| LmsTask {
            id: 0,
            provider: "canvas".to_string(),
            external_id: "assignment:1".to_string(),
            course_code: None,
            title: "Ch2 Prelecture".to_string(),
            due_at: Some(1_700_000_000),
            html_url: None,
            completed,
            completed_at: None,
        };

        upsert_tasks(&mut conn, &[task(false)]).unwrap();
        let done = |conn: &Connection| -> i64 {
            conn.query_row("SELECT completed FROM tasks", [], |row| row.get(0))
                .unwrap()
        };
        assert_eq!(done(&conn), 0);

        // Canvas now reports it submitted.
        upsert_tasks(&mut conn, &[task(true)]).unwrap();
        assert_eq!(done(&conn), 1);
        let dated: Option<i64> = conn
            .query_row("SELECT completed_locally_at FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert!(dated.is_some(), "the Completed list needs a date to sort by");

        // And the calendar feed, which knows nothing about submissions, does not undo it.
        upsert_tasks(&mut conn, &[task(false)]).unwrap();
        assert_eq!(done(&conn), 1);
        let still: Option<i64> = conn
            .query_row("SELECT completed_locally_at FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(still, dated, "and does not re-date it either");
    }

    // Two copies of Nudgy each wrote a sample for the same second, and the day added up
    // past twenty-four hours. One second of one app is one row — the second offer is
    // dropped, and the count says so rather than reporting what it was handed.
    #[test]
    fn the_same_second_is_only_counted_once() {
        let mut conn = memory_db();
        let ts = local_midnight(&conn, 0) + 3_600;

        assert_eq!(insert_samples(&mut conn, &[sample(ts, "Development", 5)]).unwrap(), 1);
        assert_eq!(insert_samples(&mut conn, &[sample(ts, "Development", 5)]).unwrap(), 0);

        let total: i64 = conn
            .query_row(
                "SELECT SUM(duration_seconds) FROM activity_samples",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(total, 5, "a replayed flush must not double the day");
    }

    // A different app in the same second is a different row — the guard is against the
    // same moment arriving twice, not against two names sharing a timestamp.
    #[test]
    fn a_different_app_in_the_same_second_still_lands() {
        let mut conn = memory_db();
        let ts = local_midnight(&conn, 0) + 3_600;

        let mut other = sample(ts, "Neutral", 5);
        other.process_name = "something-else".to_string();

        assert_eq!(insert_samples(&mut conn, &[sample(ts, "Development", 5)]).unwrap(), 1);
        assert_eq!(insert_samples(&mut conn, &[other]).unwrap(), 1);
    }

    // The whole reason `localtime` is in that query. Two samples an hour either side of
    // local midnight are two different days to a person, and a UTC grouping would file
    // them together for anyone west of Greenwich.
    #[test]
    fn samples_are_bucketed_by_local_day() {
        let mut conn = memory_db();
        let midnight = local_midnight(&conn, 0);

        insert_samples(
            &mut conn,
            &[
                sample(midnight - 3600, "Development", 600), // late yesterday
                sample(midnight + 3600, "Development", 900), // early today
            ],
        )
        .unwrap();

        let rows = daily_totals(&conn, midnight - 86_400, midnight + 86_400).unwrap();
        assert_eq!(rows.len(), 2, "expected one row per local day, got {rows:?}");
        assert_eq!(rows[0].seconds, 600);
        assert_eq!(rows[1].seconds, 900);
        assert_ne!(rows[0].day, rows[1].day);
    }

    #[test]
    fn daily_totals_splits_categories_within_a_day() {
        let mut conn = memory_db();
        let midnight = local_midnight(&conn, 0);
        insert_samples(
            &mut conn,
            &[
                sample(midnight + 3600, "Development", 600),
                sample(midnight + 7200, "Development", 300),
                // A second of its own: one app cannot be in two categories at one
                // instant, and since migration 12 the table will not pretend it can.
                sample(midnight + 7205, "Free Time", 1200),
            ],
        )
        .unwrap();

        let rows = daily_totals(&conn, midnight, midnight + 86_400).unwrap();
        assert_eq!(rows.len(), 2);
        // Ordered by seconds within the day, so the biggest slice leads.
        assert_eq!(rows[0].category, "Free Time");
        assert_eq!(rows[0].seconds, 1200);
        assert_eq!(rows[1].seconds, 900);
    }

    #[test]
    fn a_target_is_upserted_rather_than_duplicated() {
        let conn = memory_db();
        let mut target = CategoryTarget {
            category: "Free Time".to_string(),
            direction: TARGET_AT_MOST.to_string(),
            seconds_per_day: 3600,
            created_at: 0,
        };
        upsert_target(&conn, &target, 100).unwrap();
        target.seconds_per_day = 5400;
        upsert_target(&conn, &target, 200).unwrap();

        let stored = load_targets(&conn).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].seconds_per_day, 5400);
    }

    // A target pointing at a category that no longer exists could never be shown or met.
    #[test]
    fn deleting_a_category_takes_its_target() {
        let mut conn = memory_db();
        conn.execute(
            "INSERT INTO categories (name, color, sort_order, is_builtin) VALUES ('Reading', '#fff', 90, 0)",
            [],
        )
        .unwrap();
        let id: i64 = conn
            .query_row("SELECT id FROM categories WHERE name = 'Reading'", [], |row| row.get(0))
            .unwrap();

        upsert_target(
            &conn,
            &CategoryTarget {
                category: "Reading".to_string(),
                direction: TARGET_AT_MOST.to_string(),
                seconds_per_day: 3600,
                created_at: 0,
            },
            0,
        )
        .unwrap();

        delete_category(&mut conn, id, "Reading").unwrap();
        assert!(load_targets(&conn).unwrap().is_empty());
    }
}
