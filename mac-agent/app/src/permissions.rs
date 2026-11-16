//! The permissions Support asks the person for, apart from macOS: which there are, which are required, where each one's
//! page in System Settings is (with fallbacks), the state each is in, and when to offer a restart. The window that shows
//! them (`mac/perms.rs`) is shared by the saved app's helper and the one-off join app, so both say the same things.
//!
//! - Screen Recording and Accessibility are required. Full Disk Access is optional and only the saved app asks for it.
//! - The person flips each switch in System Settings. Support can only register itself first, so it is already in the
//!   list (`CGRequestScreenCaptureAccess`, `AXIsProcessTrustedWithOptions`). Full Disk Access has no such call.
//! - Screen Recording, on some macOS versions, stays "not allowed" in the running process until it starts again. After the
//!   person has had time to flip the switch, the window offers Restart Support.
//! - Full Disk Access is what the root service and its file helpers can do, not what the window's process can do. The
//!   service reads it with `fda_probe_main` in a fresh child (`support fda-probe`) and puts it in its status.

use crate::paths;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Perm {
    ScreenRecording,
    Accessibility,
    FullDiskAccess,
}

/// Which app asks. The join app never asks for Full Disk Access: it has no root service and no full control.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Saved,
    Join,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Item {
    pub perm: Perm,
    pub name: &'static str,
    pub required: bool,
    /// One plain line on what the permission is for.
    pub what: &'static str,
    /// Extra help, under the line.
    pub help: Option<&'static str>,
}

pub const FDA_HELP: &str = "macOS cannot add Support to this list for you. If Support is not listed, click + and choose it, or drag it in from the Finder window that \"Show Support in Finder\" opens.";

const SCREEN: Item =
    Item { perm: Perm::ScreenRecording, name: "Screen Recording", required: true, what: "Lets your support team see this Mac's screen.", help: None };
const ACCESSIBILITY: Item =
    Item { perm: Perm::Accessibility, name: "Accessibility", required: true, what: "Lets your support team move the mouse and type.", help: None };
const FULL_DISK: Item = Item {
    perm: Perm::FullDiskAccess,
    name: "Full Disk Access",
    required: false,
    what: "Lets full-control file tools write into Desktop, Documents and Downloads.",
    help: Some(FDA_HELP),
};

/// The items the app lists, in order.
pub fn items(kind: Kind) -> Vec<Item> {
    match kind {
        Kind::Saved => vec![SCREEN, ACCESSIBILITY, FULL_DISK],
        Kind::Join => vec![SCREEN, ACCESSIBILITY],
    }
}

pub fn item(perm: Perm) -> Item {
    match perm {
        Perm::ScreenRecording => SCREEN,
        Perm::Accessibility => ACCESSIBILITY,
        Perm::FullDiskAccess => FULL_DISK,
    }
}

// ---- the pages in System Settings -------------------------------------------------------------------------------

/// The pages to try for a permission, in order. The links of System Settings changed in macOS 13 and are not promised
/// to stay, so a list is tried until one opens:
///
/// 1. the documented form, `com.apple.preference.security?Privacy_*`, which every version since 10.14 answers and which
///    macOS 13 and later redirect to the new Settings app;
/// 2. the pane id of the new Settings app, `com.apple.settings.PrivacySecurity.extension?Privacy_*`, in case a later
///    version stops redirecting;
/// 3. Privacy & Security itself, so the person is at least one click from the list.
pub fn pane_urls(perm: Perm) -> [&'static str; 3] {
    match perm {
        Perm::ScreenRecording => [
            paths::SETTINGS_SCREEN,
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
            paths::SETTINGS_PRIVACY,
        ],
        Perm::Accessibility => [
            paths::SETTINGS_ACCESSIBILITY,
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
            paths::SETTINGS_PRIVACY,
        ],
        Perm::FullDiskAccess => [
            paths::SETTINGS_FULL_DISK,
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
            paths::SETTINGS_PRIVACY,
        ],
    }
}

/// Opens the first page that `open` accepts (it returns false when macOS has no app for the link). The page it opened,
/// or None when none did.
pub fn open_pane(perm: Perm, mut open: impl FnMut(&str) -> bool) -> Option<&'static str> {
    pane_urls(perm).into_iter().find(|url| open(url))
}

// ---- the state of each permission -------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Not read yet, or not readable (the service is not running, so Full Disk Access is not known).
    Unknown,
    Missing,
    Granted,
}

impl State {
    pub fn from_bool(granted: bool) -> State {
        if granted {
            State::Granted
        } else {
            State::Missing
        }
    }

    /// The words next to an item.
    pub fn text(self) -> &'static str {
        match self {
            State::Unknown => "Checking…",
            State::Missing => "Not yet",
            State::Granted => "Allowed",
        }
    }
}

/// How long after the person opened Screen Recording's page, with the switch still showing "Not yet", Restart Support
/// is offered. The running process often cannot see the switch until it starts again, and this is long enough to flip it.
pub const RESTART_AFTER_MS: u64 = 15_000;

/// The states the window shows, and when to offer a restart. Times are milliseconds from any steady clock.
#[derive(Debug, Clone)]
pub struct Tracker {
    kind: Kind,
    states: [State; 3],
    opened: [Option<u64>; 3],
    force_restart: bool,
}

fn slot(p: Perm) -> usize {
    match p {
        Perm::ScreenRecording => 0,
        Perm::Accessibility => 1,
        Perm::FullDiskAccess => 2,
    }
}

impl Tracker {
    pub fn new(kind: Kind) -> Tracker {
        Tracker { kind, states: [State::Unknown; 3], opened: [None; 3], force_restart: false }
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    pub fn observe(&mut self, perm: Perm, state: State) {
        self.states[slot(perm)] = state;
    }

    pub fn state(&self, perm: Perm) -> State {
        self.states[slot(perm)]
    }

    /// The person was sent to the permission's page.
    pub fn opened(&mut self, perm: Perm, now_ms: u64) {
        self.opened[slot(perm)] = Some(now_ms);
    }

    /// A preview shows Restart without waiting for anything.
    pub fn force_restart(&mut self, on: bool) {
        self.force_restart = on;
    }

    /// Whether a required permission is not allowed (an unread one counts as not allowed).
    pub fn required_missing(&self) -> bool {
        items(self.kind).iter().filter(|i| i.required).any(|i| self.state(i.perm) != State::Granted)
    }

    pub fn needs_restart(&self, now_ms: u64) -> bool {
        if self.force_restart {
            return true;
        }
        let screen = slot(Perm::ScreenRecording);
        self.states[screen] != State::Granted && self.opened[screen].is_some_and(|at| now_ms.saturating_sub(at) >= RESTART_AFTER_MS)
    }

    /// The line at the top of the window.
    pub fn headline(&self) -> String {
        let missing: Vec<&str> = items(self.kind).iter().filter(|i| i.required && self.state(i.perm) != State::Granted).map(|i| i.name).collect();
        if !missing.is_empty() {
            return format!(
                "Support needs {} before your support team can use this Mac. macOS lets only you turn these on: open each one and switch Support on.",
                missing.join(" and ")
            );
        }
        let optional_open = items(self.kind).iter().any(|i| !i.required && self.state(i.perm) != State::Granted);
        if optional_open {
            "Support has what it needs. Full Disk Access is optional: you can skip it.".to_string()
        } else {
            "Support has everything it needs.".to_string()
        }
    }
}

// ---- Full Disk Access -------------------------------------------------------------------------------------------

/// What reading one protected file showed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    Open,
    /// macOS refused (EPERM or EACCES): Full Disk Access is not given.
    Blocked,
    /// No such file here, or an error that says nothing about Full Disk Access.
    Unclear,
}

/// Files only a process with Full Disk Access can open, even as root, in the order they are tried. TCC's own database
/// is on every Mac since 10.14. The Time Machine preferences are the second try, for a Mac where it is missing.
pub const FDA_PROBES: [&str; 2] = ["/Library/Application Support/com.apple.TCC/TCC.db", "/Library/Preferences/com.apple.TimeMachine.plist"];

pub fn probe_outcome(result: &std::io::Result<std::fs::File>) -> Probe {
    match result {
        Ok(_) => Probe::Open,
        Err(e) if e.kind() == ErrorKind::PermissionDenied => Probe::Blocked,
        Err(_) => Probe::Unclear,
    }
}

/// Whether Full Disk Access is given, from the probes in order: the first file that opens says yes, the first that is
/// refused says no, and when none says anything the answer is None.
pub fn fda_from(probes: &[Probe]) -> Option<bool> {
    probes.iter().find_map(|p| match p {
        Probe::Open => Some(true),
        Probe::Blocked => Some(false),
        Probe::Unclear => None,
    })
}

/// Opens (and never reads) each probe file. Run by the service's child, `support fda-probe`, so a grant is seen without
/// a restart of the service.
pub fn fda_check(paths: &[&str]) -> Option<bool> {
    let probes: Vec<Probe> = paths.iter().map(|p| probe_outcome(&std::fs::File::open(Path::new(p)))).collect();
    fda_from(&probes)
}

/// `support fda-probe`: exit 0 when Full Disk Access is given, 1 when it is not, 3 when the probe could not tell.
pub fn fda_probe_main() -> i32 {
    match fda_check(&FDA_PROBES) {
        Some(true) => 0,
        Some(false) => 1,
        None => 3,
    }
}

/// What the probe child's exit code means.
pub fn fda_from_exit(code: Option<i32>) -> Option<bool> {
    match code {
        Some(0) => Some(true),
        Some(1) => Some(false),
        _ => None,
    }
}

// ---- Restart Support ---------------------------------------------------------------------------------------------

/// The app bundle that holds the running executable: `X.app` for `X.app/Contents/MacOS/x`.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let app = exe.ancestors().nth(3)?;
    (app.extension().is_some_and(|e| e == "app") && exe.ancestors().nth(1)?.ends_with("Contents/MacOS")).then(|| app.to_path_buf())
}

/// The command that starts the app again, for the person `uid`. The saved app's helper is a LaunchAgent, so launchd kills
/// it and starts it again. The join app is opened by the user, so a shell waits a second for it to quit and opens it again
/// (it carries on from its join file). None when the join app's bundle is not found.
pub fn restart_command(kind: Kind, uid: u32, exe: &Path) -> Option<(String, Vec<String>)> {
    match kind {
        Kind::Saved => Some((paths::LAUNCHCTL.to_string(), vec!["kickstart".into(), "-k".into(), format!("gui/{uid}/{}", paths::AGENT_LABEL)])),
        Kind::Join => {
            let bundle = bundle_of(exe)?;
            Some(("/bin/sh".to_string(), vec!["-c".into(), "sleep 1; exec /usr/bin/open -n \"$0\"".into(), bundle.to_string_lossy().into_owned()]))
        }
    }
}

// ---- the preview (screenshots) -----------------------------------------------------------------------------------

/// The environment variable a build with the `preview-permissions` feature reads.
pub const PREVIEW_VAR: &str = "SUPPORT_PREVIEW_PERMISSIONS";

/// States forced for a screenshot: `screen=granted,accessibility=missing,full_disk=unknown,restart`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Preview {
    pub screen: Option<State>,
    pub accessibility: Option<State>,
    pub full_disk: Option<State>,
    pub restart: bool,
}

impl Preview {
    pub fn parse(text: &str) -> Result<Preview, String> {
        let mut p = Preview::default();
        for part in text.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if part == "restart" {
                p.restart = true;
                continue;
            }
            let (key, value) = part.split_once('=').ok_or_else(|| format!("{part:?} is not name=state or restart"))?;
            let state = match value.trim() {
                "granted" => State::Granted,
                "missing" => State::Missing,
                "unknown" => State::Unknown,
                other => return Err(format!("{other:?} is not granted, missing or unknown")),
            };
            match key.trim() {
                "screen" => p.screen = Some(state),
                "accessibility" => p.accessibility = Some(state),
                "full_disk" => p.full_disk = Some(state),
                "all" => (p.screen, p.accessibility, p.full_disk) = (Some(state), Some(state), Some(state)),
                other => return Err(format!("{other:?} is not screen, accessibility, full_disk or all")),
            }
        }
        Ok(p)
    }

    pub fn state(&self, perm: Perm) -> Option<State> {
        match perm {
            Perm::ScreenRecording => self.screen,
            Perm::Accessibility => self.accessibility,
            Perm::FullDiskAccess => self.full_disk,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_saved_app_lists_three_and_the_join_app_two() {
        let saved = items(Kind::Saved);
        assert_eq!(
            saved.iter().map(|i| (i.perm, i.required)).collect::<Vec<_>>(),
            [(Perm::ScreenRecording, true), (Perm::Accessibility, true), (Perm::FullDiskAccess, false)]
        );
        assert_eq!(items(Kind::Join).len(), 2);
        assert!(items(Kind::Join).iter().all(|i| i.required));
        assert_eq!(item(Perm::FullDiskAccess).what, "Lets full-control file tools write into Desktop, Documents and Downloads.");
    }

    #[test]
    fn each_permission_has_the_three_pages_in_order() {
        for (perm, key) in [(Perm::ScreenRecording, "ScreenCapture"), (Perm::Accessibility, "Accessibility"), (Perm::FullDiskAccess, "AllFiles")] {
            let urls = pane_urls(perm);
            assert_eq!(urls[0], format!("x-apple.systempreferences:com.apple.preference.security?Privacy_{key}"));
            assert_eq!(urls[1], format!("x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_{key}"));
            assert_eq!(urls[2], "x-apple.systempreferences:com.apple.preference.security");
        }
    }

    #[test]
    fn a_page_that_does_not_open_means_try_the_next() {
        let mut tried = Vec::new();
        let opened = open_pane(Perm::Accessibility, |u| {
            tried.push(u.to_string());
            tried.len() == 2
        });
        assert_eq!(opened, Some(pane_urls(Perm::Accessibility)[1]));
        assert_eq!(tried.len(), 2);
        assert_eq!(open_pane(Perm::Accessibility, |_| false), None);
        let mut n = 0;
        assert_eq!(
            open_pane(Perm::ScreenRecording, |_| {
                n += 1;
                true
            }),
            Some(pane_urls(Perm::ScreenRecording)[0])
        );
        assert_eq!(n, 1);
    }

    #[test]
    fn required_permissions_gate_the_headline_and_optional_ones_do_not() {
        let mut t = Tracker::new(Kind::Saved);
        assert!(t.required_missing());
        assert!(t.headline().starts_with("Support needs Screen Recording and Accessibility"));
        t.observe(Perm::ScreenRecording, State::Granted);
        assert!(t.headline().starts_with("Support needs Accessibility before"));
        t.observe(Perm::Accessibility, State::Granted);
        assert!(!t.required_missing(), "Full Disk Access is optional");
        assert!(t.headline().contains("optional"));
        t.observe(Perm::FullDiskAccess, State::Granted);
        assert_eq!(t.headline(), "Support has everything it needs.");
        // The join app has no Full Disk Access to wait for.
        let mut j = Tracker::new(Kind::Join);
        j.observe(Perm::ScreenRecording, State::Granted);
        j.observe(Perm::Accessibility, State::Granted);
        assert_eq!(j.headline(), "Support has everything it needs.");
    }

    #[test]
    fn restart_is_offered_only_after_screen_recording_was_opened_and_stays_off() {
        let mut t = Tracker::new(Kind::Saved);
        assert!(!t.needs_restart(1_000_000), "never opened");
        t.opened(Perm::ScreenRecording, 1_000);
        assert!(!t.needs_restart(1_000 + RESTART_AFTER_MS - 1));
        assert!(t.needs_restart(1_000 + RESTART_AFTER_MS));
        t.observe(Perm::ScreenRecording, State::Granted);
        assert!(!t.needs_restart(1_000 + RESTART_AFTER_MS * 10), "it took effect");
        // Accessibility takes effect at once: opening its page never offers a restart.
        let mut a = Tracker::new(Kind::Join);
        a.opened(Perm::Accessibility, 0);
        assert!(!a.needs_restart(10 * RESTART_AFTER_MS));
        a.force_restart(true);
        assert!(a.needs_restart(0));
    }

    #[test]
    fn full_disk_access_reads_the_first_file_that_says_something() {
        assert_eq!(fda_from(&[Probe::Open, Probe::Blocked]), Some(true));
        assert_eq!(fda_from(&[Probe::Blocked, Probe::Open]), Some(false));
        assert_eq!(fda_from(&[Probe::Unclear, Probe::Blocked]), Some(false));
        assert_eq!(fda_from(&[Probe::Unclear, Probe::Unclear]), None);
        assert_eq!(fda_from(&[]), None);
        assert_eq!(fda_from_exit(Some(0)), Some(true));
        assert_eq!(fda_from_exit(Some(1)), Some(false));
        assert_eq!(fda_from_exit(Some(3)), None);
        assert_eq!(fda_from_exit(None), None);
    }

    #[test]
    fn a_refused_open_is_blocked_and_a_missing_file_is_unclear() {
        use std::io::Error;
        assert_eq!(probe_outcome(&Err(Error::from_raw_os_error(1))), Probe::Blocked, "EPERM");
        assert_eq!(probe_outcome(&Err(Error::from_raw_os_error(13))), Probe::Blocked, "EACCES");
        assert_eq!(probe_outcome(&Err(Error::from_raw_os_error(2))), Probe::Unclear, "ENOENT");
        let dir = std::env::temp_dir().join(format!("support-fda-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let there = dir.join("there");
        std::fs::write(&there, b"x").unwrap();
        let gone = dir.join("gone");
        assert_eq!(fda_check(&[there.to_str().unwrap()]), Some(true));
        assert_eq!(fda_check(&[gone.to_str().unwrap(), there.to_str().unwrap()]), Some(true), "a missing file is skipped");
        assert_eq!(fda_check(&[gone.to_str().unwrap()]), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_bundle_is_found_from_the_executable() {
        let exe = Path::new("/Users/a/Downloads/Support Join.app/Contents/MacOS/support-join");
        assert_eq!(bundle_of(exe), Some(PathBuf::from("/Users/a/Downloads/Support Join.app")));
        assert_eq!(bundle_of(Path::new("/tmp/target/debug/support-join")), None);
        assert_eq!(bundle_of(Path::new("/x/Other/Contents/MacOS/support")), None);
    }

    #[test]
    fn restart_kicks_the_agent_or_reopens_the_join_app() {
        let saved = restart_command(Kind::Saved, 501, Path::new(paths::BINARY_PATH)).unwrap();
        assert_eq!(saved.0, "/bin/launchctl");
        assert_eq!(saved.1, ["kickstart", "-k", "gui/501/io.github.sukardaddy.supportmcp.helper"]);
        let join = restart_command(Kind::Join, 501, Path::new("/Users/a/Support Join.app/Contents/MacOS/support-join")).unwrap();
        assert_eq!(join.0, "/bin/sh");
        assert_eq!(join.1[2], "/Users/a/Support Join.app", "the path is an argument, never part of the script");
        assert!(restart_command(Kind::Join, 501, Path::new("/tmp/support-join")).is_none());
    }

    #[test]
    fn a_preview_forces_states_and_refuses_what_it_does_not_know() {
        let p = Preview::parse("screen=granted, accessibility=missing,full_disk=unknown,restart").unwrap();
        assert_eq!(p.state(Perm::ScreenRecording), Some(State::Granted));
        assert_eq!(p.state(Perm::Accessibility), Some(State::Missing));
        assert_eq!(p.state(Perm::FullDiskAccess), Some(State::Unknown));
        assert!(p.restart);
        assert_eq!(Preview::parse("").unwrap(), Preview::default());
        let all = Preview::parse("all=granted").unwrap();
        assert!(items(Kind::Saved).iter().all(|i| all.state(i.perm) == Some(State::Granted)));
        for bad in ["screen", "screen=yes", "camera=granted", "restart=1"] {
            assert!(Preview::parse(bad).is_err(), "{bad}");
        }
    }
}
