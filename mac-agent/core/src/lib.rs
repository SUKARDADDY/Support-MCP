//! The platform-neutral core of the Support-MCP Mac client.
//!
//! Everything here speaks the relay's protocol 1 (docs/relay-v1-spec.md) and enforces the team's rules, and none of
//! it touches macOS. The Mac app (PR 3 on) supplies a `platform::Platform` that does the real screen, input, shell
//! and files, and this crate does the rest: the link and the doorbell (`device`), the long-poll session with its two
//! lanes (`session`), the rules (`rules`), update notes (`release`), key names (`keys`) and screen maths
//! (`geometry`). The numbers come from the Windows client (src/agent-app.cs) so the two agree on the wire.

pub mod clock;
pub mod device;
#[cfg(unix)]
pub mod exec;
pub mod files;
pub mod geometry;
pub mod keys;
pub mod ops;
pub mod platform;
pub mod release;
pub mod rules;
pub mod session;
pub mod stop;
#[cfg(test)]
mod testutil;
pub mod tls;
pub mod wire;

/// The release version of this client. It is the `app_version` of a check-in and the `version` of a session hello.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
