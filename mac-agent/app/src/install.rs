//! install_program on a saved Mac, as root under full control. The relay and the core's rules have judged the path as
//! written; the steps here make sure that what runs is the file they judged and nothing a person at the Mac can change
//! under it:
//!
//! 1. The path is resolved (`realpath`) and checked again with the relay's own checks, in NFC, and against the protected
//!    folders and the Support app's, with links resolved.
//! 2. The file is opened by walking from `/` without following any link (`safe_files::open_regular`), so it is the file
//!    at the path just checked, and copied into a new folder only root can open, under the data folder's `staging/`.
//!    From then on only that copy is used: nobody else can change it.
//! 3. Gatekeeper must accept what runs (`spctl --assess`), or the call is refused with its reason (approved call 10).
//! 4. A `.pkg` or `.mpkg` runs through `installer -pkg <copy> -target /`. A `.dmg` is attached read-only into the staging
//!    folder and always detached; a `.zip` is first checked (`zipscan`) and then expanded there with `ditto -x -k`. Either
//!    must hold exactly one app (or, a disk image, exactly one package and no app). The app must be a real folder with no
//!    link inside that leads out of it. It is copied with `ditto` into the staging folder, given to root with no write
//!    for others and no setuid bit, checked by Gatekeeper, and moved into /Applications in one step: swapped with an older
//!    copy (`renamex_np` with `RENAME_SWAP`), whose removal then waits for the staging folder's, or put there only if
//!    nothing is there yet (`RENAME_EXCL`).
//!
//! The steps that need macOS's own tools are behind `Tools`, so the rest is tested on Linux.

use crate::paths;
use crate::programs::{self, AppInfo};
use crate::safe_files;
use crate::zipscan;
use serde_json::{json, Value};
use std::ffi::CString;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use support_core::exec::RunOutput;
use support_core::platform::InstallRequest;
use support_core::rules::{self, MacInstaller};
use support_core::stop::Stop;

/// The largest installer copied in. A bigger one is refused rather than fill the disk.
pub const INSTALLER_MAX: u64 = 16 << 30;
/// What a Gatekeeper check may take (it can ask Apple about a notarization ticket).
pub const ASSESS_WAIT: Duration = Duration::from_secs(120);

/// What Gatekeeper is asked: whether a package may be installed, or an app run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Assess {
    Install,
    Execute,
}

/// A disk image attached by `Tools::attach`: the device to detach, and where its volumes are.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Attached {
    pub device: String,
    pub mounts: Vec<PathBuf>,
}

/// A package receipt (`pkgutil --pkg-info-plist` and `--files`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Receipt {
    pub volume: String,
    pub location: String,
    pub files: Vec<String>,
}

/// macOS's own tools. Every one runs by its full path, with a clean environment, from /, with nothing on stdin.
pub trait Tools: Send + Sync {
    /// `spctl --assess --type install|execute`. Ok when Gatekeeper accepts it, else its reason.
    fn assess(&self, path: &Path, kind: Assess) -> Result<(), String>;
    /// `installer -pkg <pkg> -target /`.
    fn install_package(&self, pkg: &Path, timeout: Duration, stop: &Stop) -> Result<RunOutput, String>;
    /// Whether a disk image asks to accept a license before it opens (`hdiutil imageinfo`).
    fn needs_license(&self, image: &Path) -> Result<bool, String>;
    /// `hdiutil attach -nobrowse -readonly -noautoopen -mountrandom <mount_root>`.
    fn attach(&self, image: &Path, mount_root: &Path, timeout: Duration, stop: &Stop) -> Result<Attached, String>;
    /// `hdiutil detach`, forced if it must be. A mount point or a device.
    fn detach(&self, what: &str);
    /// `ditto -x -k <zip> <into>`.
    fn unzip(&self, zip: &Path, into: &Path, timeout: Duration, stop: &Stop) -> Result<(), String>;
    /// `ditto <from> <to>`: a copy of a folder, links kept as links.
    fn copy(&self, from: &Path, to: &Path, timeout: Duration, stop: &Stop) -> Result<(), String>;
    /// The ids of the receipts that list any of these paths (`pkgutil --file-info`).
    fn receipts_owning(&self, paths: &[String]) -> Vec<String>;
    fn receipt(&self, id: &str) -> Option<Receipt>;
    /// `pkgutil --forget`.
    fn forget(&self, id: &str) -> Result<(), String>;
}

/// A tool by its full path, with a clean environment, from /, with nothing on stdin.
fn tool(path: &str) -> std::process::Command {
    let mut c = std::process::Command::new(path);
    c.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").env("LANG", "en_US.UTF-8").current_dir("/");
    c
}

/// The most a tool's whole output may be when it is read in full (a plist, a list of files).
const FULL_MAX: usize = 64 << 20;

/// Runs a tool and reads all it writes (up to `FULL_MAX`), killing it at the timeout. Returns its exit code (None when it
/// was killed), stdout and stderr.
/// A tool's exit code (None when it was killed), stdout and stderr.
type Ran = (Option<i32>, Vec<u8>, Vec<u8>);

fn run_full(mut c: std::process::Command, timeout: Duration) -> Result<Ran, String> {
    use std::process::Stdio;
    let mut child = c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(p) = pipe {
                let _ = p.take(FULL_MAX as u64).read_to_end(&mut out);
            }
            out
        })
    };
    let out = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let until = Instant::now() + timeout;
    let code = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status.code(),
            None if Instant::now() >= until => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    Ok((code, out.join().unwrap_or_default(), err.join().unwrap_or_default()))
}

/// What a tool said, on one line.
fn said(out: &[u8], err: &[u8]) -> String {
    let text = String::from_utf8_lossy(if err.iter().any(|b| !b.is_ascii_whitespace()) { err } else { out }).replace(['\n', '\r'], " ");
    support_core::wire::clean(&text, 300)
}

/// A package id as pkgutil prints it, safe to hand back to it as an argument.
fn good_pkg_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 255 && !id.starts_with('-') && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// macOS's tools themselves.
pub struct SystemTools;

impl Tools for SystemTools {
    fn assess(&self, path: &Path, kind: Assess) -> Result<(), String> {
        let mut c = tool(paths::SPCTL);
        c.args(["--assess", "--type", if kind == Assess::Install { "install" } else { "execute" }, "-v"]).arg(path);
        match run_full(c, ASSESS_WAIT)? {
            (Some(0), _, _) => Ok(()),
            (None, _, _) => Err("Gatekeeper did not answer in time".into()),
            (Some(_), out, err) => Err(said(&out, &err)),
        }
    }

    fn install_package(&self, pkg: &Path, timeout: Duration, stop: &Stop) -> Result<RunOutput, String> {
        let mut c = tool(paths::INSTALLER);
        c.arg("-pkg").arg(pkg).args(["-target", "/"]);
        support_core::exec::run(&mut c, timeout, stop)
    }

    fn needs_license(&self, image: &Path) -> Result<bool, String> {
        let mut c = tool(paths::HDIUTIL);
        c.args(["imageinfo", "-plist"]).arg(image);
        let (code, out, err) = run_full(c, Duration::from_secs(120))?;
        if code != Some(0) {
            return Err(format!("hdiutil could not read the disk image: {}", said(&out, &err)));
        }
        let v = plist::Value::from_reader_xml(out.as_slice()).map_err(|e| format!("hdiutil's answer could not be read: {e}"))?;
        Ok(license_in(&v))
    }

    fn attach(&self, image: &Path, mount_root: &Path, timeout: Duration, _stop: &Stop) -> Result<Attached, String> {
        let mut c = tool(paths::HDIUTIL);
        c.args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountrandom"]).arg(mount_root).arg("-plist").arg(image);
        let (code, out, err) = run_full(c, timeout)?;
        let parsed = (code == Some(0)).then(|| plist::Value::from_reader_xml(out.as_slice()).ok().map(|v| attached_in(&v))).flatten();
        match parsed {
            Some(a) if !a.device.is_empty() => Ok(a),
            _ => {
                // Whatever did get attached under the mount folder is detached before the refusal.
                if let Ok(entries) = fs::read_dir(mount_root) {
                    for e in entries.flatten() {
                        self.detach(&e.path().to_string_lossy());
                    }
                }
                Err(if code.is_none() {
                    "the disk image did not open in time".into()
                } else {
                    format!("the disk image could not be opened: {}", said(&out, &err))
                })
            }
        }
    }

    fn detach(&self, what: &str) {
        let mut c = tool(paths::HDIUTIL);
        c.args(["detach", what]);
        if !matches!(run_full(c, Duration::from_secs(60)), Ok((Some(0), _, _))) {
            let mut c = tool(paths::HDIUTIL);
            c.args(["detach", what, "-force"]);
            let _ = run_full(c, Duration::from_secs(60));
        }
    }

    fn unzip(&self, zip: &Path, into: &Path, timeout: Duration, stop: &Stop) -> Result<(), String> {
        let mut c = tool(paths::DITTO);
        c.args(["-x", "-k"]).arg(zip).arg(into);
        let out = support_core::exec::run(&mut c, timeout, stop)?;
        match out.exit_code {
            Some(0) => Ok(()),
            None => Err("the zip did not expand in time".into()),
            Some(_) => Err(format!("ditto could not expand the zip: {}", said(&out.stdout, &out.stderr))),
        }
    }

    fn copy(&self, from: &Path, to: &Path, timeout: Duration, stop: &Stop) -> Result<(), String> {
        let mut c = tool(paths::DITTO);
        c.arg(from).arg(to);
        let out = support_core::exec::run(&mut c, timeout, stop)?;
        match out.exit_code {
            Some(0) => Ok(()),
            None => Err("the app was not copied in time".into()),
            Some(_) => Err(format!("ditto could not copy the app: {}", said(&out.stdout, &out.stderr))),
        }
    }

    fn receipts_owning(&self, paths_: &[String]) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for p in paths_ {
            let mut c = tool(paths::PKGUTIL);
            c.args(["--file-info", p]);
            if let Ok((Some(0), out, _)) = run_full(c, Duration::from_secs(60)) {
                for id in String::from_utf8_lossy(&out).lines().filter_map(|l| l.strip_prefix("pkgid: ")).map(str::trim) {
                    if good_pkg_id(id) && !ids.iter().any(|i| i == id) {
                        ids.push(id.to_string());
                    }
                }
            }
        }
        ids
    }

    fn receipt(&self, id: &str) -> Option<Receipt> {
        if !good_pkg_id(id) {
            return None;
        }
        let mut c = tool(paths::PKGUTIL);
        c.args(["--pkg-info-plist", id]);
        let (code, out, _) = run_full(c, Duration::from_secs(60)).ok()?;
        let info = plist::Value::from_reader_xml(out.as_slice()).ok().filter(|_| code == Some(0))?.into_dictionary()?;
        let text = |k: &str| info.get(k).and_then(|v| v.as_string()).unwrap_or("").to_string();
        let mut c = tool(paths::PKGUTIL);
        c.args(["--files", id]);
        let (code, out, _) = run_full(c, Duration::from_secs(120)).ok()?;
        if code != Some(0) || out.len() >= FULL_MAX {
            return None;
        }
        let files = String::from_utf8_lossy(&out).lines().filter(|l| !l.is_empty()).map(str::to_string).collect();
        Some(Receipt { volume: text("volume"), location: text("install-location"), files })
    }

    fn forget(&self, id: &str) -> Result<(), String> {
        if !good_pkg_id(id) {
            return Err(format!("{id} is not a package id"));
        }
        let mut c = tool(paths::PKGUTIL);
        c.args(["--forget", id]);
        match run_full(c, Duration::from_secs(60))? {
            (Some(0), _, _) => Ok(()),
            (_, out, err) => Err(said(&out, &err)),
        }
    }
}

/// Whether `hdiutil imageinfo -plist` says the image has a license to accept.
pub fn license_in(v: &plist::Value) -> bool {
    v.as_dictionary()
        .and_then(|d| d.get("Properties"))
        .and_then(|p| p.as_dictionary())
        .and_then(|p| p.get("Software License Agreement"))
        .and_then(|l| l.as_boolean())
        .unwrap_or(false)
}

/// The device and mount points in `hdiutil attach -plist`'s answer. The device to detach is the whole disk: the shortest
/// device entry.
pub fn attached_in(v: &plist::Value) -> Attached {
    let mut out = Attached::default();
    let entities = v.as_dictionary().and_then(|d| d.get("system-entities")).and_then(|e| e.as_array()).cloned().unwrap_or_default();
    for e in entities.iter().filter_map(|e| e.as_dictionary()) {
        if let Some(dev) = e.get("dev-entry").and_then(|d| d.as_string()) {
            if out.device.is_empty() || dev.len() < out.device.len() {
                out.device = dev.to_string();
            }
        }
        if let Some(m) = e.get("mount-point").and_then(|m| m.as_string()) {
            out.mounts.push(PathBuf::from(m));
        }
    }
    out
}

/// What an install works with: the tools, the data folder (staging/ and removed/ are under it) and the folder apps go to.
pub struct Env<'a> {
    pub tools: &'a dyn Tools,
    pub data_dir: &'a Path,
    pub apps_dir: &'a Path,
    pub stop: &'a Stop,
}

/// The uid that owns the data folder and what is made in it: root on a Mac, the test's own user in a test.
fn me() -> u32 {
    // SAFETY: a getter.
    unsafe { libc::geteuid() }
}

fn not_found(path: &str) -> String {
    rules::err("not_found", &format!("there is no installer at {path}"))
}

/// A folder made new for one install, only for root, under `<data>/staging/`. Dropping it detaches what is still attached
/// in it and removes it, never following a link.
pub struct Stage<'a> {
    pub dir: PathBuf,
    tools: &'a dyn Tools,
    pub attached: Vec<String>,
}

impl<'a> Stage<'a> {
    pub fn new(data_dir: &Path, tools: &'a dyn Tools) -> Result<Stage<'a>, String> {
        crate::state::ensure_dir(data_dir, me())?;
        let root = data_dir.join(paths::STAGING_DIR);
        crate::state::ensure_dir(&root, me())?;
        for n in 0..100u32 {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let dir = root.join(format!("install-{}-{nanos}-{n}", std::process::id()));
            match fs::DirBuilder::new().mode(0o700).create(&dir) {
                Ok(()) => return Ok(Stage { dir, tools, attached: Vec::new() }),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("{}: {e}", dir.display())),
            }
        }
        Err("could not make a staging folder".into())
    }

    /// A new folder in the stage, only for root.
    pub fn sub(&self, name: &str) -> Result<PathBuf, String> {
        let p = self.dir.join(name);
        fs::DirBuilder::new().mode(0o700).create(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        Ok(p)
    }
}

impl Drop for Stage<'_> {
    fn drop(&mut self) {
        for what in self.attached.drain(..).rev() {
            self.tools.detach(&what);
        }
        remove_tree(&self.dir);
    }
}

/// Removes a folder and what is in it, or a file or a link, never following a link.
pub fn remove_tree(path: &Path) {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_dir() => {
            let _ = fs::remove_dir_all(path);
        }
        Ok(_) => {
            let _ = fs::remove_file(path);
        }
        Err(_) => {}
    }
}

/// The time left before `deadline`, or the refusal that it has run out.
fn left(deadline: Instant, stop: &Stop) -> Result<Duration, String> {
    if stop.is_set() {
        return Err("stopped".into());
    }
    let now = Instant::now();
    if now >= deadline {
        return Err("it did not finish in time and was stopped".into());
    }
    Ok(deadline - now)
}

/// Copies the opened installer into the stage as `name`, made new (never over a file, never through a link), only for
/// root. Returns its size.
fn copy_in(mut from: fs::File, to: &Path, deadline: Instant, stop: &Stop) -> Result<u64, String> {
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(to)
        .map_err(|e| format!("{}: {e}", to.display()))?;
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        left(deadline, stop)?;
        let n = from.read(&mut buf).map_err(|e| format!("could not read the installer: {e}"))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > INSTALLER_MAX {
            return Err(format!("the installer is larger than {} GB", INSTALLER_MAX >> 30));
        }
        out.write_all(&buf[..n]).map_err(|e| format!("could not copy the installer: {e}"))?;
    }
    Ok(total)
}

/// Runs an install. Returns the result fields: `exit_code` and `detail`.
pub fn install(req: &InstallRequest, env: &Env) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(req.timeout_s.clamp(10, 600));
    // 1. The real path, checked again as the relay checked the path as written.
    let real = fs::canonicalize(&req.path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => not_found(&req.path),
        _ => format!("{}: {e}", req.path),
    })?;
    let real = real.to_str().ok_or("the installer's real path is not UTF-8")?.to_string();
    let checked = rules::nfc(&real);
    if let Some(problem) = rules::mac_install_problem(&checked, "") {
        return Err(if real == req.path { problem } else { format!("{} leads to {real}: {problem}", req.path) });
    }
    if rules::is_app_path(&checked) || rules::inside_any(&req.protected_folders, &checked) || rules::inside_any(&req.protected_folders, &req.path) {
        return Err(rules::refuse("protected_folder").error().unwrap_or_default());
    }
    let name = real.rsplit('/').next().unwrap_or("").to_string();
    let kind = rules::mac_installer_kind(&name).ok_or(rules::MAC_INSTALLER_TYPES)?;
    // 2. The file at that path, opened without following a link, copied where only root can reach it.
    let (file, st) = safe_files::open_regular(&real).map_err(|e| if e.ends_with("does not exist") { not_found(&real) } else { e })?;
    if st.st_nlink > 1 {
        return Err(format!("{real} has a second hard link; as root, Support does not install it. Copy it to a file of its own first"));
    }
    if st.st_size as u64 > INSTALLER_MAX {
        return Err(format!("the installer is larger than {} GB", INSTALLER_MAX >> 30));
    }
    let mut stage = Stage::new(env.data_dir, env.tools)?;
    let copy = stage.dir.join(match kind {
        MacInstaller::Package if name.to_lowercase().ends_with(".mpkg") => "installer.mpkg",
        MacInstaller::Package => "installer.pkg",
        MacInstaller::Image => "image.dmg",
        MacInstaller::Zip => "archive.zip",
    });
    copy_in(file, &copy, deadline, env.stop)?;
    match kind {
        MacInstaller::Package => run_package(&copy, &name, env, deadline),
        MacInstaller::Image => from_image(&copy, &name, &mut stage, req, env, deadline),
        MacInstaller::Zip => from_zip(&copy, &name, &stage, req, env, deadline),
    }
}

/// Gatekeeper's answer, as the refusal to give.
fn gatekeeper(env: &Env, path: &Path, kind: Assess, shown: &str) -> Result<(), String> {
    env.tools.assess(path, kind).map_err(|reason| {
        let reason = reason.replace(&path.to_string_lossy().into_owned(), shown).replace(['\n', '\r'], " ");
        format!("Gatekeeper rejected {shown}: {}. install_program installs only what Gatekeeper accepts", support_core::wire::clean(&reason, 300))
    })
}

fn run_package(pkg: &Path, shown: &str, env: &Env, deadline: Instant) -> Result<Value, String> {
    gatekeeper(env, pkg, Assess::Install, shown)?;
    let out = env.tools.install_package(pkg, left(deadline, env.stop)?, env.stop)?;
    if out.timed_out {
        return Err("the package did not finish in time and was stopped".into());
    }
    let code = out.exit_code.unwrap_or(-1);
    let said = said(&out.stdout, &out.stderr);
    let detail = if code == 0 {
        format!("installed the package {shown} on /")
    } else {
        format!(
            "installer could not install the package {shown} (exit code {code}){}",
            if said.is_empty() { String::new() } else { format!(": {said}") }
        )
    };
    Ok(json!({ "exit_code": code, "detail": detail }))
}

/// One name at the top of a disk image or zip.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub kind: Kind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Dir,
    Link,
    File,
    Other,
}

/// What a disk image or zip is installed from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Found {
    App(String),
    Package(String),
}

fn is_app_name(name: &str) -> bool {
    name.len() > 4 && name.get(name.len() - 4..).is_some_and(|e| e.eq_ignore_ascii_case(".app"))
}

fn listing(names: &[&String]) -> String {
    names.iter().map(|n| n.as_str()).collect::<Vec<_>>().join(", ")
}

/// The one-app rule. Hidden names and `__MACOSX` are left out. Exactly one app and no package is the app, which must be a
/// real folder. With `packages` (a disk image), exactly one package and no app is the package. Anything else is refused
/// with what was found. `what` is "disk image" or "zip".
pub fn one_app(entries: &[Entry], packages: bool, what: &str) -> Result<Found, String> {
    let shown: Vec<&Entry> = entries.iter().filter(|e| !e.name.starts_with('.') && e.name != "__MACOSX").collect();
    let apps: Vec<&String> = shown.iter().filter(|e| is_app_name(&e.name)).map(|e| &e.name).collect();
    let pkgs: Vec<&String> = shown.iter().filter(|e| rules::mac_installer_kind(&e.name) == Some(MacInstaller::Package)).map(|e| &e.name).collect();
    let kind_of = |n: &String| shown.iter().find(|e| &e.name == n).map(|e| e.kind).unwrap_or(Kind::Other);
    if apps.len() == 1 && pkgs.is_empty() {
        return match kind_of(apps[0]) {
            Kind::Dir => Ok(Found::App(apps[0].clone())),
            Kind::Link => Err(format!("{} in the {what} is a link, not an app folder; install_program does not follow it", apps[0])),
            _ => Err(format!("{} in the {what} is not an app folder", apps[0])),
        };
    }
    if packages && apps.is_empty() && pkgs.len() == 1 {
        return match kind_of(pkgs[0]) {
            Kind::File | Kind::Dir => Ok(Found::Package(pkgs[0].clone())),
            _ => Err(format!("{} in the {what} is a link, not a package; install_program does not follow it", pkgs[0])),
        };
    }
    let found = match (apps.len(), pkgs.len()) {
        (0, 0) => "no app".to_string(),
        (a, 0) => format!("{a} apps ({})", listing(&apps)),
        (0, p) => format!("{p} packages ({})", listing(&pkgs)),
        (a, p) => format!(
            "{a} app{} and {p} package{} ({}, {})",
            if a == 1 { "" } else { "s" },
            if p == 1 { "" } else { "s" },
            listing(&apps),
            listing(&pkgs)
        ),
    };
    let need = if packages { "exactly one app, or one package and no app" } else { "exactly one app" };
    Err(format!("the {what} holds {found} at its top; install_program installs from it only when it holds {need}"))
}

/// The names at the top of a folder, links not followed.
pub fn list_top(dir: &Path) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.flatten() {
        let Some(name) = e.file_name().to_str().map(str::to_string) else { continue };
        let kind = match fs::symlink_metadata(e.path()) {
            Ok(m) if m.file_type().is_symlink() => Kind::Link,
            Ok(m) if m.file_type().is_dir() => Kind::Dir,
            Ok(m) if m.file_type().is_file() => Kind::File,
            _ => Kind::Other,
        };
        out.push(Entry { name, kind });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn from_image(image: &Path, shown: &str, stage: &mut Stage, req: &InstallRequest, env: &Env, deadline: Instant) -> Result<Value, String> {
    if env.tools.needs_license(image)? {
        return Err(format!(
            "{shown} asks to accept a license before it opens; install_program does not accept a license for anyone. Open it at the Mac instead"
        ));
    }
    let mounts = stage.sub("mnt")?;
    let attached = env.tools.attach(image, &mounts, left(deadline, env.stop)?, env.stop)?;
    // Detached when the stage goes, whatever happens next: the whole device, or each volume when there is no device.
    if attached.device.is_empty() {
        stage.attached.extend(attached.mounts.iter().map(|m| m.to_string_lossy().into_owned()));
    } else {
        stage.attached.push(attached.device.clone());
    }
    // Each volume must be inside the stage's own mount folder, where nobody but root can reach it.
    let mut entries = Vec::new();
    let mut by_name = std::collections::HashMap::new();
    for m in &attached.mounts {
        if !m.starts_with(&mounts) {
            return Err(format!("the disk image was attached at {}, not where Support asked", m.display()));
        }
        for e in list_top(m)? {
            by_name.insert(e.name.clone(), m.join(&e.name));
            entries.push(e);
        }
    }
    match one_app(&entries, true, "disk image")? {
        Found::App(name) => install_app(&by_name[&name], &name, stage, req, env, deadline),
        Found::Package(name) => run_package(&by_name[&name], &name, env, deadline),
    }
}

fn from_zip(zip: &Path, shown: &str, stage: &Stage, req: &InstallRequest, env: &Env, deadline: Instant) -> Result<Value, String> {
    zipscan::check(zip).map_err(|e| format!("{shown}: {e}"))?;
    let into = stage.sub("unzip")?;
    env.tools.unzip(zip, &into, left(deadline, env.stop)?, env.stop)?;
    match one_app(&list_top(&into)?, false, "zip")? {
        Found::App(name) => install_app(&into.join(&name), &name, stage, req, env, deadline),
        Found::Package(_) => unreachable!("a zip is never installed from a package"),
    }
}

/// Why a link inside an app leads out of it, or None. `rel` is the link's place in the app (its parts), `target` what it
/// holds. The target is followed part by part inside the app, through the app's own links, as the system would follow it:
/// an absolute target, or a `..` that would leave the app's folder at any step, leads out.
fn leads_out(app: &Path, rel: &[String], target: &str) -> bool {
    if target.starts_with('/') {
        return true;
    }
    let mut cur: Vec<String> = rel[..rel.len().saturating_sub(1)].to_vec();
    let mut todo: std::collections::VecDeque<String> = target.split('/').map(str::to_string).collect();
    let mut hops = 0;
    while let Some(part) = todo.pop_front() {
        match part.as_str() {
            "" | "." => {}
            ".." => {
                if cur.pop().is_none() {
                    return true;
                }
            }
            name => {
                cur.push(name.to_string());
                let here = cur.iter().fold(app.to_path_buf(), |p, c| p.join(c));
                if let Ok(t) = fs::read_link(&here) {
                    hops += 1;
                    let Some(t) = t.to_str().filter(|_| hops <= 40) else { return true };
                    if t.starts_with('/') {
                        return true;
                    }
                    cur.pop();
                    for (i, p) in t.split('/').enumerate() {
                        todo.insert(i, p.to_string());
                    }
                }
            }
        }
    }
    false
}

/// Why an app folder may not be installed, or None: it must be a real folder, hold only folders, files and links, and no
/// link in it may lead out of it. Also bounded, so a crafted app cannot keep this busy.
pub fn bundle_problem(app: &Path) -> Option<String> {
    match fs::symlink_metadata(app) {
        Ok(m) if m.file_type().is_dir() => {}
        Ok(_) => return Some(format!("{} is not an app folder", app.display())),
        Err(e) => return Some(format!("{}: {e}", app.display())),
    }
    let shown = app.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut todo: Vec<Vec<String>> = vec![vec![]];
    let mut seen = 0usize;
    while let Some(rel) = todo.pop() {
        let dir = rel.iter().fold(app.to_path_buf(), |p, c| p.join(c));
        let Ok(entries) = fs::read_dir(&dir) else { return Some(format!("{}/{} cannot be read", shown, rel.join("/"))) };
        for e in entries.flatten() {
            seen += 1;
            if seen > 500_000 {
                return Some(format!("{shown} holds more than 500,000 files"));
            }
            let Some(name) = e.file_name().to_str().map(str::to_string) else { return Some(format!("{shown} holds a name that is not UTF-8")) };
            let mut here = rel.clone();
            here.push(name);
            let path = dir.join(e.file_name());
            let Ok(m) = fs::symlink_metadata(&path) else { continue };
            let t = m.file_type();
            if t.is_symlink() {
                let target = fs::read_link(&path).ok().and_then(|t| t.to_str().map(str::to_string)).unwrap_or_else(|| "/".into());
                if leads_out(app, &here, &target) {
                    return Some(format!("{shown}/{} is a link to {target}, which leads out of the app", here.join("/")));
                }
            } else if t.is_dir() {
                if here.len() > 64 {
                    return Some(format!("{shown} is nested too deep"));
                }
                todo.push(here);
            } else if !t.is_file() {
                return Some(format!("{shown}/{} is not a file, a folder or a link", here.join("/")));
            }
        }
    }
    None
}

/// Gives every file of the staged app to root (when this runs as root) and takes away write for anyone else and the
/// setuid and setgid bits, links left as they are. An app copied from a disk image keeps the uids of whoever made the
/// image, which may be a person on this Mac; installed by root, it is root's.
pub fn make_roots(app: &Path) -> Result<(), String> {
    let root = me() == 0;
    let mut todo = vec![app.to_path_buf()];
    while let Some(p) = todo.pop() {
        let m = fs::symlink_metadata(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        if root {
            let c = CString::new(p.as_os_str().as_bytes()).map_err(|_| "a name holds a NUL")?;
            // SAFETY: a valid C string; lchown never follows a link.
            if unsafe { libc::lchown(c.as_ptr(), 0, 0) } != 0 {
                return Err(format!("{}: {}", p.display(), io::Error::last_os_error()));
            }
        }
        if m.file_type().is_symlink() {
            continue;
        }
        let mode = m.mode() & 0o7777;
        let want = mode & !0o6022;
        if want != mode {
            fs::set_permissions(&p, fs::Permissions::from_mode(want)).map_err(|e| format!("{}: {e}", p.display()))?;
        }
        if m.file_type().is_dir() {
            for e in fs::read_dir(&p).map_err(|e| format!("{}: {e}", p.display()))?.flatten() {
                todo.push(e.path());
            }
        }
    }
    Ok(())
}

/// The Support app's own bundle ids and names, which no install ever writes over.
fn is_support(id: &str, names: &[String]) -> bool {
    let id = id.to_ascii_lowercase();
    id == paths::BUNDLE_ID
        || id == paths::JOIN_BUNDLE_ID
        || id.starts_with(&format!("{}.", paths::BUNDLE_ID))
        || names.iter().any(|n| {
            let k = rules::program_key(&rules::nfc(n));
            let k = k.strip_suffix(".app").unwrap_or(&k);
            k == "support" || k == "support join" || rules::is_app_program(k)
        })
}

/// Whether one of the app's names or its bundle id is a protected program, compared as the rules compare names (and in
/// NFC, and with or without .app).
pub fn is_protected(id: &str, names: &[String], protected: &[String]) -> bool {
    let key = |n: &str| {
        let k = rules::program_key(&rules::nfc(n));
        k.strip_suffix(".app").map(str::to_string).unwrap_or(k)
    };
    let mine: Vec<String> = names.iter().map(|n| key(n)).chain([key(id)]).collect();
    protected.iter().any(|p| mine.contains(&key(p)))
}

/// Why an app may not go to `/Applications/<name>`, or None. `new` is the app being installed, `old` the app already
/// there (None when nothing is). Never over Support or the join app, a protected program, or one of Apple's apps.
pub fn destination_problem(name: &str, new: &AppInfo, old: Option<&AppInfo>, protected: &[String]) -> Option<String> {
    let mut names = new.names.clone();
    names.push(name.to_string());
    if is_support(&new.id, &names) || old.is_some_and(|o| is_support(&o.id, &o.names)) {
        return Some(rules::err("protected_program", &format!("{name} is, or would replace, the Support app, which is never installed over")));
    }
    if is_protected(&new.id, &names, protected) || old.is_some_and(|o| is_protected(&o.id, &o.names, protected)) {
        return Some(rules::err("protected_program", &format!("{name} is, or would replace, a program the team's rules protect")));
    }
    if old.is_some_and(|o| o.id.to_ascii_lowercase().starts_with("com.apple.")) {
        return Some(rules::err("protected_program", &format!("{name} would replace one of Apple's own apps, which are part of macOS")));
    }
    None
}

/// A name an app may have in /Applications: ends in .app, no slash, not hidden, at most 255 bytes.
fn good_app_name(name: &str) -> bool {
    is_app_name(name) && !name.contains('/') && !name.starts_with('.') && name.len() <= 255 && !name.contains('\0')
}

/// Swaps two paths in one step, so each holds what the other held. Neither is followed if it is a link.
pub fn swap(a: &Path, b: &Path) -> io::Result<()> {
    let (ca, cb) = (CString::new(a.as_os_str().as_bytes())?, CString::new(b.as_os_str().as_bytes())?);
    #[cfg(target_os = "macos")]
    // SAFETY: two valid C strings.
    let r = unsafe { libc::renamex_np(ca.as_ptr(), cb.as_ptr(), libc::RENAME_SWAP) };
    #[cfg(target_os = "linux")]
    // SAFETY: two valid C strings, relative to the working folder only when not absolute (they always are).
    let r = unsafe { libc::renameat2(libc::AT_FDCWD, ca.as_ptr(), libc::AT_FDCWD, cb.as_ptr(), libc::RENAME_EXCHANGE) };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let r = {
        let _ = (&ca, &cb);
        return Err(io::Error::from(io::ErrorKind::Unsupported));
    };
    if r == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Moves `from` to `to` only if nothing is at `to`, in one step.
pub fn move_new(from: &Path, to: &Path) -> io::Result<()> {
    let (ca, cb) = (CString::new(from.as_os_str().as_bytes())?, CString::new(to.as_os_str().as_bytes())?);
    #[cfg(target_os = "macos")]
    // SAFETY: two valid C strings.
    let r = unsafe { libc::renamex_np(ca.as_ptr(), cb.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    // SAFETY: two valid C strings.
    let r = unsafe { libc::renameat2(libc::AT_FDCWD, ca.as_ptr(), libc::AT_FDCWD, cb.as_ptr(), libc::RENAME_NOREPLACE) };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let r = {
        let _ = (&ca, &cb);
        return Err(io::Error::from(io::ErrorKind::Unsupported));
    };
    if r == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Installs one app folder (in a mounted image or an expanded zip, both inside the stage).
fn install_app(src: &Path, name: &str, stage: &Stage, req: &InstallRequest, env: &Env, deadline: Instant) -> Result<Value, String> {
    if !good_app_name(name) {
        return Err(format!("{name} is not a name an app can have in Applications"));
    }
    if let Some(problem) = bundle_problem(src) {
        return Err(problem);
    }
    // The copy that is checked is the copy that is moved: in the stage, where only root can change it.
    let staged = stage.sub("app")?.join(name);
    env.tools.copy(src, &staged, left(deadline, env.stop)?, env.stop)?;
    if let Some(problem) = bundle_problem(&staged) {
        return Err(problem);
    }
    make_roots(&staged)?;
    let new = programs::app_info(&staged).ok_or_else(|| format!("{name} has no bundle id in its Info.plist, so it is not installed"))?;
    let dest = env.apps_dir.join(name);
    let before = match fs::symlink_metadata(&dest) {
        Ok(m) if m.file_type().is_dir() => Some(m),
        Ok(_) => return Err(format!("{} is there already and is not an app folder; install_program does not replace it", dest.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{}: {e}", dest.display())),
    };
    let old = before.as_ref().and_then(|_| programs::app_info(&dest));
    if let Some(problem) = destination_problem(name, &new, old.as_ref(), &req.protected_programs) {
        return Err(problem);
    }
    gatekeeper(env, &staged, Assess::Execute, name)?;
    left(deadline, env.stop)?;
    let moved = |e: io::Error| match e.raw_os_error() {
        Some(libc::EXDEV) => {
            format!("{} is on another disk than Support's data folder; the app cannot be moved there in one step", env.apps_dir.display())
        }
        Some(libc::EPERM) => format!(
            "macOS did not let Support put the app in {} ({e}); allow Support under App Management in System Settings, Privacy & Security",
            env.apps_dir.display()
        ),
        _ => format!("could not move {name} into {}: {e}", env.apps_dir.display()),
    };
    match before {
        Some(b) => {
            swap(&staged, &dest).map_err(moved)?;
            // What came out must be the app that was checked. If someone put another one there meanwhile, it goes back.
            let out = fs::symlink_metadata(&staged).ok();
            if out.as_ref().map(|m| (m.dev(), m.ino())) != Some((b.dev(), b.ino())) {
                let _ = swap(&staged, &dest);
                return Err(format!("{} changed while it was being replaced; nothing was installed. Try again", dest.display()));
            }
            // The old copy is in the stage now and goes with it.
        }
        None => move_new(&staged, &dest).map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                format!("{} appeared while {name} was being installed; nothing was installed. Try again", dest.display())
            } else {
                moved(e)
            }
        })?,
    }
    let version = if new.version.is_empty() { String::new() } else { format!(" {}", new.version) };
    let replaced = if old.is_some() { ", in place of the older copy" } else { "" };
    Ok(json!({ "exit_code": 0, "detail": format!("installed {name}{version} ({}) in {}{replaced}", new.id, env.apps_dir.display()) }))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    pub fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("support-mac-install-{name}-{}", std::process::id()));
        remove_tree(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    /// A tree of files for a fake disk image or zip: a path and what it is.
    #[derive(Clone)]
    pub enum Node {
        File(&'static str),
        Link(&'static str),
    }

    pub fn build(root: &Path, nodes: &[(&str, Node)]) {
        fs::create_dir_all(root).unwrap();
        for (rel, node) in nodes {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            match node {
                Node::File(text) => fs::write(&p, text).unwrap(),
                Node::Link(t) => std::os::unix::fs::symlink(t, &p).unwrap(),
            }
        }
    }

    pub fn plist(id: &str, name: &str) -> String {
        format!(
            "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{id}</string><key>CFBundleName</key><string>{name}</string><key>CFBundleExecutable</key><string>{name}</string><key>CFBundleShortVersionString</key><string>1.2</string></dict></plist>"
        )
    }

    /// An app folder at `root/<name>.app` with this bundle id.
    pub fn app(root: &Path, name: &str, id: &str) {
        let c = root.join(format!("{name}.app/Contents"));
        fs::create_dir_all(c.join("MacOS")).unwrap();
        fs::write(c.join("Info.plist"), plist(id, name)).unwrap();
        fs::write(c.join("MacOS").join(name), "#!/bin/sh\n").unwrap();
    }

    /// Copies a folder, links kept as links (what ditto does).
    pub fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
        let m = fs::symlink_metadata(from)?;
        if m.file_type().is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(from)?, to)
        } else if m.is_dir() {
            fs::create_dir(to)?;
            for e in fs::read_dir(from)?.flatten() {
                copy_tree(&e.path(), &to.join(e.file_name()))?;
            }
            fs::set_permissions(to, m.permissions())
        } else {
            fs::copy(from, to).map(|_| ())
        }
    }

    /// Tools that do on Linux what the Mac's would: a disk image is a folder the test filled (by the installer's file
    /// name), attached by copying it into the mount folder; a zip likewise. Gatekeeper says no to names in `reject`.
    #[derive(Default)]
    pub struct FakeTools {
        pub images: Mutex<HashMap<String, PathBuf>>,
        pub reject: Mutex<Vec<String>>,
        pub license: Mutex<bool>,
        pub log: Mutex<Vec<String>>,
        pub package_exit: Mutex<i32>,
        pub receipts: Mutex<HashMap<String, Receipt>>,
        /// The contents of the last copy the stage made, by size: what the install read.
        pub staged_bytes: Mutex<Vec<u8>>,
        /// Set while the receipts are read: a session that stops in the middle of an uninstall.
        pub stop_on_receipts: Mutex<Option<std::sync::Arc<Stop>>>,
    }

    impl FakeTools {
        fn say(&self, line: String) {
            self.log.lock().unwrap().push(line);
        }
        /// The folder a fake image or zip stands for: the key its bytes are, or the longest key they hold (a zip's comment).
        fn content_of(&self, file: &Path) -> PathBuf {
            let bytes = fs::read(file).unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes).into_owned();
            *self.staged_bytes.lock().unwrap() = bytes;
            let images = self.images.lock().unwrap();
            images
                .get(text.as_str())
                .or_else(|| images.iter().filter(|(k, _)| text.contains(k.as_str())).max_by_key(|(k, _)| k.len()).map(|(_, v)| v))
                .cloned()
                .unwrap_or_else(|| PathBuf::from("/nonexistent"))
        }
    }

    impl Tools for FakeTools {
        fn assess(&self, path: &Path, kind: Assess) -> Result<(), String> {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            self.say(format!("assess {kind:?} {name}"));
            if self.reject.lock().unwrap().iter().any(|r| name.contains(r.as_str()) || fs::read_to_string(path).is_ok_and(|t| t.contains(r.as_str())))
            {
                return Err(format!("{}: rejected\nsource=no usable signature", path.display()));
            }
            Ok(())
        }
        fn install_package(&self, pkg: &Path, _: Duration, _: &Stop) -> Result<RunOutput, String> {
            self.say(format!("installer {}", pkg.file_name().unwrap().to_string_lossy()));
            let code = *self.package_exit.lock().unwrap();
            Ok(RunOutput { exit_code: Some(code), stderr: if code == 0 { vec![] } else { b"installer: failed".to_vec() }, ..Default::default() })
        }
        fn needs_license(&self, image: &Path) -> Result<bool, String> {
            self.content_of(image);
            Ok(*self.license.lock().unwrap())
        }
        fn attach(&self, image: &Path, mount_root: &Path, _: Duration, _: &Stop) -> Result<Attached, String> {
            let src = self.content_of(image);
            let m = mount_root.join("vol-1");
            copy_tree(&src, &m).map_err(|e| e.to_string())?;
            self.say("attach".into());
            Ok(Attached { device: "/dev/disk9".into(), mounts: vec![m] })
        }
        fn detach(&self, what: &str) {
            self.say(format!("detach {}", if what.starts_with("/dev/") { what } else { "mount" }));
        }
        fn unzip(&self, zip: &Path, into: &Path, _: Duration, _: &Stop) -> Result<(), String> {
            let src = self.content_of(zip);
            for e in fs::read_dir(&src).map_err(|e| e.to_string())?.flatten() {
                copy_tree(&e.path(), &into.join(e.file_name())).map_err(|e| e.to_string())?;
            }
            self.say("unzip".into());
            Ok(())
        }
        fn copy(&self, from: &Path, to: &Path, _: Duration, _: &Stop) -> Result<(), String> {
            self.say(format!("ditto {}", from.file_name().unwrap().to_string_lossy()));
            copy_tree(from, to).map_err(|e| e.to_string())
        }
        fn receipts_owning(&self, paths: &[String]) -> Vec<String> {
            if let Some(stop) = &*self.stop_on_receipts.lock().unwrap() {
                stop.set();
            }
            let r = self.receipts.lock().unwrap();
            let mut ids: Vec<String> = r
                .iter()
                .filter(|(_, rc)| {
                    rc.files.iter().any(|f| paths.iter().any(|p| support_core::rules::path_inside(p, &format!("{}/{}/{f}", rc.volume, rc.location))))
                })
                .map(|(id, _)| id.clone())
                .collect();
            ids.sort();
            ids
        }
        fn receipt(&self, id: &str) -> Option<Receipt> {
            self.receipts.lock().unwrap().get(id).cloned()
        }
        fn forget(&self, id: &str) -> Result<(), String> {
            self.say(format!("forget {id}"));
            self.receipts.lock().unwrap().remove(id);
            Ok(())
        }
    }

    /// A test's world: a data folder, an Applications folder, a Downloads folder and fake tools.
    pub struct World {
        pub root: PathBuf,
        pub data: PathBuf,
        pub apps: PathBuf,
        pub downloads: PathBuf,
        pub tools: FakeTools,
        pub stop: std::sync::Arc<Stop>,
    }

    impl World {
        pub fn new(name: &str) -> World {
            let root = temp(name);
            let (data, apps, downloads) = (root.join("data"), root.join("Applications"), root.join("Downloads"));
            fs::create_dir_all(&apps).unwrap();
            fs::create_dir_all(&downloads).unwrap();
            World { root, data, apps, downloads, tools: FakeTools::default(), stop: Stop::new() }
        }
        pub fn env(&self) -> Env<'_> {
            Env { tools: &self.tools, data_dir: &self.data, apps_dir: &self.apps, stop: &self.stop }
        }
        /// A disk image or zip file in Downloads whose contents are `nodes`.
        pub fn image(&self, file: &str, nodes: &[(&str, Node)]) -> String {
            let content = self.root.join(format!("content-{file}"));
            build(&content, nodes);
            self.tools.images.lock().unwrap().insert(file.to_string(), content);
            let p = self.downloads.join(file);
            fs::write(&p, file).unwrap();
            p.to_string_lossy().into_owned()
        }
        pub fn install(&self, path: &str) -> Result<Value, String> {
            self.install_with(path, &[])
        }
        pub fn install_with(&self, path: &str, protected: &[&str]) -> Result<Value, String> {
            let req = InstallRequest {
                path: path.to_string(),
                timeout_s: 300,
                protected_programs: protected.iter().map(|s| s.to_string()).collect(),
                protected_folders: vec![
                    self.root.join("Protected").to_string_lossy().into_owned(),
                    "/Applications/Support.app".into(),
                    "/Library/Application Support/SupportMCP".into(),
                ],
            };
            install(&req, &self.env())
        }
        pub fn staging_is_empty(&self) -> bool {
            fs::read_dir(self.data.join(paths::STAGING_DIR)).map(|mut d| d.next().is_none()).unwrap_or(true)
        }
    }

    impl Drop for World {
        fn drop(&mut self) {
            remove_tree(&self.root);
        }
    }

    fn rect_app() -> Vec<(&'static str, Node)> {
        vec![
            ("Rectangle.app/Contents/Info.plist", Node::File(Box::leak(plist("com.knollsoft.Rectangle", "Rectangle").into_boxed_str()))),
            ("Rectangle.app/Contents/MacOS/Rectangle", Node::File("bin")),
            ("Rectangle.app/Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle", Node::File("lib")),
            ("Rectangle.app/Contents/Frameworks/Sparkle.framework/Versions/Current", Node::Link("B")),
            ("Rectangle.app/Contents/Frameworks/Sparkle.framework/Sparkle", Node::Link("Versions/Current/Sparkle")),
            ("Applications", Node::Link("/Applications")),
            (".background/bg.png", Node::File("png")),
        ]
    }

    #[test]
    fn a_disk_image_with_one_app_is_copied_into_applications_and_always_detached() {
        let w = World::new("dmg");
        let path = w.image("Rectangle0.84.dmg", &rect_app());
        let r = w.install(&path).unwrap();
        assert_eq!(r["exit_code"], 0);
        assert!(r["detail"].as_str().unwrap().contains("installed Rectangle.app 1.2 (com.knollsoft.Rectangle)"), "{r}");
        let installed = w.apps.join("Rectangle.app");
        assert!(installed.join("Contents/Info.plist").is_file());
        assert_eq!(fs::read_link(installed.join("Contents/Frameworks/Sparkle.framework/Versions/Current")).unwrap(), PathBuf::from("B"));
        let log = w.tools.log.lock().unwrap().clone();
        assert_eq!(log, vec!["attach", "ditto Rectangle.app", "assess Execute Rectangle.app", "detach /dev/disk9"], "{log:?}");
        assert!(w.staging_is_empty(), "the stage is gone");
        // Root only: the staging folder and the data folder.
        assert_eq!(fs::metadata(w.data.join(paths::STAGING_DIR)).unwrap().mode() & 0o777, 0o700);
    }

    #[test]
    fn an_older_copy_is_swapped_out_in_one_step_and_removed() {
        let w = World::new("swap");
        app(&w.apps, "Rectangle", "com.knollsoft.Rectangle");
        fs::write(w.apps.join("Rectangle.app/old-marker"), "old").unwrap();
        let path = w.image("R.dmg", &rect_app());
        let r = w.install(&path).unwrap();
        assert!(r["detail"].as_str().unwrap().ends_with("in place of the older copy"), "{r}");
        assert!(!w.apps.join("Rectangle.app/old-marker").exists());
        assert!(w.apps.join("Rectangle.app/Contents/Frameworks").is_dir());
        assert!(w.staging_is_empty(), "the old copy went with the stage");
    }

    #[test]
    fn a_disk_image_with_one_package_and_no_app_runs_the_package_after_its_own_gatekeeper_check() {
        let w = World::new("dmgpkg");
        let path = w.image("Tool.dmg", &[("Tool Installer.pkg", Node::File("pkg")), ("README.txt", Node::File("read me"))]);
        let r = w.install(&path).unwrap();
        assert_eq!(r, json!({"exit_code": 0, "detail": "installed the package Tool Installer.pkg on /"}));
        assert_eq!(
            *w.tools.log.lock().unwrap(),
            vec!["attach", "assess Install Tool Installer.pkg", "installer Tool Installer.pkg", "detach /dev/disk9"]
        );
        // A package Gatekeeper rejects is refused with its reason, and the image is still detached.
        let w = World::new("dmgpkg2");
        w.tools.reject.lock().unwrap().push("Bad".into());
        let path = w.image("Bad.dmg", &[("Bad.pkg", Node::File("pkg"))]);
        let e = w.install(&path).unwrap_err();
        assert_eq!(
            e,
            "Gatekeeper rejected Bad.pkg: Bad.pkg: rejected source=no usable signature. install_program installs only what Gatekeeper accepts"
        );
        assert!(w.tools.log.lock().unwrap().ends_with(&["detach /dev/disk9".to_string()]));
        assert!(!w.tools.log.lock().unwrap().iter().any(|l| l.starts_with("installer")));
    }

    #[test]
    fn a_package_is_checked_by_gatekeeper_then_run_from_the_root_only_copy() {
        let w = World::new("pkg");
        let p = w.downloads.join("Thing.pkg");
        fs::write(&p, "a package").unwrap();
        let r = w.install(p.to_str().unwrap()).unwrap();
        assert_eq!(r, json!({"exit_code": 0, "detail": "installed the package Thing.pkg on /"}));
        assert_eq!(*w.tools.log.lock().unwrap(), vec!["assess Install installer.pkg", "installer installer.pkg"]);
        *w.tools.package_exit.lock().unwrap() = 1;
        let r = w.install(p.to_str().unwrap()).unwrap();
        assert_eq!(r, json!({"exit_code": 1, "detail": "installer could not install the package Thing.pkg (exit code 1): installer: failed"}));
        // Unsigned: refused with Gatekeeper's reason, and installer never runs.
        let w = World::new("pkg2");
        w.tools.reject.lock().unwrap().push("unsigned".into());
        let p = w.downloads.join("Unsigned.pkg");
        fs::write(&p, "unsigned package").unwrap();
        let e = w.install(p.to_str().unwrap()).unwrap_err();
        assert!(e.starts_with("Gatekeeper rejected Unsigned.pkg: Unsigned.pkg: rejected"), "{e}");
        assert!(!w.tools.log.lock().unwrap().iter().any(|l| l.starts_with("installer")));
        assert!(w.staging_is_empty());
    }

    #[test]
    fn the_real_path_is_checked_again_and_a_link_never_leads_round_the_checks() {
        let w = World::new("links");
        fs::create_dir_all(w.root.join("Protected")).unwrap();
        fs::write(w.root.join("Protected/secret.pkg"), "pkg").unwrap();
        // A link in Downloads into a protected folder: the real path is what is judged.
        std::os::unix::fs::symlink(w.root.join("Protected/secret.pkg"), w.downloads.join("innocent.pkg")).unwrap();
        assert_eq!(
            w.install(w.downloads.join("innocent.pkg").to_str().unwrap()).unwrap_err(),
            "protected_folder: the team's rules protect this folder"
        );
        // A link named .pkg to a file that is not an installer.
        fs::write(w.downloads.join("notes.txt"), "x").unwrap();
        std::os::unix::fs::symlink(w.downloads.join("notes.txt"), w.downloads.join("fake.pkg")).unwrap();
        let e = w.install(w.downloads.join("fake.pkg").to_str().unwrap()).unwrap_err();
        assert!(e.ends_with(rules::MAC_INSTALLER_TYPES) && e.contains("leads to"), "{e}");
        // A link to a system folder's file.
        let e = w.install(&format!("{}/missing.pkg", w.downloads.display())).unwrap_err();
        assert!(e.starts_with("not_found: there is no installer at"), "{e}");
        // A hard link is refused.
        fs::write(w.downloads.join("a.pkg"), "pkg").unwrap();
        fs::hard_link(w.downloads.join("a.pkg"), w.downloads.join("b.pkg")).unwrap();
        assert!(w.install(w.downloads.join("b.pkg").to_str().unwrap()).unwrap_err().contains("second hard link"));
        // A folder named .pkg is not a flat package.
        fs::create_dir_all(w.downloads.join("Bundle.pkg")).unwrap();
        assert!(w.install(w.downloads.join("Bundle.pkg").to_str().unwrap()).unwrap_err().contains("not a regular file"));
        assert!(w.tools.log.lock().unwrap().is_empty(), "no tool ran");
    }

    #[test]
    fn the_one_app_rule_over_a_listing() {
        let e = |name: &str, kind: Kind| Entry { name: name.into(), kind };
        let ok = |list: Vec<Entry>, pk: bool| one_app(&list, pk, "disk image");
        assert_eq!(ok(vec![e("A.app", Kind::Dir), e("Applications", Kind::Link), e(".DS_Store", Kind::File)], true), Ok(Found::App("A.app".into())));
        assert_eq!(ok(vec![e("A.APP", Kind::Dir), e("__MACOSX", Kind::Dir)], false), Ok(Found::App("A.APP".into())));
        assert_eq!(ok(vec![e("Setup.pkg", Kind::File), e("Read Me.rtf", Kind::File)], true), Ok(Found::Package("Setup.pkg".into())));
        assert_eq!(
            ok(vec![e("A.app", Kind::Dir), e("B.app", Kind::Dir)], true),
            Err("the disk image holds 2 apps (A.app, B.app) at its top; install_program installs from it only when it holds exactly one app, or one package and no app".into())
        );
        assert_eq!(
            ok(vec![e("A.app", Kind::Link)], true),
            Err("A.app in the disk image is a link, not an app folder; install_program does not follow it".into())
        );
        assert_eq!(ok(vec![e("A.app", Kind::File)], true), Err("A.app in the disk image is not an app folder".into()));
        assert!(ok(vec![e("A.app", Kind::Dir), e("x.pkg", Kind::File)], true).unwrap_err().contains("holds 1 app and 1 package (A.app, x.pkg)"));
        assert!(ok(vec![e("x.pkg", Kind::File), e("y.mpkg", Kind::File)], true).unwrap_err().contains("holds 2 packages"));
        assert!(ok(vec![e("README", Kind::File)], true).unwrap_err().contains("holds no app at its top"));
        assert!(ok(vec![e("x.pkg", Kind::Link)], true).unwrap_err().contains("is a link, not a package"));
        // A zip never installs a package.
        assert_eq!(
            one_app(&[e("x.pkg", Kind::File)], false, "zip"),
            Err("the zip holds 1 packages (x.pkg) at its top; install_program installs from it only when it holds exactly one app".into())
        );
        assert!(one_app(&[e(".hidden.app", Kind::Dir)], true, "disk image").unwrap_err().contains("no app"));
    }

    #[test]
    fn the_negative_disk_images_are_refused_and_nothing_in_applications_changes() {
        let w = World::new("neg");
        app(&w.apps, "Support", paths::BUNDLE_ID);
        let before = fs::symlink_metadata(w.apps.join("Support.app/Contents/Info.plist")).unwrap().modified().unwrap();
        let two = w.image("two.dmg", &[("A.app/Contents/Info.plist", Node::File("x")), ("B.app/Contents/Info.plist", Node::File("x"))]);
        assert!(w.install(&two).unwrap_err().contains("holds 2 apps (A.app, B.app)"));
        let sup = w.image("sup.dmg", &[("Support.app/Contents/Info.plist", Node::File(Box::leak(plist("com.evil.x", "Support").into_boxed_str())))]);
        assert_eq!(
            w.install(&sup).unwrap_err(),
            "protected_program: Support.app is, or would replace, the Support app, which is never installed over"
        );
        let id = w.image("id.dmg", &[("Helper.app/Contents/Info.plist", Node::File(Box::leak(plist(paths::BUNDLE_ID, "Helper").into_boxed_str())))]);
        assert!(w.install(&id).unwrap_err().starts_with("protected_program: Helper.app is, or would replace, the Support app"));
        let join = w.image("join.dmg", &[("J.app/Contents/Info.plist", Node::File(Box::leak(plist(paths::JOIN_BUNDLE_ID, "J").into_boxed_str())))]);
        assert!(w.install(&join).unwrap_err().starts_with("protected_program:"));
        let link = w.image("link.dmg", &[("Evil.app", Node::Link("/Applications/Support.app"))]);
        assert!(w.install(&link).unwrap_err().contains("Evil.app in the disk image is a link"));
        let out = w.image(
            "out.dmg",
            &[
                ("Out.app/Contents/Info.plist", Node::File(Box::leak(plist("com.x.out", "Out").into_boxed_str()))),
                ("Out.app/Contents/Resources/escape", Node::Link("../../../../../../etc")),
            ],
        );
        assert!(w
            .install(&out)
            .unwrap_err()
            .contains("Out.app/Contents/Resources/escape is a link to ../../../../../../etc, which leads out of the app"));
        w.tools.reject.lock().unwrap().push("Signed".into());
        let unsigned = w.image("u.dmg", &[("Signed.app/Contents/Info.plist", Node::File(Box::leak(plist("com.x.u", "Signed").into_boxed_str())))]);
        assert!(w.install(&unsigned).unwrap_err().starts_with("Gatekeeper rejected Signed.app"));
        *w.tools.license.lock().unwrap() = true;
        let lic = w.image("lic.dmg", &rect_app());
        assert!(w.install(&lic).unwrap_err().contains("asks to accept a license"));
        *w.tools.license.lock().unwrap() = false;
        // Support.app is untouched, every image was detached, and no stage is left.
        assert_eq!(fs::symlink_metadata(w.apps.join("Support.app/Contents/Info.plist")).unwrap().modified().unwrap(), before);
        assert_eq!(fs::read_dir(&w.apps).unwrap().count(), 1);
        let log = w.tools.log.lock().unwrap();
        assert_eq!(log.iter().filter(|l| *l == "attach").count(), log.iter().filter(|l| *l == "detach /dev/disk9").count());
        assert!(w.staging_is_empty());
    }

    #[test]
    fn a_protected_program_or_one_of_apples_apps_is_never_installed_over() {
        let w = World::new("prot");
        let path = w.image("R.dmg", &rect_app());
        assert!(w.install_with(&path, &["Rectangle"]).unwrap_err().starts_with("protected_program:"));
        assert!(w.install_with(&path, &["com.knollsoft.rectangle"]).unwrap_err().starts_with("protected_program:"));
        assert!(w.install_with(&path, &["Rectangle.app"]).unwrap_err().starts_with("protected_program:"));
        // An app of another name that would replace a protected or an Apple app by its folder name.
        app(&w.apps, "Rectangle", "com.apple.Rectangle");
        assert_eq!(w.install(&path).unwrap_err(), "protected_program: Rectangle.app would replace one of Apple's own apps, which are part of macOS");
        let info = |id: &str, names: &[&str]| AppInfo { id: id.into(), version: String::new(), names: names.iter().map(|s| s.to_string()).collect() };
        let protected = vec!["Caf\u{e9}".to_string()];
        assert!(destination_problem("X.app", &info("x.y", &["Cafe\u{301}"]), None, &protected).is_some(), "NFD name against NFC rule");
        assert!(destination_problem("X.app", &info("x.y", &["X"]), Some(&info("z", &["Caf\u{e9}"])), &protected).is_some(), "the app it replaces");
        assert!(destination_problem("X.app", &info("x.y", &["X"]), None, &protected).is_none());
        assert!(destination_problem("Support Join.app", &info("x.y", &["Support Join"]), None, &[]).is_some());
        assert!(destination_problem("X.app", &info("io.github.sukardaddy.supportmcp.next", &["X"]), None, &[]).is_some());
        assert!(destination_problem("Supportive.app", &info("x.y", &["Supportive"]), None, &[]).is_none());
        assert!(w.tools.log.lock().unwrap().iter().all(|l| !l.starts_with("assess Execute")), "refused before Gatekeeper is asked");
    }

    #[test]
    fn links_inside_an_app_must_stay_inside_it_even_through_other_links() {
        let w = World::new("bundle");
        let a = w.root.join("A.app");
        build(
            &a,
            &[("Contents/Info.plist", Node::File("x")), ("Contents/Versions/B/lib", Node::File("x")), ("Contents/Versions/Current", Node::Link("B"))],
        );
        assert_eq!(bundle_problem(&a), None);
        for (link, target, out) in [
            ("Contents/lib", "Versions/Current/lib", false),
            ("Contents/x", "./Versions/../Info.plist", false),
            ("Contents/dangling", "Nope/none", false),
            ("Contents/abs", "/etc/passwd", true),
            ("Contents/up", "../../x", true),
            ("Contents/root", "..", false),
            ("self", ".", false),
            ("Contents/through", "../self/..", true),
            ("Contents/Versions/B/deep", "../../../../outside", true),
        ] {
            let b = w.root.join(format!("T{}.app", link.replace('/', "_")));
            copy_tree(&a, &b).unwrap();
            if link == "Contents/through" {
                std::os::unix::fs::symlink(".", b.join("self")).unwrap();
            }
            std::os::unix::fs::symlink(target, b.join(link)).unwrap();
            assert_eq!(bundle_problem(&b).is_some(), out, "{link} -> {target}: {:?}", bundle_problem(&b));
        }
        // A loop of links is refused, not followed for ever.
        let l = w.root.join("Loop.app");
        build(&l, &[("a", Node::Link("b")), ("b", Node::Link("a")), ("c", Node::Link("a/x"))]);
        assert!(bundle_problem(&l).is_some());
        // The app itself must be a real folder.
        std::os::unix::fs::symlink(&a, w.root.join("L.app")).unwrap();
        assert!(bundle_problem(&w.root.join("L.app")).unwrap().contains("not an app folder"));
    }

    #[test]
    fn a_staged_app_loses_write_for_others_and_its_setuid_bits() {
        let w = World::new("modes");
        let a = w.root.join("M.app");
        build(&a, &[("Contents/MacOS/m", Node::File("x")), ("Contents/link", Node::Link("MacOS/m"))]);
        fs::set_permissions(a.join("Contents/MacOS/m"), fs::Permissions::from_mode(0o6777)).unwrap();
        fs::set_permissions(a.join("Contents"), fs::Permissions::from_mode(0o777)).unwrap();
        make_roots(&a).unwrap();
        assert_eq!(fs::metadata(a.join("Contents/MacOS/m")).unwrap().mode() & 0o7777, 0o755);
        assert_eq!(fs::metadata(a.join("Contents")).unwrap().mode() & 0o7777, 0o755);
        assert!(fs::symlink_metadata(a.join("Contents/link")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn a_zip_with_one_app_is_installed_and_one_with_a_package_or_two_apps_is_not() {
        let w = World::new("zip");
        // The fake zip's bytes must still be a zip zipscan accepts: an empty one.
        let path = w.image(
            "Foo.zip",
            &[
                ("Foo.app/Contents/Info.plist", Node::File(Box::leak(plist("com.x.foo", "Foo").into_boxed_str()))),
                ("__MACOSX/._Foo.app", Node::File("x")),
            ],
        );
        fs::write(&path, zipscan::tests::zip(&[("Foo.app/", false), ("Foo.app/Contents/Info.plist", false)], "Foo.zip")).unwrap();
        let r = w.install(&path).unwrap();
        assert!(r["detail"].as_str().unwrap().starts_with("installed Foo.app 1.2 (com.x.foo)"), "{r}");
        let pk = w.image("Pk.zip", &[("x.pkg", Node::File("p"))]);
        fs::write(&pk, zipscan::tests::zip(&[("x.pkg", false)], "Pk.zip")).unwrap();
        assert!(w.install(&pk).unwrap_err().starts_with("the zip holds 1 packages"));
        // A zip that would write through a link of its own never reaches ditto.
        let slip = w.image("Slip.zip", &[]);
        fs::write(&slip, zipscan::tests::zip(&[("a", true), ("a/evil", false)], "Slip.zip")).unwrap();
        assert!(w.install(&slip).unwrap_err().starts_with("Slip.zip: a/evil is inside a, which is a link"));
        assert_eq!(w.tools.log.lock().unwrap().iter().filter(|l| *l == "unzip").count(), 2);
        assert!(w.staging_is_empty());
    }

    #[test]
    fn a_swap_and_a_move_never_follow_a_link_and_a_move_never_replaces() {
        let w = World::new("rename");
        let (a, b) = (w.root.join("a"), w.root.join("b"));
        fs::create_dir(&a).unwrap();
        fs::write(a.join("f"), "a").unwrap();
        std::os::unix::fs::symlink("/", &b).unwrap();
        swap(&a, &b).unwrap();
        assert!(fs::symlink_metadata(&a).unwrap().file_type().is_symlink(), "the link moved, it was not followed");
        assert_eq!(fs::read_to_string(b.join("f")).unwrap(), "a");
        let c = w.root.join("c");
        fs::create_dir(&c).unwrap();
        assert_eq!(move_new(&c, &b).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        move_new(&c, &w.root.join("d")).unwrap();
    }
}
