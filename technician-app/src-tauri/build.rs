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
    embed_manifest_in_every_target();
    // Tauri embeds its own copy of the manifest, in the app only. It is left out here and the
    // linker embeds ours below, so there is exactly one in each binary.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}

// On Windows with the MSVC linker, every executable this package links gets the application
// manifest: the app, the library's unit tests and tests/real_relay.rs. Tauri's windowing code
// imports TaskDialogIndirect, which exists only in version 6 of the Common Controls, and that
// version is chosen by the manifest. A test executable without one fails to start with
// STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) before its first test runs.
fn embed_manifest_in_every_target() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    if target_os == "windows" && target_env == "msvc" {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
