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

/// The host, lowercased, with `www.` and any port or credentials removed.
///
/// Returns `None` for anything that is not a page somebody navigated to: `about:blank`, a
/// `file://` path, a `chrome://` settings screen. Those are not sites, and a `file://` URL
/// in particular is a path on this machine — exactly the sort of thing that must not travel
/// any further than the function that read it.
pub fn host_of(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    if !matches!(scheme.to_lowercase().as_str(), "http" | "https") {
        return None;
    }

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
    if host.is_empty() || !host.contains('.') {
        return None;
    }
    Some(host)
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
