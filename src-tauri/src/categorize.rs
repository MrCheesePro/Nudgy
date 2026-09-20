//! Guessing a category for an app nobody has classified yet.
//!
//! A keyword table: offline, instant, free, and right about the apps people actually
//! run. No model, no key, no network — a suggestion is not worth a round trip, and an
//! app tracker that needs an API key to name Photoshop has lost the plot.
//!
//! Nothing here writes anything, and nothing here pretends. A guess fills a dropdown,
//! the user still presses the button, and "no idea" is a real answer.

use crate::watcher::registry::normalize;

pub const SOURCE_HEURISTIC: &str = "heuristic";
pub const SOURCE_NONE: &str = "none";

/// The shortest stem worth matching. Two characters would hit almost anything.
const MIN_STEM: usize = 3;

/// Stems that name an app, paired with where its time belongs. Matched against the
/// normalized process name, the normalized app name, and the last dot-segment of a bundle
/// id — so `com.apple.dt.Xcode`, `Xcode.app` and `xcode` all land the same way.
///
/// Longest match wins, which is what stops `code` from beating `androidstudio` on a string
/// containing both.
const STEMS: &[(&str, &str)] = &[
    // Development
    ("vscode", "Development"),
    ("visualstudiocode", "Development"),
    ("code", "Development"),
    ("cursor", "Development"),
    ("zed", "Development"),
    ("xcode", "Development"),
    ("androidstudio", "Development"),
    ("intellij", "Development"),
    ("pycharm", "Development"),
    ("webstorm", "Development"),
    ("goland", "Development"),
    ("rustrover", "Development"),
    ("sublimetext", "Development"),
    ("neovim", "Development"),
    ("iterm", "Development"),
    ("ghostty", "Development"),
    ("alacritty", "Development"),
    ("kitty", "Development"),
    ("warp", "Development"),
    ("terminal", "Development"),
    ("docker", "Development"),
    ("postman", "Development"),
    ("insomnia", "Development"),
    ("tableplus", "Development"),
    ("sourcetree", "Development"),
    ("github", "Development"),
    // Productivity
    ("microsoftword", "Productivity"),
    ("microsoftexcel", "Productivity"),
    ("powerpoint", "Productivity"),
    ("outlook", "Productivity"),
    ("onenote", "Productivity"),
    ("notion", "Productivity"),
    ("obsidian", "Productivity"),
    ("evernote", "Productivity"),
    ("bear", "Productivity"),
    ("todoist", "Productivity"),
    ("things", "Productivity"),
    ("slack", "Productivity"),
    ("teams", "Productivity"),
    ("zoom", "Productivity"),
    ("webex", "Productivity"),
    ("acrobat", "Productivity"),
    ("keynote", "Productivity"),
    ("numbers", "Productivity"),
    ("pages", "Productivity"),
    ("anki", "Productivity"),
    ("zotero", "Productivity"),
    ("mendeley", "Productivity"),
    ("calculator", "Productivity"),
    ("reminders", "Productivity"),
    ("calendar", "Productivity"),
    ("mail", "Productivity"),
    ("preview", "Productivity"),
    ("notes", "Productivity"),
    // Creative
    ("photoshop", "Creative"),
    ("illustrator", "Creative"),
    ("indesign", "Creative"),
    ("lightroom", "Creative"),
    ("premierepro", "Creative"),
    ("aftereffects", "Creative"),
    ("figma", "Creative"),
    ("sketch", "Creative"),
    ("blender", "Creative"),
    ("clipstudiopaint", "Creative"),
    ("procreate", "Creative"),
    ("krita", "Creative"),
    ("affinity", "Creative"),
    ("davinciresolve", "Creative"),
    ("finalcut", "Creative"),
    ("audacity", "Creative"),
    ("ableton", "Creative"),
    ("logicpro", "Creative"),
    ("garageband", "Creative"),
    ("fl studio", "Creative"),
    ("unity", "Creative"),
    ("unrealeditor", "Creative"),
    ("canva", "Creative"),
    // Gaming
    ("steam", "Gaming"),
    ("epicgames", "Gaming"),
    ("battlenet", "Gaming"),
    ("riotclient", "Gaming"),
    ("leagueoflegends", "Gaming"),
    ("valorant", "Gaming"),
    ("minecraft", "Gaming"),
    ("roblox", "Gaming"),
    ("osu", "Gaming"),
    ("gog", "Gaming"),
    ("origin", "Gaming"),
    ("ubisoftconnect", "Gaming"),
    ("nintendo", "Gaming"),
    // Free Time
    ("spotify", "Free Time"),
    ("netflix", "Free Time"),
    ("hulu", "Free Time"),
    ("disney", "Free Time"),
    ("crunchyroll", "Free Time"),
    ("twitch", "Free Time"),
    ("youtube", "Free Time"),
    ("plex", "Free Time"),
    ("vlc", "Free Time"),
    ("iina", "Free Time"),
    ("podcasts", "Free Time"),
    ("appletv", "Free Time"),
    ("music", "Free Time"),
    // Social
    ("discord", "Social"),
    ("whatsapp", "Social"),
    ("telegram", "Social"),
    ("signal", "Social"),
    ("messenger", "Social"),
    ("messages", "Social"),
    ("facetime", "Social"),
    ("instagram", "Social"),
    ("snapchat", "Social"),
    ("bluesky", "Social"),
];

/// The offline guess. `None` means "no opinion", and it has to stay honest rather than
/// defaulting to something plausible: the UI shows it as "no idea", which is useful,
/// where a confident wrong answer would quietly mis-file the app forever.
pub fn guess(process_name: &str, app_name: Option<&str>) -> Option<String> {
    let mut haystacks = vec![normalize(process_name)];

    // A bundle id's last segment is usually the app: `com.apple.dt.Xcode` → `xcode`. The
    // whole id is kept too, for the ones that spell the name across segments.
    if let Some(tail) = process_name.rsplit('.').next() {
        haystacks.push(normalize(tail));
    }
    if let Some(name) = app_name {
        haystacks.push(normalize(name));
    }
    haystacks.retain(|value| !value.is_empty());

    let mut best: Option<(usize, &str)> = None;
    for (stem, category) in STEMS {
        let needle = normalize(stem);
        if needle.len() < MIN_STEM {
            continue;
        }
        if !haystacks.iter().any(|value| value.contains(&needle)) {
            continue;
        }
        if best.is_none_or(|(length, _)| needle.len() > length) {
            best = Some((needle.len(), category));
        }
    }

    best.map(|(_, category)| category.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_tail_of_a_bundle_id() {
        assert_eq!(guess("com.apple.dt.Xcode", None).as_deref(), Some("Development"));
        assert_eq!(guess("com.spotify.client", None).as_deref(), Some("Free Time"));
        assert_eq!(
            guess("jp.co.celsys.ClipStudioPaint", None).as_deref(),
            Some("Creative")
        );
    }

    #[test]
    fn reads_a_windows_executable() {
        assert_eq!(guess("steam.exe", None).as_deref(), Some("Gaming"));
        assert_eq!(guess("Discord.exe", None).as_deref(), Some("Social"));
    }

    #[test]
    fn falls_back_to_the_display_name() {
        assert_eq!(
            guess("app-9182", Some("Adobe Photoshop 2024")).as_deref(),
            Some("Creative")
        );
    }

    // Knowing when it does not know is the point — a guess that always answers would be
    // worse than useless, because nothing on screen would say which ones to check.
    #[test]
    fn unknown_apps_produce_no_opinion() {
        assert_eq!(guess("com.acme.LedgerPro", None), None);
        assert_eq!(guess("", None), None);
    }

    #[test]
    fn the_longest_stem_wins() {
        // "code" and "androidstudio" both appear; the specific one has to win.
        assert_eq!(
            guess("com.google.android.studio", Some("Android Studio")).as_deref(),
            Some("Development")
        );
        assert_eq!(
            guess("com.adobe.PremierePro", Some("Premiere Pro")).as_deref(),
            Some("Creative")
        );
    }
}
