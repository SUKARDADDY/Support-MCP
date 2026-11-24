//! The show-request marker: how an app launch asks a helper that is not running yet to show its window.
//!
//! A signal cannot do this. launchd starts the helper after `launchctl kickstart` returns, and a SIGINFO that arrives
//! before the helper installs its handler is dropped (it is ignored by default). So the app launch writes an empty
//! file in the person's own per-user temp folder first, and the starting helper looks for it once its UI is up.
//! Nothing can arrive too early: the file waits.
//!
//! The folder is the person's own, but the marker is still opened without following links, and a link at its path is
//! neither written through nor read as a request.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

/// The marker's file name, after the helper's bundle id.
pub const MARKER_NAME: &str = "io.github.sukardaddy.supportmcp.show";

pub fn marker_path(dir: &Path) -> PathBuf {
    dir.join(MARKER_NAME)
}

fn c_path(dir: &Path) -> Option<CString> {
    CString::new(marker_path(dir).as_os_str().as_bytes()).ok()
}

/// Writes the marker in `dir`: created if missing (mode 0600), never through a link. Err names the cause.
pub fn request(dir: &Path) -> Result<(), String> {
    let path = c_path(dir).ok_or("the temp folder's path is not usable")?;
    // SAFETY: a NUL-terminated path; the descriptor is closed below.
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600 as libc::c_uint) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // SAFETY: a descriptor this function opened.
    unsafe { libc::close(fd) };
    Ok(())
}

/// Whether a request is waiting in `dir`. A request is a regular file, owned by this user, that can be opened
/// without following a link. It is removed (unlink removes a name, it never follows one), so it counts once. A link
/// at the path is left alone and is not a request.
pub fn consume(dir: &Path) -> bool {
    let Some(path) = c_path(dir) else { return false };
    // SAFETY: a NUL-terminated path; the descriptor is closed below.
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK) };
    if fd < 0 {
        return false;
    }
    // SAFETY: an all-zero stat is a valid out-parameter; fstat fills it from the open descriptor.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: a live descriptor and a local out-parameter.
    let ok = unsafe { libc::fstat(fd, &mut st) } == 0 && (st.st_mode & libc::S_IFMT) == libc::S_IFREG && st.st_uid == unsafe { libc::geteuid() };
    // SAFETY: a descriptor this function opened.
    unsafe { libc::close(fd) };
    // SAFETY: a NUL-terminated path.
    ok && unsafe { libc::unlink(path.as_ptr()) } == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("support-show-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_written_marker_is_consumed_once() {
        let d = dir("once");
        request(&d).unwrap();
        // Asking twice before the helper looks is still one request.
        request(&d).unwrap();
        assert!(marker_path(&d).exists());
        assert!(consume(&d));
        assert!(!marker_path(&d).exists());
        assert!(!consume(&d));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn the_marker_is_private_and_named_for_the_bundle_id() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir("mode");
        request(&d).unwrap();
        assert_eq!(marker_path(&d).file_name().unwrap(), "io.github.sukardaddy.supportmcp.show");
        let mode = std::fs::metadata(marker_path(&d)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode & 0o077, 0, "mode is {mode:o}");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn no_marker_means_no_show() {
        let d = dir("none");
        assert!(!consume(&d));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_link_at_the_marker_path_is_not_followed_and_not_a_request() {
        use std::os::unix::fs::symlink;
        let d = dir("link");
        let target = d.join("target");
        std::fs::write(&target, b"keep").unwrap();
        symlink(&target, marker_path(&d)).unwrap();
        // Not a request, and the link is left where it is.
        assert!(!consume(&d));
        assert!(std::fs::symlink_metadata(marker_path(&d)).unwrap().file_type().is_symlink());
        // Writing does not go through the link: it fails, and the target is untouched.
        assert!(request(&d).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
        // A link to nothing is no different.
        std::fs::remove_file(marker_path(&d)).unwrap();
        symlink(d.join("missing"), marker_path(&d)).unwrap();
        assert!(!consume(&d));
        assert!(request(&d).is_err());
        assert!(!d.join("missing").exists());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
