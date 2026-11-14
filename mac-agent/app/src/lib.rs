//! The Support-MCP Mac app: one binary, `support`, with a role per process (`role`). The root service (`service`)
//! runs the core's device service and is its `Platform`; the helper in each session does the screen, the input and
//! the windows; the socket between them (`server`, `frame`, `ipc`, `peer`) is the privilege boundary.
//!
//! Everything that does not need macOS is here, outside `mac`, and is tested on Linux. `mac` holds the frameworks
//! (ScreenCaptureKit, CoreGraphics events, AppKit, Accessibility's trust check, Security's code signing and
//! authorization) and builds only for macOS.

pub mod as_user;
pub mod frame;
pub mod input_plan;
pub mod ipc;
pub mod paths;
pub mod peer;
pub mod plists;
pub mod power;
pub mod programs;
pub mod role;
pub mod safe_files;
pub mod server;
pub mod service;
pub mod setup;
pub mod state;
pub mod uninstall;

#[cfg(target_os = "macos")]
pub mod mac;

/// The app's version: the core's, so the bundle, the hello and the check-in agree.
pub const VERSION: &str = support_core::VERSION;
