//! Downloading a Mac release package: from GitHub only, with every redirect checked, never more than the signed note
//! says, and kept only when its size and SHA-256 are the note's.
//!
//! The note (`release::MacNote`) is signed with the project's release key and names the package's URL, size and
//! SHA-256, so nothing the relay or the network says is trusted for any of them. The rules:
//!
//! - The first request goes to the note's URL, which `release::parse_mac_note` already holds to `https://github.com/`.
//! - A redirect is followed only to `https://objects.githubusercontent.com` or `https://release-assets.githubusercontent.com`
//!   (where GitHub serves release assets), at most 5 times. Anything else stops the download.
//! - A declared length other than the note's size is refused before a byte is kept, and the body is cut off as soon as
//!   it is longer than the note's size. The note's size is at most 40 MiB (`release::PACKAGE_SIZE_MAX`).
//! - The file is written new, only for its owner, never through a link, and removed on any failure.
//!
//! A `test-release` build (the macOS update test) may also fetch from loopback over plain http, and starts at
//! `SUPPORT_TEST_DOWNLOAD_ORIGIN` in place of `https://github.com`. Any other build never does (see `Policy::built_in`).

use crate::release::{self, MacNote, PACKAGE_SIZE_MAX};
use crate::stop::Stop;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

/// The hosts a redirect may lead to: where GitHub serves a release's assets.
pub const REDIRECT_HOSTS: [&str; 2] = ["objects.githubusercontent.com", "release-assets.githubusercontent.com"];
pub const MAX_REDIRECTS: usize = 5;
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// The whole download, 40 MiB at most, must be done in this time.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadError {
    /// The note's URL is not one this build downloads from.
    Host,
    /// A redirect to a host that is not allowed, or too many.
    Redirect,
    /// An answer other than 200.
    Status(u16),
    Network(String),
    /// More bytes than the note's size, declared or sent.
    TooLarge,
    /// Fewer bytes than the note's size.
    Size,
    Hash,
    Write(String),
    Stopped,
}

impl fmt::Display for DownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DownloadError::Host => write!(f, "the package's address is not on GitHub"),
            DownloadError::Redirect => write!(f, "the download was redirected somewhere other than GitHub's release storage"),
            DownloadError::Status(s) => write!(f, "the download answered {s}"),
            DownloadError::Network(e) => write!(f, "the download failed: {e}"),
            DownloadError::TooLarge => write!(f, "the package is larger than the signed note says"),
            DownloadError::Size => write!(f, "the package is smaller than the signed note says"),
            DownloadError::Hash => write!(f, "the package's SHA-256 is not the signed note's"),
            DownloadError::Write(e) => write!(f, "the package could not be saved: {e}"),
            DownloadError::Stopped => write!(f, "stopped"),
        }
    }
}

/// Where this build may download from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    /// Plain http to 127.0.0.1, ::1 or localhost is also allowed, for the first request and for redirects.
    pub allow_loopback: bool,
    /// Requests go to this origin in place of `https://github.com`, with the same path.
    pub origin: Option<String>,
}

impl Policy {
    /// GitHub only.
    pub fn github() -> Policy {
        Policy { allow_loopback: false, origin: None }
    }

    /// What this build allows: GitHub only, except in a `test-release` build.
    #[cfg(not(feature = "test-release"))]
    pub fn built_in() -> Policy {
        Policy::github()
    }

    /// A `test-release` build: loopback too, and the test's origin when it was given at build time.
    #[cfg(feature = "test-release")]
    pub fn built_in() -> Policy {
        Policy { allow_loopback: true, origin: option_env!("SUPPORT_TEST_DOWNLOAD_ORIGIN").map(str::to_string) }
    }
}

fn is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// Whether a redirect may be followed to `url`: https on one of `REDIRECT_HOSTS` on its usual port with no user name, or
/// (a policy that allows it) http on loopback.
pub fn redirect_allowed(url: &url::Url, policy: &Policy) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => url.port().is_none() && url.host_str().is_some_and(|h| REDIRECT_HOSTS.contains(&h)),
        "http" => policy.allow_loopback && is_loopback(url),
        _ => false,
    }
}

/// The first request's URL: the note's, which must be on `https://github.com/`. A policy with an origin swaps it for
/// `https://github.com`, and that origin must be loopback over http.
pub fn start_url(note_url: &str, policy: &Policy) -> Result<url::Url, DownloadError> {
    if !release::download_allowed(note_url) {
        return Err(DownloadError::Host);
    }
    let text = match &policy.origin {
        None => note_url.to_string(),
        Some(origin) => {
            let path = note_url.strip_prefix("https://github.com").ok_or(DownloadError::Host)?;
            format!("{}{path}", origin.trim_end_matches('/'))
        }
    };
    let url = url::Url::parse(&text).map_err(|_| DownloadError::Host)?;
    let ok = match url.scheme() {
        "https" => policy.origin.is_none() && url.host_str() == Some("github.com") && url.port().is_none(),
        "http" => policy.allow_loopback && is_loopback(&url),
        _ => false,
    };
    if !ok || !url.username().is_empty() || url.password().is_some() {
        return Err(DownloadError::Host);
    }
    Ok(url)
}

/// What a download has taken in so far, checked against the note as it arrives.
pub struct Intake {
    size: u64,
    sha256: String,
    got: u64,
    hash: Sha256,
}

impl Intake {
    pub fn new(note: &MacNote) -> Intake {
        Intake { size: note.size.min(PACKAGE_SIZE_MAX), sha256: note.sha256.clone(), got: 0, hash: Sha256::new() }
    }

    /// The answer's declared length, if it gave one: it must be the note's size.
    pub fn declared(&self, length: Option<u64>) -> Result<(), DownloadError> {
        match length {
            Some(n) if n > self.size => Err(DownloadError::TooLarge),
            Some(n) if n < self.size => Err(DownloadError::Size),
            _ => Ok(()),
        }
    }

    /// One more piece of the body. Refused as soon as the total passes the note's size.
    pub fn take(&mut self, chunk: &[u8]) -> Result<(), DownloadError> {
        self.got = self.got.saturating_add(chunk.len() as u64);
        if self.got > self.size {
            return Err(DownloadError::TooLarge);
        }
        self.hash.update(chunk);
        Ok(())
    }

    /// The whole body: exactly the note's size and SHA-256.
    pub fn finish(self) -> Result<(), DownloadError> {
        if self.got != self.size {
            return Err(DownloadError::Size);
        }
        let hex: String = self.hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if hex != self.sha256 {
            return Err(DownloadError::Hash);
        }
        Ok(())
    }
}

/// A new file only its owner can read and write, never through a link.
fn create_new(path: &Path) -> Result<fs::File, DownloadError> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    o.open(path).map_err(|e| DownloadError::Write(e.to_string()))
}

/// Downloads the note's package to `to` (which must not exist yet). On any failure nothing is left at `to`.
pub async fn download(note: &MacNote, to: &Path, policy: &Policy, stop: &Stop) -> Result<(), DownloadError> {
    let url = start_url(&note.url, policy)?;
    let mut file = create_new(to)?;
    let result = tokio::select! {
        r = fetch(url, note, policy, &mut file) => r,
        _ = stop.stopped() => Err(DownloadError::Stopped),
    };
    let result = result.and_then(|()| file.sync_all().map_err(|e| DownloadError::Write(e.to_string())));
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(to);
    }
    result
}

async fn fetch(url: url::Url, note: &MacNote, policy: &Policy, file: &mut fs::File) -> Result<(), DownloadError> {
    crate::tls::init();
    let p = policy.clone();
    let client = reqwest::Client::builder()
        .user_agent(format!("Support-Mac/{}", crate::VERSION))
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(DOWNLOAD_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() <= MAX_REDIRECTS && redirect_allowed(attempt.url(), &p) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|e| DownloadError::Network(e.to_string()))?;
    let mut response = client.get(url).send().await.map_err(|e| DownloadError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
        return Err(DownloadError::Redirect);
    }
    if status != 200 {
        return Err(DownloadError::Status(status));
    }
    let mut intake = Intake::new(note);
    intake.declared(response.content_length())?;
    while let Some(chunk) = response.chunk().await.map_err(|e| DownloadError::Network(e.to_string()))? {
        intake.take(&chunk)?;
        file.write_all(&chunk).map_err(|e| DownloadError::Write(e.to_string()))?;
    }
    intake.finish()
}

/// Whether the file at `path` is the note's package: read again from disk, its size and SHA-256.
pub fn file_matches(path: &Path, note: &MacNote) -> bool {
    let Ok(mut f) = fs::File::open(path) else { return false };
    let mut intake = Intake::new(note);
    let mut buf = vec![0u8; 1 << 20];
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if intake.take(&buf[..n]).is_err() {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }
    intake.finish().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn note(bytes: &[u8], url: &str) -> MacNote {
        MacNote { version: "1.1.1".into(), sha256: release::sha256_hex(bytes), size: bytes.len() as u64, released: 1, url: url.into() }
    }

    const GH: &str = "https://github.com/o/r/releases/download/mac-v1.1.1/Support-1.1.1.pkg";

    fn u(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[test]
    fn redirects_go_only_to_githubs_release_storage_over_https() {
        let gh = Policy::github();
        assert!(redirect_allowed(&u("https://objects.githubusercontent.com/github-production-release-asset/1?x=y"), &gh));
        assert!(redirect_allowed(&u("https://release-assets.githubusercontent.com/a/b?sig=1"), &gh));
        for bad in [
            "http://objects.githubusercontent.com/a",
            "https://objects.githubusercontent.com:8443/a",
            "https://user@objects.githubusercontent.com/a",
            "https://evil.objects.githubusercontent.com/a",
            "https://objects.githubusercontent.com.evil.example/a",
            "https://raw.githubusercontent.com/a",
            "https://github.com/o/r/releases/download/x",
            "https://example.com/a",
            "http://127.0.0.1:8080/a",
            "http://localhost/a",
            "ftp://objects.githubusercontent.com/a",
        ] {
            assert!(!redirect_allowed(&u(bad), &gh), "{bad}");
        }
        // A test build's policy adds plain http on loopback, and nothing else.
        let test = Policy { allow_loopback: true, origin: None };
        assert!(redirect_allowed(&u("http://127.0.0.1:8080/a"), &test));
        assert!(redirect_allowed(&u("http://[::1]:8080/a"), &test));
        assert!(redirect_allowed(&u("http://localhost/a"), &test));
        assert!(!redirect_allowed(&u("http://192.168.1.2/a"), &test));
        assert!(!redirect_allowed(&u("http://example.com/a"), &test));
    }

    #[test]
    fn the_built_in_policy_is_github_only() {
        #[cfg(not(feature = "test-release"))]
        assert_eq!(Policy::built_in(), Policy::github());
        #[cfg(feature = "test-release")]
        assert!(Policy::built_in().allow_loopback);
    }

    #[test]
    fn the_first_request_goes_to_the_notes_github_url() {
        assert_eq!(start_url(GH, &Policy::github()).unwrap().as_str(), GH);
        for bad in ["http://github.com/o/r", "https://github.com.evil/o", "https://objects.githubusercontent.com/a", "https://github.com/a?b"] {
            assert_eq!(start_url(bad, &Policy::github()), Err(DownloadError::Host), "{bad}");
        }
        // A test origin takes github.com's place, path kept; it must be loopback over http, and allowed.
        let test = Policy { allow_loopback: true, origin: Some("http://127.0.0.1:8791".into()) };
        assert_eq!(start_url(GH, &test).unwrap().as_str(), "http://127.0.0.1:8791/o/r/releases/download/mac-v1.1.1/Support-1.1.1.pkg");
        let remote = Policy { allow_loopback: true, origin: Some("http://example.com".into()) };
        assert_eq!(start_url(GH, &remote), Err(DownloadError::Host));
        let not_allowed = Policy { allow_loopback: false, origin: Some("http://127.0.0.1:8791".into()) };
        assert_eq!(start_url(GH, &not_allowed), Err(DownloadError::Host));
        let https_origin = Policy { allow_loopback: true, origin: Some("https://evil.example".into()) };
        assert_eq!(start_url(GH, &https_origin), Err(DownloadError::Host));
    }

    #[test]
    fn the_intake_holds_the_body_to_the_notes_size_and_hash() {
        let bytes = b"0123456789";
        let n = note(bytes, GH);
        // Declared lengths.
        let i = Intake::new(&n);
        assert_eq!(i.declared(Some(10)), Ok(()));
        assert_eq!(i.declared(None), Ok(()));
        assert_eq!(i.declared(Some(11)), Err(DownloadError::TooLarge));
        assert_eq!(i.declared(Some(9)), Err(DownloadError::Size));
        // The exact bytes, in pieces.
        let mut i = Intake::new(&n);
        i.take(b"01234").unwrap();
        i.take(b"56789").unwrap();
        assert_eq!(i.finish(), Ok(()));
        // One byte too many is refused at once.
        let mut i = Intake::new(&n);
        i.take(b"0123456789").unwrap();
        assert_eq!(i.take(b"x"), Err(DownloadError::TooLarge));
        // Short, or the same length with other bytes.
        let mut i = Intake::new(&n);
        i.take(b"012345678").unwrap();
        assert_eq!(i.finish(), Err(DownloadError::Size));
        let mut i = Intake::new(&n);
        i.take(b"012345678X").unwrap();
        assert_eq!(i.finish(), Err(DownloadError::Hash));
    }

    #[test]
    fn the_intake_never_takes_more_than_40_mib_whatever_the_note_says() {
        // A note can't name more (parse_mac_note refuses it), but the cap holds even for a note made by hand.
        let n = MacNote { version: "1.1.1".into(), sha256: "00".repeat(32), size: u64::MAX, released: 1, url: GH.into() };
        let mut i = Intake::new(&n);
        let mib = vec![0u8; 1 << 20];
        for _ in 0..40 {
            i.take(&mib).unwrap();
        }
        assert_eq!(i.take(b"x"), Err(DownloadError::TooLarge));
        assert_eq!(Intake::new(&n).declared(Some(PACKAGE_SIZE_MAX + 1)), Err(DownloadError::TooLarge));
    }

    /// A path, and its answer: a status, extra headers and a body.
    type Route = (&'static str, u16, Vec<(String, String)>, Vec<u8>);

    /// A loopback server with fixed routes. Keeps the paths it was asked for.
    async fn server(routes: Vec<Route>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let routes = routes.clone();
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut b = [0u8; 2048];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        let n = sock.read(&mut b).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&b[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    log.lock().unwrap().push(path.clone());
                    let (status, headers, body) =
                        routes.iter().find(|r| r.0 == path).map(|r| (r.1, r.2.clone(), r.3.clone())).unwrap_or((404, vec![], b"no".to_vec()));
                    let mut out = format!("HTTP/1.1 {status} X\r\nconnection: close\r\n");
                    // "x-no-length" sends the body with no length, ended by closing the connection.
                    let mut has_length = false;
                    for (k, v) in headers {
                        has_length |= k == "content-length" || k == "x-no-length";
                        out.push_str(&format!("{k}: {v}\r\n"));
                    }
                    if !has_length {
                        out.push_str(&format!("content-length: {}\r\n", body.len()));
                    }
                    out.push_str("\r\n");
                    let _ = sock.write_all(out.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (origin, seen)
    }

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("support-dl-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn a_download_follows_an_allowed_redirect_and_keeps_the_notes_bytes() {
        let bytes = b"xar! the package".to_vec();
        let path = "/o/r/releases/download/mac-v1.1.1/Support-1.1.1.pkg";
        let (origin, seen) = server(vec![
            (path, 302, vec![("location".into(), "/assets/Support-1.1.1.pkg".into())], vec![]),
            ("/assets/Support-1.1.1.pkg", 200, vec![], bytes.clone()),
        ])
        .await;
        let policy = Policy { allow_loopback: true, origin: Some(origin) };
        let d = dir("ok");
        let to = d.join("p.pkg");
        download(&note(&bytes, GH), &to, &policy, &Stop::new()).await.unwrap();
        assert_eq!(fs::read(&to).unwrap(), bytes);
        assert!(file_matches(&to, &note(&bytes, GH)));
        assert!(!file_matches(&to, &note(b"other", GH)));
        assert_eq!(*seen.lock().unwrap(), vec![path.to_string(), "/assets/Support-1.1.1.pkg".to_string()]);
        // The file is new each time: a second download to the same place is refused and leaves the first alone.
        assert!(matches!(download(&note(&bytes, GH), &to, &policy, &Stop::new()).await, Err(DownloadError::Write(_))));
        assert_eq!(fs::read(&to).unwrap(), bytes);
        fs::remove_dir_all(&d).unwrap();
    }

    #[tokio::test]
    async fn a_redirect_off_the_allowed_hosts_stops_the_download() {
        let bytes = b"xar! the package".to_vec();
        let path = "/o/r/releases/download/mac-v1.1.1/Support-1.1.1.pkg";
        let (origin, seen) = server(vec![(path, 302, vec![("location".into(), "http://192.0.2.1/evil.pkg".into())], vec![])]).await;
        let policy = Policy { allow_loopback: true, origin: Some(origin) };
        let d = dir("redirect");
        let to = d.join("p.pkg");
        assert_eq!(download(&note(&bytes, GH), &to, &policy, &Stop::new()).await, Err(DownloadError::Redirect));
        assert!(!to.exists(), "nothing is left behind");
        assert_eq!(seen.lock().unwrap().len(), 1, "the redirect was not followed");
        fs::remove_dir_all(&d).unwrap();
    }

    #[tokio::test]
    async fn a_redirect_loop_ends_after_five() {
        let bytes = b"xar!".to_vec();
        let path = "/o/r/releases/download/mac-v1.1.1/Support-1.1.1.pkg";
        let (origin, seen) = server(vec![(path, 302, vec![("location".into(), path.into())], vec![])]).await;
        let policy = Policy { allow_loopback: true, origin: Some(origin) };
        let d = dir("loop");
        let to = d.join("p.pkg");
        assert_eq!(download(&note(&bytes, GH), &to, &policy, &Stop::new()).await, Err(DownloadError::Redirect));
        assert!(seen.lock().unwrap().len() <= MAX_REDIRECTS + 2);
        assert!(!to.exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[tokio::test]
    async fn a_body_other_than_the_notes_is_refused_and_removed() {
        let good = b"xar! the package".to_vec();
        let path = "/o/r/releases/download/mac-v1.1.1/Support-1.1.1.pkg";
        let d = dir("bad");
        for (body, headers, want) in [
            // Longer than the note, as declared.
            (b"xar! the package and more".to_vec(), vec![], DownloadError::TooLarge),
            // No declared length: the bytes past the note's size are refused as they arrive.
            (b"xar! the package and more".to_vec(), vec![("x-no-length".to_string(), "1".to_string())], DownloadError::TooLarge),
            // Same length, other bytes.
            (b"xar! the pockage".to_vec(), vec![], DownloadError::Hash),
            (b"xar!".to_vec(), vec![], DownloadError::Size),
        ] {
            let (origin, _) = server(vec![(path, 200, headers, body)]).await;
            let policy = Policy { allow_loopback: true, origin: Some(origin) };
            let to = d.join("p.pkg");
            assert_eq!(download(&note(&good, GH), &to, &policy, &Stop::new()).await, Err(want));
            assert!(!to.exists());
        }
        let (origin, _) = server(vec![]).await;
        let policy = Policy { allow_loopback: true, origin: Some(origin) };
        assert_eq!(download(&note(&good, GH), &d.join("p.pkg"), &policy, &Stop::new()).await, Err(DownloadError::Status(404)));
        // A release build's policy never reaches loopback at all.
        assert_eq!(
            download(&note(&good, GH), &d.join("p.pkg"), &Policy { allow_loopback: false, origin: Some("http://127.0.0.1:1".into()) }, &Stop::new())
                .await,
            Err(DownloadError::Host)
        );
        fs::remove_dir_all(&d).unwrap();
    }
}
