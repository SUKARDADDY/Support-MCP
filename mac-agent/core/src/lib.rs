//! The platform-neutral core of the Support-MCP Mac client.
//!
//! Everything here speaks the relay's protocol 1 (docs/relay-v1-spec.md) and enforces the team's rules, and none of
//! it touches macOS. The Mac app (PR 3 on) supplies a `platform::Platform` that does the real screen, input, shell
//! and files, and this crate does the rest: the link and the doorbell (`device`), the long-poll session with its two
//! lanes (`session`), the rules (`rules`), update notes (`release`), key names (`keys`) and screen maths
//! (`geometry`). The numbers come from the Windows client (src/agent-app.cs) so the two agree on the wire.

pub mod clock;
pub mod device;
pub mod download;
#[cfg(unix)]
pub mod exec;
pub mod files;
pub mod geometry;
pub mod keys;
pub mod ops;
pub mod platform;
pub mod redeem;
pub mod release;
pub mod rules;
pub mod session;
pub mod stop;
#[cfg(test)]
mod testutil;
pub mod tls;
pub mod wire;

/// The release version of this client. It is the `app_version` of a check-in and the `version` of a session hello.
#[cfg(not(feature = "test-release"))]
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A `test-release` build may report another version (SUPPORT_TEST_VERSION at build time), so the macOS update test can
/// build several versions from one source.
#[cfg(feature = "test-release")]
pub const VERSION: &str = match option_env!("SUPPORT_TEST_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

// The build-time names only a `test-release` build may use. Any other build stops here, so the app that ships can never
// trust a test key, report a made-up version or download from loopback.
#[cfg(not(feature = "test-release"))]
const _: () = assert!(
    option_env!("SUPPORT_TEST_RELEASE_KEY").is_none()
        && option_env!("SUPPORT_TEST_VERSION").is_none()
        && option_env!("SUPPORT_TEST_DOWNLOAD_ORIGIN").is_none(),
    "SUPPORT_TEST_RELEASE_KEY, SUPPORT_TEST_VERSION or SUPPORT_TEST_DOWNLOAD_ORIGIN is set in the build environment. Only a build with the test-release feature may use them. Unset them to build the app that ships."
);
