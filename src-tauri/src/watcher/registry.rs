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
