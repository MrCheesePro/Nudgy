use anyhow::Result;
use rusqlite::Connection;

/// Each entry is one forward-only migration. Adding a new schema change means appending
/// to this list — never editing an existing entry, since machines in the wild have
/// already run it. `user_version` records how far a given database has come.
const MIGRATIONS: &[&str] = &[
    // 1 — tracking core
    r#"
    CREATE TABLE IF NOT EXISTS activity_samples (
        id               INTEGER PRIMARY KEY,
        ts               INTEGER NOT NULL,
        duration_seconds INTEGER NOT NULL,
        process_name     TEXT    NOT NULL,
        app_name         TEXT,
        window_title     TEXT,
        category         TEXT    NOT NULL,
        source           TEXT    NOT NULL,
        client_id        TEXT,
        is_idle          INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_samples_ts       ON activity_samples(ts);
    CREATE INDEX IF NOT EXISTS idx_samples_proc_ts  ON activity_samples(process_name, ts);
    CREATE INDEX IF NOT EXISTS idx_samples_cat_ts   ON activity_samples(category, ts);

    CREATE TABLE IF NOT EXISTS known_apps (
        id              INTEGER PRIMARY KEY,
        match_type      TEXT    NOT NULL,
        pattern         TEXT    NOT NULL UNIQUE,
        display_name    TEXT    NOT NULL,
        category        TEXT    NOT NULL,
        is_user_defined INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS redaction_rules (
        id              INTEGER PRIMARY KEY,
        match_type      TEXT    NOT NULL,
        pattern         TEXT    NOT NULL UNIQUE,
        is_user_defined INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // 2 — tasks, goals and schedule blocks (populated in M3/M4, created now so the
    //     schema does not move underneath an already-shipped database)
    r#"
    CREATE TABLE IF NOT EXISTS tasks (
        id                  INTEGER PRIMARY KEY,
        provider            TEXT    NOT NULL,
        external_id         TEXT    NOT NULL,
        course_code         TEXT,
        title               TEXT    NOT NULL,
        due_at              INTEGER,
        html_url            TEXT,
        completed           INTEGER NOT NULL DEFAULT 0,
        completed_locally_at INTEGER,
        synced_at           INTEGER,
        UNIQUE(provider, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);

    CREATE TABLE IF NOT EXISTS goals (
        id             INTEGER PRIMARY KEY,
        label          TEXT    NOT NULL,
        target_process TEXT,
        target_seconds INTEGER NOT NULL DEFAULT 0,
        cadence        TEXT    NOT NULL DEFAULT 'daily',
        active         INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS schedule_blocks (
        id             INTEGER PRIMARY KEY,
        day            TEXT    NOT NULL,
        start_ts       INTEGER NOT NULL,
        end_ts         INTEGER NOT NULL,
        label          TEXT    NOT NULL,
        category       TEXT    NOT NULL DEFAULT 'Productivity',
        target_process TEXT,
        target_seconds INTEGER,
        verified_state TEXT    NOT NULL DEFAULT 'pending',
        source         TEXT    NOT NULL DEFAULT 'manual'
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_day ON schedule_blocks(day);
    "#,
    // 3 — work plans: an estimate for a piece of work, the blocks it was broken into,
    //     and the running check-in conversation about whether the estimate still holds.
    r#"
    CREATE TABLE IF NOT EXISTS plans (
        id                   INTEGER PRIMARY KEY,
        task_id              INTEGER,
        title                TEXT    NOT NULL,
        estimate_seconds     INTEGER NOT NULL,
        mode                 TEXT    NOT NULL DEFAULT 'pomodoro',
        focus_seconds        INTEGER NOT NULL DEFAULT 2700,
        status               TEXT    NOT NULL DEFAULT 'active',
        -- Accumulated working seconds at which to ask the user how it is going. NULL
        -- means a check-in is already on screen waiting for an answer.
        next_checkin_seconds INTEGER,
        checkin_count        INTEGER NOT NULL DEFAULT 0,
        due_at               INTEGER,
        created_at           INTEGER NOT NULL,
        completed_at         INTEGER,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);

    ALTER TABLE schedule_blocks ADD COLUMN plan_id INTEGER;
    CREATE INDEX IF NOT EXISTS idx_blocks_plan ON schedule_blocks(plan_id);
    "#,
    // 4 — how a plan's pomodoro sessions are shaped, so editing a plan restores the
    //     style it was built with rather than guessing.
    r#"
    ALTER TABLE plans ADD COLUMN pomodoro_style TEXT NOT NULL DEFAULT 'custom';
    ALTER TABLE plans ADD COLUMN break_seconds INTEGER NOT NULL DEFAULT 300;
    "#,
    // 5 — `window_title` stopped meaning "the page's own words" and started meaning a
    //     short site label from a registry rule. Rows written under the old meaning hold
    //     raw titles that nothing should display any more, so they are dropped rather
    //     than left to surface as site labels. The redaction sentinel stays: it records
    //     that something private was deliberately withheld, which is worth keeping.
    r#"
    UPDATE activity_samples
       SET window_title = NULL
     WHERE window_title IS NOT NULL
       AND window_title <> '[Private]';
    "#,
    // 6 — the seeded title rules used to be broad buckets: one regex matching youtube,
    //     twitch, netflix and hulu alike, labelled "Streaming (web)". Now that the label
    //     is shown next to the app, it has to name the actual site, and the per-site
    //     rules that replace these sort after them — so the bucket would always win.
    //     Seeding is insert-or-ignore and cannot remove a row, so they go here. Rules the
    //     user wrote are untouched.
    r#"
    DELETE FROM known_apps
     WHERE match_type = 'title_regex'
       AND is_user_defined = 0
       AND display_name IN (
           'Development (web)', 'Documents (web)', 'Coursework (web)',
           'Streaming (web)', 'Social (web)'
       );

    -- An earlier pass shipped a pattern that tried to catch a bare "x" and matched far
    -- too much. The replacement is seeded under its own pattern, so drop the original.
    DELETE FROM known_apps
     WHERE match_type = 'title_regex'
       AND is_user_defined = 0
       AND pattern = '(?i)(^|\s)(x|twitter)\s*[/(]|\bon x\b|\btwitter\b';
    "#,
];

pub fn run_migrations(conn: &Connection) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let target = MIGRATIONS.len() as i64;

    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let version = index as i64 + 1;
        if version <= current {
            continue;
        }
        conn.execute_batch(sql)?;
        // PRAGMA does not accept bound parameters.
        conn.execute_batch(&format!("PRAGMA user_version = {version}"))?;
        log::info!("applied migration {version}");
    }

    if current > target {
        log::warn!("database user_version {current} is newer than this build expects ({target})");
    }
    Ok(())
}
