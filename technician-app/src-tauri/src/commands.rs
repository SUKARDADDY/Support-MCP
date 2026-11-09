// The commands the screens call. Each is a thin wrapper over the core; the list of them is
// in command_list.rs and is what the app manifest and the capability file are held to.
use crate::core::{AccountView, Core};
use crate::error::CoreError;
use crate::feed::AccountItem;
use crate::relay::ToolOutput;
use crate::store::Prefs;
use crate::update::{UpdateStatus, Updater};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::State;
use tauri_plugin_autostart::ManagerExt;

type Shared<'a> = State<'a, Arc<Core>>;

#[derive(Serialize)]
pub struct AppInfo {
    pub version: &'static str,
    /// The relay address the sign-in form starts with: set when the app is built.
    pub default_relay: &'static str,
    pub default_team: &'static str,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        default_relay: option_env!("SUPPORT_DEFAULT_RELAY").unwrap_or(""),
        default_team: "default",
    }
}

#[tauri::command]
pub fn accounts_list(core: Shared<'_>) -> Vec<AccountView> {
    core.accounts()
}

#[tauri::command]
pub async fn sign_in(core: Shared<'_>, relay: String, team: String) -> Result<AccountView, CoreError> {
    core.inner().clone().sign_in(&relay, &team).await
}

#[tauri::command]
pub fn sign_in_cancel(core: Shared<'_>) {
    core.cancel_sign_in();
}

#[tauri::command]
pub fn sign_out(core: Shared<'_>, account: String) -> Result<(), CoreError> {
    core.sign_out(&account)
}

#[tauri::command]
pub async fn relay_request(core: Shared<'_>, account: String, method: String, path: String, body: Option<Value>) -> Result<Value, CoreError> {
    core.request(&account, &method, &path, body).await
}

#[tauri::command]
pub async fn relay_tool(core: Shared<'_>, account: String, name: String, args: Option<Value>) -> Result<ToolOutput, CoreError> {
    core.tool(&account, &name, args.unwrap_or_else(|| Value::Object(Default::default()))).await
}

#[tauri::command]
pub fn notifications_recent(core: Shared<'_>) -> Vec<AccountItem> {
    core.recent_items()
}

#[tauri::command]
pub fn prefs_get(core: Shared<'_>) -> Prefs {
    core.prefs()
}

#[tauri::command]
pub fn prefs_set(core: Shared<'_>, prefs: Prefs) -> Result<(), CoreError> {
    core.set_prefs(prefs)
}

/// Whether the app starts when the person signs in to Windows. Off until they choose it.
#[tauri::command]
pub fn autostart_get(app: tauri::AppHandle) -> Result<bool, CoreError> {
    app.autolaunch().is_enabled().map_err(|_| CoreError::other("Could not read the start setting."))
}

#[tauri::command]
pub fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<(), CoreError> {
    let launch = app.autolaunch();
    let done = if enabled { launch.enable() } else { launch.disable() };
    done.map_err(|_| CoreError::other("Could not change the start setting."))
}

/// What the updater knows: the running version, a newer one found or kept, and the last check.
#[tauri::command]
pub fn update_status(updater: State<'_, Arc<Updater>>) -> UpdateStatus {
    updater.status()
}

/// Checks for a newer signed release now. A found installer is kept and runs at the next start.
#[tauri::command]
pub async fn update_check(updater: State<'_, Arc<Updater>>) -> Result<UpdateStatus, CoreError> {
    Ok(updater.inner().clone().check().await)
}
