//! The command line (`sudo support setup ...`, `sudo support uninstall`), the service's last uninstall step, and the
//! client side of the socket that the helper's windows use too.

use crate::frame;
use crate::ipc::{self, Request, SetupRequest};
use crate::paths;
use crate::role::SetupArgs;
use crate::setup;
use serde_json::{Map, Value};
use std::os::fd::AsRawFd;
use std::time::Duration;

/// Sends one request to the service and reads its answer. The socket's folder is root's, and the peer must be root.
pub fn call(req: &Request, timeout: Duration) -> Result<Map<String, Value>, String> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let mut s = tokio::net::UnixStream::connect(paths::SOCKET_PATH).await.map_err(|_| "Support's service is not running.".to_string())?;
        let (mut uid, mut gid) = (1u32, 1u32);
        // SAFETY: local out-parameters on a live socket.
        if unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != 0 {
            return Err("the socket is not Support's service".to_string());
        }
        frame::write(&mut s, &ipc::request_message(req)).await.map_err(|e| e.to_string())?;
        tokio::time::timeout(timeout, frame::read(&mut s, None))
            .await
            .map_err(|_| "Support's service did not answer.".to_string())?
            .map_err(|e| e.to_string())
    })
}

/// The six digits as people read them: 123 456.
pub fn digits(code: &str) -> String {
    if code.len() == 6 {
        format!("{} {}", &code[..3], &code[3..])
    } else {
        code.to_string()
    }
}

pub fn setup(args: &SetupArgs) -> i32 {
    // Checked here first, so a typo needs no password.
    if let Err(e) = setup::parse_link(&args.link, args.code.as_deref()).and_then(|_| setup::check_name(&args.name)) {
        eprintln!("{e}");
        return 2;
    }
    let auth = match super::auth::acquire("Support wants to set up remote support on this Mac.") {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let req = Request::Setup(SetupRequest {
        auth: auth.external,
        link: args.link.clone(),
        code: args.code.clone(),
        name: args.name.clone(),
        access: args.access.clone(),
        control: args.control.clone(),
    });
    let answer = call(&req, Duration::from_secs(90));
    drop(auth);
    match answer {
        Ok(m) if m.get("ok") == Some(&Value::Bool(true)) => {
            match m.get("confirm").and_then(Value::as_str) {
                Some(c) => println!("Support is waiting for your support team to approve this Mac. Read them these six digits: {}", digits(c)),
                None => println!("Support is set up. Your support team can now reach this Mac."),
            }
            0
        }
        Ok(m) => {
            eprintln!("{}", m.get("error").and_then(Value::as_str).unwrap_or("Setup failed."));
            1
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

pub fn uninstall() -> i32 {
    let auth = match super::auth::acquire("Support wants to remove itself from this Mac.") {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let answer = call(&Request::Uninstall { auth: auth.external }, Duration::from_secs(60));
    drop(auth);
    match answer {
        Ok(m) if m.get("ok") == Some(&Value::Bool(true)) => {
            if m.get("relay_confirmed") == Some(&Value::Bool(false)) {
                println!("Support was removed. Your support team's server did not confirm it, so ask them to remove this Mac from their list.");
            } else {
                println!("Support was removed.");
            }
            0
        }
        Ok(m) => {
            eprintln!("{}", m.get("error").and_then(Value::as_str).unwrap_or("Uninstall failed."));
            1
        }
        // No service to ask: root can still take everything away by hand.
        // SAFETY: a getter.
        Err(_) if unsafe { libc::geteuid() } == 0 => {
            if let Some(s) = crate::state::load(std::path::Path::new(paths::DATA_DIR)).filter(|s| !s.finished()) {
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build();
                if let (Ok(rt), Ok(link)) = (rt, support_core::device::DeviceLink::new(&s.origin)) {
                    rt.block_on(link.leave(&s.key));
                }
            }
            finish_now()
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

fn finish_now() -> i32 {
    let procs = || <super::os::MacOs as crate::service::Os>::processes(&super::os::MacOs::new());
    let steps = crate::uninstall::finish_steps(&crate::uninstall::gui_uids(&procs()));
    let failed = crate::uninstall::run_steps(&steps, std::process::id() as i32, procs);
    for f in &failed {
        eprintln!("support: could not undo: {f}");
    }
    i32::from(!failed.is_empty())
}

/// `uninstall --finish`: started detached by the service once it has left the team.
pub fn finish() -> i32 {
    // SAFETY: a getter.
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("This runs as root, from Support's service.");
        return 2;
    }
    // Give the service a moment to answer the person who asked.
    std::thread::sleep(Duration::from_secs(1));
    finish_now()
}
