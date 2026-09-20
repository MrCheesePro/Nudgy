//! Calendar feed reader.
//!
//! Reads a published iCal (`.ics`) URL — Google Calendar's "secret address in iCal
//! format", or any other calendar that exports one — and returns the events inside a
//! time window, with recurrence expanded.
//!
//! Recurrence is the whole point: a weekly lecture appears once in the file as a single
//! VEVENT with an RRULE. Ignoring that would mean the planner schedules work straight
//! through every class.
//!
//! The feed URL is a read-only bearer credential, so it lives in the keychain, never in
//! the settings table.

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use ical::parser::ical::component::IcalEvent;
use reqwest::Client;
use rrule::{RRuleSet, Tz as RruleTz};
use serde::Serialize;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const USER_AGENT: &str = concat!("Nudgy/", env!("CARGO_PKG_VERSION"));
/// A single feed should never be this big; a runaway download is a bug or an attack.
const MAX_FEED_BYTES: usize = 8 * 1024 * 1024;
/// Ceiling on occurrences expanded from one rule, so a malformed RRULE cannot hang us.
const MAX_OCCURRENCES: u16 = 512;
const MAX_SUMMARY_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub summary: String,
    pub start_ts: i64,
    pub end_ts: i64,
    /// All-day events block the day conceptually but should not eat every free slot.
    pub all_day: bool,
    /// From RFC 7986 `COLOR` or `X-APPLE-CALENDAR-COLOR`, when the feed carries one.
    /// Google's iCal export does not, so this is usually None and the UI derives a
    /// colour from the title instead.
    pub color: Option<String>,
}

pub async fn fetch_feed(url: &str) -> Result<String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err(anyhow!("calendar URL must start with https://"));
    }

    let http = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .context("building HTTP client")?;

    let response = http
        .get(trimmed)
        .send()
        .await
        .context("fetching the calendar feed")?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "calendar feed returned {} (check the secret iCal URL)",
            response.status().as_u16()
        ));
    }

    let body = response.text().await.context("reading the calendar feed")?;
    if body.len() > MAX_FEED_BYTES {
        return Err(anyhow!("calendar feed is unreasonably large"));
    }
    if !body.contains("BEGIN:VCALENDAR") {
        return Err(anyhow!("that URL did not return an iCal feed"));
    }
    Ok(body)
}

/// Parses a feed and returns every occurrence overlapping `[window_start, window_end)`.
pub fn events_in_window(feed: &str, window_start: i64, window_end: i64) -> Result<Vec<CalendarEvent>> {
    let reader = ical::IcalParser::new(feed.as_bytes());
    let mut events = Vec::new();

    for calendar in reader {
        let calendar = match calendar {
            Ok(value) => value,
            Err(error) => {
                log::warn!("skipping unparsable calendar: {error}");
                continue;
            }
        };

        // Some feeds colour the whole calendar rather than individual events.
        let calendar_color = calendar
            .properties
            .iter()
            .find(|property| {
                property.name == "COLOR" || property.name == "X-APPLE-CALENDAR-COLOR"
            })
            .and_then(|property| property.value.clone());

        for event in calendar.events {
            match expand_event(&event, window_start, window_end, calendar_color.as_deref()) {
                Ok(mut expanded) => events.append(&mut expanded),
                // One broken VEVENT must not cost the user their whole calendar.
                Err(error) => log::warn!("skipping calendar event: {error}"),
            }
        }
    }

    events.sort_by_key(|event| event.start_ts);
    events.dedup();
    Ok(events)
}

fn expand_event(
    event: &IcalEvent,
    window_start: i64,
    window_end: i64,
    calendar_color: Option<&str>,
) -> Result<Vec<CalendarEvent>> {
    let summary = property(event, "SUMMARY")
        .map(|value| sanitize(&value))
        .unwrap_or_else(|| "Busy".to_string());

    if property(event, "STATUS").as_deref() == Some("CANCELLED") {
        return Ok(Vec::new());
    }
    // Declined or free-time events are not commitments.
    if property(event, "TRANSP").as_deref() == Some("TRANSPARENT") {
        return Ok(Vec::new());
    }

    let (start_ts, start_all_day) = property_time(event, "DTSTART")
        .ok_or_else(|| anyhow!("event `{summary}` has no usable DTSTART"))?;

    let duration = match property_time(event, "DTEND") {
        Some((end_ts, _)) if end_ts > start_ts => end_ts - start_ts,
        // No DTEND: an all-day event covers the day, a timed one defaults to an hour.
        _ if start_all_day => 24 * 3600,
        _ => 3600,
    };

    let exdates: Vec<i64> = event
        .properties
        .iter()
        .filter(|property| property.name == "EXDATE")
        .filter_map(|property| property.value.as_deref())
        .flat_map(|value| value.split(',').filter_map(parse_ical_datetime))
        .map(|(ts, _)| ts)
        .collect();

    let color = property(event, "COLOR")
        .or_else(|| property(event, "X-APPLE-CALENDAR-COLOR"))
        .or_else(|| calendar_color.map(str::to_string))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let starts = match property(event, "RRULE") {
        Some(rule) => expand_rrule(&rule, event, start_ts, window_start, window_end)?,
        None => vec![start_ts],
    };

    Ok(starts
        .into_iter()
        .filter(|start| !exdates.contains(start))
        .map(|start| CalendarEvent {
            summary: summary.clone(),
            start_ts: start,
            end_ts: start + duration,
            all_day: start_all_day,
            color: color.clone(),
        })
        // Overlap, not containment: a lecture that began before the window still blocks it.
        .filter(|event| event.end_ts > window_start && event.start_ts < window_end)
        .collect())
}

fn expand_rrule(
    rule: &str,
    event: &IcalEvent,
    start_ts: i64,
    window_start: i64,
    window_end: i64,
) -> Result<Vec<i64>> {
    // The `rrule` crate wants DTSTART and RRULE together, in its own accepted form.
    let dtstart = Utc
        .timestamp_opt(start_ts, 0)
        .single()
        .ok_or_else(|| anyhow!("invalid DTSTART timestamp"))?
        .format("DTSTART:%Y%m%dT%H%M%SZ")
        .to_string();

    let mut source = format!("{dtstart}\nRRULE:{rule}");
    for property in &event.properties {
        if property.name == "RDATE" {
            if let Some(value) = &property.value {
                source.push_str(&format!("\nRDATE:{value}"));
            }
        }
    }

    let set: RRuleSet = source
        .parse()
        .map_err(|error| anyhow!("unsupported recurrence rule: {error}"))?;

    let after = RruleTz::UTC.timestamp_opt(window_start, 0).single();
    let before = RruleTz::UTC.timestamp_opt(window_end, 0).single();
    let (Some(after), Some(before)) = (after, before) else {
        return Err(anyhow!("invalid recurrence window"));
    };

    let result = set.after(after).before(before).all(MAX_OCCURRENCES);
    Ok(result.dates.into_iter().map(|date| date.timestamp()).collect())
}

fn property(event: &IcalEvent, name: &str) -> Option<String> {
    event
        .properties
        .iter()
        .find(|property| property.name == name)
        .and_then(|property| property.value.clone())
}

/// Reads a date-time property along with its TZID parameter, which is what makes a
/// 9am class land at 9am rather than 9am UTC.
fn property_time(event: &IcalEvent, name: &str) -> Option<(i64, bool)> {
    let property = event
        .properties
        .iter()
        .find(|property| property.name == name)?;
    let raw = property.value.as_deref()?;

    let tzid = property.params.as_ref().and_then(|params| {
        params
            .iter()
            .find(|(key, _)| key == "TZID")
            .and_then(|(_, values)| values.first().cloned())
    });

    let (naive_ts, all_day) = parse_ical_datetime(raw)?;

    // A trailing Z already means UTC; parse_ical_datetime resolved it.
    if raw.ends_with('Z') || all_day {
        return Some((naive_ts, all_day));
    }

    match tzid.and_then(|zone| zone.parse::<Tz>().ok()) {
        Some(zone) => {
            let naive = DateTime::from_timestamp(naive_ts, 0)?.naive_utc();
            let local = zone.from_local_datetime(&naive).single()?;
            Some((local.timestamp(), all_day))
        }
        // Floating time: the spec says interpret in the viewer's local zone.
        None => {
            let naive = DateTime::from_timestamp(naive_ts, 0)?.naive_utc();
            let local = chrono::Local.from_local_datetime(&naive).single()?;
            Some((local.timestamp(), all_day))
        }
    }
}

/// Returns (timestamp, all_day). For non-UTC values the timestamp is the wall-clock time
/// read as if it were UTC; the caller re-anchors it to the right zone.
fn parse_ical_datetime(raw: &str) -> Option<(i64, bool)> {
    let value = raw.trim();

    if let Some(stripped) = value.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(stripped, "%Y%m%dT%H%M%S").ok()?;
        return Some((naive.and_utc().timestamp(), false));
    }

    if value.len() == 8 {
        let date = chrono::NaiveDate::parse_from_str(value, "%Y%m%d").ok()?;
        let local = chrono::Local
            .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
            .single()?;
        return Some((local.timestamp(), true));
    }

    let naive = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()?;
    Some((naive.and_utc().timestamp(), false))
}

fn sanitize(value: &str) -> String {
    value
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\n", " ")
        .replace("\\N", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_SUMMARY_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW_START: i64 = 1_789_600_000; // 2026-09-17
    const WINDOW_END: i64 = 1_790_400_000; // 2026-09-26

    fn feed(body: &str) -> String {
        format!("BEGIN:VCALENDAR\nVERSION:2.0\n{body}\nEND:VCALENDAR\n")
    }

    #[test]
    fn reads_an_event_colour_when_the_feed_provides_one() {
        let ics = feed(
            "BEGIN:VEVENT\nUID:c1\nSUMMARY:Coloured\nCOLOR:#0B8043\n\
             DTSTART:20260918T170000Z\nDTEND:20260918T180000Z\nEND:VEVENT",
        );
        let events = events_in_window(&ics, WINDOW_START, WINDOW_END).unwrap();
        assert_eq!(events[0].color.as_deref(), Some("#0B8043"));
    }

    #[test]
    fn a_feed_without_colours_leaves_it_to_the_ui() {
        let ics = feed(
            "BEGIN:VEVENT\nUID:c2\nSUMMARY:Plain\n\
             DTSTART:20260918T170000Z\nDTEND:20260918T180000Z\nEND:VEVENT",
        );
        assert!(events_in_window(&ics, WINDOW_START, WINDOW_END).unwrap()[0]
            .color
            .is_none());
    }

    #[test]
    fn reads_a_single_timed_event() {
        let ics = feed(
            "BEGIN:VEVENT\nUID:1\nSUMMARY:Lab section\n\
             DTSTART:20260918T170000Z\nDTEND:20260918T183000Z\nEND:VEVENT",
        );
        let events = events_in_window(&ics, WINDOW_START, WINDOW_END).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].summary, "Lab section");
        assert_eq!(events[0].end_ts - events[0].start_ts, 5_400);
    }

    #[test]
    fn expands_a_weekly_recurring_class() {
        let ics = feed(
            "BEGIN:VEVENT\nUID:2\nSUMMARY:CS 330 Lecture\n\
             DTSTART:20260918T160000Z\nDTEND:20260918T170000Z\n\
             RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=3\nEND:VEVENT",
        );
        let events = events_in_window(&ics, WINDOW_START, WINDOW_END).unwrap();
        // Three weekly occurrences, but the window only covers the first two.
        assert!(events.len() >= 2, "expected recurrences, got {}", events.len());
        assert!(events.iter().all(|event| event.summary == "CS 330 Lecture"));
    }

    #[test]
    fn honours_exdate_cancellations() {
        let ics = feed(
            "BEGIN:VEVENT\nUID:3\nSUMMARY:Seminar\n\
             DTSTART:20260918T160000Z\nDTEND:20260918T170000Z\n\
             RRULE:FREQ=DAILY;COUNT=3\nEXDATE:20260919T160000Z\nEND:VEVENT",
        );
        let events = events_in_window(&ics, WINDOW_START, WINDOW_END).unwrap();
        assert!(
            !events
                .iter()
                .any(|event| event.start_ts == 1_789_833_600),
            "the excluded date should not appear"
        );
    }

    #[test]
    fn skips_cancelled_and_transparent_events() {
        let ics = feed(
            "BEGIN:VEVENT\nUID:4\nSUMMARY:Called off\nSTATUS:CANCELLED\n\
             DTSTART:20260918T160000Z\nDTEND:20260918T170000Z\nEND:VEVENT\n\
             BEGIN:VEVENT\nUID:5\nSUMMARY:FYI only\nTRANSP:TRANSPARENT\n\
             DTSTART:20260918T180000Z\nDTEND:20260918T190000Z\nEND:VEVENT",
        );
        assert!(events_in_window(&ics, WINDOW_START, WINDOW_END).unwrap().is_empty());
    }

    #[test]
    fn an_event_without_dtend_still_blocks_an_hour() {
        let ics = feed("BEGIN:VEVENT\nUID:6\nSUMMARY:Office hours\nDTSTART:20260918T200000Z\nEND:VEVENT");
        let events = events_in_window(&ics, WINDOW_START, WINDOW_END).unwrap();
        assert_eq!(events[0].end_ts - events[0].start_ts, 3_600);
    }

    #[test]
    fn events_outside_the_window_are_dropped() {
        let ics = feed(
            "BEGIN:VEVENT\nUID:7\nSUMMARY:Last year\n\
             DTSTART:20250918T160000Z\nDTEND:20250918T170000Z\nEND:VEVENT",
        );
        assert!(events_in_window(&ics, WINDOW_START, WINDOW_END).unwrap().is_empty());
    }

    #[test]
    fn summary_escapes_are_unfolded() {
        assert_eq!(sanitize("Math\\, Physics\\nand more"), "Math, Physics and more");
    }

    #[test]
    fn a_broken_event_does_not_sink_the_feed() {
        let ics = feed(
            "BEGIN:VEVENT\nUID:8\nSUMMARY:No start\nEND:VEVENT\n\
             BEGIN:VEVENT\nUID:9\nSUMMARY:Good one\n\
             DTSTART:20260918T160000Z\nDTEND:20260918T170000Z\nEND:VEVENT",
        );
        let events = events_in_window(&ics, WINDOW_START, WINDOW_END).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].summary, "Good one");
    }
}
