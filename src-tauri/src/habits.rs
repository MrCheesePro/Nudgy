//! Habits: things you declare rather than things the watcher measures.
//!
//! The storage half. All the streak arithmetic lives in `src/services/habits.ts`, where it
//! is pure and tested — the backend's job is to remember what was ticked, not to work out
//! what that adds up to.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// How much history to hand the frontend.
///
/// Enough for any streak anybody will actually have, and small enough to send on every
/// refresh without thinking about it. A longer run than this is still counted correctly up
/// to the edge of the window; it simply cannot be shown as longer.
pub const HISTORY_DAYS: i64 = 400;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Habit {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    /// 0 is Sunday. Empty means every day.
    #[serde(default)]
    pub weekdays: Vec<u32>,
    /// `YYYY-MM-DD`, local. The frontend needs the day, never the instant.
    #[serde(default)]
    pub created_day: String,
    #[serde(default)]
    pub archived_day: Option<String>,
}

/// Habits and their ticks, in one answer.
///
/// Together rather than in two commands because a streak is meaningless without both, and
/// two round trips means a frame where the counts are wrong.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitsSnapshot {
    pub habits: Vec<Habit>,
    /// `(habit id, day)` pairs. A flat list, because the frontend groups it into sets.
    pub ticks: Vec<(i64, String)>,
}

pub fn create(conn: &Connection, name: &str, weekdays: &[u32]) -> Result<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow::anyhow!("a habit needs a name"));
    }

    conn.execute(
        "INSERT INTO habits (name, weekdays, created_at) VALUES (?1, ?2, ?3)",
        params![name, join(weekdays), chrono::Utc::now().timestamp()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn rename(conn: &Connection, id: i64, name: &str, weekdays: &[u32]) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow::anyhow!("a habit needs a name"));
    }

    conn.execute(
        "UPDATE habits SET name = ?2, weekdays = ?3 WHERE id = ?1",
        params![id, name, join(weekdays)],
    )?;
    Ok(())
}

/// Puts a habit away without destroying what it recorded.
///
/// A month you kept something up happened, whether or not you are still doing it — and the
/// perfect-day streak has to know a habit was *not* asked for after this date, which a
/// delete could not express.
pub fn archive(conn: &Connection, id: i64, archived: bool) -> Result<()> {
    conn.execute(
        "UPDATE habits SET archived_at = ?2 WHERE id = ?1",
        params![id, archived.then(|| chrono::Utc::now().timestamp())],
    )?;
    Ok(())
}

/// Deletes a habit and everything it ticked. Offered only behind a confirmation, and
/// distinct from archiving on purpose: this is the one that loses the history.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM habit_days WHERE habit_id = ?1", params![id])?;
    conn.execute("DELETE FROM habits WHERE id = ?1", params![id])?;
    Ok(())
}

/// Ticks or unticks one day. Idempotent in both directions.
pub fn set_done(conn: &Connection, id: i64, day: &str, done: bool) -> Result<()> {
    if done {
        conn.execute(
            "INSERT OR IGNORE INTO habit_days (habit_id, day, done_at) VALUES (?1, ?2, ?3)",
            params![id, day, chrono::Utc::now().timestamp()],
        )?;
    } else {
        conn.execute(
            "DELETE FROM habit_days WHERE habit_id = ?1 AND day = ?2",
            params![id, day],
        )?;
    }
    Ok(())
}

pub fn snapshot(conn: &Connection) -> Result<HabitsSnapshot> {
    let mut stmt = conn.prepare(
        "SELECT id, name, weekdays,
                date(created_at, 'unixepoch', 'localtime'),
                CASE WHEN archived_at IS NULL THEN NULL
                     ELSE date(archived_at, 'unixepoch', 'localtime') END
           FROM habits
          ORDER BY archived_at IS NOT NULL, id",
    )?;
    let habits = stmt
        .query_map([], |row| {
            Ok(Habit {
                id: row.get(0)?,
                name: row.get(1)?,
                weekdays: split(row.get::<_, Option<String>>(2)?.as_deref()),
                created_day: row.get(3)?,
                archived_day: row.get(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let cutoff = chrono::Utc::now().timestamp() - HISTORY_DAYS * 86_400;
    let mut stmt = conn.prepare(
        "SELECT habit_id, day FROM habit_days WHERE done_at >= ?1 ORDER BY day",
    )?;
    let ticks = stmt
        .query_map(params![cutoff], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(HabitsSnapshot { habits, ticks })
}

fn join(weekdays: &[u32]) -> Option<String> {
    let mut days: Vec<u32> = weekdays.iter().copied().filter(|day| *day < 7).collect();
    days.sort_unstable();
    days.dedup();
    if days.is_empty() {
        return None;
    }
    Some(days.iter().map(u32::to_string).collect::<Vec<_>>().join(","))
}

/// Anything unparseable is dropped rather than failing the row: a broken weekday list
/// should cost a day of a schedule, not the whole habit.
fn split(raw: Option<&str>) -> Vec<u32> {
    raw.map(|value| {
        value
            .split(',')
            .filter_map(|part| part.trim().parse::<u32>().ok())
            .filter(|day| *day < 7)
            .collect()
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run_migrations(&conn).unwrap();
        conn
    }

    #[test]
    fn a_habit_round_trips_with_its_days() {
        let conn = memory_db();
        let id = create(&conn, "  Gym  ", &[3, 1, 5, 1]).unwrap();

        let stored = snapshot(&conn).unwrap();
        assert_eq!(stored.habits.len(), 1);
        assert_eq!(stored.habits[0].name, "Gym", "trimmed");
        assert_eq!(stored.habits[0].weekdays, vec![1, 3, 5], "sorted and deduped");
        assert_eq!(stored.habits[0].archived_day, None);

        set_done(&conn, id, "2026-09-23", true).unwrap();
        assert_eq!(snapshot(&conn).unwrap().ticks, vec![(id, "2026-09-23".to_string())]);
    }

    // Two clicks in the same second must not make two rows, and unticking is a delete.
    #[test]
    fn ticking_is_idempotent_in_both_directions() {
        let conn = memory_db();
        let id = create(&conn, "Journal", &[]).unwrap();

        set_done(&conn, id, "2026-09-23", true).unwrap();
        set_done(&conn, id, "2026-09-23", true).unwrap();
        assert_eq!(snapshot(&conn).unwrap().ticks.len(), 1);

        set_done(&conn, id, "2026-09-23", false).unwrap();
        set_done(&conn, id, "2026-09-23", false).unwrap();
        assert!(snapshot(&conn).unwrap().ticks.is_empty());
    }

    // Archiving keeps the history; deleting is the one that loses it.
    #[test]
    fn archiving_keeps_the_ticks_and_deleting_does_not() {
        let conn = memory_db();
        let id = create(&conn, "Gym", &[]).unwrap();
        set_done(&conn, id, "2026-09-23", true).unwrap();

        archive(&conn, id, true).unwrap();
        let after = snapshot(&conn).unwrap();
        assert!(after.habits[0].archived_day.is_some());
        assert_eq!(after.ticks.len(), 1);

        archive(&conn, id, false).unwrap();
        assert_eq!(snapshot(&conn).unwrap().habits[0].archived_day, None);

        delete(&conn, id).unwrap();
        let gone = snapshot(&conn).unwrap();
        assert!(gone.habits.is_empty());
        assert!(gone.ticks.is_empty(), "its days go with it");
    }

    #[test]
    fn a_habit_needs_a_name() {
        let conn = memory_db();
        assert!(create(&conn, "   ", &[]).is_err());
        let id = create(&conn, "Gym", &[]).unwrap();
        assert!(rename(&conn, id, "", &[]).is_err());
    }

    #[test]
    fn an_empty_schedule_means_every_day() {
        let conn = memory_db();
        create(&conn, "Journal", &[]).unwrap();
        assert!(snapshot(&conn).unwrap().habits[0].weekdays.is_empty());
    }
}
