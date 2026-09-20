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
    title_rules: Vec<TitleRule>,
    redact_exact: HashSet<String>,
    redact_title: Vec<Regex>,
}

struct TitleRule {
    regex: Regex,
    display_name: String,
    category: String,
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

        Ok(registry)
    }

    /// Resolve a foreground observation to (display name, category).
    /// Order: exact executable/bundle id, then title regex, then Neutral.
    pub fn categorize(&self, foreground: &Foreground) -> (String, String) {
        if let Some((name, category)) = self.exact.get(&foreground.process_name.to_lowercase()) {
            return (name.clone(), category.clone());
        }

        if let Some(title) = foreground.title.as_deref() {
            for rule in &self.title_rules {
                if rule.regex.is_match(title) {
                    let name = foreground
                        .app_name
                        .clone()
                        .unwrap_or_else(|| rule.display_name.clone());
                    return (name, rule.category.clone());
                }
            }
        }

        let name = foreground
            .app_name
            .clone()
            .unwrap_or_else(|| foreground.process_name.clone());
        (name, CATEGORY_NEUTRAL.to_string())
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
fn normalize(value: &str) -> String {
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
            title_rules: vec![TitleRule {
                regex: Regex::new("(?i)youtube").unwrap(),
                display_name: "Streaming (web)".to_string(),
                category: "Social".to_string(),
            }],
            redact_exact: HashSet::from(["1password.exe".to_string()]),
            redact_title: vec![Regex::new("(?i)incognito").unwrap()],
        }
    }

    #[test]
    fn exact_match_wins_and_is_case_insensitive() {
        let (name, category) = registry().categorize(&foreground("CODE.EXE", Some("youtube")));
        assert_eq!(name, "Visual Studio Code");
        assert_eq!(category, "Development");
    }

    #[test]
    fn title_regex_applies_when_no_exact_match() {
        let (_, category) = registry().categorize(&foreground("chrome.exe", Some("YouTube - x")));
        assert_eq!(category, "Social");
    }

    #[test]
    fn unknown_process_falls_back_to_neutral() {
        let (name, category) = registry().categorize(&foreground("mystery.exe", None));
        assert_eq!(name, "mystery.exe");
        assert_eq!(category, CATEGORY_NEUTRAL);
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
