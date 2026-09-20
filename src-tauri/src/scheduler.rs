//! Schedule storage and the goal verifier.
//!
//! The verifier is the point of the whole application: it answers "did the block I
//! planned actually happen?" from measured data rather than self-report.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::db::queries;

pub const STATE_PENDING: &str = "pending";
pub const STATE_MET: &str = "met";
pub const STATE_MISSED: &str = "missed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleBlock {
    #[serde(default)]
    pub id: i64,
    pub day: String,
    pub start_ts: i64,
    pub end_ts: i64,
    pub label: String,
    #[serde(default = "default_category")]
    pub category: String,
    pub target_process: Option<String>,
    pub target_seconds: Option<i64>,
    #[serde(default = "default_state")]
    pub verified_state: String,
    #[serde(default = "default_source")]
    pub source: String,
    /// Seconds before the start to give a nudge. `None` defers to the global default;
    /// `Some(0)` is a deliberate "tell me as it begins".
    #[serde(default)]
    pub reminder_lead_seconds: Option<i64>,
    /// Set when this block belongs to a work plan, so progress rolls up to the estimate.
    #[serde(default)]
    pub plan_id: Option<i64>,
}

fn default_category() -> String {
    "Productivity".to_string()
}

fn default_state() -> String {
    STATE_PENDING.to_string()
}

fn default_source() -> String {
    "llm".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub block_id: i64,
    pub accumulated_seconds: i64,
    pub target_seconds: i64,
    pub met: bool,
    pub state: String,
}

const INSERT_BLOCK: &str = "INSERT INTO schedule_blocks
     (day, start_ts, end_ts, label, category, target_process,
      target_seconds, verified_state, source, plan_id, reminder_lead_seconds)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)";

/// Replaces a day's schedule wholesale, except for blocks that belong to a plan —
/// regenerating an agenda must not silently delete work the user committed to.
pub fn save_day(conn: &mut Connection, day: &str, blocks: &[ScheduleBlock]) -> Result<usize> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM schedule_blocks WHERE day = ?1 AND plan_id IS NULL",
        params![day],
    )?;
    {
        let mut stmt = tx.prepare_cached(INSERT_BLOCK)?;
        for block in blocks.iter().filter(|block| block.plan_id.is_none()) {
            stmt.execute(params![
                day,
                block.start_ts,
                block.end_ts,
                block.label,
                block.category,
                block.target_process,
                block.target_seconds,
                block.verified_state,
                block.source,
                block.plan_id,
                block.reminder_lead_seconds,
            ])?;
        }
    }
    tx.commit()?;
    Ok(blocks.len())
}

/// Adds blocks without disturbing what is already there. Used when a plan is committed;
/// `day` is the fallback for blocks that do not carry their own.
pub fn append_day(
    conn: &Connection,
    day: &str,
    blocks: &[ScheduleBlock],
    plan_id: Option<i64>,
) -> Result<usize> {
    let mut stmt = conn.prepare_cached(INSERT_BLOCK)?;
    for block in blocks {
        let block_day = if block.day.is_empty() { day } else { &block.day };
        stmt.execute(params![
            block_day,
            block.start_ts,
            block.end_ts,
            block.label,
            block.category,
            block.target_process,
            block.target_seconds,
            block.verified_state,
            block.source,
            plan_id.or(block.plan_id),
            block.reminder_lead_seconds,
        ])?;
    }
    Ok(blocks.len())
}

/// Blocks across a span of days, inclusive. `YYYY-MM-DD` sorts and compares correctly as
/// text, so no date maths is needed here.
pub fn load_range(conn: &Connection, start_day: &str, end_day: &str) -> Result<Vec<ScheduleBlock>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, day, start_ts, end_ts, label, category, target_process,
                target_seconds, verified_state, source, plan_id, reminder_lead_seconds
           FROM schedule_blocks
          WHERE day >= ?1 AND day <= ?2
          ORDER BY start_ts ASC",
    )?;
    let rows = stmt
        .query_map(params![start_day, end_day], |row| {
            Ok(ScheduleBlock {
                id: row.get(0)?,
                day: row.get(1)?,
                start_ts: row.get(2)?,
                end_ts: row.get(3)?,
                label: row.get(4)?,
                category: row.get(5)?,
                target_process: row.get(6)?,
                target_seconds: row.get(7)?,
                verified_state: row.get(8)?,
                source: row.get(9)?,
                plan_id: row.get(10)?,
                reminder_lead_seconds: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn load_day(conn: &Connection, day: &str) -> Result<Vec<ScheduleBlock>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, day, start_ts, end_ts, label, category, target_process,
                target_seconds, verified_state, source, plan_id, reminder_lead_seconds
           FROM schedule_blocks
          WHERE day = ?1
          ORDER BY start_ts ASC",
    )?;
    let rows = stmt
        .query_map(params![day], |row| {
            Ok(ScheduleBlock {
                id: row.get(0)?,
                day: row.get(1)?,
                start_ts: row.get(2)?,
                end_ts: row.get(3)?,
                label: row.get(4)?,
                category: row.get(5)?,
                target_process: row.get(6)?,
                target_seconds: row.get(7)?,
                verified_state: row.get(8)?,
                source: row.get(9)?,
                plan_id: row.get(10)?,
                reminder_lead_seconds: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Checks one block against recorded activity.
///
/// A block with no target process can never be verified automatically and stays
/// `pending`. A block whose window has not closed yet also stays `pending` — it has not
/// failed, it simply has not finished.
pub fn verify_block(conn: &Connection, block: &ScheduleBlock, now: i64) -> Result<VerificationResult> {
    let target_seconds = block
        .target_seconds
        .unwrap_or_else(|| (block.end_ts - block.start_ts).max(0));

    let Some(process) = block.target_process.as_deref() else {
        return Ok(VerificationResult {
            block_id: block.id,
            accumulated_seconds: 0,
            target_seconds,
            met: false,
            state: STATE_PENDING.to_string(),
        });
    };

    let accumulated =
        queries::active_seconds_for_process(conn, process, block.start_ts, block.end_ts)?;
    let met = accumulated >= target_seconds;

    let state = if met {
        STATE_MET
    } else if now < block.end_ts {
        STATE_PENDING
    } else {
        STATE_MISSED
    };

    if block.id > 0 {
        conn.execute(
            "UPDATE schedule_blocks SET verified_state = ?2 WHERE id = ?1",
            params![block.id, state],
        )?;
    }

    Ok(VerificationResult {
        block_id: block.id,
        accumulated_seconds: accumulated,
        target_seconds,
        met,
        state: state.to_string(),
    })
}

pub fn verify_day(conn: &Connection, day: &str, now: i64) -> Result<Vec<VerificationResult>> {
    load_day(conn, day)?
        .iter()
        .map(|block| verify_block(conn, block, now))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ActivitySample;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run_migrations(&conn).unwrap();
        conn
    }

    fn sample(ts: i64, process: &str, is_idle: bool) -> ActivitySample {
        ActivitySample {
            ts,
            duration_seconds: 300,
            process_name: process.to_string(),
            app_name: None,
            window_title: None,
            category: "Creative".to_string(),
            source: "passive".to_string(),
            client_id: None,
            is_idle,
        }
    }

    fn block(start: i64, end: i64, target: i64) -> ScheduleBlock {
        ScheduleBlock {
            id: 0,
            day: "2026-09-18".to_string(),
            start_ts: start,
            end_ts: end,
            label: "Draw".to_string(),
            category: "Creative".to_string(),
            target_process: Some("ClipStudioPaint.exe".to_string()),
            target_seconds: Some(target),
            verified_state: STATE_PENDING.to_string(),
            source: "llm".to_string(),
            plan_id: None,
            reminder_lead_seconds: None,
        }
    }

    #[test]
    fn a_block_is_met_once_enough_active_time_accumulates() {
        let mut conn = memory_db();
        let samples: Vec<ActivitySample> = (0..6)
            .map(|index| sample(1_000 + index * 300, "ClipStudioPaint.exe", false))
            .collect();
        queries::insert_samples(&mut conn, &samples).unwrap();

        let result = verify_block(&conn, &block(1_000, 3_000, 1_800), 5_000).unwrap();
        assert!(result.met);
        assert_eq!(result.state, STATE_MET);
    }

    #[test]
    fn idle_time_inside_the_window_does_not_count() {
        let mut conn = memory_db();
        let samples: Vec<ActivitySample> = (0..6)
            .map(|index| sample(1_000 + index * 300, "ClipStudioPaint.exe", true))
            .collect();
        queries::insert_samples(&mut conn, &samples).unwrap();

        let result = verify_block(&conn, &block(1_000, 3_000, 1_800), 5_000).unwrap();
        assert_eq!(result.accumulated_seconds, 0);
        assert_eq!(result.state, STATE_MISSED);
    }

    #[test]
    fn an_unfinished_block_stays_pending_rather_than_missed() {
        let conn = memory_db();
        let result = verify_block(&conn, &block(1_000, 3_000, 1_800), 1_500).unwrap();
        assert_eq!(result.state, STATE_PENDING);
    }

    #[test]
    fn saving_a_day_replaces_the_previous_plan() {
        let mut conn = memory_db();
        save_day(&mut conn, "2026-09-18", &[block(1_000, 3_000, 1_800)]).unwrap();
        save_day(&mut conn, "2026-09-18", &[block(4_000, 6_000, 1_800)]).unwrap();

        let stored = load_day(&conn, "2026-09-18").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].start_ts, 4_000);
    }
}
