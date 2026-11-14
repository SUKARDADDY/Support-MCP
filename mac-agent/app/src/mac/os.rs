//! The service's view of macOS: who is at the console, the Mac's name and version, FileVault, power, processes, and
//! the commands that work as a person.

use crate::as_user;
use crate::ipc::AUTH_LEN;
use crate::paths;
use crate::power::{self, FileVault};
use crate::programs::{self, Proc};
use crate::role::FileOp;
use crate::service::Os;
use serde_json::Value;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use support_core::device::{self, Identity};

/// The owner of /dev/console: the person at the screen, or root at the login window.
pub fn console_uid() -> Option<u32> {
    let path = std::ffi::CString::new("/dev/console").ok()?;
    // SAFETY: a zeroed stat is a valid out-parameter.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::stat(path.as_ptr(), &mut st) } != 0 {
        return None;
    }
    (st.st_uid != 0).then_some(st.st_uid)
}

/// One line of a tool's output, or "" when it fails.
fn tool(path: &str, args: &[&str]) -> String {
    Command::new(path)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// This binary, for the `run-as` and `file-op` children.
fn self_exe() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from(paths::BINARY_PATH))
}

pub struct MacOs {
    identity: Mutex<Option<(Identity, Instant)>>,
}

impl MacOs {
    pub fn new() -> MacOs {
        MacOs { identity: Mutex::new(None) }
    }
}

impl Default for MacOs {
    fn default() -> Self {
        Self::new()
    }
}

impl Os for MacOs {
    fn console_uid(&self) -> Option<u32> {
        console_uid()
    }

    /// Read once every 10 minutes: the computer's name can change in System Settings, the version at an update.
    fn identity(&self) -> Identity {
        let mut cached = self.identity.lock().unwrap();
        if let Some((id, at)) = cached.as_ref() {
            if at.elapsed() < Duration::from_secs(600) {
                return id.clone();
            }
        }
        let mut machine = tool(paths::SCUTIL, &["--get", "ComputerName"]);
        if machine.is_empty() {
            machine = tool("/bin/hostname", &["-s"]);
        }
        let id = Identity {
            os: device::os_string(&tool(paths::SW_VERS, &["-productVersion"]), &tool(paths::SW_VERS, &["-buildVersion"])),
            machine: support_core::wire::clean(&machine, 100),
            app_version: support_core::VERSION.to_string(),
        };
        *cached = Some((id.clone(), Instant::now()));
        id
    }

    fn filevault(&self) -> FileVault {
        match Command::new(paths::FDESETUP).arg("isactive").stdin(Stdio::null()).stderr(Stdio::null()).output() {
            Ok(o) => power::read_fdesetup(o.status.code(), &String::from_utf8_lossy(&o.stdout)),
            Err(_) => FileVault::Unknown,
        }
    }

    fn power(&self, restart: bool) -> Result<(), String> {
        let flag = if restart { "-r" } else { "-h" };
        let status = Command::new(paths::SHUTDOWN).args([flag, "now"]).stdin(Stdio::null()).status().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("shutdown exited with {status}"))
        }
    }

    fn processes(&self) -> Vec<Proc> {
        let out = Command::new(paths::PS).args(["-axo", "pid=,uid=,comm="]).stdin(Stdio::null()).stderr(Stdio::null()).output();
        out.map(|o| programs::parse_ps(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default()
    }

    fn verify_admin(&self, auth: &[u8; AUTH_LEN], peer: crate::peer::Peer) -> Result<(), String> {
        super::auth::verify(auth, peer)
    }

    fn user_command(&self, uid: u32, command: &str) -> Command {
        as_user::user_command(&self_exe(), uid, command)
    }

    fn file_as_user(&self, uid: u32, op: &FileOp, input: &[u8]) -> Result<Value, String> {
        as_user::spawn_file_op(&self_exe(), uid, op, input)
    }

    fn uninstall_finish(&self) -> Result<(), String> {
        let mut c = Command::new(self_exe());
        c.args(["uninstall", "--finish"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).current_dir("/");
        // SAFETY: setsid is async-signal-safe. The child leaves the service's process group, so launchd's bootout of
        // the service does not take it along.
        unsafe {
            c.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        c.spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}
