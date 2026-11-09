// The technician app's Rust core: the part that holds the sign-in, talks to the relay and
// reaches the operating system. The screens (../src) only call the commands listed in
// command_list.rs.
pub mod command_list;

#[derive(serde::Serialize)]
struct AppInfo {
    version: &'static str,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo { version: env!("CARGO_PKG_VERSION") }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running the Support app");
}
