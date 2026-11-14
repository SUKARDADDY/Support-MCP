//! list_programs and close_program on a saved Mac. Installing and uninstalling arrive with PR 6; the core refuses them
//! until then.
//!
//! - `list`: the apps in /Applications (and one level of plain folders in it, such as Utilities), each as
//!   `{id: "bundle:<CFBundleIdentifier>", name, version, publisher: ""}`, and the running apps as `{name, pid, session}`.
//! - `close`: by name or pid. Each target is first asked to quit (the helper's NSRunningApplication terminate in the
//!   person's session, else SIGTERM), then, with `force`, killed. Never this app, launchd, or the parts of macOS a
//!   session cannot lose. Under limited control only the signed-in person's own programs.

use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};
use support_core::rules::{self, process_key};

pub const LIST_MAX: usize = 2000;
/// Running a polite quit gets this long; a kill, this long again.
pub const QUIT_WAIT: Duration = Duration::from_secs(5);
pub const KILL_WAIT: Duration = Duration::from_secs(3);

/// The processes no one closes from here: what a Mac's session cannot lose.
const CRITICAL: &[&str] = &[
    "launchd",
    "kernel_task",
    "loginwindow",
    "windowserver",
    "logind",
    "opendirectoryd",
    "securityd",
    "securityagent",
    "coreservicesd",
    "cfprefsd",
    "configd",
    "distnoted",
    "notifyd",
    "powerd",
    "diskarbitrationd",
    "fseventsd",
    "syslogd",
    "logd",
    "tccd",
    "trustd",
    "sandboxd",
    "coreaudiod",
    "useractivityd",
    "systemuiserver",
    "dock",
    "controlcenter",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub id: String,
    pub name: String,
    pub version: String,
}

/// One app folder's entry, or None when it has no bundle id.
pub fn read_app(app: &Path) -> Option<Installed> {
    let info = plist::Value::from_file(app.join("Contents/Info.plist")).ok()?.into_dictionary()?;
    let text = |k: &str| info.get(k).and_then(|v| v.as_string()).map(|s| support_core::wire::clean(s, 200)).filter(|s| !s.is_empty());
    let id = text("CFBundleIdentifier")?;
    let stem = app.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    Some(Installed {
        id: format!("bundle:{id}"),
        name: text("CFBundleDisplayName").or_else(|| text("CFBundleName")).unwrap_or(stem),
        version: text("CFBundleShortVersionString").or_else(|| text("CFBundleVersion")).unwrap_or_default(),
    })
}

/// The apps in `root` and in its plain subfolders, by name. Links are not followed.
pub fn installed(root: &Path) -> Vec<Installed> {
    let mut out = Vec::new();
    let is_app = |p: &Path| p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("app"));
    let real_dir = |p: &Path| std::fs::symlink_metadata(p).map(|m| m.file_type().is_dir()).unwrap_or(false);
    let Ok(entries) = std::fs::read_dir(root) else { return out };
    for e in entries.flatten() {
        let p = e.path();
        if !real_dir(&p) {
            continue;
        }
        if is_app(&p) {
            out.extend(read_app(&p));
        } else if let Ok(inner) = std::fs::read_dir(&p) {
            for i in inner.flatten() {
                let q = i.path();
                if is_app(&q) && real_dir(&q) {
                    out.extend(read_app(&q));
                }
            }
        }
        if out.len() >= LIST_MAX {
            break;
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
    out.truncate(LIST_MAX);
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: i32,
    pub uid: u32,
    /// The executable's path (ps `comm` on a Mac).
    pub path: String,
}

impl Proc {
    /// The executable's file name.
    pub fn name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }

    /// The app bundle's name without .app, for a process inside one (`Visual Studio Code` for its `Electron`).
    pub fn app_name(&self) -> Option<&str> {
        let i = self.path.find(".app/Contents/MacOS/")?;
        let head = &self.path[..i];
        Some(head.rsplit('/').next().unwrap_or(head))
    }
}

/// `ps -axo pid=,uid=,comm=`: a pid, a uid and the path, which may hold spaces.
pub fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let (pid, rest) = line.split_once(char::is_whitespace)?;
            let rest = rest.trim_start();
            let (uid, path) = rest.split_once(char::is_whitespace)?;
            Some(Proc { pid: pid.parse().ok()?, uid: uid.parse().ok()?, path: path.trim().to_string() })
        })
        .filter(|p| p.pid > 0 && !p.path.is_empty())
        .collect()
}

/// The running apps for the list: processes inside an app bundle.
pub fn running(procs: &[Proc]) -> Vec<Value> {
    procs
        .iter()
        .filter(|p| p.app_name().is_some())
        .take(LIST_MAX)
        .map(|p| json!({ "name": p.name(), "pid": p.pid, "session": Value::Null }))
        .collect()
}

pub fn list_result(installed: &[Installed], procs: &[Proc]) -> Value {
    json!({
        "installed": installed.iter().map(|i| json!({ "id": i.id, "name": i.name, "version": i.version, "publisher": "" })).collect::<Vec<_>>(),
        "running": running(procs),
    })
}

/// Why a process is never closed from here, or None.
pub fn untouchable(p: &Proc, own_pid: i32) -> Option<&'static str> {
    if p.pid <= 1 || p.pid == own_pid {
        return Some("is a part of macOS");
    }
    if rules::is_app_program(p.name()) || rules::is_app_path(&p.path) {
        return Some("is the Support app");
    }
    let key = p.name().to_lowercase();
    if CRITICAL.contains(&key.as_str()) {
        return Some("is a part of macOS");
    }
    None
}

/// Whether a process is the one a frame names: its pid, or its executable or app name compared as the relay does.
pub fn matches(p: &Proc, name: Option<&str>, pid: Option<i32>) -> bool {
    match (name, pid) {
        (_, Some(pid)) => p.pid == pid,
        (Some(n), None) => {
            let want = process_key(n);
            !want.is_empty() && (process_key(p.name()) == want || p.app_name().is_some_and(|a| process_key(a) == want))
        }
        _ => false,
    }
}

/// What the frame asks to close: its name, or its pid (a whole number above 1).
pub fn target_of(frame: &support_core::wire::Frame) -> (Option<String>, Option<i32>) {
    let name = frame.text("name");
    let pid = frame.raw.get("pid").and_then(Value::as_i64).filter(|p| *p > 1 && *p <= i32::MAX as i64).map(|p| p as i32);
    (Some(name).filter(|n| !n.trim().is_empty()), pid)
}

/// What closing needs from the system.
pub trait Closer {
    /// Asks these processes' apps to quit in the person's session. Returns the pids it asked.
    fn ask_quit(&self, pids: &[i32]) -> Vec<i32>;
    fn signal(&self, pid: i32, sig: i32);
    fn alive(&self, pid: i32) -> bool;
}

fn wait_gone(c: &dyn Closer, pids: &[i32], limit: Duration, stop: &support_core::stop::Stop) {
    let until = Instant::now() + limit;
    while Instant::now() < until && pids.iter().any(|p| c.alive(*p)) {
        if stop.wait(Duration::from_millis(100)) {
            return;
        }
    }
}

/// Closes what the frame names. `console` is the person signed in (None at the login window).
#[allow(clippy::too_many_arguments)]
pub fn close(
    frame: &support_core::wire::Frame,
    procs: &[Proc],
    console: Option<u32>,
    limited: bool,
    own_pid: i32,
    closer: &dyn Closer,
    stop: &support_core::stop::Stop,
) -> Result<Value, String> {
    let (name, pid) = target_of(frame);
    if name.is_none() && pid.is_none() {
        return Err(rules::err("not_found", "give the name or pid of a running program"));
    }
    let mut blocked = None;
    let mut eligible = Vec::new();
    for p in procs.iter().filter(|p| matches(p, name.as_deref(), pid)) {
        if let Some(why) = untouchable(p, own_pid) {
            blocked = Some(format!("{} {why}", p.name()));
            continue;
        }
        if limited && Some(p.uid) != console {
            continue;
        }
        eligible.push(p.pid);
    }
    if eligible.is_empty() {
        if let Some(b) = blocked {
            return Err(rules::err("protected_program", &format!("{b}; it is never closed from here")));
        }
        let text = if limited { "no running program of the signed-in user has that name or pid" } else { "no running program has that name or pid" };
        return Err(rules::err("not_found", text));
    }
    let asked = closer.ask_quit(&eligible);
    for p in eligible.iter().filter(|p| !asked.contains(p)) {
        closer.signal(*p, libc::SIGTERM);
    }
    wait_gone(closer, &eligible, QUIT_WAIT, stop);
    if frame.flag("force") {
        for p in eligible.iter().filter(|p| closer.alive(**p)) {
            closer.signal(*p, libc::SIGKILL);
        }
        wait_gone(closer, &eligible, KILL_WAIT, stop);
    }
    let remaining = eligible.iter().filter(|p| closer.alive(**p)).count();
    let mut out = json!({ "closed": eligible.len() - remaining });
    if remaining > 0 {
        out["still_running"] = json!(remaining);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use support_core::stop::Stop;
    use support_core::wire::Frame;

    #[test]
    fn apps_are_listed_by_bundle_id_with_name_and_version() {
        let root = std::env::temp_dir().join(format!("support-mac-apps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let app = |rel: &str, plist_body: &str| {
            let dir = root.join(rel).join("Contents");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("Info.plist"), format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict>{plist_body}</dict></plist>"))
                .unwrap();
        };
        app("TextEdit.app", "<key>CFBundleIdentifier</key><string>com.apple.TextEdit</string><key>CFBundleName</key><string>TextEdit</string><key>CFBundleShortVersionString</key><string>1.19</string>");
        app("Utilities/Terminal.app", "<key>CFBundleIdentifier</key><string>com.apple.Terminal</string><key>CFBundleDisplayName</key><string>Terminal</string><key>CFBundleVersion</key><string>455</string>");
        app("NoId.app", "<key>CFBundleName</key><string>NoId</string>");
        app("Bare.app", "<key>CFBundleIdentifier</key><string>x.bare</string>");
        std::fs::create_dir_all(root.join("Deep/Deeper/Hidden.app/Contents")).unwrap();
        std::os::unix::fs::symlink(root.join("TextEdit.app"), root.join("Linked.app")).unwrap();
        let list = installed(&root);
        assert_eq!(
            list,
            vec![
                Installed { id: "bundle:x.bare".into(), name: "Bare".into(), version: "".into() },
                Installed { id: "bundle:com.apple.Terminal".into(), name: "Terminal".into(), version: "455".into() },
                Installed { id: "bundle:com.apple.TextEdit".into(), name: "TextEdit".into(), version: "1.19".into() },
            ]
        );
        let v = list_result(&list, &[]);
        assert_eq!(v["installed"][0]["publisher"], "");
        assert_eq!(v["running"], json!([]));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ps_output_is_read_with_spaces_in_paths() {
        let ps = "    1     0 /sbin/launchd\n  412   501 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n  500   501 /usr/libexec/x\nbad line\n";
        let procs = parse_ps(ps);
        assert_eq!(procs.len(), 3);
        assert_eq!(procs[1].name(), "Electron");
        assert_eq!(procs[1].app_name(), Some("Visual Studio Code"));
        assert_eq!(running(&procs), vec![json!({"name":"Electron","pid":412,"session":null})]);
    }

    fn proc(pid: i32, uid: u32, path: &str) -> Proc {
        Proc { pid, uid, path: path.into() }
    }

    struct Fake {
        alive: Mutex<Vec<i32>>,
        /// Pids that ignore a polite quit.
        stubborn: Vec<i32>,
        gui: Vec<i32>,
        log: Mutex<Vec<String>>,
    }

    impl Closer for Fake {
        fn ask_quit(&self, pids: &[i32]) -> Vec<i32> {
            let asked: Vec<i32> = pids.iter().copied().filter(|p| self.gui.contains(p)).collect();
            for p in &asked {
                self.log.lock().unwrap().push(format!("quit {p}"));
                if !self.stubborn.contains(p) {
                    self.alive.lock().unwrap().retain(|a| a != p);
                }
            }
            asked
        }
        fn signal(&self, pid: i32, sig: i32) {
            self.log.lock().unwrap().push(format!("sig{sig} {pid}"));
            if sig == libc::SIGKILL || !self.stubborn.contains(&pid) {
                self.alive.lock().unwrap().retain(|a| *a != pid);
            }
        }
        fn alive(&self, pid: i32) -> bool {
            self.alive.lock().unwrap().contains(&pid)
        }
    }

    fn frame(v: Value) -> Frame {
        Frame::parse(&v).unwrap()
    }

    fn procs() -> Vec<Proc> {
        vec![
            proc(1, 0, "/sbin/launchd"),
            proc(90, 0, "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow"),
            proc(100, 0, "/Applications/Support.app/Contents/MacOS/support"),
            proc(200, 501, "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit"),
            proc(201, 502, "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit"),
            proc(300, 501, "/usr/local/bin/worker"),
        ]
    }

    #[test]
    fn a_program_is_asked_to_quit_and_killed_only_when_forced() {
        let stop = Stop::new();
        let f = Fake { alive: Mutex::new(vec![200, 201, 300]), stubborn: vec![200], gui: vec![200, 201], log: Mutex::default() };
        let slow = frame(json!({"type":"programs","id":"1","lane":"cmd","action":"close","name":"textedit"}));
        // Not forced: the stubborn one stays, reported as still running. The wait is cut short by a stop.
        let s2 = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            s2.set();
        });
        let r = close(&slow, &procs(), Some(501), false, 999, &f, &stop).unwrap();
        assert_eq!(r, json!({"closed":1,"still_running":1}));
        assert!(!f.log.lock().unwrap().iter().any(|l| l.starts_with("sig")), "no signal for apps the helper asked to quit");
        // Forced: killed.
        let forced = frame(json!({"type":"programs","id":"1","lane":"cmd","action":"close","pid":200,"force":true}));
        let stop = Stop::new();
        let r = close(&forced, &procs(), Some(501), false, 999, &f, &stop).unwrap();
        assert_eq!(r, json!({"closed":1}));
        assert!(f.log.lock().unwrap().contains(&format!("sig{} 200", libc::SIGKILL)));
    }

    #[test]
    fn limited_control_closes_only_the_signed_in_persons_programs() {
        let stop = Stop::new();
        let f = Fake { alive: Mutex::new(vec![200, 201]), stubborn: vec![], gui: vec![], log: Mutex::default() };
        let fr = frame(json!({"type":"programs","id":"1","lane":"cmd","action":"close","name":"TextEdit"}));
        assert_eq!(close(&fr, &procs(), Some(501), true, 999, &f, &stop).unwrap(), json!({"closed":1}));
        assert!(f.alive(201), "the other user's TextEdit is untouched");
        assert!(f.log.lock().unwrap().contains(&format!("sig{} 200", libc::SIGTERM)), "not a GUI app of the session: SIGTERM");
        let other = frame(json!({"type":"programs","id":"1","lane":"cmd","action":"close","pid":201}));
        assert!(close(&other, &procs(), Some(501), true, 999, &f, &stop)
            .unwrap_err()
            .starts_with("not_found: no running program of the signed-in user"));
    }

    #[test]
    fn the_app_itself_and_macos_are_never_closed() {
        let stop = Stop::new();
        let f = Fake { alive: Mutex::new(vec![1, 90, 100]), stubborn: vec![], gui: vec![], log: Mutex::default() };
        for (target, text) in [
            (json!({"name":"support"}), "protected_program: support is the Support app"),
            (json!({"pid":100}), "protected_program: support is the Support app"),
            (json!({"name":"loginwindow"}), "protected_program: loginwindow is a part of macOS"),
        ] {
            let mut v = json!({"type":"programs","id":"1","lane":"cmd","action":"close"});
            v.as_object_mut().unwrap().extend(target.as_object().unwrap().clone());
            let e = close(&frame(v), &procs(), Some(501), false, 999, &f, &stop).unwrap_err();
            assert!(e.starts_with(text), "{e}");
        }
        // pid 1 is never a target, even by pid.
        let e = close(&frame(json!({"type":"programs","id":"1","lane":"cmd","action":"close","pid":1})), &procs(), Some(501), false, 999, &f, &stop);
        assert!(e.unwrap_err().starts_with("not_found"));
        assert!(f.log.lock().unwrap().is_empty());
        let mine = proc(4242, 0, "/usr/bin/whatever");
        assert!(untouchable(&mine, 4242).is_some(), "the service's own pid");
    }

    #[test]
    fn a_name_matches_the_executable_or_the_app() {
        let code = proc(5, 501, "/Applications/Visual Studio Code.app/Contents/MacOS/Electron");
        assert!(matches(&code, Some("electron"), None));
        assert!(matches(&code, Some("Visual Studio Code"), None));
        assert!(matches(&code, Some("/Applications/Visual Studio Code.app/Contents/MacOS/Electron"), None));
        assert!(!matches(&code, Some("Code"), None));
        assert!(!matches(&code, Some(" "), None));
        assert!(matches(&code, None, Some(5)));
    }
}
