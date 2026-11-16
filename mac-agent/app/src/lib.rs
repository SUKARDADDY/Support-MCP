//! The Support-MCP Mac app: one binary, `support`, with a role per process (`role`). The root service (`service`)
//! runs the core's device service and is its `Platform`; the helper in each session does the screen, the input and
//! the windows; the socket between them (`server`, `frame`, `ipc`, `peer`) is the privilege boundary.
//!
//! Everything that does not need macOS is here, outside `mac`, and is tested on Linux. `mac` holds the frameworks
//! (ScreenCaptureKit, CoreGraphics events, AppKit, Accessibility's trust check, Security's code signing and
//! authorization) and builds only for macOS.

pub mod as_user;
pub mod ax_plan;
pub mod frame;
pub mod input_plan;
pub mod install;
pub mod ipc;
pub mod join;
pub mod paths;
pub mod peer;
pub mod permissions;
pub mod plists;
pub mod power;
pub mod programs;
pub mod remove;
pub mod role;
pub mod safe_files;
pub mod server;
pub mod service;
pub mod setup;
pub mod show_request;
pub mod state;
pub mod uninstall;
pub mod update;
pub mod zipscan;

#[cfg(target_os = "macos")]
pub mod mac;

/// The app's version: the core's, so the bundle, the hello and the check-in agree.
pub const VERSION: &str = support_core::VERSION;

// SUPPORT_TEST_BROKEN makes a `test-release` build's service exit at start (the update test's broken version). Any other
// build stops here when it is set.
#[cfg(not(feature = "test-release"))]
const _: () = assert!(
    option_env!("SUPPORT_TEST_BROKEN").is_none(),
    "SUPPORT_TEST_BROKEN is set in the build environment. Only a build with the test-release feature may use it."
);
