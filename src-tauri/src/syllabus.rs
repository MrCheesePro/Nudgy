//! Reading class times out of a syllabus.
//!
//! There is no model in Nudgy (invariant 4), so this understands one thing: the
//! meeting-pattern grammar, which is stereotyped across almost every syllabus ever
//! written.
//!
//! ```text
//! Lecture: MWF 10:00–10:50 AM, Pierce 201
//! TuTh 2:00-3:20 p.m.
//! Lab: F 1:00–3:50 PM (Chem 1420)
//! M/W/F 8–8:50
//! ```
//!
//! It will miss unusual formats and it will pick up things that are not classes — office
//! hours read exactly like a lecture, and are probably worth having anyway. Neither
//! matters much, because **nothing here writes anything**: every candidate is proposed and
//! confirmed, which is invariant 4's arithmetic proposing and the user disposing.

use serde::Serialize;

/// Whole words that name a day outright.
///
/// Checked before anything is taken apart letter by letter, so `Sat` is Saturday rather
/// than Saturday-then-Tuesday, and `Sun` is not Sunday-then-something.
const DAY_WORDS: [(&str, u32); 16] = [
    ("sunday", 0),
    ("monday", 1),
    ("tuesday", 2),
    ("wednesday", 3),
    ("thursday", 4),
    ("friday", 5),
    ("saturday", 6),
    ("sun", 0),
    ("mon", 1),
    ("tues", 2),
    ("tue", 2),
    ("wed", 3),
    ("thurs", 4),
    ("thu", 4),
    ("fri", 5),
    ("sat", 6),
];

/// The letters a compact run like `MWF` or `TuTh` is built from, longest first so `Th` is
/// taken before `T`.
///
/// `R` is Thursday. That is a real convention in course catalogues — `MWRF` — and exactly
/// the kind of thing a parser has to be told rather than left to infer.
const DAY_LETTERS: [(&str, u32); 9] = [
    ("su", 0),
    ("sa", 6),
    ("th", 4),
    ("tu", 2),
    ("m", 1),
    ("t", 2),
    ("w", 3),
    ("r", 4),
    ("f", 5),
];

/// A line longer than this is prose, not a timetable entry.
const MAX_LINE_CHARS: usize = 200;

/// Room names are short. Anything longer is the rest of a sentence.
const MAX_LOCATION_CHARS: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingPattern {
    /// "Lecture", "Lab", "Discussion" — whatever preceded the colon, when it was short.
    pub label: Option<String>,
    /// 0 is Sunday, the same convention as `events.weekdays`.
    pub weekdays: Vec<u32>,
    /// Minutes past midnight, local.
    pub start_minutes: u32,
    pub end_minutes: u32,
    pub location: Option<String>,
}

/// Every meeting pattern the text appears to describe, in the order they were written.
pub fn meetings(text: &str) -> Vec<MeetingPattern> {
    let mut found: Vec<MeetingPattern> = Vec::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.chars().count() > MAX_LINE_CHARS {
            continue;
        }

        let (label, body) = split_label(line);
        let Some(times) = find_time_range(body) else {
            continue;
        };
        let weekdays = find_weekdays(&body[..times.at]);
        if weekdays.is_empty() {
            // A time with no days is a deadline or an office hour without a day — not
            // something that can be laid down as a weekly commitment.
            continue;
        }

        let candidate = MeetingPattern {
            label,
            weekdays,
            start_minutes: times.start,
            end_minutes: times.end,
            location: find_location(&body[times.after..]),
        };

        // The same class listed twice in one document is one class.
        if !found.contains(&candidate) {
            found.push(candidate);
        }
    }

    found
}

/// `Lecture: MWF 10–10:50` → `("Lecture", "MWF 10–10:50")`.
///
/// Only a short run of words before the first colon, so a sentence with a colon in the
/// middle of it does not donate half of itself as a label.
fn split_label(line: &str) -> (Option<String>, &str) {
    let Some(at) = line.find(':') else {
        return (None, line);
    };

    let head = line[..at].trim();
    let rest = line[at + 1..].trim();

    // A time like `10:30` also has a colon; the head would then be a number.
    let wordy = head.split_whitespace().count() <= 3
        && !head.is_empty()
        && head.chars().any(|character| character.is_alphabetic())
        && head.chars().all(|character| !character.is_ascii_digit());

    if wordy {
        (Some(head.to_string()), rest)
    } else {
        (None, line)
    }
}

struct TimeRange {
    start: u32,
    end: u32,
    /// Byte offset where the range begins, so days are looked for before it.
    at: usize,
    /// Byte offset just past it, so a location is looked for after it.
    after: usize,
}

/// The first `10:00–10:50 AM`-shaped thing on the line.
fn find_time_range(line: &str) -> Option<TimeRange> {
    let bytes = line.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        // Mid-number: skip to the end of it rather than restarting inside it.
        if index > 0 && bytes[index - 1].is_ascii_digit() {
            index += 1;
            continue;
        }

        if let Some((first, after_first)) = read_clock(line, index) {
            let (separator, after_separator) = read_separator(line, after_first);
            if separator {
                if let Some((second, after_second)) = read_clock(line, after_separator) {
                    let (start, end) = resolve(first, second);
                    return Some(TimeRange {
                        start,
                        end,
                        at: index,
                        after: after_second,
                    });
                }
            }
        }

        index += 1;
    }

    None
}

/// A clock reading and what it did or did not say about morning.
#[derive(Clone, Copy)]
struct Clock {
    hour: u32,
    minute: u32,
    meridiem: Option<bool>,
}

/// Reads `10`, `10:00`, `10:00 AM`, `10 a.m.` from `at`.
fn read_clock(line: &str, at: usize) -> Option<(Clock, usize)> {
    let bytes = line.as_bytes();
    let mut index = at;

    let digits_start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    let hour: u32 = line[digits_start..index].parse().ok()?;
    if hour > 24 {
        return None;
    }

    let mut minute = 0;
    if index < bytes.len() && bytes[index] == b':' {
        let minutes_start = index + 1;
        let mut end = minutes_start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == minutes_start {
            return None;
        }
        minute = line[minutes_start..end].parse().ok()?;
        if minute > 59 {
            return None;
        }
        index = end;
    }

    // `10 AM`, `10am`, `10 a.m.`
    let mut meridiem = None;
    let after_space = skip_spaces(line, index);
    let tail = line[after_space..].to_ascii_lowercase();
    let cleaned = tail.replace('.', "");
    if cleaned.starts_with("am") {
        meridiem = Some(true);
        index = after_space + meridiem_len(&line[after_space..]);
    } else if cleaned.starts_with("pm") {
        meridiem = Some(false);
        index = after_space + meridiem_len(&line[after_space..]);
    }

    Some((
        Clock {
            hour,
            minute,
            meridiem,
        },
        index,
    ))
}

/// How many bytes the meridiem actually took, dots and all.
fn meridiem_len(rest: &str) -> usize {
    let mut taken = 0;
    let mut letters = 0;
    for character in rest.chars() {
        if character == '.' {
            taken += character.len_utf8();
            continue;
        }
        if letters < 2 && character.is_ascii_alphabetic() {
            taken += character.len_utf8();
            letters += 1;
            continue;
        }
        break;
    }
    taken
}

fn skip_spaces(line: &str, from: usize) -> usize {
    let bytes = line.as_bytes();
    let mut index = from;
    while index < bytes.len() && bytes[index] == b' ' {
        index += 1;
    }
    index
}

/// `-`, `–`, `—` or `to`, with optional spaces around it.
fn read_separator(line: &str, from: usize) -> (bool, usize) {
    let start = skip_spaces(line, from);
    let rest = &line[start..];

    for dash in ["-", "\u{2013}", "\u{2014}"] {
        if let Some(tail) = rest.strip_prefix(dash) {
            return (true, skip_spaces(line, line.len() - tail.len()));
        }
    }

    let lower = rest.to_ascii_lowercase();
    if lower.starts_with("to ") || lower.starts_with("to\t") {
        return (true, skip_spaces(line, start + 2));
    }

    (false, from)
}

/// Turns two clock readings into minutes past midnight.
///
/// Two rules, both of them what a timetable means rather than what the digits say:
///
/// - **A meridiem on one half applies to both.** `8–8:50 AM` is fifty minutes, not twelve
///   hours. It is written that way constantly and read that way by everybody.
/// - **With no meridiem at all, 8–11 is morning and 12–7 is afternoon.** Nothing meets at
///   three in the morning, and `2–3:20` is the afternoon in every syllabus ever printed.
fn resolve(first: Clock, second: Clock) -> (u32, u32) {
    let shared = first.meridiem.or(second.meridiem);

    let mut start = to_minutes(first, first.meridiem.or(shared));
    let mut end = to_minutes(second, second.meridiem.or(shared));

    // `11–1` with no meridiem: the end has quietly crossed noon.
    if end <= start && end + 12 * 60 > start {
        end += 12 * 60;
    }
    if start >= 24 * 60 {
        start %= 24 * 60;
    }
    if end > 24 * 60 {
        end = 24 * 60;
    }

    (start, end)
}

fn to_minutes(clock: Clock, meridiem: Option<bool>) -> u32 {
    let hour = match meridiem {
        Some(true) => {
            if clock.hour == 12 {
                0
            } else {
                clock.hour
            }
        }
        Some(false) => {
            if clock.hour == 12 {
                12
            } else {
                clock.hour + 12
            }
        }
        // Nothing meets at three in the morning.
        None if clock.hour < 8 => clock.hour + 12,
        None => clock.hour,
    };
    hour * 60 + clock.minute
}

/// Day letters and names, in whatever separators the line used.
///
/// Word by word, which is the only way to tell `MWF` from `and`. A word is a day if it
/// names one outright, or if **every** letter of it is part of a day run — so `mwf` and
/// `tuth` are days, while `and`, `at` and `final` are not, despite all beginning with one.
/// Anything else is skipped entirely rather than mined for letters.
fn find_weekdays(head: &str) -> Vec<u32> {
    let lower = head.to_ascii_lowercase();
    let mut days: Vec<u32> = Vec::new();

    for word in lower.split(|character: char| !character.is_ascii_alphabetic()) {
        if word.is_empty() {
            continue;
        }

        if let Some((_, day)) = DAY_WORDS.iter().find(|(name, _)| *name == word) {
            if !days.contains(day) {
                days.push(*day);
            }
            continue;
        }

        if let Some(run) = read_day_run(word) {
            for day in run {
                if !days.contains(&day) {
                    days.push(day);
                }
            }
        }
    }

    days.sort_unstable();
    days
}

/// `mwf` → Mon/Wed/Fri. `None` the moment a letter is not a day, which is what keeps
/// ordinary words out.
fn read_day_run(word: &str) -> Option<Vec<u32>> {
    let mut days = Vec::new();
    let mut rest = word;

    while !rest.is_empty() {
        let (token, day) = DAY_LETTERS
            .iter()
            .find(|(token, _)| rest.starts_with(token))?;
        days.push(*day);
        rest = &rest[token.len()..];
    }

    Some(days)
}

/// Whatever trails the time — a room, a building — trimmed of the punctuation joining it.
fn find_location(tail: &str) -> Option<String> {
    let cleaned = tail
        .trim()
        .trim_start_matches([',', '-', '\u{2013}', '\u{2014}', ':', ';'])
        .trim();

    // A parenthesised room is the common case, and the brackets are not part of the name.
    let inner = cleaned
        .strip_prefix('(')
        .and_then(|rest| rest.split(')').next())
        .unwrap_or(cleaned)
        .trim()
        .trim_end_matches(['.', ',', ')'])
        .trim();

    if inner.is_empty() || inner.chars().count() > MAX_LOCATION_CHARS {
        return None;
    }
    // A bare word with no letters is punctuation that survived the trim.
    if !inner.chars().any(char::is_alphanumeric) {
        return None;
    }

    Some(inner.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn only(text: &str) -> MeetingPattern {
        let found = meetings(text);
        assert_eq!(found.len(), 1, "expected exactly one meeting in {text:?}");
        found.into_iter().next().unwrap()
    }

    #[test]
    fn reads_the_canonical_lecture_line() {
        let meeting = only("Lecture: MWF 10:00–10:50 AM, Pierce 201");
        assert_eq!(meeting.label.as_deref(), Some("Lecture"));
        assert_eq!(meeting.weekdays, vec![1, 3, 5]);
        assert_eq!(meeting.start_minutes, 10 * 60);
        assert_eq!(meeting.end_minutes, 10 * 60 + 50);
        assert_eq!(meeting.location.as_deref(), Some("Pierce 201"));
    }

    // `Th` has to be matched before `T`, or TuTh becomes Tuesday twice.
    #[test]
    fn tuesday_and_thursday_are_not_two_tuesdays() {
        assert_eq!(only("TuTh 2:00-3:20 p.m.").weekdays, vec![2, 4]);
        assert_eq!(only("TTh 2:00-3:20 p.m.").weekdays, vec![2, 4]);
    }

    // `R` is Thursday in a course catalogue. Nobody guesses this; it has to be told.
    #[test]
    fn r_is_thursday() {
        assert_eq!(only("MWR 9:00-9:50 AM").weekdays, vec![1, 3, 4]);
    }

    #[test]
    fn separators_between_days_do_not_matter() {
        let slashes = only("M/W/F 8:00-8:50 AM").weekdays;
        let commas = only("M, W, F 8:00-8:50 AM").weekdays;
        let words = only("Monday and Wednesday, 9:30-10:45 AM").weekdays;
        assert_eq!(slashes, vec![1, 3, 5]);
        assert_eq!(commas, vec![1, 3, 5]);
        assert_eq!(words, vec![1, 3], "`and` is not a Saturday");
    }

    /// `8–8:50 AM` is fifty minutes. Reading the first half as morning only because the
    /// second half said so is the whole trick.
    #[test]
    fn a_meridiem_on_one_half_applies_to_both() {
        let meeting = only("MWF 8–8:50 AM");
        assert_eq!(meeting.start_minutes, 8 * 60);
        assert_eq!(meeting.end_minutes, 8 * 60 + 50);
    }

    // Nothing meets at two in the morning.
    #[test]
    fn a_bare_afternoon_range_is_read_as_the_afternoon() {
        let meeting = only("TuTh 2-3:20");
        assert_eq!(meeting.start_minutes, 14 * 60);
        assert_eq!(meeting.end_minutes, 15 * 60 + 20);
    }

    #[test]
    fn noon_and_midnight_land_the_right_way_round() {
        assert_eq!(only("F 12:00-1:00 PM").start_minutes, 12 * 60);
        assert_eq!(only("F 12:00-1:00 AM").start_minutes, 0);
    }

    #[test]
    fn a_range_crossing_noon_is_not_backwards() {
        let meeting = only("W 11:00-1:00");
        assert_eq!(meeting.start_minutes, 11 * 60);
        assert_eq!(meeting.end_minutes, 13 * 60);
    }

    #[test]
    fn a_bracketed_room_loses_its_brackets() {
        assert_eq!(
            only("Lab: F 1:00–3:50 PM (Chem 1420)").location.as_deref(),
            Some("Chem 1420")
        );
    }

    #[test]
    fn a_line_with_no_time_is_not_a_meeting() {
        assert!(meetings("Attendance is expected at every Monday session.").is_empty());
    }

    #[test]
    fn a_time_with_no_days_is_not_a_weekly_commitment() {
        assert!(meetings("Final exam 10:00-12:00").is_empty());
    }

    #[test]
    fn the_same_line_twice_is_one_meeting() {
        let text = "MWF 10:00-10:50 AM\nMWF 10:00-10:50 AM";
        assert_eq!(meetings(text).len(), 1);
    }

    #[test]
    fn a_whole_syllabus_yields_each_of_its_meetings() {
        let text = "\
PHYS 040A — General Physics
Fall 2026

Lecture: MWF 10:00–10:50 AM, Pierce 201
Lab: F 1:00–3:50 PM (Chem 1420)
Discussion: Th 4:00-4:50 PM

Office hours are by appointment.
Grading: 40% homework, 60% exams.
";
        let found = meetings(text);
        assert_eq!(found.len(), 3);
        assert_eq!(found[0].label.as_deref(), Some("Lecture"));
        assert_eq!(found[1].weekdays, vec![5]);
        assert_eq!(found[2].start_minutes, 16 * 60);
    }

    // Prose must not donate half a sentence as a label.
    #[test]
    fn a_long_head_before_a_colon_is_not_a_label() {
        let meeting = only("Please note the class meets on MWF 10:00-10:50 AM");
        assert_eq!(meeting.label, None);
    }
}
