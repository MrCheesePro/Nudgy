//! Events you add by hand: a class, a shift, a train.
//!
//! The calendar feed already produces commitments the planner refuses to schedule over
//! (invariant 18), and these are the same thing from a different source — so they expand
//! into the same `CalendarEvent` the feed produces, and everything downstream is unchanged.
//!
//! **Recurrence is stored as a rule, never as rows.** A class three times a week for a
//! term is one row and an arithmetic expansion, not a hundred and twenty rows that have to
//! be regenerated when the time moves. It also means "every Tuesday, forever" is
//! expressible at all.

use anyhow::Result;
use chrono::{Datelike, Duration, Local, NaiveDate, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};

use crate::integrations::calendar::CalendarEvent;

/// How an event repeats. Anything unrecognised is read as `None`, so a row written by a
/// later version cannot make a window of the calendar disappear.
pub const REPEAT_NONE: &str = "none";
pub const REPEAT_DAILY: &str = "daily";
pub const REPEAT_WEEKLY: &str = "weekly";
pub const REPEAT_MONTHLY: &str = "monthly";

/// A ceiling on how many occurrences one rule may produce for one window.
///
/// A window is at most a couple of months, so nothing legitimate comes near this. It is
/// here because the loop's exit depends on arithmetic over dates, and a bug in that
/// arithmetic should produce a short calendar rather than a hung app.
const MAX_OCCURRENCES: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEvent {
    #[serde(default)]
    pub id: i64,
    pub title: String,
    /// What sort of thing it is — "Class", "Work", "Travel". Free text, shown as a chip.
    #[serde(default)]
    pub kind: Option<String>,
    /// Where, verbatim. Never routed or looked up; see invariant 32.
    #[serde(default)]
    pub location: Option<String>,
    /// The first occurrence. Later ones keep its wall-clock time, not its offset.
    pub start_ts: i64,
    pub end_ts: i64,
    pub repeat: String,
    /// For `weekly`: which days, 0 = Sunday. Empty means the day the first one falls on.
    #[serde(default)]
    pub weekdays: Vec<u32>,
    /// Inclusive last day, or `None` for a rule with no end.
    #[serde(default)]
    pub until_ts: Option<i64>,
}

/// Every occurrence of `event` overlapping `[start_ts, end_ts)`.
///
/// Each occurrence keeps the first one's **wall-clock** time rather than its offset, so a
/// nine o'clock class is still at nine after the clocks change — which is what somebody
/// means by "every Tuesday at nine" and not what adding 604800 seconds repeatedly gives.
pub fn occurrences(event: &LocalEvent, start_ts: i64, end_ts: i64) -> Vec<CalendarEvent> {
    let Some(first_start) = Local.timestamp_opt(event.start_ts, 0).single() else {
        return Vec::new();
    };

    let duration = (event.end_ts - event.start_ts).max(0);
    let time_of_day = first_start.time();
    let first_date = first_start.date_naive();

    // The last date worth generating: the window's end, or the rule's own end if sooner.
    let window_end = Local
        .timestamp_opt(end_ts, 0)
        .single()
        .map(|moment| moment.date_naive());
    let rule_end = event
        .until_ts
        .and_then(|ts| Local.timestamp_opt(ts, 0).single())
        .map(|moment| moment.date_naive());
    let Some(last_date) = earliest(window_end, rule_end) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut date = first_date;
    let mut guard = 0;

    while date <= last_date && guard < MAX_OCCURRENCES {
        guard += 1;

        if matches(event, date, first_date) {
            if let Some(occurrence) = at(date, time_of_day, duration, event) {
                // Overlap, not containment: an event already running when the window
                // opens is still a commitment inside it.
                if occurrence.end_ts > start_ts && occurrence.start_ts < end_ts {
                    out.push(occurrence);
                }
            }
        }

        let Some(next) = advance(event, date, first_date) else {
            break;
        };
        date = next;
    }

    out
}

/// Whether the rule fires on `date`.
fn matches(event: &LocalEvent, date: NaiveDate, first: NaiveDate) -> bool {
    match event.repeat.as_str() {
        REPEAT_DAILY => true,
        REPEAT_WEEKLY => {
            if event.weekdays.is_empty() {
                date.weekday() == first.weekday()
            } else {
                event
                    .weekdays
                    .contains(&date.weekday().num_days_from_sunday())
            }
        }
        // Same day of the month. A month without that day — the 31st of February — simply
        // has no occurrence, which is less surprising than silently moving it to the 28th.
        REPEAT_MONTHLY => date.day() == first.day(),
        _ => date == first,
    }
}

/// The next date worth testing. Stepping a day at a time for weekly and monthly rules is
/// wasteful in principle and irrelevant in practice — the window is weeks, not decades —
/// and it keeps `matches` the only place the rule is interpreted.
fn advance(event: &LocalEvent, date: NaiveDate, _first: NaiveDate) -> Option<NaiveDate> {
    match event.repeat.as_str() {
        REPEAT_DAILY | REPEAT_WEEKLY | REPEAT_MONTHLY => date.checked_add_signed(Duration::days(1)),
        // A one-off has nothing after it.
        _ => None,
    }
}

/// One occurrence, built from a local date and the original's wall-clock time.
fn at(
    date: NaiveDate,
    time: NaiveTime,
    duration: i64,
    event: &LocalEvent,
) -> Option<CalendarEvent> {
    // `.earliest()` rather than `.single()`: on the morning the clocks go forward an hour
    // does not exist, and the sensible reading of "9am that day" is the first 9am there is.
    let start = Local.from_local_datetime(&date.and_time(time)).earliest()?;
    let start_ts = start.timestamp();

    Some(CalendarEvent {
        summary: event.title.clone(),
        start_ts,
        end_ts: start_ts + duration,
        all_day: false,
        location: event.location.clone(),
        color: None,
    })
}

fn earliest(left: Option<NaiveDate>, right: Option<NaiveDate>) -> Option<NaiveDate> {
    match (left, right) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

/// Normalises what the frontend sent, so a malformed rule cannot be stored.
pub fn sanitize(mut event: LocalEvent) -> Result<LocalEvent> {
    event.title = event.title.trim().to_string();
    if event.title.is_empty() {
        return Err(anyhow::anyhow!("an event needs a name"));
    }
    if event.end_ts <= event.start_ts {
        return Err(anyhow::anyhow!("an event has to end after it starts"));
    }

    event.repeat = match event.repeat.as_str() {
        REPEAT_DAILY => REPEAT_DAILY,
        REPEAT_WEEKLY => REPEAT_WEEKLY,
        REPEAT_MONTHLY => REPEAT_MONTHLY,
        _ => REPEAT_NONE,
    }
    .to_string();

    event.weekdays.retain(|day| *day < 7);
    event.weekdays.sort_unstable();
    event.weekdays.dedup();
    event.kind = event.kind.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    event.location = event
        .location
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at_local(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        Local
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .unwrap()
            .timestamp()
    }

    fn event(repeat: &str) -> LocalEvent {
        LocalEvent {
            id: 1,
            title: "Physics lab".to_string(),
            kind: Some("Class".to_string()),
            location: Some("Pierce 201".to_string()),
            start_ts: at_local(2026, 9, 1, 9, 0), // a Tuesday
            end_ts: at_local(2026, 9, 1, 11, 0),
            repeat: repeat.to_string(),
            weekdays: Vec::new(),
            until_ts: None,
        }
    }

    fn window(from: (i32, u32, u32), to: (i32, u32, u32)) -> (i64, i64) {
        (
            at_local(from.0, from.1, from.2, 0, 0),
            at_local(to.0, to.1, to.2, 0, 0),
        )
    }

    #[test]
    fn a_one_off_happens_once() {
        let (start, end) = window((2026, 9, 1), (2026, 10, 1));
        let out = occurrences(&event(REPEAT_NONE), start, end);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].summary, "Physics lab");
        assert_eq!(out[0].end_ts - out[0].start_ts, 2 * 3600);
        assert_eq!(out[0].location.as_deref(), Some("Pierce 201"));
    }

    #[test]
    fn a_one_off_outside_the_window_is_not_returned() {
        let (start, end) = window((2026, 10, 1), (2026, 11, 1));
        assert!(occurrences(&event(REPEAT_NONE), start, end).is_empty());
    }

    #[test]
    fn daily_repeats_every_day_of_the_window() {
        let (start, end) = window((2026, 9, 1), (2026, 9, 8));
        assert_eq!(occurrences(&event(REPEAT_DAILY), start, end).len(), 7);
    }

    // Empty weekdays means "the day the first one is on", which is what somebody who
    // picked a date and said "weekly" meant.
    #[test]
    fn weekly_with_no_days_chosen_follows_the_first_one() {
        let (start, end) = window((2026, 9, 1), (2026, 9, 29));
        let out = occurrences(&event(REPEAT_WEEKLY), start, end);
        assert_eq!(out.len(), 4);
        for occurrence in &out {
            let day = Local.timestamp_opt(occurrence.start_ts, 0).single().unwrap();
            assert_eq!(day.weekday(), chrono::Weekday::Tue);
        }
    }

    #[test]
    fn weekly_fires_on_every_day_chosen() {
        let mut lab = event(REPEAT_WEEKLY);
        lab.weekdays = vec![1, 3, 5]; // Monday, Wednesday, Friday
        let (start, end) = window((2026, 9, 1), (2026, 9, 15));
        let out = occurrences(&lab, start, end);
        for occurrence in &out {
            let day = Local.timestamp_opt(occurrence.start_ts, 0).single().unwrap();
            assert!(matches!(
                day.weekday(),
                chrono::Weekday::Mon | chrono::Weekday::Wed | chrono::Weekday::Fri
            ));
        }
        assert_eq!(out.len(), 6);
    }

    #[test]
    fn monthly_keeps_the_day_of_the_month() {
        // September, October, November and December, since the window reaches Dec 2.
        let (start, end) = window((2026, 9, 1), (2026, 12, 2));
        let out = occurrences(&event(REPEAT_MONTHLY), start, end);
        assert_eq!(out.len(), 4);
        for occurrence in &out {
            let day = Local.timestamp_opt(occurrence.start_ts, 0).single().unwrap();
            assert_eq!(day.day(), 1);
        }
    }

    // The 31st of February is not moved to the 28th; it simply does not happen.
    #[test]
    fn monthly_skips_a_month_without_that_day() {
        let mut rent = event(REPEAT_MONTHLY);
        rent.start_ts = at_local(2026, 1, 31, 9, 0);
        rent.end_ts = at_local(2026, 1, 31, 10, 0);

        let (start, end) = window((2026, 1, 1), (2026, 4, 1));
        let out = occurrences(&rent, start, end);
        let days: Vec<u32> = out
            .iter()
            .map(|occurrence| {
                Local
                    .timestamp_opt(occurrence.start_ts, 0)
                    .single()
                    .unwrap()
                    .month()
            })
            .collect();
        assert_eq!(days, vec![1, 3], "February has no 31st");
    }

    #[test]
    fn an_end_date_stops_it() {
        let mut lab = event(REPEAT_DAILY);
        lab.until_ts = Some(at_local(2026, 9, 3, 23, 59));
        let (start, end) = window((2026, 9, 1), (2026, 10, 1));
        assert_eq!(occurrences(&lab, start, end).len(), 3);
    }

    // An event already running when the window opens is still a commitment inside it.
    #[test]
    fn an_occurrence_overlapping_the_edge_is_included() {
        let mut lab = event(REPEAT_NONE);
        lab.start_ts = at_local(2026, 9, 1, 8, 0);
        lab.end_ts = at_local(2026, 9, 1, 10, 0);

        let start = at_local(2026, 9, 1, 9, 0);
        let end = at_local(2026, 9, 1, 12, 0);
        assert_eq!(occurrences(&lab, start, end).len(), 1);
    }

    #[test]
    fn sanitizing_refuses_what_cannot_be_drawn() {
        let mut blank = event(REPEAT_NONE);
        blank.title = "   ".to_string();
        assert!(sanitize(blank).is_err());

        let mut backwards = event(REPEAT_NONE);
        backwards.end_ts = backwards.start_ts - 60;
        assert!(sanitize(backwards).is_err());
    }

    #[test]
    fn sanitizing_tidies_a_rule_rather_than_trusting_it() {
        let mut messy = event("fortnightly");
        messy.weekdays = vec![9, 3, 3, 1];
        messy.location = Some("   ".to_string());

        let clean = sanitize(messy).unwrap();
        assert_eq!(clean.repeat, REPEAT_NONE, "an unknown rule is a one-off");
        assert_eq!(clean.weekdays, vec![1, 3], "out of range dropped, sorted, deduped");
        assert_eq!(clean.location, None, "blank is absent, not empty");
    }
}
