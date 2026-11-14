//! Working as the signed-in person instead of root. The root service never runs a person's command or opens their
//! files with root's rights: it starts this same binary as a child, which drops to the person's uid, gid and groups
//! first and checks it cannot get root back, and only then does the work.
//!
//! - `run-as --uid <uid> -- <command>`: started through `launchctl asuser <uid>`, so the command runs in the person's
//!   own bootstrap (it can open apps in their session), in their home folder, with zsh, in its own process group.
//! - `file-op get|put --uid <uid> --path <path> ...`: put_file and get_file under limited control. The data goes
//!   through stdin and stdout, and the answer is one JSON line.

use crate::paths;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use support_core::files;
use support_core::wire::{GET_LENGTH_MAX, PUT_B64_MAX};

/// The most bytes a put brings on stdin: the largest chunk the relay sends, decoded.
pub const PUT_MAX: usize = PUT_B64_MAX / 4 * 3;
/// The most bytes read from a file-op child's stdout: one get's base64 and its fields.
pub const ANSWER_MAX: usize = 1 << 20;
pub const FILE_OP_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
}

/// The account of a uid, from the system's user database.
pub fn account(uid: u32) -> Option<Account> {
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: a zeroed passwd is a valid out-parameter, the buffer is as long as we say, and the result pointer is
    // checked before the entry is read.
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe { libc::getpwuid_r(uid as libc::uid_t, &mut pw, buf.as_mut_ptr(), buf.len(), &mut out) };
    if rc != 0 || out.is_null() || pw.pw_name.is_null() {
        return None;
    }
    // SAFETY: getpwuid_r filled these with C strings inside `buf`.
    let text = |p: *const libc::c_char| if p.is_null() { String::new() } else { unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned() };
    Some(Account { name: text(pw.pw_name), uid: pw.pw_uid, gid: pw.pw_gid, home: text(pw.pw_dir) })
}

/// Becomes the person: their groups, gid and uid, in that order, then checks that root cannot be had back. Run as
/// root. A process that already is that person (a test, or the person themselves) goes on as it is; any other
/// caller is refused, so this can never be used to become someone else.
pub fn become_user(uid: u32) -> Result<Account, String> {
    if uid == 0 {
        return Err("this never runs as root".into());
    }
    let acct = account(uid).ok_or_else(|| format!("there is no user {uid}"))?;
    // SAFETY: plain getters and setters of this process's ids, checked after each call.
    unsafe {
        if libc::geteuid() != 0 {
            if libc::getuid() == uid && libc::geteuid() == uid {
                return Ok(acct);
            }
            return Err("only root can work as another user".into());
        }
        let name = CString::new(acct.name.clone()).map_err(|_| "a bad user name")?;
        if libc::initgroups(name.as_ptr(), acct.gid as _) != 0 {
            return Err(format!("initgroups: {}", std::io::Error::last_os_error()));
        }
        if libc::setgid(acct.gid) != 0 {
            return Err(format!("setgid: {}", std::io::Error::last_os_error()));
        }
        if libc::setuid(uid) != 0 {
            return Err(format!("setuid: {}", std::io::Error::last_os_error()));
        }
        if libc::getuid() != uid || libc::geteuid() != uid || libc::getgid() != acct.gid || libc::getegid() != acct.gid || libc::setuid(0) == 0 {
            return Err("the switch to the user did not hold".into());
        }
    }
    Ok(acct)
}

/// The environment a person's command starts with: nothing of root's.
pub fn user_env(acct: &Account) -> Vec<(String, String)> {
    vec![
        ("HOME".into(), acct.home.clone()),
        ("USER".into(), acct.name.clone()),
        ("LOGNAME".into(), acct.name.clone()),
        ("SHELL".into(), paths::SHELL.into()),
        ("PATH".into(), paths::RUN_PATH.into()),
        ("LANG".into(), "en_US.UTF-8".into()),
    ]
}

/// The `run-as` role: becomes the person and replaces itself with zsh running the command. Returns only on failure.
pub fn run_as_main(uid: u32, command: &str) -> String {
    let acct = match become_user(uid) {
        Ok(a) => a,
        Err(e) => return e,
    };
    let home = if Path::new(&acct.home).is_dir() { acct.home.clone() } else { "/".to_string() };
    let mut cmd = Command::new(paths::SHELL);
    cmd.arg("-c").arg(command).current_dir(home).env_clear().envs(user_env(&acct));
    #[cfg(target_os = "macos")]
    if let Some(tmp) = darwin_temp_dir() {
        cmd.env("TMPDIR", tmp);
    }
    let e = std::os::unix::process::CommandExt::exec(&mut cmd);
    format!("could not start {}: {e}", paths::SHELL)
}

/// The person's own temporary folder (after the switch, so it is theirs).
#[cfg(target_os = "macos")]
fn darwin_temp_dir() -> Option<String> {
    let mut buf = vec![0 as libc::c_char; 1024];
    // SAFETY: the buffer is as long as we say; confstr NUL-terminates what it writes.
    let n = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, buf.as_mut_ptr(), buf.len()) };
    if n == 0 || n > buf.len() {
        return None;
    }
    Some(unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().into_owned())
}

/// The command the service runs for a person: `launchctl asuser <uid> <this binary> run-as --uid <uid> -- <command>`.
pub fn user_command(exe: &Path, uid: u32, command: &str) -> Command {
    let mut c = Command::new(paths::LAUNCHCTL);
    c.arg("asuser").arg(uid.to_string()).arg(exe).arg("run-as").arg("--uid").arg(uid.to_string()).arg("--").arg(command);
    c.env_clear().env("PATH", paths::RUN_PATH).current_dir("/");
    c
}

/// The command the service runs as root (`as: "system"`, full control only): zsh in /var/root.
pub fn root_command(command: &str) -> Command {
    let mut c = Command::new(paths::SHELL);
    c.arg("-c").arg(command).current_dir(paths::ROOT_HOME).env_clear().envs([
        ("HOME", paths::ROOT_HOME),
        ("USER", "root"),
        ("LOGNAME", "root"),
        ("SHELL", paths::SHELL),
        ("PATH", paths::RUN_PATH),
        ("LANG", "en_US.UTF-8"),
    ]);
    c
}

fn answer(v: Value) -> String {
    v.to_string()
}

/// The `file-op` role. Prints one JSON line and returns the exit code.
pub fn file_op_main(uid: u32, op: &crate::role::FileOp) -> i32 {
    let out = match file_op(uid, op) {
        Ok(v) => v,
        Err(e) => json!({ "ok": false, "error": support_core::wire::clean(&e, 300) }),
    };
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}", answer(out));
    0
}

fn file_op(uid: u32, op: &crate::role::FileOp) -> Result<Value, String> {
    become_user(uid)?;
    match op {
        crate::role::FileOp::Put { path, append } => {
            let checked = files::absolute_path(path)?;
            let mut data = Vec::new();
            std::io::stdin().lock().take(PUT_MAX as u64 + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
            if data.len() > PUT_MAX {
                return Err("File chunk too large.".into());
            }
            let n = files::put(&checked, &data, *append)?;
            Ok(json!({ "ok": true, "bytes": n }))
        }
        crate::role::FileOp::Get { path, offset, length } => {
            let checked = files::absolute_path(path)?;
            if *length == 0 || *length > GET_LENGTH_MAX as usize {
                return Err("length is out of range".into());
            }
            let c = files::get(&checked, *offset, *length)?;
            Ok(json!({ "ok": true, "data_b64": B64.encode(&c.data), "size": c.size, "eof": c.eof }))
        }
    }
}

/// Runs a file-op child for `uid` and reads its answer. `exe` is this binary.
pub fn spawn_file_op(exe: &Path, uid: u32, op: &crate::role::FileOp, input: &[u8]) -> Result<Value, String> {
    let mut c = Command::new(exe);
    c.arg("file-op");
    match op {
        crate::role::FileOp::Get { path, offset, length } => {
            c.arg("get").args(["--uid", &uid.to_string(), "--path", path, "--offset", &offset.to_string(), "--length", &length.to_string()]);
        }
        crate::role::FileOp::Put { path, append } => {
            c.arg("put").args(["--uid", &uid.to_string(), "--path", path]);
            if *append {
                c.arg("--append");
            }
        }
    }
    c.env_clear().current_dir("/").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = c.spawn().map_err(|e| format!("could not start the file helper: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let data = input.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&data);
    });
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = (&mut stdout).take(ANSWER_MAX as u64 + 1).read_to_end(&mut out);
        out
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > FILE_OP_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("the file operation took too long".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let _ = writer.join();
    let out = reader.join().map_err(|_| "the file helper's answer was lost")?;
    read_file_answer(&out, op)
}

/// Checks a file-op child's answer strictly, as anything a lower-privileged process says.
pub fn read_file_answer(out: &[u8], op: &crate::role::FileOp) -> Result<Value, String> {
    const BAD: &str = "the file helper gave no answer";
    if out.len() > ANSWER_MAX {
        return Err(BAD.into());
    }
    let v: Value = serde_json::from_slice(out).map_err(|_| BAD)?;
    let m = v.as_object().ok_or(BAD)?;
    match m.get("ok") {
        Some(Value::Bool(false)) => Err(m.get("error").and_then(Value::as_str).map(|e| support_core::wire::clean(e, 300)).ok_or(BAD)?),
        Some(Value::Bool(true)) => match op {
            crate::role::FileOp::Put { .. } => {
                let n = m.get("bytes").and_then(Value::as_u64).filter(|n| *n <= PUT_MAX as u64).ok_or(BAD)?;
                Ok(json!({ "bytes": n }))
            }
            crate::role::FileOp::Get { length, .. } => {
                let text = m.get("data_b64").and_then(Value::as_str).ok_or(BAD)?;
                let data = B64.decode(text).map_err(|_| BAD)?;
                if data.len() > *length {
                    return Err(BAD.into());
                }
                let size = m.get("size").and_then(Value::as_u64).ok_or(BAD)?;
                let eof = m.get("eof").and_then(Value::as_bool).ok_or(BAD)?;
                Ok(json!({ "data": B64.encode(&data), "size": size, "eof": eof }))
            }
        },
        _ => Err(BAD.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::role::FileOp;

    #[test]
    fn a_person_command_goes_through_their_bootstrap_and_this_binary() {
        let c = user_command(Path::new(paths::BINARY_PATH), 501, "id -un; sw_vers");
        assert_eq!(c.get_program(), paths::LAUNCHCTL);
        let args: Vec<_> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, vec!["asuser", "501", paths::BINARY_PATH, "run-as", "--uid", "501", "--", "id -un; sw_vers"]);
        // The person's command line then reads back as the same role.
        assert_eq!(crate::role::parse(&args[2 + 1..]), Ok(crate::role::Role::RunAs { uid: 501, command: "id -un; sw_vers".into() }));
        let envs: Vec<_> = c.get_envs().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        assert_eq!(envs, vec!["PATH"], "nothing of root's environment goes along");
    }

    #[test]
    fn a_root_command_starts_in_var_root_with_a_clean_environment() {
        let c = root_command("whoami");
        assert_eq!(c.get_program(), paths::SHELL);
        assert_eq!(c.get_current_dir(), Some(Path::new("/var/root")));
        assert!(c.get_envs().any(|(k, v)| k == "HOME" && v == Some(std::ffi::OsStr::new("/var/root"))));
    }

    #[test]
    fn nobody_but_root_becomes_someone_else() {
        // SAFETY: getters.
        let (me, euid) = unsafe { (libc::getuid(), libc::geteuid()) };
        assert!(become_user(0).is_err());
        if euid != 0 {
            assert_eq!(become_user(me).unwrap().uid, me, "being yourself already is fine");
            assert!(become_user(me + 1).is_err());
        }
    }

    #[test]
    fn a_childs_answer_is_read_strictly() {
        let put = FileOp::Put { path: "/x".into(), append: false };
        let get = FileOp::Get { path: "/x".into(), offset: 0, length: 4 };
        assert_eq!(read_file_answer(br#"{"ok":true,"bytes":3}"#, &put).unwrap(), json!({"bytes":3}));
        assert_eq!(read_file_answer(br#"{"ok":false,"error":"denied"}"#, &put).unwrap_err(), "denied");
        assert!(read_file_answer(br#"{"ok":true,"bytes":-1}"#, &put).is_err());
        assert!(read_file_answer(b"", &put).is_err());
        assert!(read_file_answer(b"garbage", &put).is_err());
        let ok = read_file_answer(br#"{"ok":true,"data_b64":"YWJj","size":3,"eof":true}"#, &get).unwrap();
        assert_eq!(ok, json!({"data":"YWJj","size":3,"eof":true}));
        assert!(read_file_answer(br#"{"ok":true,"data_b64":"YWJjZGVm","size":6,"eof":true}"#, &get).is_err(), "more than was asked");
        assert!(read_file_answer(br#"{"ok":true,"data_b64":"!!","size":3,"eof":true}"#, &get).is_err());
    }
}
