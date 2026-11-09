// The commands the screens may call. build.rs declares exactly these in the app manifest,
// so Tauri exposes no other command of ours, and the capability file grants each by name.
// A test (src/lockdown_tests.rs) holds this list, the handler in lib.rs and the capability
// file to one another.
pub const COMMANDS: &[&str] = &["app_info"];
