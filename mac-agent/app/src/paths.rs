//! Every fixed name and place of the Mac app (plans/2026-11-14-macos-agent-research.md, section 3). The packaging files
//! in mac-agent/packaging/ hold the same names, and `plists` tests that they agree.

/// The bundle id. It is also the code signing identifier, which the designated requirement names.
pub const BUNDLE_ID: &str = "io.github.sukardaddy.supportmcp";
pub const APP_NAME: &str = "Support";
pub const APP_PATH: &str = "/Applications/Support.app";
/// The one binary, with every role. `support` is a name the relay already protects (`isAppProgram`).
pub const BINARY_PATH: &str = "/Applications/Support.app/Contents/MacOS/support";

/// Root's data: device.json, history.json and later update.json, previous/ and staging/. Root only, 0700.
pub const DATA_DIR: &str = "/Library/Application Support/SupportMCP";
pub const DEVICE_FILE: &str = "device.json";
pub const HISTORY_FILE: &str = "history.json";

/// The root service: a LaunchDaemon that runs `support device-service`.
pub const DAEMON_LABEL: &str = "io.github.sukardaddy.supportmcp.device";
pub const DAEMON_PLIST: &str = "/Library/LaunchDaemons/io.github.sukardaddy.supportmcp.device.plist";
/// The helper: a LaunchAgent for each signed-in session (Aqua) and for the login window (LoginWindow).
pub const AGENT_LABEL: &str = "io.github.sukardaddy.supportmcp.helper";
pub const AGENT_PLIST: &str = "/Library/LaunchAgents/io.github.sukardaddy.supportmcp.helper.plist";
/// The package id pkgbuild gives the payload, for `pkgutil --forget`.
pub const PKG_ID: &str = "io.github.sukardaddy.supportmcp.pkg";

/// The socket between the service and its helpers. The folder is root's (0755), so only root can make a socket in it,
/// and a helper that finds one there knows root made it. The socket itself is 0666: who may talk is decided per
/// connection by the peer check (src/peer.rs), not by file modes.
pub const SOCKET_DIR: &str = "/var/run/io.github.sukardaddy.supportmcp";
pub const SOCKET_PATH: &str = "/var/run/io.github.sukardaddy.supportmcp/helper.sock";

/// Where a run as root starts.
pub const ROOT_HOME: &str = "/var/root";
/// The shell for `run`.
pub const SHELL: &str = "/bin/zsh";
/// The PATH a command gets. Homebrew's two prefixes are in it so tools a person installed are found.
pub const RUN_PATH: &str = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// The tools the app runs, always by full path.
pub const LAUNCHCTL: &str = "/bin/launchctl";
pub const FDESETUP: &str = "/usr/bin/fdesetup";
pub const SHUTDOWN: &str = "/sbin/shutdown";
pub const TCCUTIL: &str = "/usr/bin/tccutil";
pub const PKGUTIL: &str = "/usr/sbin/pkgutil";
pub const SW_VERS: &str = "/usr/bin/sw_vers";
pub const SCUTIL: &str = "/usr/sbin/scutil";
pub const PS: &str = "/bin/ps";

/// System Settings, Privacy & Security, at the two switches Support needs.
pub const SETTINGS_SCREEN: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
pub const SETTINGS_ACCESSIBILITY: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
