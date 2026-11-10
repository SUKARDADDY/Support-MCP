// What keeps the web view in its box: the page may load only the app's own screens, and
// nothing it shows may open a window or move the view somewhere else. Together with the
// content security policy and the capability file (held by the tests below), the screens
// can reach only the commands in command_list.rs.
use url::Url;

/// May the web view go to `url`? Only the app's own embedded screens: Tauri serves them at
/// tauri://localhost (macOS, Linux) or http(s)://tauri.localhost (Windows). A debug build
/// also allows the Vite dev server.
pub fn navigation_allowed(url: &Url, dev: bool) -> bool {
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        "tauri" => host == "localhost",
        "http" | "https" => host == "tauri.localhost" || (dev && host == "localhost" && url.port() == Some(5173)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    fn read(rel: &str) -> String {
        std::fs::read_to_string(root().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
    }

    fn json(rel: &str) -> serde_json::Value {
        serde_json::from_str(&read(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
    }

    const CSP: &str = "default-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

    /// The command names in lib.rs's generate_handler![...].
    fn handler_commands() -> BTreeSet<String> {
        let lib = read("src/lib.rs");
        let start = lib.find("generate_handler![").expect("lib.rs registers the handler") + "generate_handler![".len();
        let end = start + lib[start..].find(']').unwrap();
        lib[start..end].split(',').map(str::trim).filter(|s| !s.is_empty()).map(|s| s.rsplit("::").next().unwrap().to_string()).collect()
    }

    /// The functions marked #[tauri::command] in commands.rs.
    fn defined_commands() -> BTreeSet<String> {
        let src = read("src/commands.rs");
        let lines: Vec<&str> = src.lines().collect();
        let mut out = BTreeSet::new();
        for (i, l) in lines.iter().enumerate() {
            if l.trim() == "#[tauri::command]" {
                let sig = lines[i + 1].trim();
                let name = sig.trim_start_matches("pub ").trim_start_matches("async ").trim_start_matches("fn ");
                out.insert(name.split('(').next().unwrap().to_string());
            }
        }
        out
    }

    #[test]
    fn the_declared_command_list_is_the_handler_and_the_defined_commands() {
        let declared: BTreeSet<String> = crate::command_list::COMMANDS.iter().map(|s| s.to_string()).collect();
        assert_eq!(declared.len(), crate::command_list::COMMANDS.len(), "no command is listed twice");
        assert_eq!(declared, handler_commands(), "build.rs's list and the handler in lib.rs");
        assert_eq!(declared, defined_commands(), "the list and the #[tauri::command] functions");
        assert!(read("build.rs").contains("include!(\"src/command_list.rs\")"), "build.rs declares the list this test holds");
        assert!(read("build.rs").contains(".commands(COMMANDS)"));
    }

    #[test]
    fn the_capability_grants_our_commands_and_listening_to_events_and_nothing_else() {
        let dir = root().join("capabilities");
        let files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(files, vec!["default.json".to_string()], "one capability file");
        let cap = json("capabilities/default.json");
        assert_eq!(cap["identifier"], "main");
        assert_eq!(cap["windows"], serde_json::json!(["main"]));
        assert!(cap.get("webviews").is_none() && cap.get("remote").is_none(), "no remote pages");
        let granted: BTreeSet<String> = cap["permissions"].as_array().unwrap().iter().map(|p| p.as_str().expect("a plain permission name").to_string()).collect();
        let mut want: BTreeSet<String> = crate::command_list::COMMANDS.iter().map(|c| format!("allow-{}", c.replace('_', "-"))).collect();
        want.insert("core:event:allow-listen".into());
        want.insert("core:event:allow-unlisten".into());
        assert_eq!(granted, want);
        // Everything but our own commands is a plugin or core permission: only the two for events.
        let others: BTreeSet<&str> = granted.iter().map(String::as_str).filter(|p| !p.starts_with("allow-")).collect();
        assert_eq!(others, BTreeSet::from(["core:event:allow-listen", "core:event:allow-unlisten"]));
    }

    #[test]
    fn the_content_security_policy_is_the_planned_one() {
        let conf = json("tauri.conf.json");
        let csp = conf["app"]["security"]["csp"].as_str().expect("the CSP is one string");
        assert_eq!(csp, CSP);
        let directive = |name: &str| csp.split(';').map(str::trim).find_map(|d| d.strip_prefix(&format!("{name} "))).map(str::to_string);
        assert_eq!(directive("default-src").as_deref(), Some("'self'"));
        assert_eq!(directive("connect-src").as_deref(), Some("ipc: http://ipc.localhost"));
        assert_eq!(directive("img-src").as_deref(), Some("'self' data:"));
        for banned in ["unsafe-inline", "unsafe-eval", "'unsafe-hashes'", "*", "https:", "blob:"] {
            assert!(!csp.contains(banned), "the CSP must not contain {banned}");
        }
        assert_eq!(conf["app"]["security"]["freezePrototype"], true);
    }

    #[test]
    fn the_shell_config_has_no_version_no_global_api_and_builds_the_per_user_installer() {
        let conf = json("tauri.conf.json");
        assert!(conf.get("version").is_none(), "Tauri takes the version from Cargo.toml");
        assert_eq!(conf["app"]["withGlobalTauri"], false);
        assert_eq!(conf["app"]["windows"][0]["create"], false, "the window is built in code, with its navigation guard");
        assert!(conf["app"]["security"].get("assetProtocol").is_none() && conf["app"]["security"].get("dangerousDisableAssetCspModification").is_none());
        let nsis = &conf["bundle"]["windows"]["nsis"];
        assert_eq!(nsis["installMode"], "currentUser");
        assert_eq!(conf["bundle"]["targets"], serde_json::json!(["nsis"]));
        assert_eq!(conf["bundle"]["windows"]["webviewInstallMode"]["type"], "downloadBootstrapper");
        assert_eq!(conf["identifier"], "dev.support-mcp.technician");
        assert!(conf["bundle"]["resources"].to_string().contains("OFL"), "the font licences ship with the installer");
    }

    #[test]
    fn a_silent_uninstall_removes_the_app_data_and_an_update_never_does() {
        let conf = json("tauri.conf.json");
        let hooks = conf["bundle"]["windows"]["nsis"]["installerHooks"].as_str().expect("the installer hooks file is set");
        let nsh = read(hooks.trim_start_matches("./"));
        // The data is removed in the post-uninstall hook only: nothing at install time.
        assert!(nsh.contains("!macro NSIS_HOOK_POSTUNINSTALL"));
        for other in ["NSIS_HOOK_PREINSTALL", "NSIS_HOOK_POSTINSTALL", "NSIS_HOOK_PREUNINSTALL"] {
            assert!(!nsh.contains(other), "{other}");
        }
        let code: String = nsh.lines().filter(|l| !l.trim_start().starts_with(';')).collect::<Vec<_>>().join("\n");
        // Both folders, only for a silent uninstall that is not an update.
        assert!(code.contains("${If} ${Silent}") && code.contains("${AndIf} $UpdateMode <> 1"));
        assert!(code.contains("RmDir /r \"$APPDATA\\${BUNDLEID}\"") && code.contains("RmDir /r \"$LOCALAPPDATA\\${BUNDLEID}\""));
        assert_eq!(code.matches("RmDir").count(), 2, "nothing else is removed");
        assert!(code.find("${If} ${Silent}").unwrap() < code.find("RmDir").unwrap(), "the removal sits inside the guard");
        // The bundle id the template expands is the folder name the app's data lives in.
        assert_eq!(conf["identifier"], "dev.support-mcp.technician");
        // The updater starts the installer in update mode.
        assert!(crate::update::INSTALLER_ARGS.contains(&"/UPDATE"));
    }

    #[test]
    fn tauri_is_built_without_dev_tools_asset_protocol_or_shell() {
        let cargo = read("Cargo.toml");
        let line = cargo.lines().find(|l| l.starts_with("tauri = ")).unwrap();
        for banned in ["devtools", "protocol-asset", "shell", "isolation", "unstable"] {
            assert!(!line.contains(banned), "{banned}");
        }
        for banned in ["tauri-plugin-shell", "tauri-plugin-fs", "tauri-plugin-http", "tauri-plugin-opener", "tauri-plugin-dialog", "tauri-plugin-updater"] {
            assert!(!cargo.contains(banned), "{banned}");
        }
    }

    #[test]
    fn nothing_but_the_persons_choice_switches_start_with_windows_on() {
        let count = |file: &str| read(file).matches(".enable()").count();
        assert_eq!(count("src/commands.rs"), 1, "only autostart_set");
        for other in ["src/lib.rs", "src/platform.rs", "src/core.rs", "src/feed.rs", "src/oauth.rs", "src/relay.rs", "src/store.rs"] {
            assert_eq!(count(other), 0, "{other}");
        }
        let src = read("src/commands.rs");
        let at = src.find("pub fn autostart_set").expect("autostart_set exists");
        assert!(src[at..].contains(".enable()"));
    }

    #[test]
    fn the_view_may_load_only_its_own_screens() {
        let ok = |s: &str, dev: bool| navigation_allowed(&Url::parse(s).unwrap(), dev);
        assert!(ok("tauri://localhost/", false));
        assert!(ok("tauri://localhost/index.html", false));
        assert!(ok("http://tauri.localhost/", false));
        assert!(ok("https://tauri.localhost/index.html", false));
        assert!(ok("http://localhost:5173/", true));
        assert!(!ok("http://localhost:5173/", false), "the dev server only in a debug build");
        for bad in [
            "https://example.com/", "http://localhost:8787/", "http://127.0.0.1/", "file:///C:/Windows/win.ini", "about:blank",
            "data:text/html,<script>1</script>", "javascript:alert(1)", "https://tauri.localhost.evil.example/", "http://evil.example/tauri.localhost",
            "tauri://evil/", "ipc://localhost/",
        ] {
            assert!(!ok(bad, false), "{bad}");
            assert!(!ok(bad, true) || bad == "http://localhost:5173/", "{bad}");
        }
    }
}
