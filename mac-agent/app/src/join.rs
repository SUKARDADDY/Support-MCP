//! The join app's logic, apart from the screen and the system: what a pasted link or code means, which relay it may
//! name, the small file that lets a restart carry on, and the steps from a link to the end of the session. Everything
//! here runs and is tested on Linux. `mac::join` and `mac::join_ui` do the real work each step asks for.
//!
//! The steps (`Step`) are driven by events and answer with effects, so no step depends on a clock or a window:
//!
//! ```text
//! Entry -> Looking -> Confirm -> Redeeming -> Asking -> Permissions -> Connecting -> Connected -> Ending -> Done
//!            (preview)  (shows relay      (code used)  (Allow /       (two switches)   (hello)                   (cleanup)
//!                        and label)                    Don't allow)
//! ```
//!
//! A second link is refused from the moment the code is used until the end of the session. The saved state
//! (`join.json`) is written when the code is used up and removed at the end, so the restart macOS forces after the
//! Screen Recording switch (and any other relaunch) resumes the same session instead of asking for a link again.

use crate::paths;
use crate::state;
use serde::{Deserialize, Serialize};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use support_core::redeem::{is_link_code, STARTUP_MAX_MS};
use support_core::wire;

/// The relay this build joins, fixed when it is built: the environment variable `SUPPORT_JOIN_RELAY_ORIGIN` at
/// `cargo build` time (packaging/build.sh passes it, and refuses to build without it). The repository's wrangler.toml
/// holds a placeholder route, so the production address cannot come from there. A link for any other relay is refused
/// before anything is sent to it.
pub const BUILD_RELAY_ORIGIN: Option<&str> = option_env!("SUPPORT_JOIN_RELAY_ORIGIN");

/// The relay this build joins, as `wire::check_origin` writes it.
pub fn build_origin() -> Result<String, String> {
    let text = BUILD_RELAY_ORIGIN.ok_or("This copy of Support Join was built without a support server, so it cannot join anything.")?;
    wire::check_origin(text).map_err(|_| "This copy of Support Join was built with a support server address it cannot use.".to_string())
}

/// `support.example.com` (and the port, when there is one) of an origin, for the person to read.
pub fn host_of(origin: &str) -> String {
    match url::Url::parse(origin) {
        Ok(u) => match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_string(),
            _ => origin.to_string(),
        },
        Err(_) => origin.to_string(),
    }
}

// ---- what was pasted -----------------------------------------------------------------------------------------------

/// A link or a code, read. `origin` is the relay a full link names, None for the app's own link and a bare code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub code: String,
    pub origin: Option<String>,
}

pub const BAD_INPUT: &str = "This is not a support link or code. Paste the link your support team sent you, or its 16-letter code.";

/// A code as people write it: any case, with spaces or hyphens between its groups.
pub fn normalize_code(text: &str) -> Option<String> {
    let c: String = text.chars().filter(|ch| !ch.is_whitespace() && *ch != '-').collect::<String>().to_lowercase();
    is_link_code(&c).then_some(c)
}

/// Reads what the person pasted, or what the page's button handed over: `supportmcp://join?code=<code>`, a full link
/// `https://<relay>/j/<code>` (with or without `?client=app`), or the code alone.
pub fn parse_input(text: &str) -> Result<Parsed, String> {
    let t = text.trim();
    if t.is_empty() {
        return Err("Paste the link your support team sent you, or its 16-letter code.".into());
    }
    if t.len() > 500 || t.chars().any(char::is_control) {
        return Err(BAD_INPUT.into());
    }
    if !t.contains(':') {
        return normalize_code(t).map(|code| Parsed { code, origin: None }).ok_or_else(|| BAD_INPUT.to_string());
    }
    let url = url::Url::parse(t).map_err(|_| BAD_INPUT.to_string())?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(BAD_INPUT.into());
    }
    let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    if url.scheme() == paths::JOIN_URL_SCHEME {
        // supportmcp://join?code=<code>
        let one_code = matches!(query.as_slice(), [(k, _)] if k == "code");
        if url.host_str() != Some("join") || !matches!(url.path(), "" | "/") || !one_code {
            return Err(BAD_INPUT.into());
        }
        return normalize_code(&query[0].1).map(|code| Parsed { code, origin: None }).ok_or_else(|| BAD_INPUT.to_string());
    }
    // https://<relay>/j/<code>[?client=app]
    let origin = wire::check_origin(&url.origin().ascii_serialization()).map_err(|_| BAD_INPUT.to_string())?;
    let app_query = query.is_empty() || matches!(query.as_slice(), [(k, v)] if k == "client" && v == "app");
    let code = url.path().strip_prefix("/j/").map(|c| c.trim_end_matches('/'));
    match code {
        Some(c) if app_query && is_link_code(c) => Ok(Parsed { code: c.to_string(), origin: Some(origin) }),
        _ => Err(BAD_INPUT.into()),
    }
}

/// A link that names a relay must name this build's relay. The check comes before any request.
pub fn check_origin(parsed: &Parsed, expected: &str) -> Result<(), String> {
    match &parsed.origin {
        Some(o) if o != expected => Err(format!(
            "This link is for {}, but this copy of Support Join only joins {}. Nothing was used. Ask your support team for the right link.",
            host_of(o),
            host_of(expected)
        )),
        _ => Ok(()),
    }
}

// ---- join.json -----------------------------------------------------------------------------------------------------

/// The session the code was used for, kept so a relaunch carries on. It holds the session key, so the file is 0600 in a
/// 0700 folder, and it is deleted when the session ends.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    pub sid: String,
    pub key: String,
    pub origin: String,
    /// The end of the first-connect window, Unix ms on this Mac's clock.
    pub startup_deadline_ms: i64,
    /// The person pressed Allow. A relaunch then goes straight on to the two switches.
    #[serde(default)]
    pub allowed: bool,
}

impl std::fmt::Debug for Saved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Saved")
            .field("sid", &self.sid)
            .field("key", &"<hidden>")
            .field("origin", &self.origin)
            .field("allowed", &self.allowed)
            .finish()
    }
}

/// `~/Library/Application Support/SupportMCP` of a home folder.
pub fn data_dir(home: &Path) -> PathBuf {
    home.join(paths::JOIN_DIR_UNDER_HOME)
}

fn file_in(dir: &Path) -> PathBuf {
    dir.join(paths::JOIN_FILE)
}

/// Writes join.json (0600, in a 0700 folder made if missing) through a temporary file and a rename.
pub fn save(dir: &Path, saved: &Saved, owner: u32) -> Result<(), String> {
    state::ensure_dir(dir, owner)?;
    let bytes = serde_json::to_vec(saved).map_err(|e| e.to_string())?;
    state::write_atomic(&file_in(dir), &bytes)
}

/// Removes join.json. Missing is fine.
pub fn delete(dir: &Path) -> Result<(), String> {
    match fs::remove_file(file_in(dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Loaded {
    None,
    /// A session to carry on with.
    Live(Saved),
    /// There was a file, but it is not one to trust or its time has run out. It has been removed. The text says why.
    Discarded(String),
}

/// Reads join.json for a relaunch. It must be a regular file the person owns that nobody else can read, name this
/// build's relay, hold a well-formed session and have time left; anything else is removed and never used.
pub fn load(dir: &Path, expected_origin: &str, owner: u32, now_ms: i64) -> Loaded {
    let path = file_in(dir);
    let Ok(meta) = fs::symlink_metadata(&path) else { return Loaded::None };
    let discard = |why: &str| {
        let _ = fs::remove_file(&path);
        Loaded::Discarded(why.to_string())
    };
    if !meta.file_type().is_file() || meta.uid() != owner || meta.permissions().mode() & 0o077 != 0 || meta.len() > 4096 {
        return discard("An earlier session's file was not safe to use, so it was removed.");
    }
    let saved: Saved = match fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        Some(s) => s,
        None => return discard("An earlier session's file could not be read, so it was removed."),
    };
    if saved.origin != expected_origin || !wire::is_session_id(&saved.sid) || !wire::is_session_id(&saved.key) {
        return discard("An earlier session's file was for another support server, so it was removed.");
    }
    // Two hours is the longest a link allows; a deadline beyond that was not written by this app.
    if saved.startup_deadline_ms > now_ms + STARTUP_MAX_MS as i64 + 60_000 {
        return discard("An earlier session's file had an impossible time, so it was removed.");
    }
    if saved.startup_deadline_ms <= now_ms {
        return discard("An earlier session's time ran out, so its file was removed.");
    }
    Loaded::Live(saved)
}

// ---- the steps -----------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Waiting for a link or a code.
    Entry,
    /// Asking the relay what the link is for (nothing is used up).
    Looking,
    /// Showing the relay and the session's label; the code is still unused.
    Confirm {
        host: String,
        label: Option<String>,
    },
    /// Using the code up.
    Redeeming,
    /// The question: Allow or Don't allow.
    Asking,
    /// Allowed; waiting for Screen Recording and Accessibility.
    Permissions,
    /// Both are on; connecting to the relay.
    Connecting,
    Connected,
    /// The session is over; cleaning up.
    Ending,
    /// Finished. `lines` say what happened and what was cleaned up.
    Done {
        lines: Vec<String>,
    },
}

impl Step {
    /// From the moment the code is used until the session is over, no other link is taken.
    pub fn live(&self) -> bool {
        matches!(self, Step::Redeeming | Step::Asking | Step::Permissions | Step::Connecting | Step::Connected | Step::Ending)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndHow {
    /// The relay ended it: the technician ended it, it expired, or the code's window ran out.
    Relay,
    /// This side stopped it (End session) or the first-connect time ran out.
    Stopped,
    Failed(String),
}

#[derive(Debug, Clone)]
pub enum Event {
    /// A link or a code from the window or the page's button.
    Submitted(String),
    PreviewOk {
        code: String,
        label: Option<String>,
    },
    PreviewFailed {
        code: String,
        text: String,
    },
    /// The person confirmed the relay and label shown.
    Confirmed,
    /// The person backed out before the code was used.
    Back,
    RedeemOk(Saved),
    RedeemFailed(String),
    Answered(bool),
    Permissions {
        screen: bool,
        accessibility: bool,
    },
    Connected,
    SessionEnded(EndHow),
    /// End session, from the corner window or the main window.
    EndClicked,
    /// A relaunch found a session to carry on with.
    Resumed(Saved),
    /// The clock, once a second or so.
    Tick(i64),
    CleanupDone(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Preview {
        origin: String,
        code: String,
    },
    Redeem {
        origin: String,
        code: String,
    },
    Save(Saved),
    Ask,
    /// Tells the relay "Don't allow" (the session ends as declined).
    SendDecline,
    StartSession(Saved),
    StopSession,
    /// Deletes join.json, resets the two permissions and reports.
    Cleanup,
    /// A line the person must see now (a refused second link).
    Notice(String),
}

pub struct Machine {
    origin: String,
    step: Step,
    notice: Option<String>,
    pending: Option<String>,
    saved: Option<Saved>,
    outcome: String,
}

pub const SECOND_LINK: &str = "A support session is already running. End it before you join another.";

impl Machine {
    pub fn new(origin: &str) -> Machine {
        Machine { origin: origin.to_string(), step: Step::Entry, notice: None, pending: None, saved: None, outcome: String::new() }
    }

    pub fn step(&self) -> &Step {
        &self.step
    }

    /// An error to show under the entry field.
    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    pub fn saved(&self) -> Option<&Saved> {
        self.saved.as_ref()
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    fn finish(&mut self, outcome: &str, effects: &mut Vec<Effect>) {
        self.outcome = outcome.to_string();
        self.step = Step::Ending;
        effects.push(Effect::Cleanup);
    }

    pub fn handle(&mut self, event: Event) -> Vec<Effect> {
        let mut fx = Vec::new();
        match (event, self.step.clone()) {
            // A link while a session is live is refused outright, and while one is only being looked at it is read afresh.
            (Event::Submitted(_), step) if step.live() => fx.push(Effect::Notice(SECOND_LINK.into())),
            (Event::Submitted(text), Step::Entry | Step::Looking | Step::Confirm { .. }) => {
                match parse_input(&text).and_then(|p| check_origin(&p, &self.origin).map(|_| p)) {
                    Ok(p) => {
                        self.notice = None;
                        self.pending = Some(p.code.clone());
                        self.step = Step::Looking;
                        fx.push(Effect::Preview { origin: self.origin.clone(), code: p.code });
                    }
                    Err(e) => {
                        self.notice = Some(e);
                        self.step = Step::Entry;
                        self.pending = None;
                    }
                }
            }
            (Event::PreviewOk { code, label }, Step::Looking) if self.pending.as_deref() == Some(&code) => {
                self.step = Step::Confirm { host: host_of(&self.origin), label };
            }
            (Event::PreviewFailed { code, text }, Step::Looking) if self.pending.as_deref() == Some(&code) => {
                self.notice = Some(text);
                self.pending = None;
                self.step = Step::Entry;
            }
            (Event::Confirmed, Step::Confirm { .. }) => {
                if let Some(code) = self.pending.clone() {
                    self.step = Step::Redeeming;
                    fx.push(Effect::Redeem { origin: self.origin.clone(), code });
                }
            }
            (Event::Back, Step::Confirm { .. } | Step::Looking) => {
                self.pending = None;
                self.step = Step::Entry;
            }
            (Event::RedeemOk(saved), Step::Redeeming) => {
                self.pending = None;
                self.saved = Some(saved.clone());
                self.step = Step::Asking;
                fx.push(Effect::Save(saved));
                fx.push(Effect::Ask);
            }
            (Event::RedeemFailed(text), Step::Redeeming) => {
                self.notice = Some(text);
                self.pending = None;
                self.step = Step::Entry;
            }
            (Event::Answered(false), Step::Asking) => {
                fx.push(Effect::SendDecline);
                self.finish("You did not allow support to connect. The session was ended.", &mut fx);
            }
            (Event::Answered(true), Step::Asking) => {
                if let Some(s) = self.saved.as_mut() {
                    s.allowed = true;
                    fx.push(Effect::Save(s.clone()));
                }
                self.step = Step::Permissions;
            }
            (Event::Permissions { screen, accessibility }, Step::Permissions) if screen && accessibility => {
                if let Some(s) = self.saved.clone() {
                    self.step = Step::Connecting;
                    fx.push(Effect::StartSession(s));
                }
            }
            (Event::Connected, Step::Connecting) => self.step = Step::Connected,
            (Event::SessionEnded(how), Step::Connecting | Step::Connected) => {
                let outcome = match how {
                    EndHow::Relay => "The session ended.".to_string(),
                    EndHow::Stopped => "You ended the session.".to_string(),
                    EndHow::Failed(e) => format!("The session stopped: {e}"),
                };
                self.finish(&outcome, &mut fx);
            }
            (Event::EndClicked, Step::Connecting | Step::Connected) => fx.push(Effect::StopSession),
            // Before the hello the relay has no session client to stop: say no, which ends it as declined.
            (Event::EndClicked, Step::Asking | Step::Permissions) => {
                fx.push(Effect::SendDecline);
                self.finish("You ended the session before support connected.", &mut fx);
            }
            (Event::Resumed(saved), Step::Entry) => {
                self.saved = Some(saved.clone());
                if saved.allowed {
                    self.step = Step::Permissions;
                } else {
                    self.step = Step::Asking;
                    fx.push(Effect::Ask);
                }
            }
            (Event::Tick(now), Step::Permissions | Step::Asking) => {
                if self.saved.as_ref().is_some_and(|s| now >= s.startup_deadline_ms) {
                    self.finish("The time the link allows ran out before support connected.", &mut fx);
                }
            }
            (Event::CleanupDone(mut lines), Step::Ending) => {
                let mut all = vec![std::mem::take(&mut self.outcome)];
                all.append(&mut lines);
                self.saved = None;
                self.step = Step::Done { lines: all };
            }
            _ => {}
        }
        fx
    }
}

// ---- the end: permissions and the Trash ---------------------------------------------------------------------------

/// The two permissions the app asks for, as `tccutil` names them, and as the person reads them.
pub const TCC_SERVICES: [(&str, &str); 2] = [("ScreenCapture", "Screen Recording"), ("Accessibility", "Accessibility")];

/// The `tccutil` arguments that reset one permission for the join app's own bundle id, and nothing else.
pub fn tcc_reset_args(service: &str) -> Vec<String> {
    vec!["reset".into(), service.into(), paths::JOIN_BUNDLE_ID.into()]
}

/// What the person is told about each reset: `Ok` when `tccutil` said it did, else its own reason.
pub fn tcc_report(results: &[(&str, Result<(), String>)]) -> Vec<String> {
    results
        .iter()
        .map(|(name, r)| match r {
            Ok(()) => format!("{name} permission removed."),
            Err(why) => format!(
                "{name} permission could not be removed ({}). Remove Support Join from {name} in System Settings, Privacy & Security.",
                wire::clean(why, 120)
            ),
        })
        .collect()
}

/// A path that macOS translocated: Gatekeeper runs a quarantined app from a read-only copy under AppTranslocation, so
/// the running path is not where the person's file is.
pub fn is_translocated(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == "AppTranslocation")
}

/// The `.app` folder that holds a binary (`.../Support Join.app/Contents/MacOS/support-join`).
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf)
}

/// What the Trash offer says and does, from the running bundle and, when it was translocated, the real one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrashOffer {
    /// Move this folder to the Trash.
    Move(PathBuf),
    /// The real place could not be found: tell the person where to look.
    Manual,
    /// Nothing to offer (the app is not in a bundle, as in a development run).
    None,
}

/// `running` is this app's bundle as macOS runs it, `original` where its file really is when `running` was translocated.
pub fn trash_offer(running: Option<&Path>, original: Option<&Path>) -> TrashOffer {
    let Some(running) = running else { return TrashOffer::None };
    if !is_translocated(running) {
        return TrashOffer::Move(running.to_path_buf());
    }
    match original {
        Some(o) if !is_translocated(o) && o.extension().is_some_and(|e| e == "app") && o.is_absolute() => TrashOffer::Move(o.to_path_buf()),
        _ => TrashOffer::Manual,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://support.example.com";
    const CODE: &str = "abcdefg234567abc";
    const SID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const KEY: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn me() -> u32 {
        // SAFETY: getuid has no failure mode.
        unsafe { libc::getuid() }
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("support-join-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn saved(allowed: bool, deadline: i64) -> Saved {
        Saved { sid: SID.into(), key: KEY.into(), origin: ORIGIN.into(), startup_deadline_ms: deadline, allowed }
    }

    // ---- links and codes ---------------------------------------------------------------------------------------------

    #[test]
    fn a_link_a_page_button_or_a_code_all_give_the_code() {
        let p = |t: &str| parse_input(t).unwrap();
        assert_eq!(p(CODE), Parsed { code: CODE.into(), origin: None });
        assert_eq!(p("  ABCD-EFG2 3456 7ABC \n").code, CODE);
        assert_eq!(p("abcd efg2 3456 7abc").code, CODE);
        assert_eq!(p(&format!("supportmcp://join?code={CODE}")), Parsed { code: CODE.into(), origin: None });
        assert_eq!(p(&format!("SupportMCP://join/?code={CODE}")).code, CODE);
        assert_eq!(p(&format!("https://support.example.com/j/{CODE}?client=app")), Parsed { code: CODE.into(), origin: Some(ORIGIN.into()) });
        assert_eq!(p(&format!("https://support.example.com/j/{CODE}")).origin.as_deref(), Some(ORIGIN));
        assert_eq!(p(&format!("https://support.example.com:8443/j/{CODE}/")).origin.as_deref(), Some("https://support.example.com:8443"));
        assert_eq!(p(&format!("http://127.0.0.1:8787/j/{CODE}?client=app")).origin.as_deref(), Some("http://127.0.0.1:8787"));
    }

    #[test]
    fn anything_else_is_refused_in_plain_words() {
        for bad in [
            "",
            "   ",
            "hello",
            "abcdefg23456",
            "ABCDEFG2345678ABC",
            "abcdefg234567ab1",
            "supportmcp://join",
            "supportmcp://join?code=short",
            "supportmcp://join?code=abcdefg234567abc&x=1",
            "supportmcp://other?code=abcdefg234567abc",
            "supportmcp://join/extra?code=abcdefg234567abc",
            "supportmcp://join?code=abcdefg234567abc#x",
            "https://support.example.com/j/short",
            "https://support.example.com/install?code=ABCDE-FGH23",
            "https://support.example.com/j/abcdefg234567abc?client=powershell",
            "https://support.example.com/j/abcdefg234567abc?x=1",
            "https://support.example.com/j/abcdefg234567abc#frag",
            "https://user:pw@support.example.com/j/abcdefg234567abc",
            "http://support.example.com/j/abcdefg234567abc",
            "ftp://support.example.com/j/abcdefg234567abc",
            "javascript:alert(1)",
            "https://support.example.com/j/abcdefg234567abc\u{7}",
        ] {
            let e = parse_input(bad).unwrap_err();
            assert!(e.contains("Paste") || e.contains("not a support link"), "{bad:?}: {e}");
        }
        assert!(parse_input(&"a".repeat(600)).is_err());
    }

    #[test]
    fn a_link_for_another_relay_is_refused_before_anything_is_sent() {
        let ok = parse_input(&format!("{ORIGIN}/j/{CODE}")).unwrap();
        assert!(check_origin(&ok, ORIGIN).is_ok());
        assert!(check_origin(&parse_input(CODE).unwrap(), ORIGIN).is_ok(), "a code names no relay: it goes to this build's");
        for other in [
            "https://evil.example/j/abcdefg234567abc",
            "https://support.example.com.evil.example/j/abcdefg234567abc",
            "https://support.example.com:8443/j/abcdefg234567abc",
            "http://127.0.0.1:8787/j/abcdefg234567abc",
        ] {
            let e = check_origin(&parse_input(other).unwrap(), ORIGIN).unwrap_err();
            assert!(e.contains("only joins support.example.com") && e.contains("Nothing was used"), "{other}: {e}");
        }
    }

    #[test]
    fn the_build_origin_is_checked_like_any_relay_address() {
        // Not set in a test build: the app refuses to join anything.
        if BUILD_RELAY_ORIGIN.is_none() {
            assert!(build_origin().unwrap_err().contains("built without a support server"));
        }
        assert_eq!(host_of("https://support.example.com"), "support.example.com");
        assert_eq!(host_of("http://127.0.0.1:8787"), "127.0.0.1:8787");
    }

    // ---- join.json ---------------------------------------------------------------------------------------------------

    #[test]
    fn join_json_is_0600_in_a_0700_folder_and_round_trips() {
        let base = temp("rt");
        let dir = base.join("Library/Application Support/SupportMCP");
        let now = 1_000_000;
        assert_eq!(load(&dir, ORIGIN, me(), now), Loaded::None);
        save(&dir, &saved(false, now + 60_000), me()).unwrap();
        let file = dir.join("join.json");
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(load(&dir, ORIGIN, me(), now), Loaded::Live(saved(false, now + 60_000)));
        save(&dir, &saved(true, now + 60_000), me()).unwrap();
        assert_eq!(load(&dir, ORIGIN, me(), now), Loaded::Live(saved(true, now + 60_000)));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "no temporary file stays");
        delete(&dir).unwrap();
        delete(&dir).unwrap();
        assert_eq!(load(&dir, ORIGIN, me(), now), Loaded::None);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_file_that_is_old_foreign_open_or_forged_is_removed_and_never_used() {
        let base = temp("bad");
        let dir = base.join("d");
        let now = 5_000_000;
        let file = dir.join("join.json");
        let discarded = |what: &str| {
            let r = load(&dir, ORIGIN, me(), now);
            assert!(matches!(r, Loaded::Discarded(_)), "{what}: {r:?}");
            assert!(!file.exists(), "{what}: removed");
        };
        save(&dir, &saved(true, now - 1), me()).unwrap();
        discarded("past its time");
        save(&dir, &Saved { origin: "https://evil.example".into(), ..saved(true, now + 1000) }, me()).unwrap();
        discarded("another relay");
        save(&dir, &saved(true, now + STARTUP_MAX_MS as i64 + 3_600_000), me()).unwrap();
        discarded("more than two hours");
        save(&dir, &Saved { key: "short".into(), ..saved(true, now + 1000) }, me()).unwrap();
        discarded("a bad key");
        save(&dir, &saved(true, now + 1000), me()).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        discarded("readable by others");
        fs::write(&file, b"not json").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        discarded("junk");
        // A link in its place is never followed.
        let other = base.join("other.json");
        fs::write(&other, serde_json::to_vec(&saved(true, now + 1000)).unwrap()).unwrap();
        fs::set_permissions(&other, fs::Permissions::from_mode(0o600)).unwrap();
        std::os::unix::fs::symlink(&other, &file).unwrap();
        discarded("a link");
        assert!(other.exists(), "what the link pointed at is left alone");
        // Someone else's file.
        save(&dir, &saved(true, now + 1000), me()).unwrap();
        assert!(matches!(load(&dir, ORIGIN, me() + 1, now), Loaded::Discarded(_)));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_saved_session_never_prints_its_key() {
        assert!(!format!("{:?}", saved(true, 1)).contains(KEY));
    }

    // ---- the steps ---------------------------------------------------------------------------------------------------

    fn machine() -> Machine {
        Machine::new(ORIGIN)
    }

    fn submit(m: &mut Machine, text: &str) -> Vec<Effect> {
        m.handle(Event::Submitted(text.into()))
    }

    /// Entry to Confirm to Asking.
    fn to_asking(m: &mut Machine) {
        assert_eq!(submit(m, CODE), vec![Effect::Preview { origin: ORIGIN.into(), code: CODE.into() }]);
        assert!(m.handle(Event::PreviewOk { code: CODE.into(), label: Some("Mrs Cohen".into()) }).is_empty());
        assert_eq!(m.step(), &Step::Confirm { host: "support.example.com".into(), label: Some("Mrs Cohen".into()) });
        assert_eq!(m.handle(Event::Confirmed), vec![Effect::Redeem { origin: ORIGIN.into(), code: CODE.into() }]);
        assert_eq!(m.handle(Event::RedeemOk(saved(false, 9_000_000))), vec![Effect::Save(saved(false, 9_000_000)), Effect::Ask]);
        assert_eq!(m.step(), &Step::Asking);
    }

    #[test]
    fn a_link_goes_through_the_relay_and_label_before_the_code_is_used() {
        let mut m = machine();
        assert_eq!(submit(&mut m, "nonsense").len(), 0);
        assert!(m.notice().unwrap().contains("not a support link"));
        assert_eq!(m.step(), &Step::Entry);
        assert_eq!(submit(&mut m, "https://evil.example/j/abcdefg234567abc").len(), 0);
        assert!(m.notice().unwrap().contains("only joins support.example.com"));
        assert_eq!(m.step(), &Step::Entry, "no request was made for another relay");
        assert_eq!(submit(&mut m, &format!("supportmcp://join?code={CODE}")).len(), 1);
        assert_eq!(m.step(), &Step::Looking);
        assert!(m.notice().is_none());
        // Nothing is redeemed until the person confirms.
        assert!(m.handle(Event::PreviewOk { code: CODE.into(), label: None }).is_empty());
        assert_eq!(m.step(), &Step::Confirm { host: "support.example.com".into(), label: None });
        assert!(m.handle(Event::Back).is_empty());
        assert_eq!(m.step(), &Step::Entry);
        // An answer to a link that was replaced is ignored.
        submit(&mut m, CODE);
        submit(&mut m, "supportmcp://join?code=bcdefg234567abcd");
        assert!(m.handle(Event::PreviewOk { code: CODE.into(), label: None }).is_empty());
        assert_eq!(m.step(), &Step::Looking);
        m.handle(Event::PreviewFailed { code: "bcdefg234567abcd".into(), text: "This support link has expired.".into() });
        assert_eq!((m.step(), m.notice()), (&Step::Entry, Some("This support link has expired.")));
    }

    #[test]
    fn a_failed_redeem_goes_back_to_the_entry_with_the_reason() {
        let mut m = machine();
        submit(&mut m, CODE);
        m.handle(Event::PreviewOk { code: CODE.into(), label: None });
        m.handle(Event::Confirmed);
        assert_eq!(m.step(), &Step::Redeeming);
        m.handle(Event::RedeemFailed("This support link was already used.".into()));
        assert_eq!((m.step(), m.notice()), (&Step::Entry, Some("This support link was already used.")));
        // Confirm without a preview does nothing.
        assert!(m.handle(Event::Confirmed).is_empty());
    }

    #[test]
    fn a_second_link_is_refused_from_the_redeem_to_the_end() {
        let other = "supportmcp://join?code=bcdefg234567abcd";
        for upto in 0..5 {
            let mut m = machine();
            submit(&mut m, CODE);
            m.handle(Event::PreviewOk { code: CODE.into(), label: None });
            m.handle(Event::Confirmed); // Redeeming
            if upto >= 1 {
                m.handle(Event::RedeemOk(saved(false, 9_000_000))); // Asking
            }
            if upto >= 2 {
                m.handle(Event::Answered(true)); // Permissions
            }
            if upto >= 3 {
                m.handle(Event::Permissions { screen: true, accessibility: true });
                // Connecting
            }
            if upto >= 4 {
                m.handle(Event::Connected);
            }
            let before = m.step().clone();
            assert!(before.live(), "{before:?}");
            assert_eq!(submit(&mut m, other), vec![Effect::Notice(SECOND_LINK.into())], "{before:?}");
            assert_eq!(m.step(), &before, "the session carries on");
            assert_eq!(m.saved().map(|s| s.sid.as_str()), if upto >= 1 { Some(SID) } else { None });
        }
        // And while it is ending.
        let mut m = machine();
        to_asking(&mut m);
        m.handle(Event::Answered(false));
        assert_eq!(m.step(), &Step::Ending);
        assert_eq!(submit(&mut m, other), vec![Effect::Notice(SECOND_LINK.into())]);
        // Once it is over, the app is done: no new link starts a second session in the same run.
        m.handle(Event::CleanupDone(vec![]));
        assert!(matches!(m.step(), Step::Done { .. }));
        assert!(submit(&mut m, other).is_empty());
        assert!(matches!(m.step(), Step::Done { .. }));
    }

    #[test]
    fn dont_allow_sends_decline_and_cleans_up() {
        let mut m = machine();
        to_asking(&mut m);
        assert_eq!(m.handle(Event::Answered(false)), vec![Effect::SendDecline, Effect::Cleanup]);
        assert_eq!(m.step(), &Step::Ending);
        let none = m.handle(Event::CleanupDone(vec!["Screen Recording permission removed.".into()]));
        assert!(none.is_empty());
        let Step::Done { lines } = m.step() else { panic!() };
        assert!(lines[0].contains("did not allow") && lines[1].contains("Screen Recording"));
        assert!(m.saved().is_none());
    }

    #[test]
    fn allow_waits_for_both_permissions_then_connects_and_runs_to_the_end() {
        let mut m = machine();
        to_asking(&mut m);
        assert_eq!(m.handle(Event::Answered(true)), vec![Effect::Save(saved(true, 9_000_000))]);
        assert_eq!(m.step(), &Step::Permissions);
        for (screen, accessibility) in [(false, false), (true, false), (false, true)] {
            assert!(m.handle(Event::Permissions { screen, accessibility }).is_empty());
            assert_eq!(m.step(), &Step::Permissions);
        }
        assert_eq!(m.handle(Event::Permissions { screen: true, accessibility: true }), vec![Effect::StartSession(saved(true, 9_000_000))]);
        assert_eq!(m.step(), &Step::Connecting);
        // Further permission reports change nothing.
        assert!(m.handle(Event::Permissions { screen: true, accessibility: true }).is_empty());
        m.handle(Event::Connected);
        assert_eq!(m.step(), &Step::Connected);
        assert_eq!(m.handle(Event::EndClicked), vec![Effect::StopSession]);
        assert_eq!(m.handle(Event::SessionEnded(EndHow::Stopped)), vec![Effect::Cleanup]);
        m.handle(Event::CleanupDone(vec!["a".into(), "b".into()]));
        let Step::Done { lines } = m.step() else { panic!() };
        assert_eq!(lines, &vec!["You ended the session.".to_string(), "a".into(), "b".into()]);
    }

    #[test]
    fn each_way_a_session_can_end_cleans_up() {
        for (how, text) in [
            (EndHow::Relay, "The session ended."),
            (EndHow::Failed("the relay refused a request".into()), "The session stopped: the relay refused a request"),
        ] {
            let mut m = machine();
            to_asking(&mut m);
            m.handle(Event::Answered(true));
            m.handle(Event::Permissions { screen: true, accessibility: true });
            assert_eq!(m.handle(Event::SessionEnded(how)), vec![Effect::Cleanup]);
            m.handle(Event::CleanupDone(vec![]));
            let Step::Done { lines } = m.step() else { panic!() };
            assert_eq!(lines[0], text);
        }
        // Ending before support connected says no to the relay, so the session does not hang until it expires.
        let mut m = machine();
        to_asking(&mut m);
        m.handle(Event::Answered(true));
        assert_eq!(m.handle(Event::EndClicked), vec![Effect::SendDecline, Effect::Cleanup]);
        // The link's time running out ends it too.
        let mut m = machine();
        to_asking(&mut m);
        m.handle(Event::Answered(true));
        assert!(m.handle(Event::Tick(8_999_999)).is_empty());
        assert_eq!(m.handle(Event::Tick(9_000_000)), vec![Effect::Cleanup]);
    }

    #[test]
    fn a_relaunch_carries_on_with_the_saved_session() {
        let mut m = machine();
        assert_eq!(m.handle(Event::Resumed(saved(true, 9_000_000))), vec![]);
        assert_eq!(m.step(), &Step::Permissions);
        assert_eq!(m.saved().map(|s| s.allowed), Some(true));
        assert!(submit(&mut m, CODE).iter().all(|e| matches!(e, Effect::Notice(_))), "a link during the resumed session is refused");
        // Closed before the question was answered: it asks again.
        let mut m = machine();
        assert_eq!(m.handle(Event::Resumed(saved(false, 9_000_000))), vec![Effect::Ask]);
        assert_eq!(m.step(), &Step::Asking);
        // After a restart the permissions are read at once, and the session starts without a new question.
        let mut m = machine();
        m.handle(Event::Resumed(saved(true, 9_000_000)));
        assert_eq!(m.handle(Event::Permissions { screen: true, accessibility: true }), vec![Effect::StartSession(saved(true, 9_000_000))]);
    }

    // ---- the end: permissions and the Trash --------------------------------------------------------------------------

    #[test]
    fn the_reset_names_only_the_join_apps_own_id() {
        assert_eq!(tcc_reset_args("ScreenCapture"), vec!["reset", "ScreenCapture", "io.github.sukardaddy.supportmcp.join"]);
        assert_eq!(tcc_reset_args("Accessibility")[2], paths::JOIN_BUNDLE_ID);
        assert_ne!(paths::JOIN_BUNDLE_ID, paths::BUNDLE_ID);
        assert!(!paths::JOIN_BUNDLE_ID.eq_ignore_ascii_case("All"));
        assert_eq!(TCC_SERVICES.map(|(s, _)| s), ["ScreenCapture", "Accessibility"]);
    }

    #[test]
    fn the_report_says_what_macos_allowed() {
        let lines = tcc_report(&[("Screen Recording", Ok(())), ("Accessibility", Err("tccutil: Failed to reset".into()))]);
        assert_eq!(lines[0], "Screen Recording permission removed.");
        assert!(lines[1].starts_with("Accessibility permission could not be removed (tccutil: Failed to reset)."));
        assert!(lines[1].contains("System Settings"));
    }

    #[test]
    fn the_real_path_of_a_translocated_app_is_found_or_the_person_is_told() {
        let running = Path::new("/private/var/folders/ab/xyz/X/AppTranslocation/6A1D/d/Support Join.app");
        assert!(is_translocated(running));
        assert!(!is_translocated(Path::new("/Users/a/Downloads/Support Join.app")));
        assert_eq!(
            bundle_of(Path::new("/Users/a/Downloads/Support Join.app/Contents/MacOS/support-join")),
            Some(PathBuf::from("/Users/a/Downloads/Support Join.app"))
        );
        assert_eq!(bundle_of(Path::new("/tmp/target/debug/support-join")), None);
        let home = Path::new("/Users/a/Downloads/Support Join.app");
        assert_eq!(trash_offer(Some(home), None), TrashOffer::Move(home.to_path_buf()));
        assert_eq!(trash_offer(Some(running), Some(home)), TrashOffer::Move(home.to_path_buf()));
        assert_eq!(trash_offer(Some(running), None), TrashOffer::Manual);
        // The "original" must be a real .app outside any translocation, never the translocated copy or a folder.
        assert_eq!(trash_offer(Some(running), Some(running)), TrashOffer::Manual);
        assert_eq!(trash_offer(Some(running), Some(Path::new("/Users/a/Downloads"))), TrashOffer::Manual);
        assert_eq!(trash_offer(Some(running), Some(Path::new("relative/Support Join.app"))), TrashOffer::Manual);
        assert_eq!(trash_offer(None, None), TrashOffer::None);
    }
}
