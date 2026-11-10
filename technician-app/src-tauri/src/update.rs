// Silent updates. The app does not use Tauri's own updater (it needs a second signing key).
// Instead the project's release key, the one that signs the PC app's update note, signs a
// note for the technician installer, and the app:
//
//   * at start and every 6 hours asks GitHub for the latest release and looks for
//       support-technician-<V>-setup.note and .note.sig (and the installer .exe)
//   * checks the signature (ECDSA P-256, SHA-256, IEEE P1363 r||s) against the public key built
//     into the app (release-key.pub), then the note's header and values
//   * needs a newer version, downloads the installer, and checks its size and SHA-256
//     against the signed note before it keeps the file
//   * at the next start checks the signature and the file again, runs the installer silently
//     (/S /R /UPDATE) and exits so the installer can replace the app's files
//
// The note is five lines, as the PC app's is, under its own header (src/release.js):
//   support-mcp-technician-release 1 / version / sha256 / size / released
use crate::error::{CoreError, CoreResult, Msg};
use crate::store::now_ms;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const NOTE_HEADER: &str = "support-mcp-technician-release 1";
/// The project's public release key: 64 bytes X||Y in base64, the file the relay's tests hold
/// equal to the key built into the PC app.
pub const RELEASE_KEY: &str = include_str!("../../../release-key.pub");
/// Where the app looks for releases. A `test-release` build may name another repository
/// (SUPPORT_RELEASE_REPO at build time); no other build can.
pub const DEFAULT_REPO: &str = "SUKARDADDY/Support-MCP";
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
/// No installer is larger than this, whatever a note says.
pub const MAX_INSTALLER_BYTES: u64 = 100 * 1024 * 1024;
/// A staged installer is run at most this many times: an installer that starts and leaves the
/// old version in place must not be run at every start for ever.
pub const MAX_ATTEMPTS: u32 = 2;

#[cfg(feature = "test-release")]
pub fn release_repo() -> &'static str {
    option_env!("SUPPORT_RELEASE_REPO").unwrap_or(DEFAULT_REPO)
}

#[cfg(not(feature = "test-release"))]
pub fn release_repo() -> &'static str {
    DEFAULT_REPO
}

/// The key a build checks notes against: release-key.pub, unless a `test-release` build names
/// its own throwaway key (SUPPORT_RELEASE_KEY) so a test release can be signed without the
/// real one. Any other build fails to compile with either variable set (lib.rs).
#[cfg(feature = "test-release")]
pub fn release_key() -> &'static str {
    option_env!("SUPPORT_RELEASE_KEY").unwrap_or(RELEASE_KEY)
}

#[cfg(not(feature = "test-release"))]
pub fn release_key() -> &'static str {
    RELEASE_KEY
}

#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    pub version: String,
    pub sha256: String,
    pub size: u64,
    pub released: u64,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// A decimal with no sign and no leading zero, as the relay writes them.
fn decimal(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 16 || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// A release version: SemVer without a leading "v", at most 32 characters.
pub fn valid_version(v: &str) -> bool {
    parse_version(v).is_some() && v.len() <= 32
}

struct Parsed<'a> {
    core: [&'a str; 3],
    pre: Option<Vec<&'a str>>,
}

fn parse_version(v: &str) -> Option<Parsed<'_>> {
    let no_build = v.split('+').next()?;
    if v.matches('+').count() > 1 || (v.contains('+') && v.split_once('+')?.1.is_empty()) {
        return None;
    }
    let (main, pre) = match no_build.split_once('-') {
        Some((m, p)) if !p.is_empty() => (m, Some(p)),
        Some(_) => return None,
        None => (no_build, None),
    };
    let nums: Vec<&str> = main.split('.').collect();
    if nums.len() != 3 || nums.iter().any(|n| n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) || (n.len() > 1 && n.starts_with('0'))) {
        return None;
    }
    let pre = match pre {
        None => None,
        Some(p) => {
            let ids: Vec<&str> = p.split('.').collect();
            let ok = ids.iter().all(|id| {
                !id.is_empty()
                    && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    && !(id.bytes().all(|b| b.is_ascii_digit()) && id.len() > 1 && id.starts_with('0'))
            });
            if !ok {
                return None;
            }
            Some(ids)
        }
    };
    Some(Parsed { core: [nums[0], nums[1], nums[2]], pre })
}

/// SemVer precedence of two valid versions, build metadata ignored (src/release.js compareVersions).
pub fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering::*;
    let (pa, pb) = (parse_version(a)?, parse_version(b)?);
    let num = |x: &str, y: &str| x.len().cmp(&y.len()).then_with(|| x.cmp(y));
    for i in 0..3 {
        let c = num(pa.core[i], pb.core[i]);
        if c != Equal {
            return Some(c);
        }
    }
    match (&pa.pre, &pb.pre) {
        (None, None) => Some(Equal),
        (None, Some(_)) => Some(Greater),
        (Some(_), None) => Some(Less),
        (Some(x), Some(y)) => {
            let is_num = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
            for (p, q) in x.iter().zip(y.iter()) {
                let c = match (is_num(p), is_num(q)) {
                    (true, true) => num(p, q),
                    (true, false) => Less,
                    (false, true) => Greater,
                    (false, false) => p.cmp(q),
                };
                if c != Equal {
                    return Some(c);
                }
            }
            Some(x.len().cmp(&y.len()))
        }
    }
}

/// The note's values, or None for anything but the exact five lines under the technician header.
pub fn parse_note(text: &str) -> Option<Note> {
    if !text.ends_with('\n') || text.bytes().any(|b| !(0x20..=0x7e).contains(&b) && b != b'\n') {
        return None;
    }
    let lines: Vec<&str> = text[..text.len() - 1].split('\n').collect();
    if lines.len() != 5 || lines[0] != NOTE_HEADER {
        return None;
    }
    let value = |line: &str, name: &str| line.strip_prefix(&format!("{name} ")).map(str::to_string);
    let version = value(lines[1], "version")?;
    let sha256 = value(lines[2], "sha256")?;
    let size = decimal(&value(lines[3], "size")?)?;
    let released = decimal(&value(lines[4], "released")?)?;
    if !valid_version(&version) || !is_hex64(&sha256) {
        return None;
    }
    Some(Note { version, sha256, size, released })
}

/// The built-in key, or one given as 64 bytes X||Y in base64 (tests use their own).
pub fn load_key(b64: &str) -> CoreResult<VerifyingKey> {
    let xy = B64.decode(b64.trim()).map_err(|_| CoreError::other(Msg::ReleaseKeyBad))?;
    if xy.len() != 64 {
        return Err(CoreError::other(Msg::ReleaseKeyBad));
    }
    let mut sec1 = Vec::with_capacity(65);
    sec1.push(0x04);
    sec1.extend_from_slice(&xy);
    VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| CoreError::other(Msg::ReleaseKeyBad))
}

/// Does `signature_b64` (64 bytes r||s, base64) sign exactly `note` under `key`?
pub fn verify_signature(key: &VerifyingKey, note: &[u8], signature_b64: &str) -> bool {
    let Ok(raw) = B64.decode(signature_b64.trim()) else { return false };
    if raw.len() != 64 {
        return false;
    }
    let Ok(sig) = Signature::from_slice(&raw) else { return false };
    key.verify(note, &sig).is_ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---- state ---------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct UpdateStatus {
    pub current: String,
    pub available: Option<String>,
    /// idle, checking, downloading, ready or error.
    pub state: &'static str,
    pub checked_at: Option<u64>,
    pub message: Option<String>,
    /// The key of `message` when it is one of ours (error.rs, Msg), for the screens to translate.
    pub reason: Option<&'static str>,
}

#[derive(Serialize, Deserialize)]
struct Staged {
    version: String,
    attempts: u32,
}

/// What the installer is started with: silent (/S), start the app again when done (/R), and
/// /UPDATE, which is the one flag that puts Tauri's NSIS installer in update mode: it installs
/// over the old files without running the old uninstaller, and any uninstaller it does start
/// is told it is an update too. /S and /R alone do not set it. docs/technician-app.md.
pub const INSTALLER_ARGS: [&str; 3] = ["/S", "/R", "/UPDATE"];

/// Runs the installer. On Windows it starts the file with INSTALLER_ARGS, detached; the app then exits.
pub trait Installer: Send + Sync {
    fn run(&self, installer: &Path) -> CoreResult<()>;
}

pub struct SilentInstaller;

impl Installer for SilentInstaller {
    fn run(&self, installer: &Path) -> CoreResult<()> {
        run_silent(installer)
    }
}

#[cfg(windows)]
fn run_silent(installer: &Path) -> CoreResult<()> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    std::process::Command::new(installer)
        .args(INSTALLER_ARGS)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|_| CoreError::other(Msg::InstallerStart))
}

#[cfg(not(windows))]
fn run_silent(_installer: &Path) -> CoreResult<()> {
    // The product is Windows only. Nothing is run elsewhere.
    Err(CoreError::other(Msg::WindowsOnly))
}

pub struct UpdateConfig {
    pub api_base: String,
    pub repo: String,
    pub current: String,
    pub key: VerifyingKey,
    /// Where the staged installer and its note live: inside the app's local data folder, since
    /// the installer is large and only useful on this PC.
    pub dir: PathBuf,
    /// Tests only: allow http to a loopback address.
    pub allow_loopback: bool,
}

impl UpdateConfig {
    pub fn production(current: &str, dir: PathBuf) -> CoreResult<UpdateConfig> {
        Ok(UpdateConfig {
            api_base: "https://api.github.com".into(),
            repo: release_repo().into(),
            current: current.into(),
            key: load_key(release_key())?,
            dir,
            allow_loopback: false,
        })
    }
}

/// Where a download may go: https on GitHub's own hosts (the release page redirects to
/// objects.githubusercontent.com). Nothing else, and never plain http, outside tests.
pub fn host_allowed(url: &url::Url, allow_loopback: bool) -> bool {
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        "https" => host == "github.com" || host.ends_with(".github.com") || host == "githubusercontent.com" || host.ends_with(".githubusercontent.com"),
        "http" => allow_loopback && (host == "127.0.0.1" || host == "localhost"),
        _ => false,
    }
}

pub struct Updater {
    cfg: UpdateConfig,
    http: reqwest::Client,
    installer: Arc<dyn Installer>,
    status: Mutex<UpdateStatus>,
    busy: tokio::sync::Mutex<()>,
}

impl Updater {
    pub fn new(cfg: UpdateConfig, installer: Arc<dyn Installer>) -> Arc<Updater> {
        let allow = cfg.allow_loopback;
        let http = reqwest::Client::builder()
            .user_agent(format!("Support-technician-app/{}", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(900))
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() < 5 && host_allowed(attempt.url(), allow) { attempt.follow() } else { attempt.stop() }
            }))
            .build()
            .expect("the update client builds");
        let status = UpdateStatus { current: cfg.current.clone(), available: None, state: "idle", checked_at: None, message: None, reason: None };
        Arc::new(Updater { cfg, http, installer, status: Mutex::new(status), busy: tokio::sync::Mutex::new(()) })
    }

    pub fn status(&self) -> UpdateStatus {
        self.status.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn set(&self, f: impl FnOnce(&mut UpdateStatus)) {
        f(&mut self.status.lock().unwrap_or_else(|p| p.into_inner()));
    }

    fn staged_dir(&self) -> PathBuf {
        self.cfg.dir.join("update")
    }

    fn file(&self, name: &str) -> PathBuf {
        self.staged_dir().join(name)
    }

    fn clear_staged(&self) {
        let _ = std::fs::remove_dir_all(self.staged_dir());
    }

    async fn get_text(&self, url: &str, max: usize) -> CoreResult<String> {
        let parsed = url::Url::parse(url).map_err(|_| CoreError::other(Msg::ReleaseAddress))?;
        if !host_allowed(&parsed, self.cfg.allow_loopback) {
            return Err(CoreError::other(Msg::ReleaseHost));
        }
        let resp = self.http.get(url).send().await?;
        if !resp.status().is_success() {
            return Err(CoreError::Unavailable(Msg::GithubStatus));
        }
        let bytes = resp.bytes().await?;
        if bytes.len() > max {
            return Err(CoreError::other(Msg::ReleaseFileLarge));
        }
        String::from_utf8(bytes.to_vec()).map_err(|_| CoreError::other(Msg::ReleaseFileText))
    }

    /// Looks for a newer signed release and, if there is one, downloads and keeps its
    /// installer. The result is the status: ready, idle (nothing newer) or error.
    pub async fn check(&self) -> UpdateStatus {
        let _one = self.busy.lock().await;
        self.set(|s| {
            s.state = "checking";
            s.message = None;
            s.reason = None;
        });
        let outcome = self.check_inner().await;
        // A check that fails (GitHub down, a bad release page) does not undo an installer that is
        // already kept and verified: it is still going to be installed at the next start.
        let kept = if outcome.is_err() { self.kept_version() } else { None };
        self.set(|s| {
            s.checked_at = Some(now_ms());
            match outcome {
                Ok(Some(v)) => {
                    s.available = Some(v);
                    s.state = "ready";
                }
                Ok(None) => {
                    // A version kept from an earlier check is still ready.
                    s.state = if s.available.is_some() { "ready" } else { "idle" };
                }
                Err(_) if kept.is_some() => {
                    s.available = kept;
                    s.state = "ready";
                    s.message = None;
                    s.reason = None;
                }
                Err(e) => {
                    s.state = "error";
                    s.available = None;
                    s.message = Some(e.to_string());
                    s.reason = e.reason();
                }
            }
        });
        self.status()
    }

    async fn check_inner(&self) -> CoreResult<Option<String>> {
        let url = format!("{}/repos/{}/releases/latest", self.cfg.api_base, self.cfg.repo);
        let resp = self.http.get(&url).header("accept", "application/vnd.github+json").send().await?;
        let status = resp.status().as_u16();
        // No release yet.
        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(CoreError::Unavailable(Msg::GithubStatus));
        }
        let release: serde_json::Value = resp.json().await.map_err(|_| CoreError::other(Msg::ReleaseListUnclear))?;
        let assets: Vec<(String, String)> = release["assets"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| Some((x["name"].as_str()?.to_string(), x["browser_download_url"].as_str()?.to_string()))).collect())
            .unwrap_or_default();
        let find = |name: &str| assets.iter().find(|(n, _)| n == name).map(|(_, u)| u.clone());
        // The note names the version; its file name has to agree.
        let Some((note_name, note_url)) = assets.iter().find(|(n, _)| n.starts_with("support-technician-") && n.ends_with("-setup.note")).cloned() else {
            return Ok(None); // a release without a technician installer is no update
        };
        let name_version = note_name.trim_start_matches("support-technician-").trim_end_matches("-setup.note").to_string();
        let Some(sig_url) = find(&format!("support-technician-{name_version}-setup.note.sig")) else {
            return Ok(None);
        };
        let note_text = self.get_text(&note_url, 1024).await?;
        let sig_text = self.get_text(&sig_url, 1024).await?;
        // The signature first: nothing in the note is believed until it checks out.
        if !verify_signature(&self.cfg.key, note_text.as_bytes(), &sig_text) {
            return Err(CoreError::other(Msg::UpdateSignature));
        }
        let note = parse_note(&note_text).ok_or_else(|| CoreError::other(Msg::UpdateNoteForm))?;
        if note.version != name_version {
            return Err(CoreError::other(Msg::UpdateNoteName));
        }
        if note.size == 0 || note.size > MAX_INSTALLER_BYTES {
            return Err(CoreError::other(Msg::UpdateSize));
        }
        match compare_versions(&note.version, &self.cfg.current) {
            Some(std::cmp::Ordering::Greater) => {}
            Some(_) => return Ok(None),
            None => return Err(CoreError::other(Msg::UpdateVersion)),
        }
        // Already kept?
        if self.staged_ok(&note_text, &sig_text, &note) {
            return Ok(Some(note.version));
        }
        let exe_name = format!("support-technician-{}-setup.exe", note.version);
        let exe_url = find(&exe_name).ok_or_else(|| CoreError::other(Msg::UpdateNoInstaller))?;
        self.set(|s| {
            s.available = Some(note.version.clone());
            s.state = "downloading";
        });
        self.download(&exe_url, &note, &note_text, &sig_text).await?;
        Ok(Some(note.version))
    }

    // Is the kept installer the one this note describes?
    fn staged_ok(&self, note_text: &str, sig_text: &str, note: &Note) -> bool {
        let exe = self.file(&format!("support-technician-{}-setup.exe", note.version));
        std::fs::read_to_string(self.file("note")).map(|t| t == note_text).unwrap_or(false)
            && std::fs::read_to_string(self.file("note.sig")).map(|t| t.trim() == sig_text.trim()).unwrap_or(false)
            && file_matches(&exe, note)
    }

    async fn download(&self, url: &str, note: &Note, note_text: &str, sig_text: &str) -> CoreResult<()> {
        let parsed = url::Url::parse(url).map_err(|_| CoreError::other(Msg::ReleaseAddress))?;
        if !host_allowed(&parsed, self.cfg.allow_loopback) {
            return Err(CoreError::other(Msg::ReleaseHost));
        }
        self.clear_staged();
        std::fs::create_dir_all(self.staged_dir())?;
        let part = self.file("installer.part");
        let mut resp = self.http.get(url).send().await?;
        if !resp.status().is_success() {
            self.clear_staged();
            return Err(CoreError::Unavailable(Msg::GithubStatus));
        }
        if let Some(len) = resp.content_length() {
            if len != note.size {
                self.clear_staged();
                return Err(CoreError::other(Msg::InstallerSize));
            }
        }
        let mut out = std::fs::File::create(&part)?;
        let mut hasher = Sha256::new();
        let mut total: u64 = 0;
        use std::io::Write;
        while let Some(chunk) = resp.chunk().await? {
            total += chunk.len() as u64;
            if total > note.size {
                drop(out);
                self.clear_staged();
                return Err(CoreError::other(Msg::InstallerBigger));
            }
            hasher.update(&chunk);
            out.write_all(&chunk)?;
        }
        out.flush()?;
        drop(out);
        if total != note.size {
            self.clear_staged();
            return Err(CoreError::other(Msg::InstallerSize));
        }
        if hex(&hasher.finalize()) != note.sha256 {
            self.clear_staged();
            return Err(CoreError::other(Msg::InstallerHash));
        }
        std::fs::write(self.file("note"), note_text)?;
        std::fs::write(self.file("note.sig"), sig_text.trim())?;
        std::fs::write(self.file("staged.json"), serde_json::to_vec(&Staged { version: note.version.clone(), attempts: 0 })?)?;
        std::fs::rename(&part, self.file(&format!("support-technician-{}-setup.exe", note.version)))?;
        Ok(())
    }

    // The kept note, signature and installer, checked again: signed by our key, the version the
    // kept record names, newer than this app, and the installer the note describes.
    fn verify_kept(&self, staged: &Staged) -> Option<Note> {
        let exe = self.file(&format!("support-technician-{}-setup.exe", staged.version));
        let note_text = std::fs::read_to_string(self.file("note")).ok()?;
        let sig_text = std::fs::read_to_string(self.file("note.sig")).ok()?;
        if !verify_signature(&self.cfg.key, note_text.as_bytes(), &sig_text) {
            return None;
        }
        let note = parse_note(&note_text)?;
        if note.version != staged.version || compare_versions(&note.version, &self.cfg.current) != Some(std::cmp::Ordering::Greater) {
            return None;
        }
        file_matches(&exe, &note).then_some(note)
    }

    /// The version of the installer kept from an earlier check, if it still verifies. Changes nothing.
    fn kept_version(&self) -> Option<String> {
        let staged: Staged = serde_json::from_slice(&std::fs::read(self.file("staged.json")).ok()?).ok()?;
        self.verify_kept(&staged).map(|n| n.version)
    }

    /// At start: if a verified installer was kept and is newer than this app, run it silently.
    /// Returns true when it was started, so the caller exits and lets it replace the files.
    /// Anything wrong with the kept files (signature, size, hash, an older version) deletes
    /// them and the app starts as it is.
    pub fn apply_staged(&self) -> bool {
        let Ok(staged_raw) = std::fs::read(self.file("staged.json")) else { return false };
        let Ok(mut staged) = serde_json::from_slice::<Staged>(&staged_raw) else {
            self.clear_staged();
            return false;
        };
        let exe = self.file(&format!("support-technician-{}-setup.exe", staged.version));
        let verified = self.verify_kept(&staged);
        if verified.is_none() {
            self.clear_staged();
            return false;
        }
        if staged.attempts >= MAX_ATTEMPTS {
            self.clear_staged();
            return false;
        }
        staged.attempts += 1;
        if let Ok(bytes) = serde_json::to_vec(&staged) {
            let _ = std::fs::write(self.file("staged.json"), bytes);
        }
        match self.installer.run(&exe) {
            Ok(()) => true,
            Err(_) => false,
        }
    }
}

fn file_matches(path: &Path, note: &Note) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if meta.len() != note.size {
        return false;
    }
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    use std::io::Read;
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(_) => return false,
        }
    }
    hex(&hasher.finalize()) == note.sha256
}

/// Checks at start and every 6 hours, for as long as the app runs.
pub async fn run_update_loop(updater: Arc<Updater>) {
    loop {
        updater.check().await;
        tokio::time::sleep(CHECK_EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::*;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::SigningKey;
    use rand::RngCore;
    use std::cmp::Ordering::*;
    use std::collections::HashMap;

    const VECTOR: &str = include_str!("testdata/technician-note-vector.json");

    // A throwaway key made at run time, as the relay's tests do. None is kept.
    struct Keys {
        signing: SigningKey,
        xy: String,
    }

    fn keys() -> Keys {
        loop {
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            if let Ok(signing) = SigningKey::from_slice(&bytes) {
                let point = signing.verifying_key().to_encoded_point(false);
                let xy = B64.encode(&point.as_bytes()[1..]);
                return Keys { signing, xy };
            }
        }
    }

    fn sign(k: &Keys, note: &str) -> String {
        let sig: Signature = k.signing.sign(note.as_bytes());
        B64.encode(sig.to_bytes())
    }

    fn note_for(version: &str, exe: &[u8]) -> String {
        format!("{NOTE_HEADER}\nversion {version}\nsha256 {}\nsize {}\nreleased 1794000000\n", hex(&Sha256::digest(exe)), exe.len())
    }

    #[test]
    fn the_built_in_key_is_the_projects_release_key() {
        let key = load_key(RELEASE_KEY).expect("release-key.pub is a valid P-256 key");
        let _ = key;
        let root = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../release-key.pub")).unwrap();
        assert_eq!(RELEASE_KEY, root);
        assert!(load_key("not base64!").is_err());
        assert!(load_key(&B64.encode([1u8; 63])).is_err());
        assert!(load_key(&B64.encode([1u8; 64])).is_err(), "64 bytes that are not a point");
    }

    #[cfg(not(feature = "test-release"))]
    #[test]
    fn a_shipping_build_always_uses_the_built_in_key_and_repository() {
        assert_eq!(release_key(), RELEASE_KEY);
        assert_eq!(release_repo(), DEFAULT_REPO);
    }

    #[test]
    fn the_release_repo_is_the_projects_github_repository() {
        let pkg: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json")).unwrap()).unwrap();
        let url = pkg["repository"]["url"].as_str().unwrap();
        assert_eq!(format!("https://github.com/{DEFAULT_REPO}.git"), url);
    }

    #[test]
    fn a_signature_made_by_node_verifies_and_a_pc_note_does_not_pass_as_a_technician_note() {
        let v: serde_json::Value = serde_json::from_str(VECTOR).unwrap();
        let key = load_key(v["public_key_xy_b64"].as_str().unwrap()).unwrap();
        let note = v["note"].as_str().unwrap();
        assert!(verify_signature(&key, note.as_bytes(), v["signature_p1363_b64"].as_str().unwrap()), "IEEE P1363 from node:crypto");
        assert!(!verify_signature(&key, note.as_bytes(), v["signature_der_b64"].as_str().unwrap()), "a DER signature is not what the release tooling makes");
        assert_eq!(parse_note(note).unwrap().version, "0.8.0");
        // The PC note is signed correctly under the same key, yet it is no technician note.
        let pc = v["pc_note"].as_str().unwrap();
        assert!(verify_signature(&key, pc.as_bytes(), v["pc_note_signature_b64"].as_str().unwrap()));
        assert_eq!(parse_note(pc), None);
        // And a PC signature does not cover the technician note.
        assert!(!verify_signature(&key, note.as_bytes(), v["pc_note_signature_b64"].as_str().unwrap()));
    }

    #[test]
    fn signatures_fail_for_a_wrong_key_a_changed_note_and_a_bad_encoding() {
        let (a, b) = (keys(), keys());
        let note = note_for("0.8.0", b"x");
        let sig = sign(&a, &note);
        assert!(verify_signature(&load_key(&a.xy).unwrap(), note.as_bytes(), &sig));
        assert!(!verify_signature(&load_key(&b.xy).unwrap(), note.as_bytes(), &sig), "wrong key");
        assert!(!verify_signature(&load_key(&a.xy).unwrap(), note.replace("0.8.0", "0.9.0").as_bytes(), &sig), "changed note");
        for bad in ["", "not base64!", &B64.encode([0u8; 63]), &B64.encode([0u8; 64]), &B64.encode([0u8; 70])] {
            assert!(!verify_signature(&load_key(&a.xy).unwrap(), note.as_bytes(), bad), "{bad}");
        }
    }

    #[test]
    fn the_note_is_exactly_five_lines_under_the_technician_header() {
        let sha = "ab".repeat(32);
        let good = format!("{NOTE_HEADER}\nversion 0.8.0\nsha256 {sha}\nsize 9000000\nreleased 1794000000\n");
        let n = parse_note(&good).unwrap();
        assert_eq!((n.version.as_str(), n.size, n.released), ("0.8.0", 9_000_000, 1_794_000_000));
        let bad = [
            good.trim_end().to_string(),
            good.replace('\n', "\r\n"),
            format!("{good}extra 1\n"),
            good.replace("support-mcp-technician-release 1", "support-mcp-release 1"),
            good.replace("technician-release 1", "technician-release 2"),
            good.replace(&sha, &sha.to_uppercase()),
            good.replace("size 9000000", "size 09000000"),
            good.replace("size 9000000", "size 0"),
            good.replace("version 0.8.0", "version 0.8"),
            good.replace("version 0.8.0\nsha256", "sha256").replace(&format!("sha256 {sha}\n"), &format!("sha256 {sha}\nversion 0.8.0\n")),
            good.replace("version 0.8.0", "version 0.8.0\u{e9}"),
        ];
        for text in &bad {
            assert_eq!(parse_note(text), None, "{text:?}");
        }
    }

    #[test]
    fn versions_compare_by_semver_as_the_relay_does() {
        let order = ["0.4.9", "0.5.0-alpha", "0.5.0-alpha.1", "0.5.0-alpha.beta", "0.5.0-beta.2", "0.5.0-beta.11", "0.5.0-rc.1", "0.5.0", "0.5.1", "0.6.0-rc.1", "0.6.0", "0.10.0", "1.0.0"];
        for (i, a) in order.iter().enumerate() {
            for (j, b) in order.iter().enumerate() {
                assert_eq!(compare_versions(a, b), Some(i.cmp(&j)), "{a} vs {b}");
            }
        }
        assert_eq!(compare_versions("0.5.0+build.1", "0.5.0+build.2"), Some(Equal));
        assert_eq!(compare_versions("10.0.0", "9.99.99"), Some(Greater));
        for bad in ["01.0.0", "0.05.0", "0.5.0-01", "0.5", "v0.5.0", "", "0.5.0+", "0.5.0-"] {
            assert!(!valid_version(bad), "{bad}");
            assert_eq!(compare_versions(bad, "0.5.0"), None);
        }
    }

    #[test]
    fn downloads_may_come_only_from_github_over_https() {
        let ok = |s: &str, lo: bool| host_allowed(&url::Url::parse(s).unwrap(), lo);
        assert!(ok("https://github.com/o/r/releases/download/v1/x.exe", false));
        assert!(ok("https://objects.githubusercontent.com/x", false));
        assert!(ok("https://api.github.com/repos/o/r/releases/latest", false));
        for bad in ["http://github.com/x", "https://github.com.evil.example/x", "https://evilgithub.com/x", "https://evil.example/github.com", "http://127.0.0.1:1/x", "file:///x", "ftp://github.com/x"] {
            assert!(!ok(bad, false), "{bad}");
        }
        assert!(ok("http://127.0.0.1:8080/x", true));
        assert!(!ok("http://evil.example/x", true));
    }

    // ---- a fake GitHub ----------------------------------------------------------------------
    struct Fixture {
        server: FakeServer,
        updater: Arc<Updater>,
        installer: Arc<Recorder>,
        dir: PathBuf,
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<PathBuf>>);
    impl Installer for Recorder {
        fn run(&self, installer: &Path) -> CoreResult<()> {
            self.0.lock().unwrap().push(installer.to_path_buf());
            Ok(())
        }
    }

    struct Files {
        note: String,
        sig: String,
        exe: Vec<u8>,
        // The names the release gives them (the version in the names, normally the note's).
        name_version: String,
        listed: Vec<&'static str>,
    }

    fn good_files(k: &Keys, version: &str) -> Files {
        let exe = format!("MZ installer for {version}").into_bytes();
        let note = note_for(version, &exe);
        let sig = sign(k, &note);
        Files { note, sig, exe, name_version: version.to_string(), listed: vec!["exe", "note", "sig"] }
    }

    async fn fixture(name: &str, k: &Keys, current: &str, files: Files) -> Fixture {
        let base = Arc::new(Mutex::new(String::new()));
        let served: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
        let v = files.name_version.clone();
        {
            let mut m = served.lock().unwrap();
            m.insert(format!("/dl/support-technician-{v}-setup.exe"), String::from_utf8(files.exe.clone()).unwrap());
            m.insert(format!("/dl/support-technician-{v}-setup.note"), files.note.clone());
            m.insert(format!("/dl/support-technician-{v}-setup.note.sig"), files.sig.clone());
        }
        let listed = files.listed.clone();
        let b2 = base.clone();
        let server = FakeServer::start(move |r| {
            let origin = b2.lock().unwrap().clone();
            if r.path() == "/repos/o/r/releases/latest" {
                let mut assets = vec![];
                for (kind, suffix) in [("exe", ".exe"), ("note", ".note"), ("sig", ".note.sig")] {
                    if listed.contains(&kind) {
                        let n = format!("support-technician-{v}-setup{suffix}");
                        assets.push(serde_json::json!({ "name": n, "browser_download_url": format!("{origin}/dl/{n}") }));
                    }
                }
                assets.push(serde_json::json!({ "name": "support-mcp-0.7.0.exe", "browser_download_url": format!("{origin}/dl/support-mcp-0.7.0.exe") }));
                return Resp::json(200, serde_json::json!({ "tag_name": format!("v{v}"), "assets": assets }));
            }
            match served.lock().unwrap().get(r.path()) {
                Some(body) => Resp::text(200, body),
                None => Resp::json(404, serde_json::json!({})),
            }
        })
        .await;
        *base.lock().unwrap() = server.url();
        let dir = temp_dir(name);
        let installer = Arc::new(Recorder::default());
        let cfg = UpdateConfig { api_base: server.url(), repo: "o/r".into(), current: current.into(), key: load_key(&k.xy).unwrap(), dir: dir.clone(), allow_loopback: true };
        let updater = Updater::new(cfg, installer.clone());
        Fixture { server, updater, installer, dir }
    }

    fn staged_files(f: &Fixture) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(f.dir.join("update")).map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
        v.sort();
        v
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_good_newer_release_is_downloaded_checked_and_kept() {
        let k = keys();
        let f = fixture("upd-good", &k, "0.7.0", good_files(&k, "0.8.0")).await;
        let st = f.updater.check().await;
        assert_eq!((st.state, st.available.as_deref()), ("ready", Some("0.8.0")), "{st:?}");
        assert!(st.checked_at.is_some() && st.message.is_none());
        assert_eq!(staged_files(&f), vec!["note", "note.sig", "staged.json", "support-technician-0.8.0-setup.exe"]);
        // Nothing of ours went to GitHub but plain GETs: no Origin, no credentials.
        for r in f.server.seen() {
            assert_eq!(r.method, "GET");
            assert!(!r.headers.contains_key("origin") && !r.headers.contains_key("authorization"));
        }
        // A second check does not download again.
        let downloads = f.server.count("/dl/support-technician-0.8.0-setup.exe");
        f.updater.check().await;
        assert_eq!(f.server.count("/dl/support-technician-0.8.0-setup.exe"), downloads);
        assert!(f.installer.0.lock().unwrap().is_empty(), "checking never runs an installer");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_check_keeps_an_installer_that_is_already_kept_and_verified() {
        let k = keys();
        let f = fixture("upd-keep-ready", &k, "0.7.0", good_files(&k, "0.8.0")).await;
        assert_eq!(f.updater.check().await.state, "ready");
        // The next check cannot reach GitHub. The kept installer is still going to be installed.
        let cfg = UpdateConfig { api_base: "http://127.0.0.1:9".into(), repo: "o/r".into(), current: "0.7.0".into(), key: load_key(&k.xy).unwrap(), dir: f.dir.clone(), allow_loopback: true };
        let later = Updater::new(cfg, Arc::new(Recorder::default()));
        let st = later.check().await;
        assert_eq!((st.state, st.available.as_deref(), st.message.as_deref()), ("ready", Some("0.8.0"), None), "{st:?}");
        assert!(st.checked_at.is_some());
        assert_eq!(staged_files(&f), vec!["note", "note.sig", "staged.json", "support-technician-0.8.0-setup.exe"], "the kept files stay");

        // A kept installer that no longer verifies is not kept in the status either.
        let exe = f.dir.join("update/support-technician-0.8.0-setup.exe");
        let mut bytes = std::fs::read(&exe).unwrap();
        bytes[0] ^= 1;
        std::fs::write(&exe, bytes).unwrap();
        let cfg = UpdateConfig { api_base: "http://127.0.0.1:9".into(), repo: "o/r".into(), current: "0.7.0".into(), key: load_key(&k.xy).unwrap(), dir: f.dir.clone(), allow_loopback: true };
        let st = Updater::new(cfg, Arc::new(Recorder::default())).check().await;
        assert_eq!((st.state, st.available.as_deref()), ("error", None), "{st:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_release_that_is_not_newer_is_no_update() {
        let k = keys();
        for (current, version) in [("0.8.0", "0.8.0"), ("0.9.0", "0.8.0"), ("0.8.0-rc.1", "0.7.9")] {
            let f = fixture("upd-old", &k, current, good_files(&k, version)).await;
            let st = f.updater.check().await;
            assert_eq!(st.state, "idle", "{current} vs {version}: {st:?}");
            assert_eq!(f.server.count(&format!("/dl/support-technician-{version}-setup.exe")), 0, "no download");
            assert!(staged_files(&f).is_empty());
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_release_without_a_technician_note_is_no_update() {
        let k = keys();
        for listed in [vec!["exe"], vec!["exe", "note"], vec![]] {
            let mut files = good_files(&k, "0.8.0");
            files.listed = listed.clone();
            let f = fixture("upd-none", &k, "0.7.0", files).await;
            let st = f.updater.check().await;
            assert_eq!((st.state, st.message), ("idle", None), "{listed:?}");
            assert_eq!(f.server.count("/dl/support-technician-0.8.0-setup.exe"), 0);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_pc_note_under_the_technician_names_is_refused() {
        let k = keys();
        let mut files = good_files(&k, "0.8.0");
        files.note = files.note.replace(NOTE_HEADER, "support-mcp-release 1");
        files.sig = sign(&k, &files.note); // correctly signed by the right key, but a PC note
        let f = fixture("upd-pc", &k, "0.7.0", files).await;
        let st = f.updater.check().await;
        assert_eq!(st.state, "error");
        assert_eq!(st.reason, Some("update_note_form"), "the screens translate it by this key");
        assert!(st.message.unwrap().contains("not in the expected form"));
        assert_eq!(f.server.count("/dl/support-technician-0.8.0-setup.exe"), 0);
        assert!(staged_files(&f).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_note_signed_by_another_key_or_changed_after_signing_is_refused() {
        let k = keys();
        let other = keys();
        let mut files = good_files(&k, "0.8.0");
        files.sig = sign(&other, &files.note);
        let f = fixture("upd-wrongkey", &k, "0.7.0", files).await;
        let st = f.updater.check().await;
        assert_eq!(st.state, "error");
        assert!(st.message.unwrap().contains("signature did not check out"));
        assert_eq!(f.server.count("/dl/support-technician-0.8.0-setup.exe"), 0);

        let mut files = good_files(&k, "0.8.0");
        files.note = files.note.replace("released 1794000000", "released 1794000001");
        let f = fixture("upd-changed", &k, "0.7.0", files).await;
        assert_eq!(f.updater.check().await.state, "error");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_installer_of_the_wrong_size_or_hash_is_thrown_away() {
        let k = keys();
        // The file served is longer than the signed note says.
        let mut files = good_files(&k, "0.8.0");
        files.exe.extend_from_slice(b" and more");
        let f = fixture("upd-size-long", &k, "0.7.0", files).await;
        let st = f.updater.check().await;
        assert_eq!(st.state, "error");
        assert!(st.message.unwrap().contains("size"), "too long");
        assert!(staged_files(&f).is_empty(), "nothing kept");

        // The file served is shorter than the signed note says.
        let mut files = good_files(&k, "0.8.0");
        files.exe.truncate(files.exe.len() - 4);
        let f = fixture("upd-size-short", &k, "0.7.0", files).await;
        let st = f.updater.check().await;
        assert_eq!(st.state, "error");
        assert!(st.message.unwrap().contains("size"), "too short");
        assert!(staged_files(&f).is_empty());

        // Same size, one byte changed.
        let mut files = good_files(&k, "0.8.0");
        files.exe[3] ^= 1;
        let f = fixture("upd-hash", &k, "0.7.0", files).await;
        let st = f.updater.check().await;
        assert_eq!(st.state, "error");
        assert!(st.message.unwrap().contains("SHA-256"), "wrong hash");
        assert!(staged_files(&f).is_empty(), "nothing kept");
        assert!(f.installer.0.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_note_that_names_another_version_than_its_file_is_refused() {
        let k = keys();
        let mut files = good_files(&k, "0.9.0"); // a signed 0.9.0 note ...
        files.name_version = "0.8.0".into(); // ... under 0.8.0's file names
        let f = fixture("upd-mismatch", &k, "0.7.0", files).await;
        let st = f.updater.check().await;
        assert_eq!(st.state, "error");
        assert!(st.message.unwrap().contains("different versions"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn at_the_next_start_a_kept_installer_is_checked_again_and_run_silently() {
        let k = keys();
        let f = fixture("upd-apply", &k, "0.7.0", good_files(&k, "0.8.0")).await;
        assert_eq!(f.updater.check().await.state, "ready");
        // A new run of the app: a fresh Updater over the same folder.
        let installer = Arc::new(Recorder::default());
        let cfg = UpdateConfig { api_base: f.server.url(), repo: "o/r".into(), current: "0.7.0".into(), key: load_key(&k.xy).unwrap(), dir: f.dir.clone(), allow_loopback: true };
        let next = Updater::new(cfg, installer.clone());
        assert!(next.apply_staged(), "the installer was started, so the app exits");
        let ran = installer.0.lock().unwrap().clone();
        assert_eq!(ran.len(), 1);
        assert!(ran[0].ends_with("support-technician-0.8.0-setup.exe"));
    }

    #[test]
    fn the_installer_is_started_in_update_mode() {
        // Tauri's installer enters update mode only on /UPDATE. In that mode it never runs the old
        // uninstaller, and the uninstall hook (windows/hooks.nsh) never clears the sign-in.
        assert_eq!(INSTALLER_ARGS, ["/S", "/R", "/UPDATE"]);
        assert!(include_str!("update.rs").contains(".args(INSTALLER_ARGS)"), "the Windows start uses the list");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_kept_installer_that_changed_is_not_run_and_is_deleted() {
        let k = keys();
        let f = fixture("upd-tamper", &k, "0.7.0", good_files(&k, "0.8.0")).await;
        assert_eq!(f.updater.check().await.state, "ready");
        let exe = f.dir.join("update/support-technician-0.8.0-setup.exe");
        let mut bytes = std::fs::read(&exe).unwrap();
        bytes[0] ^= 1;
        std::fs::write(&exe, bytes).unwrap();
        assert!(!f.updater.apply_staged());
        assert!(f.installer.0.lock().unwrap().is_empty(), "a changed installer is never run");
        assert!(staged_files(&f).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_kept_note_that_was_swapped_or_is_no_longer_newer_stops_the_update() {
        let k = keys();
        // The note replaced by one signed with another key.
        let f = fixture("upd-swap", &k, "0.7.0", good_files(&k, "0.8.0")).await;
        f.updater.check().await;
        let note = std::fs::read_to_string(f.dir.join("update/note")).unwrap();
        std::fs::write(f.dir.join("update/note.sig"), sign(&keys(), &note)).unwrap();
        assert!(!f.updater.apply_staged());
        assert!(f.installer.0.lock().unwrap().is_empty());
        // The app was updated some other way meanwhile: the kept 0.8.0 is not newer than 0.8.0.
        let g = fixture("upd-stale", &k, "0.8.0", good_files(&k, "0.8.0")).await;
        std::fs::create_dir_all(g.dir.join("update")).unwrap();
        let files = good_files(&k, "0.8.0");
        std::fs::write(g.dir.join("update/note"), &files.note).unwrap();
        std::fs::write(g.dir.join("update/note.sig"), &files.sig).unwrap();
        std::fs::write(g.dir.join("update/support-technician-0.8.0-setup.exe"), &files.exe).unwrap();
        std::fs::write(g.dir.join("update/staged.json"), r#"{"version":"0.8.0","attempts":0}"#).unwrap();
        assert!(!g.updater.apply_staged());
        assert!(g.installer.0.lock().unwrap().is_empty());
        assert!(staged_files(&g).is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_installer_that_keeps_failing_is_not_run_at_every_start() {
        let k = keys();
        let f = fixture("upd-attempts", &k, "0.7.0", good_files(&k, "0.8.0")).await;
        f.updater.check().await;
        assert!(f.updater.apply_staged());
        assert!(f.updater.apply_staged());
        assert!(!f.updater.apply_staged(), "a third start gives up");
        assert_eq!(f.installer.0.lock().unwrap().len(), MAX_ATTEMPTS as usize);
        assert!(staged_files(&f).is_empty());
    }

    #[test]
    fn nothing_kept_means_nothing_to_run() {
        let k = keys();
        let cfg = UpdateConfig { api_base: "http://127.0.0.1:1".into(), repo: "o/r".into(), current: "0.7.0".into(), key: load_key(&k.xy).unwrap(), dir: temp_dir("upd-empty"), allow_loopback: true };
        let installer = Arc::new(Recorder::default());
        assert!(!Updater::new(cfg, installer.clone()).apply_staged());
        assert!(installer.0.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_github_that_cannot_be_reached_is_an_error_to_show_not_a_crash() {
        let k = keys();
        let cfg = UpdateConfig { api_base: "http://127.0.0.1:9".into(), repo: "o/r".into(), current: "0.7.0".into(), key: load_key(&k.xy).unwrap(), dir: temp_dir("upd-down"), allow_loopback: true };
        let st = Updater::new(cfg, Arc::new(Recorder::default())).check().await;
        assert_eq!(st.state, "error");
        assert!(st.message.is_some());
    }

    #[test]
    fn the_check_runs_every_six_hours() {
        assert_eq!(CHECK_EVERY, Duration::from_secs(21600));
    }
}
