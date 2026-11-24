//! `support`: see src/role.rs for the roles.

use support_mac::role::{self, Launch, Role};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let role = match role::launch(&args) {
        Ok(Launch::Role(r)) => r,
        // Opened as an app with no helper registered with LaunchServices (stopped), or the binary started directly:
        // show this session's helper, never start a second one. While the helper runs, Finder and `open` reach it
        // as a reopen event instead, and this branch does not run.
        Ok(Launch::App) => std::process::exit(open_app()),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let code = match role {
        Role::Version => {
            println!("Support {}", support_mac::VERSION);
            0
        }
        // These two work the same anywhere: they only drop to a user and do one thing.
        Role::FileOp { uid, op } => support_mac::as_user::file_op_main(uid, &op),
        Role::RunAs { uid, command } => {
            let e = support_mac::as_user::run_as_main(uid, &command);
            eprintln!("{e}");
            126
        }
        other => run_mac(other),
    };
    std::process::exit(code);
}

#[cfg(target_os = "macos")]
fn run_mac(role: Role) -> i32 {
    support_mac::mac::run(role)
}

#[cfg(not(target_os = "macos"))]
fn run_mac(_role: Role) -> i32 {
    eprintln!("This role runs only on a Mac.");
    2
}

#[cfg(target_os = "macos")]
fn open_app() -> i32 {
    support_mac::mac::open_app()
}

#[cfg(not(target_os = "macos"))]
fn open_app() -> i32 {
    eprintln!("{}", role::usage());
    2
}
