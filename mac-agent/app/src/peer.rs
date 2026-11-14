//! Who may talk to the root service over its socket. On every connection the service reads the peer's facts from the
//! kernel (`mac::peer` on a Mac: the audit token, the code signature and the executable path) and decides here:
//!
//! - its code must pass a signature check against the service's own designated requirement (so it is this app,
//!   signed by the same identity), and the check must have been made on the process behind the audit token;
//! - its executable must be the installed binary, by the path the kernel reports and by the path of the signed code;
//! - its uid must be the person signed in at the console, or root.
//!
//! Root may make requests (`sudo support setup`, `sudo support uninstall`) and is the login window's helper. A
//! person's helper is accepted only for the person at the console. Anything else is refused before a byte is read.
//! A refused peer gets no answer: the connection is closed.

use crate::ipc::HelperSession;

/// What the kernel and the code signing services say about a peer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerFacts {
    pub pid: i32,
    /// The effective uid, from the audit token (and getpeereid, which must agree).
    pub uid: u32,
    /// The executable's path by pid (proc_pidpath).
    pub exe: Option<String>,
    /// The path of the code the signature check ran on (SecCodeCopyPath of the guest from the audit token).
    pub code_path: Option<String>,
    /// SecCodeCheckValidity against the service's own designated requirement passed.
    pub signature_ok: bool,
}

/// A peer the service accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Peer {
    /// The person signed in at the console.
    ConsoleUser(u32),
    Root,
}

impl Peer {
    pub fn uid(self) -> u32 {
        match self {
            Peer::ConsoleUser(u) => u,
            Peer::Root => 0,
        }
    }
}

/// Reads a connected peer's facts. The Mac's reads the kernel; tests give fixed facts.
pub trait Inspector: Send + Sync + 'static {
    fn inspect(&self, fd: std::os::fd::RawFd) -> Result<PeerFacts, String>;
    /// The uid of the person signed in at the console, None at the login window.
    fn console_uid(&self) -> Option<u32>;
}

/// The decision. `expected` is the installed binary's path. `console` is who is at the console (None: nobody).
pub fn decide(f: &PeerFacts, expected: &str, console: Option<u32>) -> Result<Peer, String> {
    if !f.signature_ok {
        return Err("its code signature does not satisfy the service's designated requirement".into());
    }
    if f.exe.as_deref() != Some(expected) {
        return Err(format!("its executable is {:?}, not the installed app", f.exe.as_deref().unwrap_or("")));
    }
    // For an app, the signed code's path is its bundle (SecCodeCopyPath); for a bare binary, the binary.
    let code = f.code_path.as_deref().map(|p| p.trim_end_matches('/'));
    if code != Some(expected) && code.is_none_or(|c| Some(c) != bundle_of(expected)) {
        return Err("the signed code is not the installed app".into());
    }
    if f.pid <= 1 {
        return Err("no process".into());
    }
    match (f.uid, console) {
        (0, _) => Ok(Peer::Root),
        (uid, Some(c)) if uid == c && c != 0 => Ok(Peer::ConsoleUser(uid)),
        (uid, _) => Err(format!("uid {uid} is not the person at the console")),
    }
}

/// The bundle that holds an executable at `<bundle>.app/Contents/MacOS/<name>`.
pub fn bundle_of(exe: &str) -> Option<&str> {
    let i = exe.rfind(".app/Contents/MacOS/")?;
    let name = &exe[i + ".app/Contents/MacOS/".len()..];
    (!name.is_empty() && !name.contains('/')).then(|| &exe[..i + 4])
}

/// Whether an accepted peer may be the helper of the session it names: a person's helper only as that person while
/// they are at the console, and the login window's only as root while nobody is signed in.
pub fn may_serve(peer: Peer, session: HelperSession, console: Option<u32>) -> bool {
    match (peer, session) {
        (Peer::ConsoleUser(uid), HelperSession::Aqua) => console == Some(uid),
        (Peer::Root, HelperSession::LoginWindow) => console.is_none(),
        _ => false,
    }
}

/// Whether a peer may end the live session: the person at the console, or root.
pub fn may_end_session(peer: Peer, console: Option<u32>) -> bool {
    match peer {
        Peer::Root => true,
        Peer::ConsoleUser(uid) => console == Some(uid),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIN: &str = "/Applications/Support.app/Contents/MacOS/support";

    fn facts(uid: u32) -> PeerFacts {
        PeerFacts { pid: 400, uid, exe: Some(BIN.into()), code_path: Some(BIN.into()), signature_ok: true }
    }

    #[test]
    fn the_console_users_and_roots_signed_app_is_accepted() {
        assert_eq!(decide(&facts(501), BIN, Some(501)), Ok(Peer::ConsoleUser(501)));
        assert_eq!(decide(&facts(0), BIN, Some(501)), Ok(Peer::Root));
        assert_eq!(decide(&facts(0), BIN, None), Ok(Peer::Root));
    }

    #[test]
    fn another_user_or_nobody_at_the_console_is_refused() {
        assert!(decide(&facts(502), BIN, Some(501)).is_err(), "a second signed-in user in the background");
        assert!(decide(&facts(501), BIN, None).is_err(), "at the login window only root");
        assert!(decide(&facts(4294967294), BIN, Some(501)).is_err(), "nobody");
    }

    #[test]
    fn the_wrong_code_is_refused_whoever_runs_it() {
        let mut f = facts(501);
        f.signature_ok = false;
        assert!(decide(&f, BIN, Some(501)).unwrap_err().contains("signature"));
        let mut f = facts(0);
        f.signature_ok = false;
        assert!(decide(&f, BIN, Some(501)).is_err(), "root too: an unsigned root tool is not the app");
        // A signed copy elsewhere (a translocated or copied app) is not the installed binary.
        let mut f = facts(501);
        f.exe = Some("/Users/a/Downloads/Support.app/Contents/MacOS/support".into());
        assert!(decide(&f, BIN, Some(501)).is_err());
        let mut f = facts(501);
        f.exe = None;
        assert!(decide(&f, BIN, Some(501)).is_err());
        // The path and the checked code must be the same file.
        let mut f = facts(501);
        f.code_path = Some("/tmp/other".into());
        assert!(decide(&f, BIN, Some(501)).is_err());
        // The bundle is the signed code of an app: accepted, and so is the binary itself. Another bundle is not.
        let mut f = facts(501);
        f.code_path = Some("/Applications/Support.app/".into());
        assert!(decide(&f, BIN, Some(501)).is_ok());
        f.code_path = Some("/Applications/Support.app".into());
        assert!(decide(&f, BIN, Some(501)).is_ok());
        f.code_path = Some("/Applications/Other.app".into());
        assert!(decide(&f, BIN, Some(501)).is_err());
        f.code_path = Some("/Applications/Support.app/Contents".into());
        assert!(decide(&f, BIN, Some(501)).is_err());
        assert_eq!(bundle_of(BIN), Some("/Applications/Support.app"));
        assert_eq!(bundle_of("/usr/local/bin/support"), None);
        let mut f = facts(501);
        f.pid = 1;
        assert!(decide(&f, BIN, Some(501)).is_err());
    }

    #[test]
    fn a_helper_serves_only_its_own_session() {
        assert!(may_serve(Peer::ConsoleUser(501), HelperSession::Aqua, Some(501)));
        assert!(!may_serve(Peer::ConsoleUser(501), HelperSession::Aqua, Some(502)));
        assert!(!may_serve(Peer::ConsoleUser(501), HelperSession::LoginWindow, None));
        assert!(may_serve(Peer::Root, HelperSession::LoginWindow, None));
        assert!(!may_serve(Peer::Root, HelperSession::LoginWindow, Some(501)), "not while someone is signed in");
        assert!(!may_serve(Peer::Root, HelperSession::Aqua, Some(501)), "root is never a person's helper");
    }

    #[test]
    fn ending_a_session_is_for_the_person_at_the_mac_or_root() {
        assert!(may_end_session(Peer::Root, None));
        assert!(may_end_session(Peer::ConsoleUser(501), Some(501)));
        assert!(!may_end_session(Peer::ConsoleUser(501), Some(502)));
    }
}
