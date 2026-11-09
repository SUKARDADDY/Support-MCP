// The technician app's Rust core: the part that holds the sign-in, talks to the relay and
// reaches the operating system. The screens (../src) only call the commands listed in
// command_list.rs.
// A release check that looks anywhere but at our own repository with our own key is for test
// builds only. build.rs raises the cfg when SUPPORT_RELEASE_KEY or SUPPORT_RELEASE_REPO is set.
#[cfg(all(release_override_set, not(feature = "test-release")))]
compile_error!("SUPPORT_RELEASE_KEY or SUPPORT_RELEASE_REPO is set in the build environment. Only a build with the `test-release` feature may use them. Unset them to build the app that ships.");

pub mod command_list;
pub mod commands;
pub mod core;
pub mod error;
pub mod feed;
pub mod lockdown;
pub mod oauth;
pub mod platform;
pub mod relay;
pub mod seal;
pub mod store;
pub mod update;
#[cfg(test)]
mod testkit;

use std::sync::Arc;
use tauri::Manager;

// The browser sign-in opens: the system browser, or in the end-to-end build a file.
fn browser() -> Arc<dyn oauth::Browser> {
    #[cfg(feature = "e2e")]
    {
        let path = std::env::var("SUPPORT_E2E_AUTHORIZE_FILE").expect("SUPPORT_E2E_AUTHORIZE_FILE names the file the end-to-end build writes the authorize address to");
        Arc::new(oauth::FileBrowser { path: path.into() })
    }
    #[cfg(not(feature = "e2e"))]
    {
        Arc::new(platform::SystemBrowser)
    }
}

// The one window. It is built here, not from the config alone, so it can refuse to
// navigate anywhere but the app's own screens and refuse to open another window. Started
// by autostart (--background) it stays hidden in the tray.
fn build_main_window(app: &tauri::App, background: bool) -> tauri::Result<tauri::WebviewWindow> {
    let config = app.config().app.windows.first().cloned().expect("tauri.conf.json describes the main window");
    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        .visible(!background)
        .on_navigation(|url| lockdown::navigation_allowed(url, cfg!(debug_assertions)))
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
        .build()
}

pub fn run() {
    tauri::Builder::default()
        // Registered first, as the plugin asks: a second start only opens the window of the first.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| platform::show_main_window(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![platform::BACKGROUND_ARG])))
        .setup(|app| {
            // The accounts and their sealed sign-in (app.json) live in the roaming folder; a
            // downloaded installer is large and belongs to this PC, so it goes in the local one.
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let local_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
            // A verified update kept from the last run is installed first: it replaces the
            // app's files, so this copy exits as soon as the installer has started.
            let updater = update::Updater::new(update::UpdateConfig::production(env!("CARGO_PKG_VERSION"), local_dir)?, Arc::new(update::SilentInstaller));
            if !cfg!(feature = "e2e") && updater.apply_staged() {
                std::process::exit(0);
            }
            let window = build_main_window(app, platform::started_in_background(std::env::args()))?;
            platform::keep_in_tray(&window);
            platform::build_tray(app.handle())?;
            let handle = app.handle().clone();
            let store = Arc::new(store::Store::open(&dir, seal::default_sealer())?);
            let emitter = Arc::new(platform::TauriEmitter(handle.clone()));
            let notifier = Arc::new(platform::ToastNotifier::new(handle.clone()));
            platform::open_on_click(&handle, notifier.clone());
            let core = core::Core::new(store, emitter, notifier, browser(), core::CoreConfig::NORMAL);
            core.start();
            app.manage(core);
            // Look for a newer signed release at start and every 6 hours. A development or
            // end-to-end build never updates itself.
            if !cfg!(debug_assertions) && !cfg!(feature = "e2e") {
                tauri::async_runtime::spawn(update::run_update_loop(updater.clone()));
            }
            app.manage(updater);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::accounts_list,
            commands::sign_in,
            commands::sign_in_cancel,
            commands::sign_out,
            commands::relay_request,
            commands::relay_tool,
            commands::notifications_recent,
            commands::prefs_get,
            commands::prefs_set,
            commands::autostart_get,
            commands::autostart_set,
            commands::update_status,
            commands::update_check,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Support app");
}

#[cfg(test)]
mod tests {
    // The setup code cannot run without a window, so this reads it: the accounts and their
    // sealed sign-in stay in the roaming folder, the large installer goes in the local one.
    #[test]
    fn the_staged_installer_goes_in_the_local_data_folder_and_the_accounts_stay_in_the_roaming_one() {
        let source = include_str!("lib.rs");
        let code = &source[..source.rfind("\n#[cfg(test)]\nmod tests {").unwrap()];
        assert!(code.contains("UpdateConfig::production(env!(\"CARGO_PKG_VERSION\"), local_dir)"));
        assert!(code.contains("let local_dir = app.path().app_local_data_dir()"));
        assert!(code.contains("Store::open(&dir,"));
        assert!(code.contains("let dir = app.path().app_data_dir()"));
    }
}
