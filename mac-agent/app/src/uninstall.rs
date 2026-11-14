//! Uninstall: the service leaves the team (`/device/leave`) and stops, then starts `support uninstall --finish` as a
//! detached root process, which takes everything else away in this order, so nothing restarts half way:
//!
//! 1. the helper job in every signed-in session, then the service's job;
//! 2. any helper still running from the app;
//! 3. the two launchd property lists, the data folder and the socket folder;
//! 4. the Screen Recording and Accessibility permissions (`tccutil reset`) and the package receipt (`pkgutil --forget`);
//! 5. the app itself, last, since this process runs from it.

use crate::paths;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// A tool by its full path and its arguments. A failure is noted and the next step runs.
    Run(Vec<String>),
    /// Ends every process of the app's binary except this one.
    KillHelpers,
    RemoveFile(String),
    RemoveTree(String),
}

fn run(args: &[&str]) -> Step {
    Step::Run(args.iter().map(|s| s.to_string()).collect())
}

/// The steps, for the uids of the people signed in now.
pub fn finish_steps(gui_uids: &[u32]) -> Vec<Step> {
    let mut steps = Vec::new();
    for uid in gui_uids.iter().filter(|u| **u != 0) {
        steps.push(run(&[paths::LAUNCHCTL, "bootout", &format!("gui/{uid}/{}", paths::AGENT_LABEL)]));
    }
    steps.push(run(&[paths::LAUNCHCTL, "bootout", &format!("system/{}", paths::DAEMON_LABEL)]));
    steps.push(Step::KillHelpers);
    steps.push(Step::RemoveFile(paths::AGENT_PLIST.into()));
    steps.push(Step::RemoveFile(paths::DAEMON_PLIST.into()));
    steps.push(Step::RemoveTree(paths::DATA_DIR.into()));
    steps.push(Step::RemoveTree(paths::SOCKET_DIR.into()));
    steps.push(run(&[paths::TCCUTIL, "reset", "ScreenCapture", paths::BUNDLE_ID]));
    steps.push(run(&[paths::TCCUTIL, "reset", "Accessibility", paths::BUNDLE_ID]));
    steps.push(run(&[paths::PKGUTIL, "--forget", paths::PKG_ID]));
    steps.push(Step::RemoveTree(paths::APP_PATH.into()));
    steps
}

/// The uids of the people with a GUI session: the owners of `loginwindow` processes, root's (the login window) left out.
pub fn gui_uids(procs: &[crate::programs::Proc]) -> Vec<u32> {
    let mut uids: Vec<u32> = procs.iter().filter(|p| p.name() == "loginwindow" && p.uid != 0).map(|p| p.uid).collect();
    uids.sort_unstable();
    uids.dedup();
    uids
}

/// Runs the steps. Every step runs even when one before it failed; the failures come back as lines.
pub fn run_steps(steps: &[Step], own_pid: i32, procs: impl Fn() -> Vec<crate::programs::Proc>) -> Vec<String> {
    let mut failed = Vec::new();
    for step in steps {
        match step {
            Step::Run(args) => {
                let ok = std::process::Command::new(&args[0])
                    .args(&args[1..])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success());
                if !ok {
                    failed.push(args.join(" "));
                }
            }
            Step::KillHelpers => {
                for p in procs().iter().filter(|p| p.path == paths::BINARY_PATH && p.pid != own_pid && p.pid > 1) {
                    // SAFETY: kill(2) on one positive pid.
                    unsafe {
                        libc::kill(p.pid, libc::SIGKILL);
                    }
                }
            }
            Step::RemoveFile(path) => {
                if let Err(e) = std::fs::remove_file(path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        failed.push(format!("{path}: {e}"));
                    }
                }
            }
            Step::RemoveTree(path) => {
                // Never through a link: a link in a folder's place is removed itself, not what it points to.
                let result = match std::fs::symlink_metadata(path) {
                    Ok(m) if m.file_type().is_dir() => std::fs::remove_dir_all(path),
                    Ok(_) => std::fs::remove_file(path),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(e),
                };
                if let Err(e) = result {
                    failed.push(format!("{path}: {e}"));
                }
            }
        }
    }
    failed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::programs::Proc;

    #[test]
    fn everything_goes_and_the_app_goes_last() {
        let steps = finish_steps(&[501, 0, 502]);
        assert_eq!(steps[0], run(&["/bin/launchctl", "bootout", "gui/501/io.github.sukardaddy.supportmcp.helper"]));
        assert_eq!(steps[1], run(&["/bin/launchctl", "bootout", "gui/502/io.github.sukardaddy.supportmcp.helper"]));
        assert_eq!(steps[2], run(&["/bin/launchctl", "bootout", "system/io.github.sukardaddy.supportmcp.device"]));
        assert!(steps.contains(&run(&["/usr/bin/tccutil", "reset", "ScreenCapture", "io.github.sukardaddy.supportmcp"])));
        assert!(steps.contains(&run(&["/usr/bin/tccutil", "reset", "Accessibility", "io.github.sukardaddy.supportmcp"])));
        assert!(steps.contains(&run(&["/usr/sbin/pkgutil", "--forget", "io.github.sukardaddy.supportmcp.pkg"])));
        for path in [paths::AGENT_PLIST, paths::DAEMON_PLIST] {
            assert!(steps.contains(&Step::RemoveFile(path.into())));
        }
        assert!(steps.contains(&Step::RemoveTree(paths::DATA_DIR.into())));
        assert_eq!(steps.last(), Some(&Step::RemoveTree("/Applications/Support.app".into())));
    }

    #[test]
    fn the_gui_sessions_are_the_loginwindow_owners() {
        let p = |pid, uid, path: &str| Proc { pid, uid, path: path.into() };
        let lw = "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow";
        assert_eq!(gui_uids(&[p(90, 0, lw), p(91, 501, lw), p(92, 501, lw), p(93, 502, lw), p(94, 503, "/bin/zsh")]), vec![501, 502]);
    }

    #[test]
    fn a_tree_step_never_follows_a_link_and_every_step_runs() {
        let d = std::env::temp_dir().join(format!("support-mac-uninst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("keep")).unwrap();
        std::fs::write(d.join("keep/file"), b"x").unwrap();
        std::fs::create_dir_all(d.join("gone/sub")).unwrap();
        std::os::unix::fs::symlink(d.join("keep"), d.join("link")).unwrap();
        let s = |p: &str| d.join(p).to_string_lossy().into_owned();
        let failed = run_steps(
            &[Step::Run(vec!["/no/such/tool".into()]), Step::RemoveTree(s("link")), Step::RemoveTree(s("gone")), Step::RemoveFile(s("missing"))],
            0,
            Vec::new,
        );
        assert_eq!(failed, vec!["/no/such/tool".to_string()]);
        assert!(d.join("keep/file").exists(), "the link's target is untouched");
        assert!(!d.join("link").exists() && !d.join("gone").exists());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
