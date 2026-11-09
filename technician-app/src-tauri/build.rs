// Declares the commands the screens may call (src/command_list.rs). Only these get a
// permission, so a command added to the code but not to the list cannot be reached.
include!("src/command_list.rs");

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}
