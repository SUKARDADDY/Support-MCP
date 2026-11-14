//! The service's saved state in root's data folder: `device.json` (the link, the key, the answers given at setup, the
//! rules, the session the person allowed) and `history.json` (the last 50 lines). The folder is root's, 0700, and each
//! file 0600, written to a temporary file in the same folder, flushed and renamed over the old one.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceState {
    pub origin: String,
    pub key: String,
    pub device_id: String,
    pub workspace: String,
    pub name: String,
    /// "ask" or "any".
    pub access: String,
    /// "full" or "limited". Only ever lowered after setup.
    pub control: String,
    /// The display state: active, pending, offline, removed, expired or update_needed.
    pub state: String,
    /// The six digits the owner reads to a technician, while pending.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_session: Option<String>,
    /// `{rules, rules_tag}` as the core saves them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Value>,
}

impl DeviceState {
    /// Removed and expired are final: the Mac no longer checks in and can only be uninstalled.
    pub fn finished(&self) -> bool {
        self.state == "removed" || self.state == "expired"
    }
}

/// The data folder: made 0700 if missing. An existing one must be a real folder (not a link) owned by `owner` with no
/// access for anyone else, or it is refused, so nobody can have planted it.
pub fn ensure_dir(dir: &Path, owner: u32) -> Result<(), String> {
    match fs::symlink_metadata(dir) {
        Ok(m) => {
            if !m.file_type().is_dir() {
                return Err(format!("{} is not a folder", dir.display()));
            }
            if m.uid() != owner {
                return Err(format!("{} belongs to uid {}, not {owner}", dir.display(), m.uid()));
            }
            if m.mode() & 0o077 != 0 {
                fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        Err(_) => {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
        }
    }
}

/// Writes `bytes` to `path` through a temporary file in the same folder (0600, made new, never followed), flushed to
/// disk and renamed over the old file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no folder")?;
    let tmp: PathBuf = dir.join(format!(".{}.{}.tmp", path.file_name().and_then(|n| n.to_str()).unwrap_or("file"), std::process::id()));
    let _ = fs::remove_file(&tmp);
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)
            .map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Reads a JSON file that must be a regular file (not a link).
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let m = fs::symlink_metadata(path).ok()?;
    if !m.file_type().is_file() || m.len() > 4 << 20 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

pub fn load(dir: &Path) -> Option<DeviceState> {
    let s: DeviceState = read_json(&dir.join(crate::paths::DEVICE_FILE))?;
    (!s.origin.is_empty() && !s.key.is_empty()).then_some(s)
}

pub fn save(dir: &Path, s: &DeviceState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(crate::paths::DEVICE_FILE), &bytes)
}

pub fn load_history(dir: &Path) -> Vec<String> {
    let mut h: Vec<String> = read_json(&dir.join(crate::paths::HISTORY_FILE)).unwrap_or_default();
    support_core::device::trim_history(&mut h);
    h
}

pub fn save_history(dir: &Path, h: &[String]) -> Result<(), String> {
    let bytes = serde_json::to_vec(h).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(crate::paths::HISTORY_FILE), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("support-mac-state-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn me() -> u32 {
        // SAFETY: getuid has no failure mode.
        unsafe { libc::getuid() }
    }

    #[test]
    fn device_json_round_trips_with_0600_and_the_folder_is_0700() {
        let dir = temp("rt");
        ensure_dir(&dir, me()).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        assert!(load(&dir).is_none());
        let s = DeviceState {
            origin: "https://r.example".into(),
            key: "smd1.k".into(),
            device_id: "d".into(),
            workspace: "default".into(),
            name: "Mac".into(),
            access: "ask".into(),
            control: "limited".into(),
            state: "pending".into(),
            confirm: Some("123456".into()),
            accepted_session: None,
            rules: Some(serde_json::json!({"rules":{},"rules_tag":"x"})),
        };
        save(&dir, &s).unwrap();
        let file = dir.join(crate::paths::DEVICE_FILE);
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
        assert_eq!(load(&dir), Some(s.clone()));
        // A second save replaces it, and leaves no temporary file.
        let mut t = s.clone();
        t.state = "active".into();
        t.confirm = None;
        save(&dir, &t).unwrap();
        assert_eq!(load(&dir).unwrap().state, "active");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_planted_or_open_folder_is_handled() {
        let dir = temp("open");
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
        ensure_dir(&dir, me()).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700, "tightened");
        assert!(ensure_dir(&dir, me() + 1).is_err(), "someone else's folder is refused");
        let link = temp("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(ensure_dir(&link, me()).is_err(), "a link is refused");
        fs::remove_file(&link).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_device_file_that_is_a_link_or_junk_is_not_read() {
        let dir = temp("junk");
        ensure_dir(&dir, me()).unwrap();
        fs::write(dir.join("elsewhere.json"), b"{\"origin\":\"https://x\",\"key\":\"k\"}").unwrap();
        std::os::unix::fs::symlink(dir.join("elsewhere.json"), dir.join(crate::paths::DEVICE_FILE)).unwrap();
        assert!(load(&dir).is_none());
        fs::remove_file(dir.join(crate::paths::DEVICE_FILE)).unwrap();
        fs::write(dir.join(crate::paths::DEVICE_FILE), b"not json").unwrap();
        assert!(load(&dir).is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn history_keeps_the_last_50() {
        let dir = temp("hist");
        ensure_dir(&dir, me()).unwrap();
        let lines: Vec<String> = (0..60).map(|i| format!("line {i}")).collect();
        save_history(&dir, &lines).unwrap();
        let back = load_history(&dir);
        assert_eq!(back.len(), 50);
        fs::remove_dir_all(&dir).unwrap();
    }
}
