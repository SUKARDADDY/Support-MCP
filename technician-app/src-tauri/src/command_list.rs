// The commands the screens may call. build.rs declares exactly these in the app manifest,
// so Tauri exposes no other command of ours, and the capability file grants each by name.
// A test (src/lockdown_tests.rs) holds this list, the handler in lib.rs and the capability
// file to one another.
pub const COMMANDS: &[&str] = &[
    "app_info",
    "accounts_list",
    "sign_in",
    "sign_in_cancel",
    "sign_out",
    "relay_request",
    "relay_tool",
    "notifications_recent",
    "prefs_get",
    "prefs_set",
    "autostart_get",
    "autostart_set",
    "window_theme",
    "update_status",
    "update_check",
];
