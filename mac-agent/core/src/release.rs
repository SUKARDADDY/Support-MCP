//! The Mac release note: parse it, check its signature against the project's release key, compare versions.
//!
//! The note is six lines under its own header, so a Windows or technician note never passes as a Mac note (the
//! signature covers the header). The relay passes the note and its signature on and never checks the signature. This
//! client does, against `release-key.pub`, which is built in with `include_str!`. The rules are those of
//! `parseMacNote` in src/release.js and `Updater.Check` in src/agent-app.cs.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;

pub const MAC_NOTE_HEADER: &str = "support-mcp-mac-release 1";
/// The project's release key: 64 bytes X||Y of a P-256 point, in base64 (the file at the repository root).
pub const RELEASE_KEY: &str = include_str!("../../../release-key.pub");
/// The largest package the note may name, and the largest note.
pub const PACKAGE_SIZE_MAX: u64 = 41_943_040;
pub const NOTE_MAX: usize = 1024;
const URL_MAX: usize = 300;
const VERSION_MAX: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MacNote {
    pub version: String,
    pub sha256: String,
    pub size: u64,
    pub released: u64,
    pub url: String,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A decimal with no sign and no leading zero, at most 16 digits (the relay's `^[1-9][0-9]{0,15}$`).
fn decimal(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 16 || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

struct Parsed<'a> {
    core: [&'a str; 3],
    pre: Option<Vec<&'a str>>,
}

fn all_idents(s: &str) -> bool {
    s.split('.').all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

fn parse_version(v: &str) -> Option<Parsed<'_>> {
    let (main, build) = match v.split_once('+') {
        Some((m, b)) => (m, Some(b)),
        None => (v, None),
    };
    if build.is_some_and(|b| !all_idents(b)) {
        return None;
    }
    let (core, pre) = match main.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (main, None),
    };
    let nums: Vec<&str> = core.split('.').collect();
    if nums.len() != 3 || nums.iter().any(|n| n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) || (n.len() > 1 && n.starts_with('0'))) {
        return None;
    }
    let pre = match pre {
        None => None,
        Some(p) => {
            if !all_idents(p) {
                return None;
            }
            let ids: Vec<&str> = p.split('.').collect();
            // A numeric identifier has no leading zero; 0a is a word, 01 is not allowed.
            if ids.iter().any(|id| id.bytes().all(|b| b.is_ascii_digit()) && id.len() > 1 && id.starts_with('0')) {
                return None;
            }
            Some(ids)
        }
    };
    Some(Parsed { core: [nums[0], nums[1], nums[2]], pre })
}

/// A release version: strict SemVer (the pattern of src/version.js), at most 32 characters.
pub fn valid_version(v: &str) -> bool {
    v.len() <= VERSION_MAX && parse_version(v).is_some()
}

/// SemVer precedence, build metadata ignored. None when either side is not a valid version.
pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let (pa, pb) = (parse_version(a)?, parse_version(b)?);
    // Digits without leading zeros: the longer is larger, equal lengths compare as text.
    let num = |x: &str, y: &str| x.len().cmp(&y.len()).then_with(|| x.cmp(y));
    for i in 0..3 {
        let c = num(pa.core[i], pb.core[i]);
        if c != Ordering::Equal {
            return Some(c);
        }
    }
    match (&pa.pre, &pb.pre) {
        (None, None) => Some(Ordering::Equal),
        (None, Some(_)) => Some(Ordering::Greater),
        (Some(_), None) => Some(Ordering::Less),
        (Some(x), Some(y)) => {
            let is_num = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
            for (p, q) in x.iter().zip(y.iter()) {
                let c = match (is_num(p), is_num(q)) {
                    (true, true) => num(p, q),
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    (false, false) => p.cmp(q),
                };
                if c != Ordering::Equal {
                    return Some(c);
                }
            }
            Some(x.len().cmp(&y.len()))
        }
    }
}

/// The note's values, or None for anything but the exact six lines under the Mac header.
pub fn parse_mac_note(text: &str) -> Option<MacNote> {
    if text.len() > NOTE_MAX || !text.ends_with('\n') || text.bytes().any(|b| !(0x20..=0x7e).contains(&b) && b != b'\n') {
        return None;
    }
    let lines: Vec<&str> = text[..text.len() - 1].split('\n').collect();
    if lines.len() != 6 || lines[0] != MAC_NOTE_HEADER {
        return None;
    }
    let value = |line: &str, name: &str| line.strip_prefix(name).and_then(|rest| rest.strip_prefix(' ')).map(str::to_string);
    let version = value(lines[1], "version")?;
    let sha256 = value(lines[2], "sha256")?;
    let size = decimal(&value(lines[3], "size")?)?;
    let released = decimal(&value(lines[4], "released")?)?;
    let url = value(lines[5], "url")?;
    if !valid_version(&version) || !is_hex64(&sha256) || size > PACKAGE_SIZE_MAX || !url_ok(&url) {
        return None;
    }
    Some(MacNote { version, sha256, size, released, url })
}

/// `https://github.com/` and a path with no `?`, `#`, white space or `..` part, at most 300 characters.
fn url_ok(url: &str) -> bool {
    url.len() <= URL_MAX
        && url.starts_with("https://github.com/")
        && url.bytes().all(|b| (0x21..=0x7e).contains(&b))
        && !url.contains(['?', '#'])
        && !url.split('/').any(|part| part == "..")
}

/// A key given as 64 bytes X||Y in base64, as `release-key.pub` holds it.
pub fn load_key(b64: &str) -> Result<VerifyingKey, String> {
    let xy = B64.decode(b64.trim()).map_err(|_| "the release key is not base64".to_string())?;
    if xy.len() != 64 {
        return Err("the release key must be 64 bytes".to_string());
    }
    let mut sec1 = Vec::with_capacity(65);
    sec1.push(0x04);
    sec1.extend_from_slice(&xy);
    VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| "the release key is not a P-256 point".to_string())
}

/// Whether `signature_b64` (64 bytes r||s, base64: the IEEE P1363 form, never DER) signs exactly `note` under `key`.
pub fn verify_signature(key: &VerifyingKey, note: &[u8], signature_b64: &str) -> bool {
    let Ok(raw) = B64.decode(signature_b64.trim()) else { return false };
    if raw.len() != 64 {
        return false;
    }
    let Ok(sig) = Signature::from_slice(&raw) else { return false };
    key.verify(note, &sig).is_ok()
}

/// The built-in key.
pub fn release_key() -> Result<VerifyingKey, String> {
    load_key(RELEASE_KEY)
}

#[derive(Debug, PartialEq, Eq)]
pub enum UpdateRefusal {
    NoRelease,
    BadSignature,
    BadNote,
    VersionMismatch,
    NotNewer,
    FailedBefore,
}

impl UpdateRefusal {
    pub fn as_str(&self) -> &'static str {
        match self {
            UpdateRefusal::NoRelease => "no release",
            UpdateRefusal::BadSignature => "bad signature",
            UpdateRefusal::BadNote => "bad note",
            UpdateRefusal::VersionMismatch => "version mismatch",
            UpdateRefusal::NotNewer => "not newer",
            UpdateRefusal::FailedBefore => "failed before",
        }
    }
}

/// The `update` object of a hello answer ({"version","note","signature"}) checked against `key`: the signature over
/// the note's exact bytes, the note's form, the outer version (when present) equal to the note's, a version newer
/// than `current` that has not failed its trial before. The relay's offer is never trusted for anything else.
pub fn check_update(update: &Value, current: &str, failed: &[String], key: &VerifyingKey) -> Result<MacNote, UpdateRefusal> {
    let (Some(note), Some(sig)) = (update.get("note").and_then(Value::as_str), update.get("signature").and_then(Value::as_str)) else {
        return Err(UpdateRefusal::NoRelease);
    };
    if !verify_signature(key, note.as_bytes(), sig) {
        return Err(UpdateRefusal::BadSignature);
    }
    let parsed = parse_mac_note(note).ok_or(UpdateRefusal::BadNote)?;
    if let Some(outer) = update.get("version") {
        if outer.as_str() != Some(parsed.version.as_str()) {
            return Err(UpdateRefusal::VersionMismatch);
        }
    }
    if compare_versions(&parsed.version, current) != Some(Ordering::Greater) {
        return Err(UpdateRefusal::NotNewer);
    }
    if failed.contains(&parsed.version) {
        return Err(UpdateRefusal::FailedBefore);
    }
    Ok(parsed)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether a downloaded package is the one the note names: its size and its SHA-256.
pub fn package_matches(bytes: &[u8], note: &MacNote) -> bool {
    bytes.len() as u64 == note.size && sha256_hex(bytes) == note.sha256
}

/// The host the package may come from: GitHub over https only. The note's url is already held to this.
pub fn download_allowed(url: &str) -> bool {
    url_ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::SigningKey;
    use rand::RngCore;
    use serde_json::json;

    const VECTORS: &str = include_str!("../tests/data/vectors.json");

    fn vectors() -> Value {
        serde_json::from_str(VECTORS).unwrap()
    }

    #[test]
    fn the_built_in_key_is_the_projects_release_key() {
        // include_str! reads the file at the repository root, so this is a check that the path still points at it.
        let on_disk = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../release-key.pub")).unwrap();
        assert_eq!(RELEASE_KEY, on_disk);
        assert!(release_key().is_ok(), "release-key.pub is a valid P-256 point");
        assert_eq!(B64.decode(RELEASE_KEY.trim()).unwrap().len(), 64);
        assert!(load_key("not base64!").is_err());
        assert!(load_key(&B64.encode([1u8; 63])).is_err());
        assert!(load_key(&B64.encode([1u8; 64])).is_err(), "64 bytes that are not a point");
    }

    fn vector_key() -> VerifyingKey {
        load_key(vectors()["public_key_xy_b64"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn the_relays_own_notes_parse_exactly_as_the_relay_parses_them() {
        let v = vectors();
        for (name, case) in v["notes"].as_object().unwrap() {
            let note = case["note"].as_str().unwrap();
            let relay_accepts = case["relay_accepts"].as_bool().unwrap();
            assert_eq!(parse_mac_note(note).is_some(), relay_accepts, "{name}");
        }
    }

    #[test]
    fn a_valid_mac_note_has_its_six_values() {
        let v = vectors();
        let n = parse_mac_note(v["notes"]["valid"]["note"].as_str().unwrap()).unwrap();
        assert_eq!(n.version, "1.2.3");
        assert_eq!(n.sha256, "ab".repeat(32));
        assert_eq!((n.size, n.released), (12_345_678, 1_794_000_000));
        assert_eq!(n.url, "https://github.com/SUKARDADDY/Support-MCP/releases/download/v1.2.3/Support-1.2.3.pkg");
        let pre = parse_mac_note(v["notes"]["prerelease"]["note"].as_str().unwrap()).unwrap();
        assert_eq!(pre.version, "2.0.0-rc.1");
        // The size limit is 40 MiB, inclusive.
        assert!(parse_mac_note(v["notes"]["size_at_40_mib"]["note"].as_str().unwrap()).is_some());
        assert!(parse_mac_note(v["notes"]["size_over_40_mib"]["note"].as_str().unwrap()).is_none());
    }

    #[test]
    fn a_note_made_by_node_verifies_and_every_tampered_form_fails() {
        let v = vectors();
        let key = vector_key();
        let valid = &v["notes"]["valid"];
        let note = valid["note"].as_str().unwrap();
        let sig = valid["signature"].as_str().unwrap();
        assert!(verify_signature(&key, note.as_bytes(), sig), "IEEE P1363 from node:crypto");
        // One changed character, a changed version, and a note signed for another text.
        for tampered in [
            note.replace("1.2.3", "1.2.4"),
            note.replace("12345678", "12345679"),
            note.replace("SUKARDADDY", "EVIL"),
            format!("{note} "),
            note.trim_end().to_string(),
        ] {
            assert!(!verify_signature(&key, tampered.as_bytes(), sig), "{tampered:?}");
        }
        // The signature of another note does not cover this one.
        assert!(!verify_signature(&key, note.as_bytes(), v["notes"]["prerelease"]["signature"].as_str().unwrap()));
        // Not 64 bytes, not base64, empty.
        for bad in ["", "not base64!", &B64.encode([0u8; 63]), &B64.encode([0u8; 64]), &B64.encode([0u8; 70])] {
            assert!(!verify_signature(&key, note.as_bytes(), bad), "{bad}");
        }
        // The project's own key does not accept a throwaway key's signature.
        assert!(!verify_signature(&release_key().unwrap(), note.as_bytes(), sig));
    }

    #[test]
    fn a_der_signature_is_not_accepted() {
        // The release tooling signs IEEE P1363 (r||s). A DER signature is 70 or so bytes and never verifies.
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let signing = SigningKey::from_slice(&bytes).unwrap();
        let sig: Signature = signing.sign(b"x");
        let key = *signing.verifying_key();
        assert!(verify_signature(&key, b"x", &B64.encode(sig.to_bytes())));
        assert!(!verify_signature(&key, b"x", &B64.encode(sig.to_der().as_bytes())));
    }

    #[test]
    fn a_note_for_another_product_does_not_pass_as_a_mac_note() {
        let v = vectors();
        for name in ["windows_header", "technician_header", "five_lines"] {
            let note = v["notes"][name]["note"].as_str().unwrap();
            assert_eq!(parse_mac_note(note), None, "{name}");
        }
        let key = vector_key();
        // Even correctly signed, a wrong-header note is refused as a bad note.
        let case = &v["notes"]["windows_header"];
        let update = json!({"note": case["note"], "signature": case["signature"]});
        assert_eq!(check_update(&update, "1.0.0", &[], &key), Err(UpdateRefusal::BadNote));
    }

    #[test]
    fn check_update_follows_the_windows_clients_rules() {
        let v = vectors();
        let key = vector_key();
        let good = &v["notes"]["valid"];
        let update = |outer: Option<&str>| {
            let mut u = json!({"note": good["note"], "signature": good["signature"]});
            if let Some(o) = outer {
                u["version"] = json!(o);
            }
            u
        };
        assert_eq!(check_update(&update(Some("1.2.3")), "1.0.0", &[], &key).unwrap().version, "1.2.3");
        assert_eq!(check_update(&update(None), "1.0.0", &[], &key).unwrap().version, "1.2.3", "the outer version is optional");
        assert_eq!(check_update(&update(Some("1.2.4")), "1.0.0", &[], &key), Err(UpdateRefusal::VersionMismatch));
        assert_eq!(check_update(&update(Some("1.2.3")), "1.2.3", &[], &key), Err(UpdateRefusal::NotNewer));
        assert_eq!(check_update(&update(Some("1.2.3")), "1.3.0", &[], &key), Err(UpdateRefusal::NotNewer));
        assert_eq!(check_update(&update(Some("1.2.3")), "not a version", &[], &key), Err(UpdateRefusal::NotNewer));
        assert_eq!(check_update(&update(Some("1.2.3")), "1.0.0", &["1.2.3".to_string()], &key), Err(UpdateRefusal::FailedBefore));
        assert_eq!(check_update(&json!({"note": good["note"]}), "1.0.0", &[], &key), Err(UpdateRefusal::NoRelease));
        assert_eq!(check_update(&json!({}), "1.0.0", &[], &key), Err(UpdateRefusal::NoRelease));
        let forged = json!({"note": good["note"], "signature": v["notes"]["prerelease"]["signature"]});
        assert_eq!(check_update(&forged, "1.0.0", &[], &key), Err(UpdateRefusal::BadSignature));
        // The built-in key refuses a note the throwaway key signed.
        assert_eq!(check_update(&update(None), "1.0.0", &[], &release_key().unwrap()), Err(UpdateRefusal::BadSignature));
    }

    #[test]
    fn a_package_is_the_one_the_note_names() {
        let bytes = b"pkg bytes";
        let note = MacNote {
            version: "1.0.1".into(),
            sha256: sha256_hex(bytes),
            size: bytes.len() as u64,
            released: 1,
            url: "https://github.com/a/b".into(),
        };
        assert!(package_matches(bytes, &note));
        assert!(!package_matches(b"pkg bytez", &note));
        assert!(!package_matches(b"pkg bytes!", &note));
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn version_validity_matches_the_relays() {
        let v = vectors();
        for pair in v["versions"]["validity"].as_array().unwrap() {
            let (s, expected) = (pair[0].as_str().unwrap(), pair[1].as_bool().unwrap());
            assert_eq!(valid_version(s), expected, "{s:?}");
        }
    }

    #[test]
    fn versions_compare_by_semver_as_the_relay_does() {
        let v = vectors();
        let order: Vec<&str> = v["versions"]["sorted"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
        for (i, a) in order.iter().enumerate() {
            for (j, b) in order.iter().enumerate() {
                // A version with build metadata equals the same version without it, so only compare distinct cores.
                if a.starts_with("2.0.0") && b.starts_with("2.0.0") {
                    assert_eq!(compare_versions(a, b), Some(Ordering::Equal));
                    continue;
                }
                assert_eq!(compare_versions(a, b), Some(i.cmp(&j)), "{a} vs {b}");
            }
        }
        assert_eq!(compare_versions("1.0", "1.0.0"), None);
    }

    #[test]
    fn the_download_comes_only_from_github_over_https() {
        assert!(download_allowed("https://github.com/SUKARDADDY/Support-MCP/releases/download/v1.0.0/Support-1.0.0.pkg"));
        for bad in [
            "http://github.com/a/b",
            "https://evil.example/github.com/a",
            "https://github.com.evil.example/a",
            "https://github.com/a?b",
            "https://github.com/a/../b",
            "ftp://github.com/a",
        ] {
            assert!(!download_allowed(bad), "{bad}");
        }
    }
}
