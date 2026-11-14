//! The one binary's roles, chosen by its first argument. PR 4 adds nothing here (Accessibility lives in the helper),
//! PR 5 adds `join` (the one-off app, a separate bundle) and PR 7 adds the update roles. Each is a new variant, so a
//! role that is not built yet is refused like any unknown one.
//!
//! | Role | Runs as | Started by |
//! |---|---|---|
//! | `device-service` | root | the LaunchDaemon |
//! | `helper` | the signed-in user, or root at the login window | the LaunchAgent |
//! | `setup` | an administrator (the CLI under sudo) | a person |
//! | `uninstall` | an administrator (the CLI under sudo); `--finish` as root, by the service | a person, the service |
//! | `file-op` | root, which drops to the user first | the service |
//! | `run-as` | root, which drops to the user first | the service, through `launchctl asuser` |

/// What a setup from the command line gives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupArgs {
    pub link: String,
    /// A pairing code, when the link carries none.
    pub code: Option<String>,
    pub name: String,
    pub access: String,
    pub control: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileOp {
    /// Reads `length` bytes from `offset` and writes one JSON line on stdout.
    Get { path: String, offset: u64, length: usize },
    /// Writes stdin to the file (replaces it, or appends) and writes one JSON line on stdout.
    Put { path: String, append: bool },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    DeviceService,
    Helper,
    Setup(SetupArgs),
    /// `finish`: the service's own last step, after it has left the relay (the jobs, the files, the permissions).
    Uninstall {
        finish: bool,
    },
    FileOp {
        uid: u32,
        op: FileOp,
    },
    RunAs {
        uid: u32,
        command: String,
    },
    Version,
}

const USAGE: &str = "usage:
  sudo support setup --link <setup link> --name <name> --access ask|any --control full|limited [--code <code>]
  sudo support uninstall
  support version
The other roles are started by the system (device-service, helper) or by the service itself.";

pub fn usage() -> &'static str {
    USAGE
}

/// The value after `--name`, once. A flag given twice, or without a value, is an error.
fn take(args: &[String], name: &str) -> Result<Option<String>, String> {
    let mut found = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == name {
            if found.is_some() {
                return Err(format!("{name} is given twice"));
            }
            let v = args.get(i + 1).filter(|v| !v.starts_with("--")).ok_or_else(|| format!("{name} needs a value"))?;
            found = Some(v.clone());
            i += 2;
        } else {
            i += 1;
        }
    }
    Ok(found)
}

/// Every argument must be one of `flags` (with a value) or `switches` (without).
fn only(args: &[String], flags: &[&str], switches: &[&str]) -> Result<(), String> {
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if flags.contains(&a) {
            i += 2;
        } else if switches.contains(&a) {
            i += 1;
        } else {
            return Err(format!("unknown argument {a:?}"));
        }
    }
    Ok(())
}

fn uid_arg(args: &[String]) -> Result<u32, String> {
    let text = take(args, "--uid")?.ok_or("--uid is required")?;
    // Digits only: no sign, no spaces. A user's uid is never 0 here; root's work never drops privileges.
    if text.is_empty() || text.len() > 10 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err("--uid must be a number".into());
    }
    match text.parse::<u32>() {
        Ok(0) => Err("--uid must not be 0".into()),
        Ok(n) => Ok(n),
        Err(_) => Err("--uid must be a number".into()),
    }
}

fn number<T: std::str::FromStr>(args: &[String], name: &str, default: Option<T>) -> Result<T, String> {
    match take(args, name)? {
        Some(t) if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) => t.parse().map_err(|_| format!("{name} is out of range")),
        Some(_) => Err(format!("{name} must be a number")),
        None => default.ok_or_else(|| format!("{name} is required")),
    }
}

/// The arguments after the program name.
pub fn parse(args: &[String]) -> Result<Role, String> {
    let Some(first) = args.first() else { return Err(USAGE.to_string()) };
    let rest = &args[1..];
    match first.as_str() {
        "device-service" if rest.is_empty() => Ok(Role::DeviceService),
        "helper" if rest.is_empty() => Ok(Role::Helper),
        "version" | "--version" if rest.is_empty() => Ok(Role::Version),
        "setup" => {
            only(rest, &["--link", "--code", "--name", "--access", "--control"], &[])?;
            let link = take(rest, "--link")?.ok_or("--link is required")?;
            let name = take(rest, "--name")?.ok_or("--name is required")?;
            // Nothing is chosen for the person: access and control must be given.
            let access = take(rest, "--access")?.ok_or("--access is required (ask or any)")?;
            let control = take(rest, "--control")?.ok_or("--control is required (full or limited)")?;
            if access != "ask" && access != "any" {
                return Err("--access must be ask or any".into());
            }
            if control != "full" && control != "limited" {
                return Err("--control must be full or limited".into());
            }
            Ok(Role::Setup(SetupArgs { link, code: take(rest, "--code")?, name, access, control }))
        }
        "uninstall" => {
            only(rest, &[], &["--finish"])?;
            Ok(Role::Uninstall { finish: rest.iter().any(|a| a == "--finish") })
        }
        "file-op" => {
            let (verb, opts) = rest.split_first().ok_or("file-op needs get or put")?;
            let uid = uid_arg(opts)?;
            let path = take(opts, "--path")?.ok_or("--path is required")?;
            let op = match verb.as_str() {
                "get" => {
                    only(opts, &["--uid", "--path", "--offset", "--length"], &[])?;
                    FileOp::Get { path, offset: number(opts, "--offset", Some(0))?, length: number(opts, "--length", None)? }
                }
                "put" => {
                    only(opts, &["--uid", "--path"], &["--append"])?;
                    FileOp::Put { path, append: opts.iter().any(|a| a == "--append") }
                }
                _ => return Err("file-op needs get or put".into()),
            };
            Ok(Role::FileOp { uid, op })
        }
        "run-as" => {
            // run-as --uid <uid> -- <command>: everything after -- is the one command text.
            let dash = rest.iter().position(|a| a == "--").ok_or("run-as needs -- before the command")?;
            let (opts, command) = (&rest[..dash], &rest[dash + 1..]);
            only(opts, &["--uid"], &[])?;
            if command.len() != 1 {
                return Err("run-as takes the command as one argument".into());
            }
            Ok(Role::RunAs { uid: uid_arg(opts)?, command: command[0].clone() })
        }
        _ => Err(USAGE.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(line: &[&str]) -> Result<Role, String> {
        parse(&line.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn the_system_roles_take_no_arguments() {
        assert_eq!(p(&["device-service"]), Ok(Role::DeviceService));
        assert_eq!(p(&["helper"]), Ok(Role::Helper));
        assert_eq!(p(&["version"]), Ok(Role::Version));
        assert!(p(&["device-service", "--x"]).is_err());
        assert!(p(&["helper", "extra"]).is_err());
        assert!(p(&[]).is_err());
        // Roles of later PRs are unknown until they are built.
        for later in ["join", "device-update", "update-rollback", "--service"] {
            assert!(p(&[later]).is_err(), "{later}");
        }
    }

    #[test]
    fn setup_needs_every_answer_and_preselects_nothing() {
        let ok = p(&["setup", "--link", "https://r.example/install?code=ABCDE-FGH23", "--name", "Mac", "--access", "ask", "--control", "limited"]);
        assert_eq!(
            ok,
            Ok(Role::Setup(SetupArgs {
                link: "https://r.example/install?code=ABCDE-FGH23".into(),
                code: None,
                name: "Mac".into(),
                access: "ask".into(),
                control: "limited".into()
            }))
        );
        assert!(p(&["setup", "--link", "l", "--name", "n", "--access", "ask"]).unwrap_err().contains("--control"));
        assert!(p(&["setup", "--link", "l", "--name", "n", "--control", "full"]).unwrap_err().contains("--access"));
        assert!(p(&["setup", "--link", "l", "--name", "n", "--access", "always", "--control", "full"]).is_err());
        assert!(p(&["setup", "--link", "l", "--name", "n", "--access", "any", "--control", "root"]).is_err());
        assert!(p(&["setup", "--link", "l", "--link", "m", "--name", "n", "--access", "any", "--control", "full"]).unwrap_err().contains("twice"));
        assert!(p(&["setup", "--link", "--name", "n", "--access", "any", "--control", "full"]).is_err());
        assert!(p(&["setup", "--link", "l", "--name", "n", "--access", "any", "--control", "full", "--yes"]).is_err());
    }

    #[test]
    fn file_op_and_run_as_name_a_real_user_and_nothing_else() {
        assert_eq!(
            p(&["file-op", "get", "--uid", "501", "--path", "/Users/a/x", "--offset", "5", "--length", "100"]),
            Ok(Role::FileOp { uid: 501, op: FileOp::Get { path: "/Users/a/x".into(), offset: 5, length: 100 } })
        );
        assert_eq!(
            p(&["file-op", "put", "--uid", "501", "--path", "/Users/a/x", "--append"]),
            Ok(Role::FileOp { uid: 501, op: FileOp::Put { path: "/Users/a/x".into(), append: true } })
        );
        for uid in ["0", "-1", "+5", " 5", "abc", "99999999999", ""] {
            assert!(p(&["file-op", "put", "--uid", uid, "--path", "/x"]).is_err(), "{uid:?}");
        }
        assert!(p(&["file-op", "get", "--uid", "501", "--path", "/x"]).unwrap_err().contains("--length"));
        assert!(p(&["file-op", "rm", "--uid", "501", "--path", "/x"]).is_err());
        assert!(p(&["file-op", "put", "--uid", "501", "--path", "/x", "--offset", "1"]).is_err());

        assert_eq!(p(&["run-as", "--uid", "501", "--", "id -un; sw_vers"]), Ok(Role::RunAs { uid: 501, command: "id -un; sw_vers".into() }));
        assert!(p(&["run-as", "--uid", "501", "--", "a", "b"]).is_err());
        assert!(p(&["run-as", "--uid", "501", "id"]).is_err());
        assert!(p(&["run-as", "--uid", "0", "--", "id"]).is_err());
    }

    #[test]
    fn uninstall_has_one_switch() {
        assert_eq!(p(&["uninstall"]), Ok(Role::Uninstall { finish: false }));
        assert_eq!(p(&["uninstall", "--finish"]), Ok(Role::Uninstall { finish: true }));
        assert!(p(&["uninstall", "--force"]).is_err());
    }
}
