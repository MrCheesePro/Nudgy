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
    // 7 — categories stop being a compile-time constant and become rows, so a person can
    //     add one. `Free Time` arrives as an eighth built-in; Gaming and Social stay
    //     separate, because "a game" and "a group chat" are not the same evening.
    //
    //     `priority` fixes a real ambiguity: title rules used to fire in alphabetical
    //     pattern order, so which rule claimed "YouTube — how to write a thesis" was luck.
    //     School rules now outrank media rules, which is what "Chrome is Neutral unless it
    //     is coursework" actually means, and a rule the user wrote outranks both.
    r#"
    CREATE TABLE IF NOT EXISTS categories (
        id         INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL UNIQUE,
        color      TEXT    NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 100,
        is_builtin INTEGER NOT NULL DEFAULT 0
    );

    -- Colours are the ones the frontend already drew, so nothing on screen shifts hue.
    INSERT OR IGNORE INTO categories (name, color, sort_order, is_builtin) VALUES
      ('Development',  '#8b7bd8', 10, 1),
      ('Productivity', '#4fa88c', 20, 1),
      ('Creative',     '#e0a05e', 30, 1),
      ('Social',       '#e0818f', 40, 1),
      ('Gaming',       '#b07bd4', 50, 1),
      ('Free Time',    '#7fb2e5', 60, 1),
      ('Neutral',      '#bda3a7', 70, 1),
      ('Idle',         '#e7d2d5', 80, 1);

    ALTER TABLE known_apps ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;

    -- Seeding is insert-or-ignore and cannot move an existing row, so the reclassification
    -- of watching-things happens here. The samples already recorded move with the rule:
    -- a correction that only applies going forward leaves the charts wrong forever.
    UPDATE known_apps SET category = 'Free Time'
     WHERE match_type = 'title_regex'
       AND is_user_defined = 0
       AND display_name IN ('YouTube', 'Netflix', 'Twitch', 'Spotify');

    UPDATE activity_samples SET category = 'Free Time'
     WHERE is_idle = 0
       AND window_title IN ('YouTube', 'Netflix', 'Twitch', 'Spotify');

    UPDATE known_apps SET priority = 200
     WHERE match_type = 'title_regex' AND category = 'Productivity';
    UPDATE known_apps SET priority = 300 WHERE is_user_defined = 1;
    "#,
    // 8 — places and the time between them.
    //
    //     A day is not just hours, it is hours in rooms. An 8:00 class twenty-five minutes
    //     away means work stops at 7:35, and a planner that does not know this hands you a
    //     schedule you cannot physically keep.
    //
    //     `travel_cache` is not an optimisation, it is the offline story: addresses do not
    //     move, so one lookup answers forever and a plan made on a train still knows how
    //     far the library is.
    r#"
    CREATE TABLE IF NOT EXISTS places (
        id         INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL UNIQUE,
        address    TEXT    NOT NULL,
        -- Exactly one row may carry this; `set_base_place` clears the others first.
        is_base    INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS travel_cache (
        origin_id      INTEGER NOT NULL,
        destination_id INTEGER NOT NULL,
        mode           TEXT    NOT NULL,
        seconds        INTEGER NOT NULL,
        fetched_at     INTEGER NOT NULL,
        PRIMARY KEY (origin_id, destination_id, mode),
        FOREIGN KEY (origin_id)      REFERENCES places(id) ON DELETE CASCADE,
        FOREIGN KEY (destination_id) REFERENCES places(id) ON DELETE CASCADE
    );

    -- Where a hand-written task happens. NULL is the normal case and means no travel.
    ALTER TABLE schedule_blocks ADD COLUMN place_id INTEGER;
    -- Travel already accounted for before this block starts, in seconds. Stored rather
    -- than recomputed so a block drawn tomorrow shows the number it was planned against.
    ALTER TABLE schedule_blocks ADD COLUMN travel_before_seconds INTEGER NOT NULL DEFAULT 0;
    "#,
    // 9 — what a good day is supposed to look like.
    //
    //     Tracking answers "where did it go". A target is the other half: "where did I
    //     want it to go", which is the only thing that makes a week comparable to the one
    //     before it. Keyed by category name, the same way `known_apps` and
    //     `schedule_blocks` already refer to categories.
    r#"
    CREATE TABLE IF NOT EXISTS category_targets (
        category        TEXT    PRIMARY KEY,
        -- 'at_least' is a floor to reach, 'at_most' a ceiling not to pass. The direction
        -- is what makes a fall in minutes good news or bad news.
        direction       TEXT    NOT NULL,
        seconds_per_day INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
    );
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
