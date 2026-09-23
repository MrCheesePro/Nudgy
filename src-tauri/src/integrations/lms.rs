//! Coursework from a calendar feed, for every LMS.
//!
//! Canvas, Moodle, Brightspace, Blackboard and Google Classroom all publish a per-user
//! iCal feed of assignments. No token, no admin approval, no institutional permission —
//! which matters, because plenty of institutions disable personal access tokens and
//! those students could not use Nudgy at all.
//!
//! The parser is [`super::calendar`]'s, unchanged. An assignment is a VEVENT; this module
//! is the small amount of reading between one and an `LmsTask`.
//!
//! **What a feed cannot tell you is whether you handed it in.** There is no submission
//! state in iCal, so ticking work off stays manual on this path. The Canvas token remains
//! the upgrade that buys real completion, and the UI says so rather than pretending.

use anyhow::{anyhow, Result};
use ical::parser::ical::component::IcalEvent;

use super::calendar::{property, property_time, sanitize};
use crate::models::LmsTask;

/// The LMSes whose feeds are known to work. The value is what lands in `tasks.provider`.
pub const PROVIDERS: &[&str] = &[
    "canvas",
    "moodle",
    "brightspace",
    "blackboard",
    "classroom",
];

pub fn is_valid_provider(candidate: &str) -> bool {
    PROVIDERS.contains(&candidate)
}

/// A feed with no VEVENTs at all is far more likely to be the wrong URL than a term with
/// no coursework, so it is reported rather than returned as an empty success.
pub fn feed_tasks(feed: &str, provider: &str) -> Result<Vec<LmsTask>> {
    let reader = ical::IcalParser::new(feed.as_bytes());
    let mut tasks = Vec::new();
    let mut saw_calendar = false;

    for calendar in reader {
        let calendar = match calendar {
            Ok(value) => value,
            Err(error) => {
                log::warn!("skipping unparsable calendar in {provider} feed: {error}");
                continue;
            }
        };
        saw_calendar = true;

        for event in &calendar.events {
            if let Some(task) = task_from_event(event, provider) {
                tasks.push(task);
            }
        }
    }

    if !saw_calendar {
        return Err(anyhow!(
            "that does not look like a calendar feed — check the URL ends in .ics"
        ));
    }
    Ok(tasks)
}

fn task_from_event(event: &IcalEvent, provider: &str) -> Option<LmsTask> {
    let summary = property(event, "SUMMARY").map(|value| sanitize(&value))?;
    if summary.is_empty() {
        return None;
    }

    // An assignment's due date is its DTSTART. Undated events are calendar furniture —
    // term dates, holidays — and are not coursework.
    let (due_at, _) = property_time(event, "DTSTART")?;

    // The feed's own UID, never a counter. `tasks` is UNIQUE(provider, external_id), so a
    // stable id makes every re-sync an update; anything generated would duplicate the
    // whole coursework list on each pass — and duplicates look like data.
    let external_id = canonical_id(&property(event, "UID")?);

    let (title, course_code) = split_course_code(&summary);

    Some(LmsTask {
        id: 0,
        provider: provider.to_string(),
        external_id,
        course_code,
        title,
        due_at: Some(due_at),
        html_url: property(event, "URL"),
        completed: false,
        completed_at: None,
    })
}

/// The same assignment, named the same way whichever source it came from.
///
/// The REST API calls it `assignment:1121388`; the feed's UID for the same thing is
/// `event-assignment-1121388`. `tasks` is `UNIQUE(provider, external_id)`, so two
/// spellings of one id are two rows — the assignment appears twice, and ticking one off
/// leaves the other. Both are folded to the API's form, which is the shorter and the one
/// already in the table.
fn canonical_id(uid: &str) -> String {
    let trimmed = uid.trim();
    if let Some(rest) = trimmed.strip_prefix("event-calendar-event-") {
        return format!("event:{rest}");
    }
    if let Some(rest) = trimmed.strip_prefix("event-assignment-") {
        return format!("assignment:{rest}");
    }
    trimmed.to_string()
}

/// Lifts a bracketed course code off either end of a summary.
///
/// The REST API hands these back as separate fields; a feed does not, and the LMSes do
/// not agree on where it goes — Canvas trails with `Essay [MATH241]`, Moodle tends to
/// lead. Both are handled, and no bracket at all leaves the title whole with a null code,
/// which is a fine outcome rather than a failure.
fn split_course_code(summary: &str) -> (String, Option<String>) {
    let trimmed = summary.trim();

    if let Some(rest) = trimmed.strip_suffix(']') {
        if let Some(open) = rest.rfind('[') {
            let code = rest[open + 1..].trim();
            let title = rest[..open].trim();
            if plausible_code(code) && !title.is_empty() {
                return (title.to_string(), Some(code.to_string()));
            }
        }
    }

    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some(close) = rest.find(']') {
            let code = rest[..close].trim();
            let title = rest[close + 1..].trim();
            if plausible_code(code) && !title.is_empty() {
                return (title.to_string(), Some(code.to_string()));
            }
        }
    }

    (trimmed.to_string(), None)
}

/// Guards against treating a bracketed aside as a course code. `[MATH241]` is one;
/// `[see the syllabus for details]` is not.
fn plausible_code(candidate: &str) -> bool {
    // 24, not 16: a real section code is `PHYS_040A_001_26F`, which is seventeen. The cap
    // is only here to stop a parenthetical being mistaken for a code, and it was cutting
    // off codes the API happily reports for the same assignment.
    !candidate.is_empty()
        && candidate.len() <= 24
        && !candidate.contains(' ')
        && candidate.chars().any(|character| character.is_alphanumeric())
}

#[cfg(test)]
mod tests {
    /// The exact DTSTART shapes a real Canvas feed emits, including the duplicated
    /// `VALUE=DATE;VALUE=DATE` parameter it writes for an assignment with no time on it.
    const CANVAS_FEED: &str = "\
BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:event-calendar-event-253951\r
DTSTART:20260921T124500Z\r
DTEND:20260921T134500Z\r
SUMMARY:gaming\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:event-assignment-1121388\r
DTSTART:20260929T150000Z\r
DTEND:20260929T150000Z\r
SUMMARY:Ch2 Prelecture Assignment [PHYS_040A_001_26F]\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:event-assignment-1121401\r
DTSTART;VALUE=DATE;VALUE=DATE:20261002\r
SUMMARY:HW1 1D motion Part 1 [PHYS_040A_001_26F]\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:event-assignment-1121400\r
DTSTART:20261117T160000Z\r
DTEND:20261117T160000Z\r
SUMMARY:HW0 Physics Primer [PHYS_040A_001_26F]\r
END:VEVENT\r
END:VCALENDAR\r
";

    #[test]
    fn a_real_canvas_feed_yields_every_assignment_on_it() {
        let tasks = feed_tasks(CANVAS_FEED, "canvas").unwrap();
        let titles: Vec<&str> = tasks.iter().map(|task| task.title.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "gaming",
                "Ch2 Prelecture Assignment",
                "HW1 1D motion Part 1",
                "HW0 Physics Primer",
            ],
        );
    }

    use super::*;

    fn feed(events: &str) -> String {
        format!("BEGIN:VCALENDAR\nVERSION:2.0\n{events}END:VCALENDAR\n")
    }

    fn event(uid: &str, summary: &str) -> String {
        format!("BEGIN:VEVENT\nUID:{uid}\nSUMMARY:{summary}\nDTSTART:20260924T235900Z\nEND:VEVENT\n")
    }

    #[test]
    fn reads_an_assignment_with_its_due_date() {
        let tasks = feed_tasks(&feed(&event("a1", "Problem Set 4")), "canvas").unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "Problem Set 4");
        assert_eq!(tasks[0].external_id, "a1");
        assert!(tasks[0].due_at.is_some());
        assert_eq!(tasks[0].provider, "canvas");
    }

    // The two LMSes disagree about which end the code goes on, so both are lifted.
    #[test]
    fn lifts_a_course_code_from_either_end() {
        let trailing = feed_tasks(&feed(&event("a1", "Essay [MATH241]")), "canvas").unwrap();
        assert_eq!(trailing[0].title, "Essay");
        assert_eq!(trailing[0].course_code.as_deref(), Some("MATH241"));

        let leading = feed_tasks(&feed(&event("a2", "[MATH241] Essay")), "moodle").unwrap();
        assert_eq!(leading[0].title, "Essay");
        assert_eq!(leading[0].course_code.as_deref(), Some("MATH241"));
    }

    #[test]
    fn leaves_a_summary_with_no_code_alone() {
        let tasks = feed_tasks(&feed(&event("a1", "Read chapter four")), "canvas").unwrap();
        assert_eq!(tasks[0].title, "Read chapter four");
        assert_eq!(tasks[0].course_code, None);
    }

    // A bracketed aside is not a course code, and eating it would lose half the title.
    #[test]
    fn ignores_brackets_that_are_not_codes() {
        let tasks = feed_tasks(&feed(&event("a1", "Essay [see the syllabus]")), "canvas").unwrap();
        assert_eq!(tasks[0].title, "Essay [see the syllabus]");
        assert_eq!(tasks[0].course_code, None);
    }

    /// The UID doing its job: the same feed read twice yields the same identity, so
    /// `upsert_tasks` updates instead of duplicating the whole coursework list.
    #[test]
    fn the_same_feed_twice_has_the_same_identity() {
        let raw = feed(&(event("a1", "Essay") + &event("a2", "Lab")));
        let first = feed_tasks(&raw, "canvas").unwrap();
        let second = feed_tasks(&raw, "canvas").unwrap();

        let ids = |tasks: &[LmsTask]| {
            tasks
                .iter()
                .map(|task| task.external_id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&first), ids(&second));
        assert_eq!(ids(&first), vec!["a1", "a2"]);
    }

    #[test]
    fn an_undated_event_is_not_coursework() {
        let raw = feed("BEGIN:VEVENT\nUID:t1\nSUMMARY:Reading week\nEND:VEVENT\n");
        assert!(feed_tasks(&raw, "canvas").unwrap().is_empty());
    }

    // An empty success would read as "no coursework" when it is really "wrong URL".
    #[test]
    fn something_that_is_not_a_feed_is_an_error() {
        assert!(feed_tasks("<html>404</html>", "canvas").is_err());
    }
}
