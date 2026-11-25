//! The update steps that need macOS (`crate::update::System`): `pkgutil` to expand the package, `codesign` and the
//! Security framework to check the new app against this app's own designated requirement, and `launchctl` for the
//! watcher job, the service and the helpers.

use crate::install;
use crate::paths;
use crate::service::Os;
use crate::update::{self, Places, System, Updater};
use objc2_core_foundation::{CFRetained, CFString, CFURL};
use objc2_security::{
    kSecCSCheckAllArchitectures, kSecCSCheckNestedCode, kSecCSRestrictSymlinks, kSecCSStrictValidate, SecCSFlags, SecCode, SecRequirement,
    SecStaticCode,
};
use std::path::Path;
use std::ptr::{self, NonNull};
use std::sync::Arc;
use std::time::Duration;

pub struct MacSystem {
    /// This app's designated requirement as text, read from its own running code. None when it is not signed, and then
    /// no update is ever taken.
    requirement: Option<(CFRetained<SecRequirement>, String)>,
}

// SAFETY: a SecRequirement is immutable once made; Code Signing Services may use it from any thread.
unsafe impl Send for MacSystem {}
unsafe impl Sync for MacSystem {}

/// The designated requirement of the code that runs now, and its text.
fn own_requirement() -> Result<(CFRetained<SecRequirement>, String), String> {
    let mut me: *mut SecCode = ptr::null_mut();
    // SAFETY: a local out-pointer.
    let status = unsafe { SecCode::copy_self(SecCSFlags::DefaultFlags, NonNull::from(&mut me)) };
    let me = NonNull::new(me).filter(|_| status == 0).ok_or_else(|| format!("SecCodeCopySelf failed ({status})"))?;
    // SAFETY: a +1 reference from a Copy function.
    let me = unsafe { CFRetained::from_raw(me) };
    let mut st: *const SecStaticCode = ptr::null();
    // SAFETY: a live code object and a local out-pointer.
    let status = unsafe { me.copy_static_code(SecCSFlags::DefaultFlags, NonNull::from(&mut st)) };
    let st = NonNull::new(st.cast_mut()).filter(|_| status == 0).ok_or_else(|| format!("SecCodeCopyStaticCode failed ({status})"))?;
    // SAFETY: a +1 reference from a Copy function.
    let st = unsafe { CFRetained::from_raw(st) };
    let mut req: *mut SecRequirement = ptr::null_mut();
    // SAFETY: a live static code and a local out-pointer.
    let status = unsafe { SecCode::copy_designated_requirement(&st, SecCSFlags::DefaultFlags, NonNull::from(&mut req)) };
    let req = NonNull::new(req).filter(|_| status == 0).ok_or_else(|| format!("this app is not signed, so it takes no update ({status})"))?;
    // SAFETY: a +1 reference from a Copy function.
    let req = unsafe { CFRetained::from_raw(req) };
    let mut text: *const CFString = ptr::null();
    // SAFETY: a live requirement and a local out-pointer.
    let status = unsafe { req.copy_string(SecCSFlags::DefaultFlags, NonNull::from(&mut text)) };
    let text = NonNull::new(text.cast_mut()).filter(|_| status == 0).ok_or_else(|| format!("SecRequirementCopyString failed ({status})"))?;
    // SAFETY: a +1 reference from a Copy function.
    let text = unsafe { CFRetained::from_raw(text) }.to_string();
    Ok((req, text))
}

impl MacSystem {
    pub fn new() -> MacSystem {
        let requirement = match own_requirement() {
            Ok(r) => Some(r),
            Err(e) => {
                eprintln!("support: {e}");
                None
            }
        };
        MacSystem { requirement }
    }
}

impl Default for MacSystem {
    fn default() -> Self {
        Self::new()
    }
}

/// A tool's exit code 0, or what it said.
fn ok(path: &str, args: &[&str], wait: Duration) -> Result<String, String> {
    let mut c = install::tool(path);
    c.args(args);
    let (code, out, err) = install::run_full(c, wait)?;
    match code {
        Some(0) => Ok(String::from_utf8_lossy(&out).into_owned()),
        Some(n) => {
            Err(format!("{} exited with {n}: {}", Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path), install::said(&out, &err)))
        }
        None => Err(format!("{path} did not finish in time")),
    }
}

fn arg(p: &Path) -> Result<&str, String> {
    p.to_str().ok_or_else(|| format!("{} is not UTF-8", p.display()))
}

const LAUNCHCTL_WAIT: Duration = Duration::from_secs(30);

impl System for MacSystem {
    fn expand(&self, pkg: &Path, into: &Path) -> Result<(), String> {
        ok(paths::PKGUTIL, &["--expand-full", arg(pkg)?, arg(into)?], Duration::from_secs(300)).map(|_| ())
    }

    fn verify_code(&self, app: &Path) -> Result<(), String> {
        let Some((req, text)) = &self.requirement else { return Err("this app is not signed".into()) };
        // codesign itself: the whole bundle, strictly, and against this app's designated requirement.
        ok(paths::CODESIGN, &["--verify", "--strict", "--verbose=2", "-R", &format!("={text}"), arg(app)?], Duration::from_secs(120))?;
        // The same through the Security framework, with links held to the bundle and every architecture checked.
        let url = CFURL::from_directory_path(app).ok_or("the app's path is not a URL")?;
        let mut st: *const SecStaticCode = ptr::null();
        // SAFETY: a live URL and a local out-pointer.
        let status = unsafe { SecStaticCode::create_with_path(&url, SecCSFlags::DefaultFlags, NonNull::from(&mut st)) };
        let st = NonNull::new(st.cast_mut()).filter(|_| status == 0).ok_or_else(|| format!("SecStaticCodeCreateWithPath failed ({status})"))?;
        // SAFETY: a +1 reference from a Create function.
        let st = unsafe { CFRetained::from_raw(st) };
        let flags = SecCSFlags(kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate | kSecCSRestrictSymlinks);
        // SAFETY: live objects.
        let status = unsafe { st.check_validity(flags, Some(req)) };
        if status != 0 {
            return Err(format!("its signature does not satisfy this app's designated requirement ({status})"));
        }
        Ok(())
    }

    fn load_watcher(&self, plist: &Path) -> Result<(), String> {
        // One left from an earlier trial stays loaded after it exits: it goes first.
        self.unload_watcher();
        ok(paths::LAUNCHCTL, &["bootstrap", "system", arg(plist)?], LAUNCHCTL_WAIT).map(|_| ())
    }

    fn watcher_running(&self) -> bool {
        ok(paths::LAUNCHCTL, &["print", &format!("system/{}", paths::WATCH_LABEL)], LAUNCHCTL_WAIT).is_ok_and(|out| update::running_in(&out))
    }

    fn unload_watcher(&self) {
        let _ = ok(paths::LAUNCHCTL, &["bootout", &format!("system/{}", paths::WATCH_LABEL)], LAUNCHCTL_WAIT);
    }

    fn restart_service(&self) -> Result<(), String> {
        ok(paths::LAUNCHCTL, &["kickstart", "-k", &format!("system/{}", paths::DAEMON_LABEL)], LAUNCHCTL_WAIT).map(|_| ())
    }

    fn restart_helpers(&self, own_pid: i32) {
        let os = super::os::MacOs::new();
        for uid in crate::uninstall::gui_uids(&os.processes()) {
            let _ = ok(paths::LAUNCHCTL, &["kickstart", "-k", &format!("gui/{uid}/{}", paths::AGENT_LABEL)], LAUNCHCTL_WAIT);
        }
        // Anything still running an old copy (the login window's helper, or a service kickstart could not reach).
        for p in os.processes().iter().filter(|p| update::old_copy(&p.path, paths::DATA_DIR) && p.pid != own_pid && p.pid > 1) {
            // SAFETY: kill(2) on one positive pid.
            unsafe {
                libc::kill(p.pid, libc::SIGTERM);
            }
        }
    }
}

/// The `update-watch` role.
pub fn watch(restart: bool) -> i32 {
    // SAFETY: a getter.
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("The update watcher runs as root, from launchd.");
        return 2;
    }
    Updater::new(Places::mac(), crate::VERSION, Arc::new(MacSystem::new())).watch(restart)
}
