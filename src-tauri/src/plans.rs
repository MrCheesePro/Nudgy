//! Work plans and the check-in loop.
//!
//! A plan is an estimate ("this lab will take four hours") plus the blocks it was broken
//! into. Because estimates are usually wrong, the plan keeps asking: once you have
//! actually worked half of what is left, Nudgy interrupts and asks whether the estimate
//! still holds. Say "needs longer" and the estimate grows and the next check-in is
//! rescheduled; say "done" and it stops. That loop is the feature — a plan is a
//! conversation about an estimate, not a fixed prediction.
//!
//! Progress is measured, never self-reported: it is non-idle tracked time inside the
//! plan's own blocks.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub const MODE_CONTINUOUS: &str = "continuous";
pub const MODE_POMODORO: &str = "pomodoro";

pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_DONE: &str = "done";

/// Never ask twice inside this much working time, however the arithmetic falls out.
const MIN_CHECKIN_GAP_SECONDS: i64 = 15 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    #[serde(default)]
    pub id: i64,
    pub task_id: Option<i64>,
    pub title: String,
    pub estimate_seconds: i64,
    pub mode: String,
    /// `classic`, `flowmodoro` or `custom`.
    #[serde(default = "default_style")]
    pub pomodoro_style: String,
    pub focus_seconds: i64,
    #[serde(default = "default_break")]
    pub break_seconds: i64,
    #[serde(default = "default_status")]
    pub status: String,
    pub next_checkin_seconds: Option<i64>,
    #[serde(default)]
    pub checkin_count: i64,
    pub due_at: Option<i64>,
}

fn default_status() -> String {
    STATUS_ACTIVE.to_string()
}

fn default_style() -> String {
    "custom".to_string()
}

fn default_break() -> i64 {
    300
}

/// A plan plus the measured state the UI needs to talk about it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanProgress {
    pub plan: Plan,
    pub worked_seconds: i64,
    pub remaining_seconds: i64,
    pub percent: i64,
    /// True when a check-in is waiting for the user to answer.
    pub checkin_due: bool,
}

pub fn create(conn: &Connection, plan: &Plan) -> Result<i64> {
    let now = chrono::Utc::now().timestamp();
    // First check-in at the halfway mark of the original estimate.
    let first_checkin = (plan.estimate_seconds / 2).max(MIN_CHECKIN_GAP_SECONDS);

    conn.execute(
        "INSERT INTO plans
            (task_id, title, estimate_seconds, mode, pomodoro_style, focus_seconds,
             break_seconds, status, next_checkin_seconds, checkin_count, due_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, 0, ?9, ?10)",
        params![
            plan.task_id,
            plan.title,
            plan.estimate_seconds,
            plan.mode,
            plan.pomodoro_style,
            plan.focus_seconds,
            plan.break_seconds,
            first_checkin,
            plan.due_at,
            now,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn load_active(conn: &Connection) -> Result<Vec<Plan>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, task_id, title, estimate_seconds, mode, pomodoro_style, focus_seconds,
                break_seconds, status, next_checkin_seconds, checkin_count, due_at
           FROM plans WHERE status = 'active' ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Plan {
                id: row.get(0)?,
                task_id: row.get(1)?,
                title: row.get(2)?,
                estimate_seconds: row.get(3)?,
                mode: row.get(4)?,
                pomodoro_style: row.get(5)?,
                focus_seconds: row.get(6)?,
                break_seconds: row.get(7)?,
                status: row.get(8)?,
                next_checkin_seconds: row.get(9)?,
                checkin_count: row.get(10)?,
                due_at: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn load(conn: &Connection, id: i64) -> Result<Option<Plan>> {
    Ok(load_active(conn)?.into_iter().find(|plan| plan.id == id))
}

/// Measured working time for a plan: non-idle samples falling inside its blocks.
///
/// Blocks with a `target_process` only count time in that app; blocks without one count
/// any activity, because "write the lab report" has no single executable behind it.
pub fn worked_seconds(conn: &Connection, plan_id: i64) -> Result<i64> {
    let seconds: i64 = conn.query_row(
        "SELECT COALESCE(SUM(s.duration_seconds), 0)
           FROM activity_samples s
           JOIN schedule_blocks b ON b.plan_id = ?1
          WHERE s.is_idle = 0
            AND s.ts >= b.start_ts AND s.ts < b.end_ts
            AND (b.target_process IS NULL OR s.process_name = b.target_process COLLATE NOCASE)",
        params![plan_id],
        |row| row.get(0),
    )?;
    Ok(seconds)
}

pub fn progress(conn: &Connection, plan: &Plan) -> Result<PlanProgress> {
    let worked = worked_seconds(conn, plan.id)?;
    let remaining = (plan.estimate_seconds - worked).max(0);
    let percent = if plan.estimate_seconds > 0 {
        ((worked as f64 / plan.estimate_seconds as f64) * 100.0).round() as i64
    } else {
        0
    };

    // A NULL next check-in means one has fired and is waiting to be answered.
    let checkin_due = plan.next_checkin_seconds.is_none();

    Ok(PlanProgress {
        plan: plan.clone(),
        worked_seconds: worked,
        remaining_seconds: remaining,
        percent: percent.min(999),
        checkin_due,
    })
}

pub fn all_progress(conn: &Connection) -> Result<Vec<PlanProgress>> {
    load_active(conn)?
        .iter()
        .map(|plan| progress(conn, plan))
        .collect()
}

/// Plans whose measured work has passed the check-in threshold. Marks each as awaiting
/// an answer so the notification fires once, not every minute.
pub fn take_due_checkins(conn: &Connection) -> Result<Vec<PlanProgress>> {
    let mut due = Vec::new();

    for plan in load_active(conn)? {
        let Some(threshold) = plan.next_checkin_seconds else {
            continue; // already waiting on the user
        };
        let worked = worked_seconds(conn, plan.id)?;
        if worked < threshold {
            continue;
        }

        conn.execute(
            "UPDATE plans SET next_checkin_seconds = NULL WHERE id = ?1",
            params![plan.id],
        )?;

        let mut pending = plan.clone();
        pending.next_checkin_seconds = None;
        due.push(progress(conn, &pending)?);
    }

    Ok(due)
}

/// The user's answer to a check-in.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckinResponse {
    pub plan_id: i64,
    /// `on_track`, `extend` or `done`.
    pub action: String,
    /// Extra seconds to add to the estimate, for `extend`.
    #[serde(default)]
    pub extra_seconds: i64,
}

pub fn respond(conn: &Connection, response: &CheckinResponse) -> Result<PlanProgress> {
    let Some(mut plan) = load(conn, response.plan_id)? else {
        return Err(anyhow::anyhow!("plan {} is not active", response.plan_id));
    };

    if response.action == "done" {
        conn.execute(
            "UPDATE plans SET status = 'done', completed_at = ?2, next_checkin_seconds = NULL
              WHERE id = ?1",
            params![plan.id, chrono::Utc::now().timestamp()],
        )?;
        plan.status = STATUS_DONE.to_string();
        return progress(conn, &plan);
    }

    if response.action == "extend" && response.extra_seconds > 0 {
        plan.estimate_seconds += response.extra_seconds.clamp(0, 12 * 3600);
    }

    // Next question at the halfway point of whatever is left, floored so a nearly
    // finished plan does not start nagging every few minutes.
    let worked = worked_seconds(conn, plan.id)?;
    let remaining = (plan.estimate_seconds - worked).max(0);
    let next = worked + (remaining / 2).max(MIN_CHECKIN_GAP_SECONDS);

    conn.execute(
        "UPDATE plans
            SET estimate_seconds = ?2, next_checkin_seconds = ?3, checkin_count = checkin_count + 1
          WHERE id = ?1",
        params![plan.id, plan.estimate_seconds, next],
    )?;

    plan.next_checkin_seconds = Some(next);
    plan.checkin_count += 1;
    progress(conn, &plan)
}

/// Removes a plan and the blocks it put on the timeline. Detaching them instead would
/// leave work on the calendar that nothing owns and nothing can verify.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM schedule_blocks WHERE plan_id = ?1", params![id])?;
    conn.execute("DELETE FROM plans WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;
    use crate::models::ActivitySample;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run_migrations(&conn).unwrap();
        conn
    }

    fn plan(estimate_hours: i64) -> Plan {
        Plan {
            id: 0,
            task_id: None,
            title: "Parallel Systems Lab".to_string(),
            estimate_seconds: estimate_hours * 3600,
            mode: MODE_POMODORO.to_string(),
            pomodoro_style: "custom".to_string(),
            focus_seconds: 2700,
            break_seconds: 300,
            status: STATUS_ACTIVE.to_string(),
            next_checkin_seconds: None,
            checkin_count: 0,
            due_at: None,
        }
    }

    /// Attaches a block to a plan and fills it with `seconds` of tracked activity.
    fn work(conn: &mut Connection, plan_id: i64, start: i64, seconds: i64, idle: bool) {
        conn.execute(
            "INSERT INTO schedule_blocks (day, start_ts, end_ts, label, category, plan_id)
             VALUES ('2026-09-18', ?1, ?2, 'Lab', 'Productivity', ?3)",
            params![start, start + seconds, plan_id],
        )
        .unwrap();

        let samples: Vec<ActivitySample> = (0..seconds / 300)
            .map(|index| ActivitySample {
                ts: start + index * 300,
                duration_seconds: 300,
                process_name: "com.microsoft.VSCode".to_string(),
                app_name: None,
                window_title: None,
                category: "Development".to_string(),
                source: "passive".to_string(),
                client_id: None,
                is_idle: idle,
            })
            .collect();
        queries::insert_samples(conn, &samples).unwrap();
    }

    #[test]
    fn first_checkin_lands_at_half_the_estimate() {
        let conn = memory_db();
        let id = create(&conn, &plan(4)).unwrap();
        let stored = load(&conn, id).unwrap().unwrap();
        assert_eq!(stored.next_checkin_seconds, Some(2 * 3600));
    }

    #[test]
    fn progress_counts_only_non_idle_time_inside_plan_blocks() {
        let mut conn = memory_db();
        let id = create(&conn, &plan(4)).unwrap();
        work(&mut conn, id, 1_000, 3_600, false);
        work(&mut conn, id, 20_000, 3_600, true); // idle: must not count
        assert_eq!(worked_seconds(&conn, id).unwrap(), 3_600);
    }

    #[test]
    fn a_checkin_fires_once_the_halfway_mark_is_worked() {
        let mut conn = memory_db();
        let id = create(&conn, &plan(4)).unwrap();

        work(&mut conn, id, 1_000, 3_600, false);
        assert!(take_due_checkins(&conn).unwrap().is_empty(), "1h of 4h is too early");

        work(&mut conn, id, 20_000, 3_600, false);
        let due = take_due_checkins(&conn).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].worked_seconds, 7_200);

        // Fires once and then waits for an answer rather than nagging every tick.
        assert!(take_due_checkins(&conn).unwrap().is_empty());
    }

    #[test]
    fn extending_grows_the_estimate_and_reschedules_the_next_question() {
        let mut conn = memory_db();
        let id = create(&conn, &plan(4)).unwrap();
        work(&mut conn, id, 1_000, 7_200, false);
        take_due_checkins(&conn).unwrap();

        let after = respond(
            &conn,
            &CheckinResponse {
                plan_id: id,
                action: "extend".to_string(),
                extra_seconds: 3_600,
            },
        )
        .unwrap();

        assert_eq!(after.plan.estimate_seconds, 5 * 3600);
        // Worked 2h of a new 5h estimate: 3h left, so ask again at 2h + 1.5h.
        assert_eq!(after.plan.next_checkin_seconds, Some(7_200 + 5_400));
        assert_eq!(after.plan.checkin_count, 1);
    }

    #[test]
    fn deleting_a_plan_takes_its_blocks_off_the_timeline() {
        let mut conn = memory_db();
        let id = create(&conn, &plan(4)).unwrap();
        work(&mut conn, id, 1_000, 3_600, false);

        delete(&conn, id).unwrap();

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM schedule_blocks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
        assert!(load_active(&conn).unwrap().is_empty());
    }

    #[test]
    fn saying_done_ends_the_loop() {
        let mut conn = memory_db();
        let id = create(&conn, &plan(4)).unwrap();
        work(&mut conn, id, 1_000, 7_200, false);
        take_due_checkins(&conn).unwrap();

        respond(
            &conn,
            &CheckinResponse {
                plan_id: id,
                action: "done".to_string(),
                extra_seconds: 0,
            },
        )
        .unwrap();

        assert!(load_active(&conn).unwrap().is_empty());
        assert!(take_due_checkins(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_nearly_finished_plan_does_not_nag() {
        let mut conn = memory_db();
        let id = create(&conn, &plan(4)).unwrap();
        work(&mut conn, id, 1_000, 14_100, false); // 3h55m of 4h
        take_due_checkins(&conn).unwrap();

        let after = respond(
            &conn,
            &CheckinResponse {
                plan_id: id,
                action: "on_track".to_string(),
                extra_seconds: 0,
            },
        )
        .unwrap();

        let gap = after.plan.next_checkin_seconds.unwrap() - after.worked_seconds;
        assert_eq!(gap, MIN_CHECKIN_GAP_SECONDS);
    }
}
