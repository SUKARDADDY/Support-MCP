// The technician app's Rust core: the part that holds the sign-in, talks to the relay and
// reaches the operating system. The screens (../src) only call the commands listed in
// command_list.rs.
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
// navigate anywhere but the app's own screens and refuse to open another window.
fn build_main_window(app: &tauri::App) -> tauri::Result<tauri::WebviewWindow> {
    let config = app.config().app.windows.first().cloned().expect("tauri.conf.json describes the main window");
    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_navigation(|url| lockdown::navigation_allowed(url, cfg!(debug_assertions)))
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
        .build()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            build_main_window(app)?;
            let handle = app.handle().clone();
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let store = Arc::new(store::Store::open(&dir, seal::default_sealer())?);
            let emitter = Arc::new(platform::TauriEmitter(handle.clone()));
            let notifier = Arc::new(platform::ToastNotifier::new(handle));
            let core = core::Core::new(store, emitter, notifier, browser(), core::CoreConfig::NORMAL);
            core.start();
            app.manage(core);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Support app");
}
