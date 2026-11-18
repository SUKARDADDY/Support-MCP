//! uninstall_program on a saved Mac, as root under full control: `bundle:<id>` names an app in /Applications (or a plain
//! folder in it). Never Support, the join app, one of Apple's apps or a protected program. The app is asked to quit and
//! ended after 10 seconds, then moved, in one step and without following a link, into a folder only root can open,
//! `<data>/removed/<bundle id>-<Unix seconds>/`, where it stays 7 days before the service deletes it (`sweep`). Then
//! `pkgutil --forget` runs for each receipt that lists at least one file and all of whose files sit inside that app.
//! The app's support files in each person's ~/Library stay.

use crate::install::{remove_tree, Env, Receipt};
use crate::paths;
use crate::programs::{self, AppInfo, Closer, Proc};
use crate::safe_files;
use serde_json::{json, Value};
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use support_core::platform::UninstallRequest;
use support_core::rules;

/// A polite quit gets this long before the app is ended.
pub const QUIT_WAIT: Duration = Duration::from_secs(10);
pub const KILL_WAIT: Duration = Duration::from_secs(3);
/// A staging folder left by an install that never finished is removed after this long.
pub const STAGING_KEEP_S: i64 = 86_400;

/// Whether a receipt's files are all inside the app: at least one file, and each, from the receipt's volume and install
/// location, inside the app's folder by whole path parts (so `Foo.app Helper` is not inside `Foo.app`).
pub fn receipt_inside(app: &str, r: &Receipt) -> bool {
    let app = rules::posix_parts(app);
    !app.is_empty()
        && !r.files.is_empty()
        && r.files.iter().all(|f| {
            let p = rules::posix_parts(&format!("/{}/{}/{f}", r.volume, r.location));
            p.len() >= app.len() && app.iter().zip(&p).all(|(a, b)| a == b)
        })
}

/// A bundle id as a folder name: only letters, digits, dot, dash and underscore, at most 150 characters.
fn safe_id(id: &str) -> String {
    let s: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).take(150).collect();
    if s.is_empty() || s.starts_with('.') {
        format!("app{s}")
    } else {
        s
    }
}

/// Why an app may not be uninstalled, or None: Support or the join app, Apple's, or a protected program by any of its
/// names or its bundle id.
pub fn uninstall_problem(path: &Path, info: &AppInfo, protected: &[String]) -> Option<String> {
    let id = info.id.to_ascii_lowercase();
    if rules::is_app_program_id(&format!("bundle:{id}")) || rules::is_app_path(&path.to_string_lossy()) {
        return Some(rules::err("protected_program", rules::APP_NEVER_UNINSTALLED));
    }
    if id.starts_with("com.apple.") {
        return Some(rules::err("protected_program", rules::APPLE_NEVER_UNINSTALLED));
    }
    if crate::install::is_protected(&info.id, &info.names, protected) {
        return Some(rules::refuse("protected_program").error().unwrap_or_default());
    }
    None
}

/// The processes running from inside the app.
pub fn inside(procs: &[Proc], app: &str) -> Vec<i32> {
    procs.iter().filter(|p| p.pid > 1 && rules::path_inside(app, &p.path)).map(|p| p.pid).collect()
}

/// Asks the app's processes to quit, then ends what is left after `QUIT_WAIT`. Returns how many still run.
pub fn quit(pids: &[i32], closer: &dyn Closer, stop: &support_core::stop::Stop) -> usize {
    if pids.is_empty() {
        return 0;
    }
    let asked = closer.ask_quit(pids);
    for p in pids.iter().filter(|p| !asked.contains(p)) {
        closer.signal(*p, libc::SIGTERM);
    }
    let wait = |limit: Duration| {
        let until = Instant::now() + limit;
        while Instant::now() < until && pids.iter().any(|p| closer.alive(*p)) {
            if stop.wait(Duration::from_millis(100)) {
                return;
            }
        }
    };
    wait(QUIT_WAIT);
    for p in pids.iter().filter(|p| closer.alive(**p)) {
        closer.signal(*p, libc::SIGKILL);
    }
    wait(KILL_WAIT);
    pids.iter().filter(|p| closer.alive(**p)).count()
}

/// Moves `app` into `into` (a folder only root can open), from its folder opened without following a link, and only if
/// it is still the folder that was checked (`dev`, `ino`).
fn move_app(app: &Path, into: &Path, dev: u64, ino: u64) -> Result<PathBuf, String> {
    let parent = app.parent().and_then(|p| p.to_str()).ok_or("the app has no folder")?;
    let name = app.file_name().ok_or("the app has no name")?;
    let from = safe_files::open_dir(parent)?;
    let to = safe_files::open_dir(into.to_str().ok_or("the holding folder is not UTF-8")?)?;
    let c = CString::new(name.as_bytes()).map_err(|_| "the app's name holds a NUL")?;
    // SAFETY: a zeroed stat is a valid out-parameter; the folder is open and the name a valid C string.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(from.as_raw_fd(), c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(format!("{}: {}", app.display(), io::Error::last_os_error()));
    }
    if st.st_mode & libc::S_IFMT != libc::S_IFDIR || st.st_dev as u64 != dev || st.st_ino as u64 != ino {
        return Err(format!("{} changed while it was being removed; nothing was moved. Try again", app.display()));
    }
    // SAFETY: two open folders and a valid name. renameat never follows a link in the last name.
    if unsafe { libc::renameat(from.as_raw_fd(), c.as_ptr(), to.as_raw_fd(), c.as_ptr()) } != 0 {
        let e = io::Error::last_os_error();
        return Err(match e.raw_os_error() {
            Some(libc::EXDEV) => format!("{} is on another disk than Support's data folder, so it cannot be moved in one step", app.display()),
            Some(libc::EPERM) => format!(
                "macOS did not let Support move {} ({e}); allow Support under App Management in System Settings, Privacy & Security",
                app.display()
            ),
            _ => format!("could not move {}: {e}", app.display()),
        });
    }
    Ok(into.join(name))
}

/// Runs an uninstall. `procs` and `closer` are the running processes and how to end them. Returns the result fields.
pub fn uninstall(req: &UninstallRequest, env: &Env, procs: &dyn Fn() -> Vec<Proc>, closer: &dyn Closer, now_s: i64) -> Result<Value, String> {
    let id = req.bundle_id.trim();
    if rules::is_app_program_id(&format!("bundle:{id}")) {
        return Err(rules::err("protected_program", rules::APP_NEVER_UNINSTALLED));
    }
    if rules::is_apple_program_id(&format!("bundle:{id}")) {
        return Err(rules::err("protected_program", rules::APPLE_NEVER_UNINSTALLED));
    }
    let found = programs::find_by_id(env.apps_dir, id);
    let (app, info) = match found.as_slice() {
        [] => {
            return Err(rules::err(
                "not_found",
                &format!("no app in {} has the bundle id {id}; take the id from list_programs", env.apps_dir.display()),
            ))
        }
        [one] => one.clone(),
        many => {
            let list: Vec<String> = many.iter().map(|(p, _)| p.display().to_string()).collect();
            return Err(format!("{} apps have the bundle id {id} ({}); remove all but one with run first", many.len(), list.join(", ")));
        }
    };
    if let Some(problem) = uninstall_problem(&app, &info, &req.protected_programs) {
        return Err(problem);
    }
    let meta = fs::symlink_metadata(&app).map_err(|e| format!("{}: {e}", app.display()))?;
    let app_text = app.to_str().ok_or("the app's path is not UTF-8")?.to_string();
    let name = app.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // The receipts are read while the app is still where they say. Only those wholly inside it are forgotten.
    let owning = env.tools.receipts_owning(&[app_text.clone(), format!("{app_text}/Contents/Info.plist")]);
    let forget: Vec<String> = owning.into_iter().filter(|r| env.tools.receipt(r).is_some_and(|rc| receipt_inside(&app_text, &rc))).collect();
    let still = quit(&inside(&procs(), &app_text), closer, env.stop);
    // The holding folder: root's, then one new folder for this app.
    crate::state::ensure_dir(env.data_dir, me())?;
    let held = env.data_dir.join(paths::REMOVED_DIR);
    crate::state::ensure_dir(&held, me())?;
    let base = format!("{}-{now_s}", safe_id(&info.id));
    let mut slot = held.join(&base);
    for n in 2..100 {
        match fs::DirBuilder::new().mode(0o700).create(&slot) {
            Ok(()) => break,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => slot = held.join(format!("{base}-{n}")),
            Err(e) => return Err(format!("{}: {e}", slot.display())),
        }
    }
    let moved = move_app(&app, &slot, meta.dev(), meta.ino()).inspect_err(|_| {
        let _ = fs::remove_dir(&slot);
    })?;
    let mut forgot = Vec::new();
    let mut not_forgot = Vec::new();
    for r in &forget {
        match env.tools.forget(r) {
            Ok(()) => forgot.push(r.clone()),
            Err(_) => not_forgot.push(r.clone()),
        }
    }
    let mut detail = format!(
        "removed {name}{}: moved it from {} to {}, where it is kept for 7 days and then deleted. Support files in each person's ~/Library stay",
        if info.version.is_empty() { String::new() } else { format!(" {}", info.version) },
        app.parent().map(|p| p.display().to_string()).unwrap_or_default(),
        moved.display()
    );
    if !forgot.is_empty() {
        detail.push_str(&format!(". Forgot the package receipts {}", forgot.join(", ")));
    }
    if !not_forgot.is_empty() {
        detail.push_str(&format!(". Could not forget {}", not_forgot.join(", ")));
    }
    if still > 0 {
        detail.push_str(&format!(". {still} of its processes did not end"));
    }
    Ok(json!({ "exit_code": 0, "detail": detail }))
}

fn me() -> u32 {
    // SAFETY: a getter.
    unsafe { libc::geteuid() }
}

/// The Unix seconds a holding folder's name ends with (`<id>-<seconds>` or `<id>-<seconds>-<n>`).
fn held_since(name: &str) -> Option<i64> {
    let mut parts = name.rsplit('-');
    let last = parts.next()?;
    let secs = if last.len() <= 2 { parts.next()? } else { last };
    (secs.len() >= 9 && secs.bytes().all(|b| b.is_ascii_digit())).then(|| secs.parse().ok()).flatten()
}

/// Whether a staging folder (`install-<pid>-…` or `update-<pid>-…`) belongs to a process that is gone. An update restarts
/// the service before its stage is dropped, so the new service clears the old one's at its start. A pid that was reused
/// keeps its folder until the day is up.
fn stage_owner_gone(name: &str) -> bool {
    let mut parts = name.splitn(3, '-');
    let (Some(kind), Some(pid)) = (parts.next(), parts.next()) else { return false };
    if !matches!(kind, "install" | "update") {
        return false;
    }
    let Ok(pid) = pid.parse::<libc::pid_t>() else { return false };
    if pid <= 1 || pid as u32 == std::process::id() {
        return false;
    }
    // SAFETY: signal 0 only asks whether the process exists.
    let r = unsafe { libc::kill(pid, 0) };
    r == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// Deletes what uninstall_program has held for more than 7 days, staging folders whose process is gone, and staging
/// folders left behind for more than a day. A name that tells no time goes by its last change. Never follows a link. Returns what it deleted.
pub fn sweep(data_dir: &Path, now_s: i64) -> Vec<String> {
    let mut gone = Vec::new();
    let mtime = |p: &Path| fs::symlink_metadata(p).ok().map(|m| m.mtime());
    for (sub, keep, by_name) in [(paths::REMOVED_DIR, paths::REMOVED_KEEP_S, true), (paths::STAGING_DIR, STAGING_KEEP_S, false)] {
        let dir = data_dir.join(sub);
        // Only a real folder of root's: never one someone else made or linked.
        match fs::symlink_metadata(&dir) {
            Ok(m) if m.file_type().is_dir() && m.uid() == me() => {}
            _ => continue,
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let since = if by_name { held_since(&name).or_else(|| mtime(&p)) } else { mtime(&p) };
            if since.is_some_and(|t| now_s - t > keep) || (!by_name && stage_owner_gone(&name)) {
                remove_tree(&p);
                gone.push(format!("{sub}/{name}"));
            }
        }
    }
    gone
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::tests::{app, World};
    use std::sync::Mutex;
    use support_core::stop::Stop;

    fn receipt(volume: &str, location: &str, files: &[&str]) -> Receipt {
        Receipt { volume: volume.into(), location: location.into(), files: files.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn a_stage_whose_process_is_gone_is_cleared_and_a_live_ones_is_kept() {
        let mine = std::process::id();
        assert!(!stage_owner_gone(&format!("update-{mine}-1-0")), "this process");
        assert!(!stage_owner_gone("update-1-1-0"), "launchd");
        assert!(stage_owner_gone("update-2000000000-1-0"), "no such process");
        assert!(stage_owner_gone("install-2000000000-1-0"));
        assert!(!stage_owner_gone("other-2000000000-1-0"));
        assert!(!stage_owner_gone("update-x-1-0"));
    }

    #[test]
    fn a_receipt_is_forgotten_only_when_every_file_of_it_is_inside_the_app() {
        let app = "/Applications/Foo.app";
        assert!(receipt_inside(app, &receipt("/", "Applications", &["Foo.app", "Foo.app/Contents", "Foo.app/Contents/Info.plist"])));
        assert!(receipt_inside(app, &receipt("/", "/Applications/Foo.app", &[".", "Contents/MacOS/foo"])));
        assert!(receipt_inside(app, &receipt("/", "/", &["Applications/FOO.APP/Contents"])), "any case");
        assert!(receipt_inside("/Applications/Cafe\u{301}.app", &receipt("/", "Applications", &["Caf\u{e9}.app/x"])), "NFD against NFC");
        // Never: an empty receipt, a sibling whose name only starts the same, a receipt that also installs elsewhere.
        assert!(!receipt_inside(app, &receipt("/", "Applications", &[])));
        assert!(!receipt_inside(app, &receipt("/", "Applications", &["Foo.app Helper/x"])));
        assert!(!receipt_inside(app, &receipt("/", "Applications", &["Foo.app/x", "Foo.app Helper/x"])));
        assert!(!receipt_inside(app, &receipt("/", "Applications", &["Foo.app/x", "../Library/LaunchDaemons/foo.plist"])));
        assert!(!receipt_inside(app, &receipt("/", "/", &["Applications", "Applications/Foo.app"])), "the parent folder too");
        assert!(!receipt_inside(app, &receipt("/Volumes/Other", "Applications", &["Foo.app/x"])), "another volume");
        assert!(!receipt_inside(app, &receipt("/", "Applications", &["Foo.app/../Bar.app/x"])));
    }

    struct Gone {
        alive: Mutex<Vec<i32>>,
        stubborn: Vec<i32>,
        log: Mutex<Vec<String>>,
    }

    impl Closer for Gone {
        fn ask_quit(&self, pids: &[i32]) -> Vec<i32> {
            self.log.lock().unwrap().push(format!("quit {pids:?}"));
            self.alive.lock().unwrap().retain(|p| self.stubborn.contains(p));
            pids.to_vec()
        }
        fn signal(&self, pid: i32, sig: i32) {
            self.log.lock().unwrap().push(format!("sig{sig} {pid}"));
            self.alive.lock().unwrap().retain(|p| *p != pid);
        }
        fn alive(&self, pid: i32) -> bool {
            self.alive.lock().unwrap().contains(&pid)
        }
    }

    fn run(w: &World, id: &str, protected: &[&str], closer: &Gone, procs: Vec<Proc>) -> Result<Value, String> {
        let req = UninstallRequest { bundle_id: id.into(), timeout_s: 300, protected_programs: protected.iter().map(|s| s.to_string()).collect() };
        uninstall(&req, &w.env(), &move || procs.clone(), closer, 1_800_000_000)
    }

    fn quiet() -> Gone {
        Gone { alive: Mutex::default(), stubborn: vec![], log: Mutex::default() }
    }

    #[test]
    fn an_app_is_quit_moved_to_the_root_only_holding_folder_and_its_own_receipts_forgotten() {
        let w = World::new("un");
        app(&w.apps, "Rectangle", "com.knollsoft.Rectangle");
        let apps = w.apps.to_string_lossy().into_owned();
        w.tools.receipts.lock().unwrap().extend([
            ("com.knollsoft.pkg".to_string(), receipt("/", &apps, &["Rectangle.app", "Rectangle.app/Contents/Info.plist"])),
            ("com.knollsoft.helper".to_string(), receipt("/", &apps, &["Rectangle.app/Contents/x", "Rectangle.app Helper/y"])),
            ("com.other".to_string(), receipt("/", &apps, &["Other.app/x"])),
        ]);
        let exe = format!("{apps}/Rectangle.app/Contents/MacOS/Rectangle");
        let closer = Gone { alive: Mutex::new(vec![700]), stubborn: vec![], log: Mutex::default() };
        let procs = vec![Proc { pid: 700, uid: 501, path: exe }, Proc { pid: 701, uid: 501, path: format!("{apps}/Rectangle.app Helper/x") }];
        let r = run(&w, "com.knollsoft.rectangle", &[], &closer, procs).unwrap();
        let held = w.data.join("removed/com.knollsoft.Rectangle-1800000000");
        assert_eq!(r["exit_code"], 0);
        assert_eq!(
            r["detail"],
            format!(
                "removed Rectangle.app 1.2: moved it from {apps} to {}, where it is kept for 7 days and then deleted. Support files in each person's ~/Library stay. Forgot the package receipts com.knollsoft.pkg",
                held.join("Rectangle.app").display()
            )
        );
        assert!(!w.apps.join("Rectangle.app").exists());
        assert!(held.join("Rectangle.app/Contents/Info.plist").is_file());
        assert_eq!(fs::metadata(&held).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(w.data.join("removed")).unwrap().mode() & 0o777, 0o700);
        assert_eq!(*closer.log.lock().unwrap(), vec!["quit [700]"], "only the app's own process, asked to quit");
        assert_eq!(*w.tools.log.lock().unwrap(), vec!["forget com.knollsoft.pkg"]);
    }

    #[test]
    fn an_app_that_will_not_quit_is_ended_after_the_wait() {
        let closer = Gone { alive: Mutex::new(vec![9]), stubborn: vec![9], log: Mutex::default() };
        let stop = Stop::new();
        let s2 = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            s2.set();
        });
        // The stop cuts the wait short; the kill still comes.
        assert_eq!(quit(&[9], &closer, &stop), 0);
        assert_eq!(*closer.log.lock().unwrap(), vec!["quit [9]".to_string(), format!("sig{} 9", libc::SIGKILL)]);
    }

    #[test]
    fn support_the_join_app_apples_apps_and_protected_programs_stay() {
        let w = World::new("unprot");
        app(&w.apps, "Support", paths::BUNDLE_ID);
        app(&w.apps, "Helper", paths::JOIN_BUNDLE_ID);
        app(&w.apps, "Notes2", "com.apple.notes2");
        app(&w.apps, "Slack", "com.tinyspeck.slackmacgap");
        app(&w.apps, "Café", "x.cafe");
        for (id, protected, want) in [
            (paths::BUNDLE_ID, vec![], rules::APP_NEVER_UNINSTALLED),
            (paths::JOIN_BUNDLE_ID, vec![], rules::APP_NEVER_UNINSTALLED),
            ("com.apple.notes2", vec![], rules::APPLE_NEVER_UNINSTALLED),
            ("com.tinyspeck.slackmacgap", vec!["slack"], "the team's rules protect this program"),
            ("com.tinyspeck.slackmacgap", vec!["COM.TINYSPECK.SLACKMACGAP"], "the team's rules protect this program"),
            ("x.cafe", vec!["Cafe\u{301}"], "the team's rules protect this program"),
        ] {
            let e = run(&w, id, &protected, &quiet(), vec![]).unwrap_err();
            assert_eq!(e, rules::err("protected_program", want), "{id}");
        }
        // An app at Support's own path is the app, whatever its id says.
        let info = AppInfo { id: "x.y".into(), version: String::new(), names: vec!["Support".into()] };
        assert!(uninstall_problem(Path::new("/Applications/Support.app"), &info, &[]).is_some());
        assert_eq!(fs::read_dir(&w.apps).unwrap().count(), 5, "nothing moved");
        assert!(!w.data.join("removed").exists());
        // Unknown and twice-installed ids.
        assert!(run(&w, "no.such.app", &[], &quiet(), vec![]).unwrap_err().starts_with("not_found: no app in"));
        fs::create_dir_all(w.apps.join("Utilities")).unwrap();
        app(&w.apps.join("Utilities"), "Slack", "com.tinyspeck.slackmacgap");
        assert!(run(&w, "com.tinyspeck.slackmacgap", &[], &quiet(), vec![]).unwrap_err().starts_with("2 apps have the bundle id"));
    }

    #[test]
    fn an_app_swapped_for_a_link_after_the_check_is_not_moved() {
        let w = World::new("unswap");
        app(&w.apps, "Victim", "x.victim");
        let real = w.apps.join("Victim.app");
        let m = fs::symlink_metadata(&real).unwrap();
        let held = w.root.join("held");
        fs::create_dir_all(&held).unwrap();
        // Replaced by another folder: refused by its identity.
        fs::rename(&real, w.root.join("elsewhere.app")).unwrap();
        fs::create_dir_all(&real).unwrap();
        assert!(move_app(&real, &held, m.dev(), m.ino()).unwrap_err().contains("changed while it was being removed"));
        // Replaced by a link: refused, and the link's target never moves.
        fs::remove_dir(&real).unwrap();
        std::os::unix::fs::symlink(w.root.join("elsewhere.app"), &real).unwrap();
        assert!(move_app(&real, &held, m.dev(), m.ino()).is_err());
        assert!(w.root.join("elsewhere.app/Contents/Info.plist").is_file());
        // A folder on the way that is a link is not followed.
        let via = w.root.join("via");
        std::os::unix::fs::symlink(&w.apps, &via).unwrap();
        fs::rename(w.root.join("elsewhere.app"), &real).unwrap_or_else(|_| {
            fs::remove_file(&real).unwrap();
            fs::rename(w.root.join("elsewhere.app"), &real).unwrap();
        });
        assert!(move_app(&via.join("Victim.app"), &held, m.dev(), m.ino()).unwrap_err().contains("symbolic link"));
        assert_eq!(fs::read_dir(&held).unwrap().count(), 0);
    }

    #[test]
    fn held_apps_go_after_7_days_and_stale_stages_after_a_day() {
        let w = World::new("sweep");
        let removed = w.data.join("removed");
        let staging = w.data.join("staging");
        crate::state::ensure_dir(&w.data, me()).unwrap();
        crate::state::ensure_dir(&removed, me()).unwrap();
        crate::state::ensure_dir(&staging, me()).unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        for name in [format!("a.b-{}", now - 8 * 86_400), format!("a.b-{}-2", now - 8 * 86_400), format!("c.d-{}", now - 86_400)] {
            fs::create_dir_all(removed.join(name).join("X.app/Contents")).unwrap();
        }
        // A link in the holding folder is removed itself, never what it points to.
        let outside = w.root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, removed.join(format!("e.f-{}", now - 9 * 86_400))).unwrap();
        fs::create_dir_all(staging.join("install-1-2-0")).unwrap();
        let mut gone = sweep(&w.data, now);
        gone.sort();
        assert_eq!(
            gone,
            vec![
                format!("removed/a.b-{}", now - 8 * 86_400),
                format!("removed/a.b-{}-2", now - 8 * 86_400),
                format!("removed/e.f-{}", now - 9 * 86_400)
            ]
        );
        assert!(removed.join(format!("c.d-{}", now - 86_400)).exists());
        assert!(outside.join("keep").exists());
        assert!(staging.join("install-1-2-0").exists(), "a fresh stage stays");
        assert!(sweep(&w.data, now + 3 * 86_400).contains(&"staging/install-1-2-0".to_string()));
        assert_eq!(held_since("x-123"), None, "too short to be a time");
        assert_eq!(safe_id("a/b c"), "a_b_c");
        assert_eq!(safe_id(".."), "app..");
    }
}
