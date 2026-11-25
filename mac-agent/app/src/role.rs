//! The one binary's roles, chosen by its first argument. The one-off join app is not a role here: it is a binary and a
//! bundle of its own (`support-join`), so a link can never reach the root-backed app. Anything else is refused.
//!
//! | Role | Runs as | Started by |
//! |---|---|---|
//! | `device-service` | root | the LaunchDaemon |
//! | `helper` | the signed-in user, or root at the login window | the LaunchAgent |
//! | `setup` | an administrator (the CLI under sudo) | a person |
//! | `uninstall` | an administrator (the CLI under sudo); `--finish` as root, by the service | a person, the service |
//! | `file-op` | root, which drops to the user first | the service |
//! | `run-as` | root, which drops to the user first | the service, through `launchctl asuser` |
//! | `update-watch` | root, from the old app's copy in the data folder | launchd, for an update's trial (src/update.rs) |
//!
//! While the helper runs, Finder, Launchpad and `open` do not start this binary: the helper is the bundle's running
//! instance, so they send it a reopen event, which its app delegate turns into its window. With no arguments the
//! binary was opened as an app only when no helper is registered with LaunchServices (it is stopped) or the binary
//! was started directly. It never starts a second helper: it asks this session's helper (the LaunchAgent's) to show
//! its window, or has launchd start it (see `app_launch`).

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
    /// The update watcher. `restart`: it restarts the service and the helpers first (loaded by the switch).
    UpdateWatch {
        restart: bool,
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

/// What the binary does with its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    /// A role, chosen by its first argument.
    Role(Role),
    /// No arguments: opened as an app.
    App,
}

/// The arguments after the program name: none is an app launch, anything else goes to `parse` as it is.
pub fn launch(args: &[String]) -> Result<Launch, String> {
    if args.is_empty() {
        return Ok(Launch::App);
    }
    parse(args).map(Launch::Role)
}

/// What an app launch does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppLaunch {
    /// This session's helper is running (the binary was started directly, since Finder and `open` would have sent the
    /// helper a reopen event): signal it to show its window (`launchctl kill`).
    Show,
    /// Its LaunchAgent is loaded but the helper is not running, so LaunchServices had no instance to reopen: have
    /// launchd start that one (`launchctl kickstart`).
    Start,
    /// There is no helper to reach from here. The text says why.
    Refuse(&'static str),
}

/// One step of an app launch, for `mac::open_app` to do in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchStep {
    /// Leave the show-request marker (`show_request`) for a helper that is about to start.
    WriteShowMarker,
    /// Run `launchctl` with these arguments.
    Launchctl(Vec<String>),
}

/// The steps of an app launch, in order. A running helper is signalled (`signal`). A stopped one gets the marker
/// first and is started after, so the marker is there whenever the new helper looks for it. Nothing else is safe: a
/// signal sent to a helper that has not installed its handler yet is dropped.
pub fn launch_steps(launch: &AppLaunch, target: &str, signal: i32) -> Vec<LaunchStep> {
    let ctl = |args: &[&str]| LaunchStep::Launchctl(args.iter().chain([&target]).map(|a| a.to_string()).collect());
    match launch {
        AppLaunch::Show => vec![ctl(&["kill", &signal.to_string()])],
        AppLaunch::Start => vec![LaunchStep::WriteShowMarker, ctl(&["kickstart"])],
        AppLaunch::Refuse(_) => Vec::new(),
    }
}

pub const NOT_INSTALLED: &str = "Support is not installed correctly on this Mac. Install it again with its installer.";

/// launchd's name for this session's helper: the LaunchAgent in the person's own GUI domain.
pub fn helper_target(uid: u32) -> String {
    format!("gui/{uid}/{}", crate::paths::AGENT_LABEL)
}

/// What an app launch does as `uid`, given what `launchctl print <helper_target>` wrote (None when it failed: the
/// LaunchAgent is not loaded in this session). Root has no GUI session of its own here (sudo, or the login window),
/// so it gets the usage. The helper is only ever launchd's, so there is one per session.
pub fn app_launch(uid: u32, print: Option<&str>) -> AppLaunch {
    if uid == 0 {
        return AppLaunch::Refuse(USAGE);
    }
    match print {
        None => AppLaunch::Refuse(NOT_INSTALLED),
        Some(text) if text.lines().any(|l| l.trim() == "state = running") => AppLaunch::Show,
        Some(_) => AppLaunch::Start,
    }
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
        "update-watch" => {
            only(rest, &[], &["--restart"])?;
            Ok(Role::UpdateWatch { restart: rest.iter().any(|a| a == "--restart") })
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
        // `join` is never a role of this binary: the one-off app is a binary of its own (src/bin/support_join.rs), so the
        // saved app can neither join a link nor be handed one. Roles of later PRs are unknown until they are built.
        for later in ["join", "device-update", "update-rollback", "--service", "update"] {
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
    fn no_arguments_is_an_app_launch_and_every_role_is_parsed_as_before() {
        assert_eq!(launch(&[]), Ok(Launch::App));
        let args = |line: &[&str]| line.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(launch(&args(&["helper"])), Ok(Launch::Role(Role::Helper)));
        assert_eq!(launch(&args(&["device-service"])), Ok(Launch::Role(Role::DeviceService)));
        assert_eq!(launch(&args(&["version"])), Ok(Launch::Role(Role::Version)));
        // Anything else is still a role or the usage, word for word.
        assert_eq!(launch(&args(&["join"])), Err(USAGE.to_string()));
        assert_eq!(launch(&args(&[""])), Err(USAGE.to_string()));
        assert!(launch(&args(&["setup", "--link", "l"])).unwrap_err().contains("--name"));
    }

    #[test]
    fn an_app_launch_shows_the_running_helper_or_has_launchd_start_it() {
        assert_eq!(helper_target(501), "gui/501/io.github.sukardaddy.supportmcp.helper");
        let running = "gui/501/io.github.sukardaddy.supportmcp.helper = {\n\tactive count = 1\n\tstate = running\n\tpid = 812\n}\n";
        let stopped = "gui/501/io.github.sukardaddy.supportmcp.helper = {\n\tactive count = 0\n\tstate = not running\n}\n";
        assert_eq!(app_launch(501, Some(running)), AppLaunch::Show);
        assert_eq!(app_launch(501, Some(stopped)), AppLaunch::Start);
        assert_eq!(app_launch(501, None), AppLaunch::Refuse(NOT_INSTALLED));
        // Root: sudo, or the login window's helper. Nothing to show; the usage as before.
        assert_eq!(app_launch(0, Some(running)), AppLaunch::Refuse(USAGE));
    }

    #[test]
    fn a_cold_launch_leaves_the_marker_before_it_starts_the_helper() {
        let t = "gui/501/io.github.sukardaddy.supportmcp.helper";
        let ctl = |a: &[&str]| LaunchStep::Launchctl(a.iter().map(|s| s.to_string()).chain([t.to_string()]).collect());
        // A stopped helper: the marker first, so it is there when the new helper looks, then the start.
        assert_eq!(launch_steps(&AppLaunch::Start, t, 29), vec![LaunchStep::WriteShowMarker, ctl(&["kickstart"])]);
        // A running helper already has its handler: the signal alone, and no marker to go stale.
        assert_eq!(launch_steps(&AppLaunch::Show, t, 29), vec![ctl(&["kill", "29"])]);
        assert!(launch_steps(&AppLaunch::Refuse(NOT_INSTALLED), t, 29).is_empty());
    }

    #[test]
    fn the_update_watcher_has_one_switch() {
        assert_eq!(p(&["update-watch"]), Ok(Role::UpdateWatch { restart: false }));
        assert_eq!(p(&["update-watch", "--restart"]), Ok(Role::UpdateWatch { restart: true }));
        assert!(p(&["update-watch", "--now"]).is_err());
        assert!(p(&["update-watch", "/tmp/x.pkg"]).is_err());
    }

    #[test]
    fn uninstall_has_one_switch() {
        assert_eq!(p(&["uninstall"]), Ok(Role::Uninstall { finish: false }));
        assert_eq!(p(&["uninstall", "--finish"]), Ok(Role::Uninstall { finish: true }));
        assert!(p(&["uninstall", "--force"]).is_err());
    }
}
