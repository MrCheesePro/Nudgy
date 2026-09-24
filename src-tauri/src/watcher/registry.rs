use anyhow::{Context, Result};
use regex::Regex;
use rusqlite::Connection;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::db::queries;
use crate::models::{AppRule, Foreground, CATEGORY_NEUTRAL};

pub const MATCH_EXE: &str = "exe";
pub const MATCH_TITLE_REGEX: &str = "title_regex";
pub const REDACTED_TITLE: &str = "[Private]";

/// Compiled view of `known_apps` + `redaction_rules`. Rebuilt whenever a rule changes,
/// so the tick loop never compiles a regex.
#[derive(Default)]
pub struct Registry {
    exact: HashMap<String, (String, String)>,
    /// Already in precedence order — `load_app_rules` sorts by priority — so the first
    /// match is the answer and nothing has to be re-ranked on the tick path.
    title_rules: Vec<TitleRule>,
    redact_exact: HashSet<String>,
    redact_title: Vec<Regex>,
    /// The live category vocabulary. It is a table now, not a constant, so "is this a
    /// real category?" has to be asked of something that was loaded.
    categories: HashSet<String>,
}

struct TitleRule {
    regex: Regex,
    display_name: String,
    category: String,
}

/// What a foreground observation becomes once the rules have had their say.
pub struct Resolved {
    pub display_name: String,
    pub category: String,
    /// A short site label — "YouTube", "Canvas" — or None. Never the raw window title.
    pub context: Option<String>,
}

/// Browsers show someone else's content, so the page decides the category. Matched on the
/// stem so `chrome.exe`, `com.google.chrome` and `google chrome` all land here.
fn is_browser(process: &str) -> bool {
    const BROWSERS: &[&str] = &[
        "chrome", "chromium", "safari", "firefox", "msedge", "edge", "arc", "brave", "opera",
        "vivaldi", "zen", "orion",
    ];
    BROWSERS.iter().any(|name| process.contains(name))
}

impl Registry {
    pub fn load(conn: &Connection) -> Result<Self> {
        let mut registry = Registry::default();

        for rule in queries::load_app_rules(conn)? {
            match rule.match_type.as_str() {
                MATCH_EXE => {
                    registry.exact.insert(
                        rule.pattern.to_lowercase(),
                        (rule.display_name, rule.category),
                    );
                }
                MATCH_TITLE_REGEX => match Regex::new(&rule.pattern) {
                    Ok(regex) => registry.title_rules.push(TitleRule {
                        regex,
                        display_name: rule.display_name,
                        category: rule.category,
                    }),
                    // A rule that will not compile is skipped rather than fatal: one bad
                    // pattern must not stop the watcher from tracking anything at all.
                    Err(error) => {
                        log::warn!("skipping registry regex `{}`: {error}", rule.pattern)
                    }
                },
                other => log::warn!("unknown match_type `{other}` in known_apps"),
            }
        }

        for (match_type, pattern) in queries::load_redaction_patterns(conn)? {
            match match_type.as_str() {
                MATCH_EXE => {
                    registry.redact_exact.insert(pattern.to_lowercase());
                }
                MATCH_TITLE_REGEX => match Regex::new(&pattern) {
                    Ok(regex) => registry.redact_title.push(regex),
                    Err(error) => log::warn!("skipping redaction regex `{pattern}`: {error}"),
                },
                other => log::warn!("unknown match_type `{other}` in redaction_rules"),
            }
        }

        registry.categories = queries::category_names(conn)?.into_iter().collect();

        Ok(registry)
    }

    /// True when `name` is a category someone could actually have chosen. Replaces the old
    /// compile-time list, so a category added at runtime is valid immediately.
    pub fn has_category(&self, name: &str) -> bool {
        self.categories.contains(name)
    }

    /// A registry that knows nothing but a vocabulary — enough to test the callers that
    /// only ask `has_category`, without standing up a database.
    #[cfg(test)]
    pub fn with_categories(names: &[&str]) -> Self {
        Registry {
            categories: names.iter().map(|name| name.to_string()).collect(),
            ..Registry::default()
        }
    }

    /// Resolve a foreground observation to what gets stored.
    ///
    /// Inside a browser the site is the answer, not the browser: an hour of Chrome on
    /// YouTube and an hour of Chrome on Canvas are not the same hour, and calling both
    /// "Productivity" makes the day's numbers a lie. So for a browser the title rules run
    /// first and decide the category; everywhere else the executable wins, because a file
    /// called `youtube.ts` open in an editor is still development work.
    pub fn resolve(&self, foreground: &Foreground) -> Resolved {
        let process = foreground.process_name.to_lowercase();

        if is_browser(&process) {
            // The host first, and it beats every title rule whatever their priorities say.
            // A title rule is a guess at what a page calls itself; a host is what the page
            // *is*. `elearn.ucr.edu` is Canvas even when the tab is named after a PDF, and
            // a video titled "canvas painting tutorial" on youtube.com is not coursework.
            //
            // Skipped for a redacted window: a private tab's host is exactly as private as
            // its title, and invariant 6 wants that decided before anything is built.
            if !self.is_redacted(foreground) {
                if let Some(rule) = self.matching_host_rule(foreground) {
                    return Resolved {
                        display_name: self.display_name_for(&process, foreground),
                        category: rule.category.clone(),
                        context: Some(rule.display_name.clone()),
                    };
                }
            }

            if let Some(rule) = self.matching_title_rule(foreground) {
                return Resolved {
                    display_name: self.display_name_for(&process, foreground),
                    category: rule.category.clone(),
                    // The only part of a title that is ever kept: a short label from a
                    // rule someone wrote, never the page's own words.
                    context: Some(rule.display_name.clone()),
                };
            }
        }

        if let Some((name, category)) = self.exact.get(&process) {
            return Resolved {
                display_name: name.clone(),
                category: category.clone(),
                context: None,
            };
        }

        if let Some(rule) = self.matching_title_rule(foreground) {
            return Resolved {
                display_name: self.display_name_for(&process, foreground),
                category: rule.category.clone(),
                context: Some(rule.display_name.clone()),
            };
        }

        Resolved {
            display_name: self.display_name_for(&process, foreground),
            category: CATEGORY_NEUTRAL.to_string(),
            context: None,
        }
    }

    fn matching_title_rule(&self, foreground: &Foreground) -> Option<&TitleRule> {
        let title = foreground.title.as_deref()?;
        self.title_rules.iter().find(|rule| rule.regex.is_match(title))
    }

    /// The same rules, run against the host instead.
    ///
    /// One list, not two: a rule saying "pollev" should recognise the site whether that
    /// word turns up in the title or in the address, and keeping a separate table of host
    /// rules would mean every site had to be written down twice and could disagree.
    fn matching_host_rule(&self, foreground: &Foreground) -> Option<&TitleRule> {
        let host = foreground.host.as_deref()?;
        self.title_rules.iter().find(|rule| rule.regex.is_match(host))
    }

    /// The browser keeps its own name even when a site rule set the category — the header
    /// reads "Google Chrome · YouTube", not "YouTube" with the app gone.
    fn display_name_for(&self, process: &str, foreground: &Foreground) -> String {
        if let Some((name, _)) = self.exact.get(process) {
            return name.clone();
        }
        foreground
            .app_name
            .clone()
            .unwrap_or_else(|| foreground.process_name.clone())
    }

    /// Guesses which app a piece of free text is about — "draw in Clip Studio" →
    /// `jp.co.celsys.ClipStudioPaint`.
    ///
    /// This is what lets a goal be verified against a specific app without the user ever
    /// typing an executable name. Matching is deliberately conservative: the app's name
    /// has to actually appear in the text, and the longest match wins so "Code" does not
    /// beat "Visual Studio Code". No match is a fine outcome — the caller then counts any
    /// activity during the block instead.
    pub fn resolve_from_text(&self, text: &str) -> Option<AppRule> {
        let haystack = normalize(text);
        if haystack.is_empty() {
            return None;
        }

        let mut best: Option<(usize, AppRule)> = None;

        for (pattern, (display_name, category)) in &self.exact {
            // Try the human name first, then the raw pattern with any extension dropped.
            let candidates = [
                normalize(display_name),
                normalize(pattern.trim_end_matches(".exe")),
            ];

            for candidate in candidates {
                // Two characters is noise; it would match almost anything.
                if candidate.len() < 3 || !haystack.contains(&candidate) {
                    continue;
                }
                let score = candidate.len();
                if best.as_ref().is_none_or(|(current, _)| score > *current) {
                    best = Some((
                        score,
                        AppRule {
                            id: 0,
                            match_type: MATCH_EXE.to_string(),
                            pattern: pattern.clone(),
                            display_name: display_name.clone(),
                            category: category.clone(),
                            is_user_defined: false,
                            priority: crate::models::PRIORITY_DEFAULT,
                        },
                    ));
                }
            }
        }

        best.map(|(_, rule)| rule)
    }

    /// True when the window title must be replaced with `[Private]` before it is stored.
    /// The title never reaches the buffer, let alone the database, in that case.
    pub fn is_redacted(&self, foreground: &Foreground) -> bool {
        if self
            .redact_exact
            .contains(&foreground.process_name.to_lowercase())
        {
            return true;
        }
        match foreground.title.as_deref() {
            Some(title) => self.redact_title.iter().any(|regex| regex.is_match(title)),
            None => false,
        }
    }
}

/// Lowercase, letters and digits only, so "Clip Studio Paint", "clipstudiopaint" and
/// "ClipStudioPaint.exe" all reduce to the same thing.
pub(crate) fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

#[derive(Debug, Deserialize)]
struct SeedFile {
    #[serde(default)]
    apps: Vec<AppRule>,
    #[serde(default)]
    redactions: Vec<SeedRedaction>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedRedaction {
    match_type: String,
    pattern: String,
}

/// Seeds the bundled registry. Uses insert-or-ignore so a rule the user has edited
/// survives an app upgrade that ships a new seed file.
pub fn seed_from_file(conn: &Connection, path: &Path) -> Result<usize> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading seed registry {}", path.display()))?;
    let seed: SeedFile = serde_json::from_str(&raw)
        .with_context(|| format!("parsing seed registry {}", path.display()))?;

    let mut inserted = 0usize;
    for rule in &seed.apps {
        queries::upsert_app_rule(conn, rule, false)?;
        inserted += 1;
    }
    for redaction in &seed.redactions {
        queries::upsert_redaction_rule(conn, &redaction.match_type, &redaction.pattern)?;
    }
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn foreground(process: &str, title: Option<&str>) -> Foreground {
        Foreground {
            process_name: process.to_string(),
            app_name: None,
            title: title.map(str::to_string),
            host: None,
        }
    }

    /// The same window, plus the host the browser gave up.
    fn on_host(process: &str, title: Option<&str>, host: &str) -> Foreground {
        Foreground {
            host: Some(host.to_string()),
            ..foreground(process, title)
        }
    }

    fn registry() -> Registry {
        Registry {
            exact: HashMap::from([
                (
                    "code.exe".to_string(),
                    ("Visual Studio Code".to_string(), "Development".to_string()),
                ),
                (
                    "jp.co.celsys.clipstudiopaint".to_string(),
                    ("Clip Studio Paint".to_string(), "Creative".to_string()),
                ),
            ]),
            // In precedence order, as `load_app_rules` returns them: the coursework rule
            // outranks the media one, so a lecture recording is school, not leisure.
            title_rules: vec![
                TitleRule {
                    regex: Regex::new("(?i)canvas|assignment").unwrap(),
                    display_name: "Canvas".to_string(),
                    category: "Productivity".to_string(),
                },
                TitleRule {
                    regex: Regex::new("(?i)youtube").unwrap(),
                    display_name: "YouTube".to_string(),
                    category: "Free Time".to_string(),
                },
            ],
            redact_exact: HashSet::from(["1password.exe".to_string()]),
            redact_title: vec![Regex::new("(?i)incognito").unwrap()],
            categories: ["Development", "Productivity", "Creative", "Free Time", "Neutral"]
                .iter()
                .map(|name| name.to_string())
                .collect(),
        }
    }

    // A source file named after a website is still development work. The title rules must
    // not reach outside a browser, or every editor tab becomes whatever it is named after.
    #[test]
    fn exact_match_wins_outside_a_browser() {
        let resolved = registry().resolve(&foreground("CODE.EXE", Some("youtube")));
        assert_eq!(resolved.display_name, "Visual Studio Code");
        assert_eq!(resolved.category, "Development");
        assert_eq!(resolved.context, None);
    }

    #[test]
    fn a_site_decides_the_category_inside_a_browser() {
        let resolved = registry().resolve(&foreground("chrome.exe", Some("YouTube - x")));
        assert_eq!(resolved.category, "Free Time");
        assert_eq!(resolved.context.as_deref(), Some("YouTube"));
    }

    // Chrome is Neutral by default and coursework moves it to Productivity. A lecture
    // watched on YouTube matches both rules, and the answer must not depend on which
    // pattern happens to sort first — the higher-priority rule is listed first and wins.
    #[test]
    fn a_school_title_beats_a_media_title() {
        let resolved = registry().resolve(&foreground(
            "chrome.exe",
            Some("YouTube - CS101 assignment walkthrough"),
        ));
        assert_eq!(resolved.category, "Productivity");
        assert_eq!(resolved.context.as_deref(), Some("Canvas"));
    }

    #[test]
    fn a_browser_with_nothing_matching_stays_neutral() {
        let resolved = registry().resolve(&foreground("chrome.exe", Some("Weather tomorrow")));
        assert_eq!(resolved.category, CATEGORY_NEUTRAL);
        assert_eq!(resolved.context, None);
    }

    #[test]
    fn categories_come_from_the_loaded_set() {
        let registry = registry();
        assert!(registry.has_category("Free Time"));
        assert!(!registry.has_category("Gardening"));
    }

    // The browser keeps its own name; the site rides alongside it as context.
    #[test]
    fn a_matched_site_does_not_rename_the_browser() {
        let mut registry = registry();
        registry.exact.insert(
            "chrome.exe".to_string(),
            ("Google Chrome".to_string(), "Productivity".to_string()),
        );
        let resolved = registry.resolve(&foreground("chrome.exe", Some("YouTube - x")));
        assert_eq!(resolved.display_name, "Google Chrome");
        assert_eq!(resolved.category, "Free Time");
    }

    #[test]
    fn an_unmatched_page_keeps_nothing_of_its_title() {
        let resolved = registry().resolve(&foreground("chrome.exe", Some("Bank statement Q3")));
        assert_eq!(resolved.context, None);
    }

    /// The registry built from the file that actually ships, rather than a hand-made one.
    ///
    /// A seeded pattern is only ever exercised through this file, so a typo in it compiles,
    /// passes every test above, and then quietly never matches anything on a real machine.
    fn shipped() -> Registry {
        let raw = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/known_apps.json"),
        )
        .expect("reading the shipped seed registry");
        let seed: SeedFile = serde_json::from_str(&raw).expect("parsing the shipped seed registry");

        let mut registry = Registry::default();
        // Exactly `load_app_rules`'s `ORDER BY priority DESC, pattern` — including the
        // alphabetical tiebreak, which is load-bearing: inside one priority tier the
        // pattern string decides, so a rule that needs to outrank a peer needs a higher
        // number rather than a luckier spelling.
        let mut apps = seed.apps;
        apps.sort_by(|left, right| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| left.pattern.cmp(&right.pattern))
        });

        for rule in apps {
            match rule.match_type.as_str() {
                MATCH_EXE => {
                    registry
                        .exact
                        .insert(rule.pattern.to_lowercase(), (rule.display_name, rule.category));
                }
                MATCH_TITLE_REGEX => registry.title_rules.push(TitleRule {
                    regex: Regex::new(&rule.pattern).expect("a shipped pattern must compile"),
                    display_name: rule.display_name,
                    category: rule.category,
                }),
                other => panic!("unknown match_type `{other}` in the shipped registry"),
            }
        }
        registry
    }

    /// A class poll is a site, not "Google Chrome" for forty minutes.
    ///
    /// Poll Everywhere puts its own name in the tab on the presenter side and a bare
    /// `pollev.com/<presenter>` on the responder side, which is the one a student sees —
    /// so the short host has to match on its own, without the full domain being spelled.
    #[test]
    fn poll_everywhere_is_recognised_however_it_is_written() {
        let registry = shipped();
        for title in [
            "Poll Everywhere",
            "PollEverywhere",
            "pollev.com/profsmith123",
            "PollEv",
            "Respond to PHYS 040A - Poll Everywhere",
        ] {
            let resolved = registry.resolve(&foreground("chrome.exe", Some(title)));
            assert_eq!(
                resolved.context.as_deref(),
                Some("Poll Everywhere"),
                "title {title:?} should have been read as the site"
            );
            assert_eq!(resolved.category, "Productivity");
        }
    }

    /// Every seeded regex compiles, and the ones sharing a word do not shadow each other.
    #[test]
    fn the_shipped_registry_still_reads_the_sites_it_names() {
        let registry = shipped();
        for (title, site) in [
            ("YouTube", "YouTube"),
            ("Canvas", "Canvas"),
            ("Kahoot!", "Kahoot"),
            ("Gradescope", "Gradescope"),
            ("MyLab Math", "Pearson"),
            ("Pearson MyLab and Mastering", "Pearson"),
            ("Ed Discussion", "Edstem"),
            ("CS010C - edstem.org", "Edstem"),
        ] {
            let resolved = registry.resolve(&foreground("chrome.exe", Some(title)));
            assert_eq!(
                resolved.context.as_deref(),
                Some(site),
                "title {title:?} landed on the wrong site"
            );
        }
    }

    /// A Canvas instance that never says "Canvas" in a window title.
    ///
    /// Only the title is visible — `kCGWindowName` is the page title and the URL is not in
    /// it — so a school whose Canvas lives at its own host is invisible to a rule written
    /// against the host. What *is* in the title is the course Canvas appends after a colon:
    /// `... .pdf: PHYS_040A_001_26F - GENERAL PHYSICS`. The SIS code is the signal, and it
    /// is specific enough to be safe: nothing else puts `LETTERS_NNNN_NNN_NNL` in a title.
    ///
    /// The priority is 250 rather than 200 because inside one tier the pattern string
    /// breaks the tie alphabetically, and `[a-z0-9-]+\.edu` sorts ahead of every
    /// `\b`-anchored pattern — at 200 this would silently resolve to "School site".
    #[test]
    fn a_schools_own_canvas_is_read_from_the_course_it_names() {
        let registry = shipped();
        for title in [
            "PHYS 40A Lec 1 QL.pdf: PHYS_040A_001_26F - GENERAL PHYSICS",
            "Modules: CS_010C_001_26F - INTRO TO DATA STRUCTURES",
            "Dashboard | elearn.ucr.edu",
        ] {
            let resolved = registry.resolve(&foreground("chrome.exe", Some(title)));
            assert_eq!(
                resolved.context.as_deref(),
                Some("Canvas"),
                "title {title:?} should have been read as Canvas"
            );
            assert_eq!(resolved.category, "Productivity");
        }
    }

    /// The whole point of asking the browser: a page that never says what site it is on.
    ///
    /// This title matches nothing in the registry — no "canvas", no "elearn", not even one
    /// of the coursework words. The host is the only thing that identifies it.
    #[test]
    fn a_host_names_a_site_the_title_never_mentions() {
        let resolved = shipped().resolve(&on_host(
            "com.google.Chrome",
            Some("PHYS 40A Lec 1 QL.pdf"),
            "elearn.ucr.edu",
        ));
        assert_eq!(resolved.context.as_deref(), Some("Canvas"));
        assert_eq!(resolved.category, "Productivity");
        assert_eq!(resolved.display_name, "Google Chrome");
    }

    /// A host is what a page *is*; a title is what it calls itself. Fact outranks claim,
    /// whatever the two rules' priorities happen to be.
    #[test]
    fn the_host_wins_over_a_title_that_says_otherwise() {
        let resolved = shipped().resolve(&on_host(
            "com.google.Chrome",
            Some("canvas painting for beginners"),
            "youtube.com",
        ));
        assert_eq!(resolved.context.as_deref(), Some("YouTube"));
        assert_eq!(resolved.category, "Free Time");
    }

    /// A private window's address is exactly as private as its title.
    #[test]
    fn a_redacted_window_is_never_asked_what_site_it_is_on() {
        let registry = registry();
        let resolved = registry.resolve(&on_host(
            "chrome.exe",
            Some("Incognito - Google"),
            "youtube.com",
        ));
        assert!(registry.is_redacted(&on_host(
            "chrome.exe",
            Some("Incognito - Google"),
            "youtube.com"
        )));
        assert_eq!(resolved.context, None);
    }

    /// Seeded site rules have to recognise a host, not only a word in a title.
    #[test]
    fn the_shipped_rules_read_hosts_too() {
        let registry = shipped();
        for (host, site) in [
            ("pollev.com", "Poll Everywhere"),
            ("edstem.org", "Edstem"),
            ("mathxl.com", "Pearson"),
            ("ucr.instructure.com", "Canvas"),
            ("gradescope.com", "Gradescope"),
        ] {
            let resolved = registry.resolve(&on_host("com.google.Chrome", None, host));
            assert_eq!(
                resolved.context.as_deref(),
                Some(site),
                "host {host:?} landed on the wrong site"
            );
        }
    }

    /// The course-code pattern must not swallow an ordinary file name.
    #[test]
    fn a_plain_download_is_not_a_course() {
        let resolved = shipped().resolve(&foreground(
            "chrome.exe",
            Some("IMG_2024_001.heic — Preview"),
        ));
        assert_eq!(resolved.context, None);
    }

    #[test]
    fn unknown_process_falls_back_to_neutral() {
        let resolved = registry().resolve(&foreground("mystery.exe", None));
        assert_eq!(resolved.display_name, "mystery.exe");
        assert_eq!(resolved.category, CATEGORY_NEUTRAL);
    }

    #[test]
    fn resolves_an_app_from_plain_goal_text() {
        let resolved = registry().resolve_from_text("draw for 30m in Clip Studio Paint");
        assert_eq!(resolved.unwrap().pattern, "jp.co.celsys.clipstudiopaint");
    }

    #[test]
    fn resolution_ignores_spacing_and_case() {
        let resolved = registry().resolve_from_text("finish the clipstudiopaint piece");
        assert_eq!(resolved.unwrap().display_name, "Clip Studio Paint");
    }

    #[test]
    fn unrelated_text_resolves_to_nothing() {
        assert!(registry().resolve_from_text("read chapter four").is_none());
        assert!(registry().resolve_from_text("").is_none());
    }

    #[test]
    fn the_longest_matching_name_wins() {
        let mut registry = registry();
        registry.exact.insert(
            "code".to_string(),
            ("Code".to_string(), "Development".to_string()),
        );
        let resolved = registry.resolve_from_text("work in Visual Studio Code");
        assert_eq!(resolved.unwrap().display_name, "Visual Studio Code");
    }

    #[test]
    fn redaction_matches_process_or_title() {
        let registry = registry();
        assert!(registry.is_redacted(&foreground("1Password.exe", Some("Vault"))));
        assert!(registry.is_redacted(&foreground("chrome.exe", Some("Incognito - Google"))));
        assert!(!registry.is_redacted(&foreground("chrome.exe", Some("News"))));
    }
}
