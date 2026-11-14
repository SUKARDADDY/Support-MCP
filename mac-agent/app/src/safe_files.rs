//! put_file and get_file as root (full control). Root can write anywhere, so a path is walked one folder at a time
//! from `/` with `openat(O_NOFOLLOW)`: no component may be a symbolic link (one that is gets an answer naming the real
//! path), missing folders are made one level at a time, and a file with a second hard link is never written. The
//! folders stay open while the file is opened, so none can be swapped for a link half way. Under limited control the
//! files are read and written by a child running as the person (`as_user`), and none of this applies.
//!
//! The path comes from `support_core::files::absolute_path`, which has already resolved `.` and `..` in the text and
//! which the rules checked; here it is only split into the names to open.

use std::ffi::{CStr, CString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use support_core::files::FileChunk;

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| support_core::files::NEEDS_ABSOLUTE.to_string())
}

fn openat(dir: RawFd, name: &CStr, flags: i32, mode: libc::c_uint) -> io::Result<OwnedFd> {
    // SAFETY: `name` is a valid C string and `dir` an open folder; the result is checked before use.
    let fd = unsafe { libc::openat(dir, name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW, mode) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a new descriptor that nothing else owns.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn fstat(fd: RawFd) -> io::Result<libc::stat> {
    // SAFETY: a zeroed stat is a valid out-parameter; the fd is open.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(st)
}

/// Whether `name` in `dir` is a symbolic link, and where it points.
fn link_target(dir: RawFd, name: &CStr) -> Option<String> {
    let mut buf = vec![0u8; 1024];
    // SAFETY: the buffer is as long as we say; readlinkat does not add a NUL.
    let n = unsafe { libc::readlinkat(dir, name.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
    (n >= 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

fn link_error(so_far: &str, target: &str) -> String {
    format!("{so_far} is a symbolic link to {target}; as root, Support does not follow links, so give the path without it")
}

fn os_error(e: io::Error, path: &str) -> String {
    match e.raw_os_error() {
        Some(libc::ENOENT) => format!("{path} does not exist"),
        Some(libc::ENOTDIR) => format!("a part of {path} is not a folder"),
        Some(libc::EACCES) | Some(libc::EPERM) => format!("{path}: permission denied"),
        _ => format!("{path}: {e}"),
    }
}

/// Opens the folder that holds the path's last name, without following any link, making missing folders when
/// `create`. Returns it and the last name.
fn parent_of(path: &str, create: bool) -> Result<(OwnedFd, CString, String), String> {
    let names: Vec<&str> = path.split('/').filter(|n| !n.is_empty()).collect();
    let (last, folders) = names.split_last().ok_or("a file path is required, not /")?;
    if names.iter().any(|n| *n == "." || *n == "..") {
        return Err(support_core::files::NEEDS_ABSOLUTE.into());
    }
    let root = cstr("/")?;
    // SAFETY: opening "/" as a folder; checked below.
    let fd = unsafe { libc::open(root.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(io::Error::last_os_error().to_string());
    }
    // SAFETY: a new descriptor.
    let mut dir = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut so_far = String::new();
    for name in folders {
        so_far.push('/');
        so_far.push_str(name);
        let c = cstr(name)?;
        let opened = match openat(dir.as_raw_fd(), &c, libc::O_RDONLY | libc::O_DIRECTORY, 0) {
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) && create => {
                // SAFETY: a valid name in an open folder.
                if unsafe { libc::mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o755) } != 0 {
                    let e = io::Error::last_os_error();
                    if e.raw_os_error() != Some(libc::EEXIST) {
                        return Err(os_error(e, &so_far));
                    }
                }
                openat(dir.as_raw_fd(), &c, libc::O_RDONLY | libc::O_DIRECTORY, 0)
            }
            other => other,
        };
        dir = match opened {
            Ok(d) => d,
            Err(e) => {
                if let Some(target) = link_target(dir.as_raw_fd(), &c) {
                    return Err(link_error(&so_far, &target));
                }
                return Err(os_error(e, &so_far));
            }
        };
    }
    Ok((dir, cstr(last)?, so_far + "/" + last))
}

/// Writes `data` to `path` as root: replaces the file, or appends. Returns the bytes written.
pub fn put(path: &str, data: &[u8], append: bool) -> Result<usize, String> {
    let (dir, name, full) = parent_of(path, true)?;
    let mut flags = libc::O_WRONLY | libc::O_CREAT | libc::O_NONBLOCK;
    if append {
        flags |= libc::O_APPEND;
    }
    let fd = openat(dir.as_raw_fd(), &name, flags, 0o644).map_err(|e| match link_target(dir.as_raw_fd(), &name) {
        Some(t) => link_error(&full, &t),
        None => os_error(e, &full),
    })?;
    let st = fstat(fd.as_raw_fd()).map_err(|e| e.to_string())?;
    if st.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(format!("{full} is not a regular file"));
    }
    if st.st_nlink > 1 {
        return Err(format!("{full} has a second hard link; as root, Support does not write to it"));
    }
    // No O_TRUNC at open: the file is emptied only once it is known to be safe to write.
    if !append {
        // SAFETY: an open regular file.
        if unsafe { libc::ftruncate(fd.as_raw_fd(), 0) } != 0 {
            return Err(io::Error::last_os_error().to_string());
        }
    }
    let mut file = std::fs::File::from(fd);
    std::io::Write::write_all(&mut file, data).map_err(|e| e.to_string())?;
    Ok(data.len())
}

/// Reads up to `length` bytes from `offset` as root.
pub fn get(path: &str, offset: u64, length: usize) -> Result<FileChunk, String> {
    let (dir, name, full) = parent_of(path, false)?;
    let fd = openat(dir.as_raw_fd(), &name, libc::O_RDONLY | libc::O_NONBLOCK, 0).map_err(|e| match link_target(dir.as_raw_fd(), &name) {
        Some(t) => link_error(&full, &t),
        None => os_error(e, &full),
    })?;
    let st = fstat(fd.as_raw_fd()).map_err(|e| e.to_string())?;
    if st.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(format!("{full} is not a regular file"));
    }
    let size = st.st_size as u64;
    let file = std::fs::File::from(fd);
    let mut data = vec![0u8; length];
    let mut total = 0usize;
    while total < length {
        let n = std::os::unix::fs::FileExt::read_at(&file, &mut data[total..], offset + total as u64).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n;
    }
    data.truncate(total);
    Ok(FileChunk { eof: offset + total as u64 >= size, data, size })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn err<T>(r: Result<T, String>) -> String {
        match r {
            Err(e) => e,
            Ok(_) => panic!("expected an error"),
        }
    }

    fn temp(name: &str) -> String {
        let d = std::env::temp_dir().join(format!("support-mac-safe-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        // The test's own temp folder may itself be behind a link (macOS /var -> /private/var), so use its real path.
        fs::canonicalize(&d).unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn a_file_is_written_with_its_folders_and_read_back() {
        let d = temp("rw");
        let p = format!("{d}/a/b/c.bin");
        assert_eq!(put(&p, b"hello ", false).unwrap(), 6);
        assert_eq!(put(&p, b"world", true).unwrap(), 5);
        let all = get(&p, 0, 100).unwrap();
        assert_eq!((all.data.as_slice(), all.size, all.eof), (&b"hello world"[..], 11, true));
        let part = get(&p, 6, 3).unwrap();
        assert_eq!((part.data.as_slice(), part.eof), (&b"wor"[..], false));
        // Replacing empties it first.
        put(&p, b"x", false).unwrap();
        assert_eq!(get(&p, 0, 10).unwrap().data, b"x");
        assert!(err(get(&format!("{d}/missing"), 0, 1)).contains("does not exist"));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn no_component_may_be_a_link() {
        let d = temp("link");
        fs::create_dir_all(format!("{d}/real")).unwrap();
        fs::write(format!("{d}/real/f"), b"secret").unwrap();
        std::os::unix::fs::symlink(format!("{d}/real"), format!("{d}/via")).unwrap();
        std::os::unix::fs::symlink(format!("{d}/real/f"), format!("{d}/flink")).unwrap();
        let e = err(get(&format!("{d}/via/f"), 0, 10));
        assert!(e.contains(&format!("{d}/via is a symbolic link to {d}/real")), "{e}");
        assert!(put(&format!("{d}/via/new"), b"x", false).is_err());
        assert!(!std::path::Path::new(&format!("{d}/real/new")).exists(), "nothing was written through the link");
        let e = err(get(&format!("{d}/flink"), 0, 10));
        assert!(e.contains("symbolic link"), "{e}");
        let e = put(&format!("{d}/flink"), b"overwrite", false).unwrap_err();
        assert!(e.contains("symbolic link"), "{e}");
        assert_eq!(fs::read(format!("{d}/real/f")).unwrap(), b"secret");
        // A link deeper down, made for a missing folder, is not followed either.
        std::os::unix::fs::symlink("/", format!("{d}/real/up")).unwrap();
        assert!(put(&format!("{d}/real/up/x/y"), b"x", false).unwrap_err().contains("symbolic link"));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_file_with_a_second_hard_link_is_never_written() {
        let d = temp("hard");
        fs::write(format!("{d}/a"), b"keep").unwrap();
        fs::hard_link(format!("{d}/a"), format!("{d}/b")).unwrap();
        let e = put(&format!("{d}/b"), b"x", false).unwrap_err();
        assert!(e.contains("second hard link"), "{e}");
        assert!(put(&format!("{d}/b"), b"x", true).is_err());
        assert_eq!(fs::read(format!("{d}/a")).unwrap(), b"keep", "not even emptied");
        // Reading one is fine.
        assert_eq!(get(&format!("{d}/b"), 0, 10).unwrap().data, b"keep");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn only_regular_files_are_opened() {
        let d = temp("kinds");
        fs::create_dir_all(format!("{d}/dir")).unwrap();
        assert!(err(get(&format!("{d}/dir"), 0, 1)).contains("not a regular file"));
        assert!(put(&format!("{d}/dir"), b"x", false).is_err());
        fs::write(format!("{d}/file"), b"x").unwrap();
        assert!(put(&format!("{d}/file/under"), b"x", false).unwrap_err().contains("not a folder"));
        assert!(get("/", 0, 1).is_err());
        fs::remove_dir_all(&d).unwrap();
    }
}
