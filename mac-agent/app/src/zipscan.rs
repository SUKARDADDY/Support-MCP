//! The check of a zip before root expands it (install_program). `ditto -x -k` runs as root, so a zip must not be able to
//! write anywhere but the folder it is expanded into. This reads the zip's own directory and refuses one that:
//!
//! - names a file with an absolute path, a `..` part, a backslash or a NUL, or a name that is not UTF-8;
//! - holds a name twice (compared as the Mac's disk compares names: NFC, no case);
//! - holds a link and also a file inside that link (`a` a link, then `a/evil`), so expanding the second would write
//!   through the first. A `__MACOSX/<path>/._<name>` entry, which ditto applies to `<path>/<name>`, counts as that path,
//!   and may not land on a link either;
//! - has entries whose local headers do not match its directory, or data between them, so a reader that walks the local
//!   headers sees exactly what this check saw;
//! - is too big when expanded, or has too many entries.
//!
//! The app that comes out is checked again afterwards (`install::bundle_problem`).

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use support_core::rules;

pub const ENTRIES_MAX: u64 = 1_000_000;
pub const DIRECTORY_MAX: u64 = 512 << 20;
pub const EXPANDED_MAX: u64 = 32 << 30;

const EOCD: u32 = 0x0605_4b50;
const EOCD64: u32 = 0x0606_4b50;
const LOCATOR64: u32 = 0x0706_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const LOCAL: u32 = 0x0403_4b50;
const DESCRIPTOR: u32 = 0x0807_4b50;

fn u16_at(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as u64)
}

fn u32_at(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as u64)
}

fn u64_at(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 8).map(|s| u64::from_le_bytes(s.try_into().unwrap_or([0; 8])))
}

fn read_at(f: &mut File, at: u64, len: u64) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; len as usize];
    f.seek(SeekFrom::Start(at)).map_err(|e| e.to_string())?;
    f.read_exact(&mut buf).map_err(|_| "the zip is cut short".to_string())?;
    Ok(buf)
}

const BAD: &str = "this is not a zip install_program can read";

/// One entry of the zip's directory.
struct Entry {
    name: String,
    raw: Vec<u8>,
    flags: u64,
    packed: u64,
    expanded: u64,
    offset: u64,
    link: bool,
    zip64: bool,
}

/// The parts of a name as the Mac's disk compares them, and whether it is an AppleDouble entry ditto applies elsewhere.
fn key_of(name: &str) -> Result<(Vec<String>, bool), String> {
    if name.contains('\\') || name.contains('\0') {
        return Err(format!("{name} holds a backslash or a NUL"));
    }
    if name.starts_with('/') {
        return Err(format!("{name} is an absolute path"));
    }
    let mut parts: Vec<String> = Vec::new();
    for p in name.split('/') {
        match p {
            "" | "." => {}
            ".." => return Err(format!("{name} climbs out of the zip with ..")),
            p => parts.push(rules::nfc(p).to_lowercase()),
        }
    }
    if parts.is_empty() {
        return Err(format!("the zip holds an entry with no name ({name:?})"));
    }
    if parts[0] == "__macosx" {
        parts.remove(0);
        if let Some(last) = parts.last_mut() {
            if let Some(real) = last.strip_prefix("._") {
                *last = real.to_string();
                return Ok((parts, true));
            }
        }
    }
    Ok((parts, false))
}

/// Why a zip may not be expanded as root, or Ok.
pub fn check(path: &Path) -> Result<(), String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len < 22 {
        return Err(BAD.into());
    }
    let tail_len = len.min(22 + 65_535);
    let tail = read_at(&mut f, len - tail_len, tail_len)?;
    let at = (0..=tail.len() - 22)
        .rev()
        .find(|&i| u32_at(&tail, i) == Some(EOCD as u64) && i + 22 + u16_at(&tail, i + 20).unwrap_or(0) as usize <= tail.len())
        .ok_or(BAD)?;
    let eocd_abs = len - tail_len + at as u64;
    let (mut count, mut size, mut start) =
        (u16_at(&tail, at + 10).ok_or(BAD)?, u32_at(&tail, at + 12).ok_or(BAD)?, u32_at(&tail, at + 16).ok_or(BAD)?);
    if count == 0xFFFF || size == 0xFFFF_FFFF || start == 0xFFFF_FFFF {
        let loc = read_at(&mut f, eocd_abs.checked_sub(20).ok_or(BAD)?, 20)?;
        if u32_at(&loc, 0) != Some(LOCATOR64 as u64) {
            return Err(BAD.into());
        }
        let z = read_at(&mut f, u64_at(&loc, 8).ok_or(BAD)?, 56)?;
        if u32_at(&z, 0) != Some(EOCD64 as u64) {
            return Err(BAD.into());
        }
        count = u64_at(&z, 32).ok_or(BAD)?;
        size = u64_at(&z, 40).ok_or(BAD)?;
        start = u64_at(&z, 48).ok_or(BAD)?;
    }
    if count > ENTRIES_MAX {
        return Err(format!("the zip holds more than {ENTRIES_MAX} entries"));
    }
    if size > DIRECTORY_MAX || start.checked_add(size).is_none_or(|end| end > eocd_abs) {
        return Err(BAD.into());
    }
    let dir = read_at(&mut f, start, size)?;
    let mut entries: Vec<Entry> = Vec::with_capacity(count as usize);
    let mut pos = 0usize;
    for _ in 0..count {
        if u32_at(&dir, pos) != Some(CENTRAL as u64) {
            return Err(BAD.into());
        }
        let flags = u16_at(&dir, pos + 8).ok_or(BAD)?;
        let mut packed = u32_at(&dir, pos + 20).ok_or(BAD)?;
        let mut expanded = u32_at(&dir, pos + 24).ok_or(BAD)?;
        let (n, x, c) =
            (u16_at(&dir, pos + 28).ok_or(BAD)? as usize, u16_at(&dir, pos + 30).ok_or(BAD)? as usize, u16_at(&dir, pos + 32).ok_or(BAD)? as usize);
        let external = u32_at(&dir, pos + 38).ok_or(BAD)?;
        let mut offset = u32_at(&dir, pos + 42).ok_or(BAD)?;
        let raw = dir.get(pos + 46..pos + 46 + n).ok_or(BAD)?.to_vec();
        let extra = dir.get(pos + 46 + n..pos + 46 + n + x).ok_or(BAD)?;
        // The zip64 extra field: the 8-byte forms of the sizes and the offset, each only when its short form is full.
        let mut zip64 = false;
        let mut e = 0usize;
        while e + 4 <= extra.len() {
            let (id, l) = (u16_at(extra, e).unwrap_or(0), u16_at(extra, e + 2).unwrap_or(0) as usize);
            if id == 1 {
                zip64 = true;
                let mut k = e + 4;
                for field in [&mut expanded, &mut packed, &mut offset] {
                    if *field == 0xFFFF_FFFF {
                        *field = u64_at(extra, k).ok_or(BAD)?;
                        k += 8;
                    }
                }
            }
            e += 4 + l;
        }
        let name = String::from_utf8(raw.clone()).map_err(|_| "a name in the zip is not UTF-8".to_string())?;
        // A link, by its Unix mode, whatever system made the zip claims to be: counting too many as links is safe.
        let link = (external >> 16) & 0o170000 == 0o120000;
        entries.push(Entry { name, raw, flags, packed, expanded, offset, link, zip64 });
        pos += 46 + n + x + c;
    }
    // What expanding would write.
    let total = entries.iter().try_fold(0u64, |t, e| t.checked_add(e.expanded)).unwrap_or(u64::MAX);
    if total > EXPANDED_MAX {
        return Err(format!("the zip would expand to more than {} GB", EXPANDED_MAX >> 30));
    }
    // Names: each once, none inside a link, no AppleDouble on a link.
    let mut keys: Vec<(Vec<String>, bool)> = Vec::with_capacity(entries.len());
    let mut seen: HashSet<Vec<String>> = HashSet::new();
    let mut links: HashMap<Vec<String>, String> = HashMap::new();
    for e in &entries {
        let (k, double) = key_of(&e.name)?;
        if !double && !seen.insert(k.clone()) {
            return Err(format!("the zip holds {} twice", e.name.trim_end_matches('/')));
        }
        if e.link {
            if double {
                return Err(format!("{} is a link in the place of a file's extra data", e.name));
            }
            links.insert(k.clone(), e.name.trim_end_matches('/').to_string());
        }
        keys.push((k, double));
    }
    for (e, (k, double)) in entries.iter().zip(&keys) {
        let upto = if *double { k.len() } else { k.len() - 1 };
        for i in 1..=upto {
            if let Some(link) = links.get(&k[..i]) {
                return Err(format!(
                    "{} is inside {link}, which is a link in the zip; install_program does not expand a zip that writes through a link",
                    e.name.trim_end_matches('/')
                ));
            }
        }
    }
    // The local headers: one at each offset the directory names, back to back from the start to the directory, each with
    // the same name.
    let mut order: Vec<&Entry> = entries.iter().collect();
    order.sort_by_key(|e| e.offset);
    let mut at = 0u64;
    for (i, e) in order.iter().enumerate() {
        if e.offset != at {
            return Err("the zip has data between its entries, or entries that overlap".into());
        }
        let head = read_at(&mut f, at, 30)?;
        if u32_at(&head, 0) != Some(LOCAL as u64) {
            return Err(BAD.into());
        }
        let (n, x) = (u16_at(&head, 26).ok_or(BAD)?, u16_at(&head, 28).ok_or(BAD)?);
        if read_at(&mut f, at + 30, n)? != e.raw {
            return Err(format!("{} has another name in its own header", e.name));
        }
        at = at.checked_add(30 + n + x).and_then(|a| a.checked_add(e.packed)).ok_or(BAD)?;
        if e.flags & 8 != 0 {
            // A data descriptor follows the data: with or without its signature, with 4- or 8-byte sizes.
            let next = order.get(i + 1).map_or(start, |n| n.offset);
            let signed = at + 4 <= len && u32_at(&read_at(&mut f, at, 4)?, 0) == Some(DESCRIPTOR as u64);
            let sizes = if e.zip64 { 16 } else { 8 };
            let want = at + 4 + sizes + if signed { 4 } else { 0 };
            if want != next {
                return Err(BAD.into());
            }
            at = want;
        }
    }
    if at != start {
        return Err("the zip has data between its entries and its directory".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A stored (not compressed) zip of these names, each a link (to "x") or a file (with its own name as data), with
    /// `comment` as the archive's comment.
    pub fn zip(entries: &[(&str, bool)], comment: &str) -> Vec<u8> {
        zip_with(entries, comment, |_, _| {})
    }

    /// The same, with `tweak` given each entry's index and its central record to change.
    pub fn zip_with(entries: &[(&str, bool)], comment: &str, tweak: impl Fn(usize, &mut Vec<u8>)) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (i, (name, link)) in entries.iter().enumerate() {
            let data: &[u8] = if *link { b"x" } else { name.as_bytes() };
            let offset = out.len() as u32;
            out.extend_from_slice(&LOCAL.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            let mode: u32 = if *link {
                0o120755
            } else if name.ends_with('/') {
                0o040755
            } else {
                0o100644
            };
            let mut c = Vec::new();
            c.extend_from_slice(&CENTRAL.to_le_bytes());
            c.extend_from_slice(&[20, 3, 20, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            c.extend_from_slice(&(data.len() as u32).to_le_bytes());
            c.extend_from_slice(&(data.len() as u32).to_le_bytes());
            c.extend_from_slice(&(name.len() as u16).to_le_bytes());
            c.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
            c.extend_from_slice(&(mode << 16).to_le_bytes());
            c.extend_from_slice(&offset.to_le_bytes());
            c.extend_from_slice(name.as_bytes());
            tweak(i, &mut c);
            central.extend_from_slice(&c);
        }
        let start = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&EOCD.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&start.to_le_bytes());
        out.extend_from_slice(&(comment.len() as u16).to_le_bytes());
        out.extend_from_slice(comment.as_bytes());
        out
    }

    fn scan(bytes: &[u8]) -> Result<(), String> {
        let p = std::env::temp_dir().join(format!("support-zipscan-{}-{}.zip", std::process::id(), rand_name()));
        std::fs::write(&p, bytes).unwrap();
        let r = check(&p);
        std::fs::remove_file(&p).unwrap();
        r
    }

    // A counter, not the clock: tests run in parallel, and two could read the same time and share a file.
    fn rand_name() -> usize {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    #[test]
    fn an_app_with_its_own_links_passes() {
        let z = zip(
            &[
                ("Foo.app/", false),
                ("Foo.app/Contents/Info.plist", false),
                ("Foo.app/Contents/Frameworks/S.framework/Versions/Current", true),
                ("Foo.app/Contents/Frameworks/S.framework/S", true),
                ("Foo.app/Contents/Frameworks/S.framework/Versions/A/S", false),
                ("__MACOSX/Foo.app/Contents/._Info.plist", false),
            ],
            "",
        );
        assert_eq!(scan(&z), Ok(()));
        assert_eq!(scan(&zip(&[], "comment")), Ok(()), "an empty zip");
    }

    #[test]
    fn a_zip_that_writes_through_its_own_link_or_out_of_its_folder_is_refused() {
        let refused = |entries: &[(&str, bool)], want: &str| {
            let e = scan(&zip(entries, "")).unwrap_err();
            assert!(e.contains(want), "{entries:?}: {e}");
        };
        refused(&[("a", true), ("a/evil", false)], "a/evil is inside a, which is a link");
        refused(&[("App.app/Contents", true), ("App.app/Contents/MacOS/x", false)], "inside App.app/Contents, which is a link");
        refused(&[("A", true), ("a/x", false)], "a/x is inside A");
        refused(&[("Caf\u{e9}", true), ("Cafe\u{301}/x", false)], "inside Caf\u{e9}");
        refused(&[("a", true), ("__MACOSX/._a", false)], "__MACOSX/._a is inside a");
        refused(&[("d/a", true), ("__MACOSX/d/._a", false)], "inside d/a");
        refused(&[("../x", false)], "climbs out");
        refused(&[("a/../../x", false)], "climbs out");
        refused(&[("/etc/x", false)], "absolute path");
        refused(&[("a\\..\\x", false)], "backslash");
        refused(&[("a", false), ("A", false)], "holds A twice");
        refused(&[("a", true), ("a", false)], "holds a twice");
        refused(&[("__MACOSX/._x", true)], "link in the place");
    }

    #[test]
    fn a_zip_whose_headers_disagree_with_its_directory_is_refused() {
        // A name changed in the directory only.
        let z = zip_with(&[("good", false)], "", |_, c| {
            let n = c.len();
            c[n - 1] = b'X';
        });
        assert!(scan(&z).unwrap_err().contains("another name in its own header"));
        // An entry the directory does not list, hidden before the listed one: its central record is taken out.
        let mut z = zip(&[("hidden/evil", false), ("ok", false)], "");
        let n = z.len();
        let start = u32_at(&z, n - 6).unwrap() as usize;
        let first = 46 + "hidden/evil".len();
        z.drain(start..start + first);
        let n = z.len();
        let size = u32_at(&z, n - 10).unwrap() as u32 - first as u32;
        z[n - 10..n - 6].copy_from_slice(&size.to_le_bytes());
        z[n - 14..n - 12].copy_from_slice(&1u16.to_le_bytes());
        z[n - 12..n - 10].copy_from_slice(&1u16.to_le_bytes());
        assert!(scan(&z).unwrap_err().contains("data between its entries"), "{:?}", scan(&z));
        // Not a zip, and a non-UTF-8 name.
        assert!(scan(b"not a zip at all, just text that is long enough").is_err());
        let z = zip_with(&[("ab", false)], "", |_, c| {
            let n = c.len();
            c[n - 1] = 0xff;
        });
        assert!(scan(&z).is_err());
    }

    #[test]
    fn keys_compare_as_the_macs_disk_does() {
        assert_eq!(key_of("A/./B/").unwrap(), (vec!["a".to_string(), "b".to_string()], false));
        assert_eq!(key_of("__MACOSX/A/._B").unwrap(), (vec!["a".to_string(), "b".to_string()], true));
        assert_eq!(key_of("__MACOSX/A/").unwrap(), (vec!["a".to_string()], false));
        assert!(key_of("./").is_err());
    }
}
