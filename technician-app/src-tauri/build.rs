// Declares the commands the screens may call (src/command_list.rs). Only these get a
// permission, so a command added to the code but not to the list cannot be reached.
include!("src/command_list.rs");

// The build-time names a test release may use (the `test-release` feature, update.rs).
const RELEASE_OVERRIDES: [&str; 2] = ["SUPPORT_RELEASE_KEY", "SUPPORT_RELEASE_REPO"];

fn main() {
    // lib.rs turns this into a compile error unless the build asked for `test-release`.
    println!("cargo:rustc-check-cfg=cfg(release_override_set)");
    for name in RELEASE_OVERRIDES {
        println!("cargo:rerun-if-env-changed={name}");
        if std::env::var_os(name).is_some() {
            println!("cargo:rustc-cfg=release_override_set");
        }
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}
