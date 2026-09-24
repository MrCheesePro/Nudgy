//! The host of the page in front — and deliberately nothing else.
//!
//! Every site rule in the registry used to be a guess at what a page *calls itself*, because
//! the window title is all the OS hands over. That works when a site puts its own name in
//! the title ("Poll Everywhere") and fails completely when it does not: a Canvas file page
//! is titled `PHYS 40A Lec 1 QL.pdf: PHYS_040A_001_26F - GENERAL PHYSICS`, which says
//! nothing about Canvas, and no amount of pattern-writing fixes that. The thing that
//! actually identifies a site is the host, and the host was never visible.
//!
//! macOS browsers answer Apple events, so it can be asked for. **Only the host survives the
//! asking.** `host_of` runs before anything is returned, the path and query are dropped in
//! the same expression that produced them, and nothing downstream is ever handed a URL —
//! this is invariant 6's "redaction runs before the sample is constructed" applied to the
//! address bar. `elearn.ucr.edu` is kept; `/courses/237131/files/26333889` is not, and a
//! page's path is usually more revealing than its title.

/// The AppleScript that asks one browser for its front tab's address.
///
/// Addressed by bundle id rather than by name: `tell application "Safari"` breaks on a
/// localized system and on anybody who renamed the app, and a wrong name makes AppleScript
/// go looking for an application rather than fail.
///
/// An unlisted browser returns `None` and keeps the title-matching path, which is also what
/// happens when the answer is refused — a site label is a nicety, not something worth
/// falling over.
pub fn script_for(bundle_id: &str) -> Option<String> {
    let id = bundle_id.to_lowercase();

    // Safari's window holds documents, not tabs, and its dictionary says so.
    if id == "com.apple.safari" || id == "com.apple.safaritechnologypreview" {
        return Some(format!(
            "tell application id \"{bundle_id}\" to get URL of front document"
        ));
    }

    const CHROMIUM: &[&str] = &[
        "com.google.chrome",
        "com.google.chrome.beta",
        "com.google.chrome.canary",
        "com.brave.browser",
        "com.microsoft.edgemac",
        "com.vivaldi.vivaldi",
        "com.operasoftware.opera",
        "company.thebrowser.browser",
    ];
    if CHROMIUM.contains(&id.as_str()) {
        return Some(format!(
            "tell application id \"{bundle_id}\" to get URL of active tab of front window"
        ));
    }

    None
}

/// Browsers show someone else's content, so the page decides the category. Matched on the
/// stem so `chrome.exe`, `com.google.chrome` and `google chrome` all land here.
pub fn is_browser(process: &str) -> bool {
    const BROWSERS: &[&str] = &[
        "chrome", "chromium", "safari", "firefox", "msedge", "edge", "arc", "brave", "opera",
        "vivaldi", "zen", "orion",
    ];
    let process = process.to_lowercase();
    BROWSERS.iter().any(|name| process.contains(name))
}

/// The host, lowercased, with `www.` and any port or credentials removed.
///
/// Two shapes come in. macOS hands over a real URL, scheme and all. Windows reads the
/// address bar, and Chrome *displays* `elearn.ucr.edu/courses/237131` with the `https://`
/// hidden — so a scheme is accepted, not required.
///
/// Returns `None` for anything that is not a page somebody navigated to: `about:blank`, a
/// `file://` path, a `chrome://` settings screen. Those are not sites, and a `file://` URL
/// in particular is a path on this machine — exactly the sort of thing that must not travel
/// any further than the function that read it. Without a scheme the bar is higher still,
/// because what is in that box may be half-typed rather than somewhere you are: it has to
/// look like a hostname and end in something that could be a TLD.
pub fn host_of(url: &str) -> Option<String> {
    let trimmed = url.trim();

    let rest = match trimmed.split_once("://") {
        Some((scheme, rest)) => {
            if !matches!(scheme.to_lowercase().as_str(), "http" | "https") {
                return None;
            }
            rest
        }
        // A search query, a half-typed address, or a bare host. Only the last is a site,
        // and a space is the cheapest thing that rules the other two out.
        None => {
            if trimmed.contains(char::is_whitespace) || trimmed.contains(':') {
                return None;
            }
            trimmed
        }
    };

    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    // `user:password@host` — the credentials are not a site and are not ours to hold.
    let host = authority.rsplit('@').next().unwrap_or_default();
    // A bracketed IPv6 literal has colons of its own, so only strip a trailing `:port`.
    let host = match host.rfind(':') {
        Some(at) if !host.ends_with(']') => &host[..at],
        _ => host,
    };

    let host = host.trim().trim_start_matches("www.").to_lowercase();
    if !looks_like_a_host(&host) {
        return None;
    }
    Some(host)
}

/// Labels separated by dots, ending in something that could be a top-level domain.
///
/// The address bar is an input as much as a display, so half of what is in it at any moment
/// is not a place. A trailing `.co` or `.edu` is the cheapest signal that somebody finished
/// typing, and everything here is a filter on what gets *kept* — nothing is corrected or
/// guessed at.
fn looks_like_a_host(host: &str) -> bool {
    let mut labels = host.split('.').peekable();
    let mut count = 0;

    while let Some(label) = labels.next() {
        if label.is_empty() {
            return false;
        }
        let ascii = label
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-');
        if !ascii || label.starts_with('-') || label.ends_with('-') {
            return false;
        }
        // The last label is the one that has to look like a suffix rather than a number.
        if labels.peek().is_none() && (label.len() < 2 || !label.chars().all(|c| c.is_ascii_alphabetic())) {
            return false;
        }
        count += 1;
    }

    count >= 2
}

#[cfg(target_os = "macos")]
pub use macos::active_host;

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    use super::{host_of, script_for};

    /// Long enough for a busy browser, short enough that a wedged one costs one tick.
    const TIMEOUT: Duration = Duration::from_secs(4);

    /// Browsers that said no. Asking again would re-prompt on every tick forever, which is
    /// how a permission dialog becomes a reason to uninstall something.
    static REFUSED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

    /// One question at a time. The first ask raises a system prompt and blocks until it is
    /// answered; without this, every tick behind it would queue another.
    static ASKING: AtomicBool = AtomicBool::new(false);

    pub async fn active_host(bundle_id: &str) -> Option<String> {
        let script = script_for(bundle_id)?;

        {
            let refused = REFUSED.lock().ok()?;
            if refused
                .as_ref()
                .is_some_and(|set| set.contains(&bundle_id.to_lowercase()))
            {
                return None;
            }
        }

        if ASKING.swap(true, Ordering::SeqCst) {
            return None;
        }
        let output = tokio::time::timeout(
            TIMEOUT,
            tokio::process::Command::new("/usr/bin/osascript")
                .arg("-e")
                .arg(&script)
                .output(),
        )
        .await;
        ASKING.store(false, Ordering::SeqCst);

        let output = match output {
            Ok(Ok(output)) => output,
            // A timeout is not a refusal: the prompt may still be on screen waiting to be
            // answered, and marking it refused would silently give up on a yes.
            _ => return None,
        };

        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            // -1743 is errAEEventNotPermitted: the user said no, or the app was never
            // granted. Anything else — no windows open, browser quitting — is transient.
            if error.contains("-1743") || error.contains("Not authorized") {
                log::info!("{bundle_id} declined to share its address; falling back to titles");
                if let Ok(mut refused) = REFUSED.lock() {
                    refused
                        .get_or_insert_with(HashSet::new)
                        .insert(bundle_id.to_lowercase());
                }
            }
            return None;
        }

        // The only place a full URL exists, and it does not outlive this line.
        host_of(&String::from_utf8_lossy(&output.stdout))
    }
}

#[cfg(target_os = "windows")]
pub use windows_ui::active_host_for_window;

#[cfg(target_os = "windows")]
mod windows_ui {
    use std::sync::Mutex;
    use std::time::Duration;

    use windows::core::Interface;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationValuePattern, TreeScope_Descendants,
        UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_ValuePatternId,
    };

    use super::host_of;

    /// Walking a browser's automation tree is expensive — tens of milliseconds, sometimes
    /// more on a window with many tabs. Long enough to be worth doing only when the page
    /// has actually changed, and long enough that a wedged browser must cost one tick
    /// rather than the tick loop.
    const TIMEOUT: Duration = Duration::from_secs(2);

    /// The last answer, and the title it went with.
    ///
    /// The window title changes on navigation, which makes it a free "has the page
    /// changed?" signal: the tree is walked once per page rather than once every three
    /// seconds. Two different pages sharing a title share an answer, and since a title is
    /// per-site far more often than not, that is a stale host only in the case where it is
    /// also the right one.
    static LAST: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

    pub async fn active_host_for_window(hwnd: isize, title: Option<&str>) -> Option<String> {
        let key = title.unwrap_or_default().to_string();

        if let Ok(last) = LAST.lock() {
            if let Some((seen, host)) = last.as_ref() {
                if seen == &key {
                    return host.clone();
                }
            }
        }

        // UI Automation blocks, so it does not belong on a runtime worker.
        let found = tokio::time::timeout(
            TIMEOUT,
            tokio::task::spawn_blocking(move || read_address_bar(hwnd)),
        )
        .await;

        let host = match found {
            Ok(Ok(host)) => host,
            // A timeout or a panicked probe is not an answer, and must not be cached as
            // one — the next tick asks again.
            _ => return None,
        };

        if let Ok(mut last) = LAST.lock() {
            *last = Some((key, host.clone()));
        }
        host
    }

    /// The first edit control in the browser's window, which is the address bar.
    ///
    /// Found by control type rather than by name: "Address and search bar" is the English
    /// name for it, and a rule that only works in English is a rule that quietly does
    /// nothing for most of the world.
    fn read_address_bar(hwnd: isize) -> Option<String> {
        unsafe {
            // S_FALSE means this thread was already initialized, which is a success. The
            // matching uninitialize is deliberately never called: the runtime reuses its
            // worker threads, and tearing COM down between ticks would cost more than it
            // saves.
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()?;

            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let window = automation.ElementFromHandle(HWND(hwnd as *mut _)).ok()?;

            let edit = automation
                .CreatePropertyCondition(
                    UIA_ControlTypePropertyId,
                    &VARIANT::from(UIA_EditControlTypeId.0),
                )
                .ok()?;
            let bar = automation.FindFirst(TreeScope_Descendants, &edit).ok()?;

            let value = bar
                .GetCurrentPattern(UIA_ValuePatternId)
                .ok()?
                .cast::<IUIAutomationValuePattern>()
                .ok()?;

            // The only place an address exists, and it does not outlive this line.
            host_of(&value.CurrentValue().ok()?.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_host_and_drops_the_page() {
        assert_eq!(
            host_of("https://elearn.ucr.edu/courses/237131/files/26333889?module_item_id=3889881"),
            Some("elearn.ucr.edu".to_string())
        );
    }

    #[test]
    fn strips_www_a_port_and_credentials() {
        assert_eq!(
            host_of("https://www.Pearson.com/mylab"),
            Some("pearson.com".to_string())
        );
        assert_eq!(
            host_of("http://example.org:8080/x"),
            Some("example.org".to_string())
        );
        assert_eq!(
            host_of("https://someone:secret@pollev.com/profsmith"),
            Some("pollev.com".to_string())
        );
    }

    /// A local file's path is not a site, and is the last thing that should travel.
    #[test]
    fn refuses_everything_that_is_not_a_page() {
        for url in [
            "file:///Users/someone/Documents/taxes.pdf",
            "chrome://settings/passwords",
            "about:blank",
            "",
            "https://",
        ] {
            assert_eq!(host_of(url), None, "{url} should not have produced a host");
        }
    }

    #[test]
    fn a_bare_host_with_no_dot_is_not_a_site() {
        assert_eq!(host_of("http://localhost:3000/admin"), None);
    }

    /// What Windows reads: Chrome *displays* the address with `https://` hidden, so the
    /// scheme has to be optional or the address bar would never resolve to anything.
    #[test]
    fn reads_the_address_bar_shape_without_a_scheme() {
        assert_eq!(
            host_of("elearn.ucr.edu/courses/237131/files/26333889"),
            Some("elearn.ucr.edu".to_string())
        );
        assert_eq!(host_of("pollev.com"), Some("pollev.com".to_string()));
    }

    /// The address bar is an input as much as a display. Half of what is in it at any
    /// moment is a search, or an address somebody is still typing, and neither is a place.
    #[test]
    fn what_is_being_typed_is_not_a_site() {
        for text in [
            "how to fix a flat tyre",
            "about:blank",
            "localhost:3000/admin",
            "192.168.1.1/admin",
            "elearn.",
            "-bad.com",
        ] {
            assert_eq!(host_of(text), None, "{text:?} should not have produced a host");
        }
    }

    #[test]
    fn only_known_browsers_are_asked() {
        assert!(script_for("com.google.Chrome").is_some());
        assert!(script_for("com.apple.Safari").is_some());
        assert!(script_for("com.microsoft.VSCode").is_none());
        assert!(script_for("com.tinyspeck.slackmacgap").is_none());
    }

    /// Safari's front window holds a document; a Chromium window holds tabs. Getting this
    /// backwards is a script that always errors, which looks exactly like a refusal.
    #[test]
    fn safari_is_asked_for_a_document_and_chrome_for_a_tab() {
        assert!(script_for("com.apple.Safari")
            .unwrap()
            .contains("front document"));
        assert!(script_for("com.google.Chrome")
            .unwrap()
            .contains("active tab"));
    }
}
