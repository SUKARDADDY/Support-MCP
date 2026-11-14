//! The macOS side: the frameworks, and each role's entry point.

pub mod auth;
pub mod capture;
pub mod cli;
pub mod helper;
pub mod input;
pub mod os;
pub mod peer;
pub mod ui;

use crate::role::Role;
use std::sync::Arc;

/// Runs a role that needs macOS. Returns the exit code.
pub fn run(role: Role) -> i32 {
    match role {
        Role::DeviceService => {
            // SAFETY: a getter.
            if unsafe { libc::geteuid() } != 0 {
                eprintln!("The device service runs as root, from its LaunchDaemon.");
                return 2;
            }
            let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("{e}");
                    return 1;
                }
            };
            let os = Arc::new(os::MacOs::new());
            let inspector = match peer::MacInspector::new() {
                Ok(i) => Arc::new(i),
                Err(e) => {
                    // Without its own designated requirement the service cannot check anyone: it serves nobody.
                    eprintln!("support: {e}");
                    return 1;
                }
            };
            let code = match rt.block_on(crate::service::run(os, inspector, crate::paths::DATA_DIR.into(), 0)) {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("support: {e}");
                    1
                }
            };
            // Exit at once: commands and the session's threads are not waited for (see service::run).
            std::process::exit(code)
        }
        Role::Helper => helper::main(),
        Role::Setup(args) => cli::setup(&args),
        Role::Uninstall { finish: false } => cli::uninstall(),
        Role::Uninstall { finish: true } => cli::finish(),
        // Handled before this is called.
        Role::Version | Role::FileOp { .. } | Role::RunAs { .. } => 2,
    }
}
