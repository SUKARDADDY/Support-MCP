//! The property lists the package installs: the app's Info.plist, the LaunchDaemon, the LaunchAgent and the (empty)
//! entitlements. They are written here and committed in mac-agent/packaging/; a test checks the two are the same, so
//! the labels and paths in the package cannot drift from the ones the app uses.

use crate::paths;

/// A property list value. Only what these files need.
pub enum P {
    Str(String),
    Bool(bool),
    Int(i64),
    Arr(Vec<P>),
    Dict(Vec<(&'static str, P)>),
}

fn s(v: &str) -> P {
    P::Str(v.to_string())
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn render(v: &P, depth: usize, out: &mut String) {
    let pad = "\t".repeat(depth);
    match v {
        P::Str(t) => out.push_str(&format!("{pad}<string>{}</string>\n", escape(t))),
        P::Bool(true) => out.push_str(&format!("{pad}<true/>\n")),
        P::Bool(false) => out.push_str(&format!("{pad}<false/>\n")),
        P::Int(n) => out.push_str(&format!("{pad}<integer>{n}</integer>\n")),
        P::Arr(items) => {
            out.push_str(&format!("{pad}<array>\n"));
            for i in items {
                render(i, depth + 1, out);
            }
            out.push_str(&format!("{pad}</array>\n"));
        }
        P::Dict(entries) => {
            out.push_str(&format!("{pad}<dict>\n"));
            for (k, v) in entries {
                out.push_str(&format!("{pad}\t<key>{}</key>\n", escape(k)));
                render(v, depth + 1, out);
            }
            out.push_str(&format!("{pad}</dict>\n"));
        }
    }
}

/// The XML text of a property list, as Apple's tools write it.
pub fn xml(root: &P) -> String {
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n",
    );
    render(root, 0, &mut out);
    out.push_str("</plist>\n");
    out
}

/// The app's Info.plist. `version` is the release; the committed file has `@VERSION@`, which the build replaces.
pub fn info_plist(version: &str) -> String {
    xml(&P::Dict(vec![
        ("CFBundleDevelopmentRegion", s("en")),
        ("CFBundleDisplayName", s(paths::APP_NAME)),
        ("CFBundleExecutable", s("support")),
        ("CFBundleIdentifier", s(paths::BUNDLE_ID)),
        ("CFBundleInfoDictionaryVersion", s("6.0")),
        ("CFBundleName", s(paths::APP_NAME)),
        ("CFBundlePackageType", s("APPL")),
        ("CFBundleShortVersionString", s(version)),
        ("CFBundleVersion", s(version)),
        // Apple silicon only, macOS 14 or later (call 4).
        ("LSArchitecturePriority", P::Arr(vec![s("arm64")])),
        ("LSMinimumSystemVersion", s("14.0")),
        ("LSRequiresNativeExecution", P::Bool(true)),
        // A menu bar app: no Dock icon and no main menu.
        ("LSUIElement", P::Bool(true)),
        ("NSHighResolutionCapable", P::Bool(true)),
        // macOS shows its own text for the two permissions; this says why, where a version shows it.
        ("NSScreenCaptureUsageDescription", s("Support shows your screen to your support team during a session you allow.")),
        ("NSSupportsAutomaticTermination", P::Bool(false)),
        ("NSSupportsSuddenTermination", P::Bool(false)),
    ]))
}

/// The join app's Info.plist (`Support Join.app`, committed as Info-join.plist). A bundle id of its own, so its Screen
/// Recording and Accessibility grants are its own. Only this bundle registers the `supportmcp` link scheme, so the saved
/// app never receives a link. It is a normal windowed app (a Dock icon and a menu with Paste), not a menu bar one.
pub fn join_info_plist(version: &str) -> String {
    xml(&P::Dict(vec![
        ("CFBundleDevelopmentRegion", s("en")),
        ("CFBundleDisplayName", s(paths::JOIN_APP_NAME)),
        ("CFBundleExecutable", s(paths::JOIN_EXECUTABLE)),
        ("CFBundleIdentifier", s(paths::JOIN_BUNDLE_ID)),
        ("CFBundleInfoDictionaryVersion", s("6.0")),
        ("CFBundleName", s(paths::JOIN_APP_NAME)),
        ("CFBundlePackageType", s("APPL")),
        ("CFBundleShortVersionString", s(version)),
        (
            "CFBundleURLTypes",
            P::Arr(vec![P::Dict(vec![
                ("CFBundleTypeRole", s("Viewer")),
                ("CFBundleURLName", s(paths::JOIN_BUNDLE_ID)),
                ("CFBundleURLSchemes", P::Arr(vec![s(paths::JOIN_URL_SCHEME)])),
            ])]),
        ),
        ("CFBundleVersion", s(version)),
        ("LSArchitecturePriority", P::Arr(vec![s("arm64")])),
        ("LSMinimumSystemVersion", s("14.0")),
        ("LSRequiresNativeExecution", P::Bool(true)),
        ("NSHighResolutionCapable", P::Bool(true)),
        ("NSScreenCaptureUsageDescription", s("Support Join shows your screen to your support team during a session you allow.")),
        ("NSSupportsAutomaticTermination", P::Bool(false)),
        ("NSSupportsSuddenTermination", P::Bool(false)),
    ]))
}

/// The LaunchDaemon: `support device-service` as root, started at boot and kept alive.
pub fn daemon_plist() -> String {
    xml(&P::Dict(vec![
        ("AssociatedBundleIdentifiers", P::Arr(vec![s(paths::BUNDLE_ID)])),
        ("KeepAlive", P::Bool(true)),
        ("Label", s(paths::DAEMON_LABEL)),
        ("ProcessType", s("Standard")),
        ("ProgramArguments", P::Arr(vec![s(paths::BINARY_PATH), s("device-service")])),
        ("RunAtLoad", P::Bool(true)),
        ("ThrottleInterval", P::Int(10)),
    ]))
}

/// The LaunchAgent: `support helper` in every signed-in session and at the login window, kept alive.
pub fn agent_plist() -> String {
    xml(&P::Dict(vec![
        ("AssociatedBundleIdentifiers", P::Arr(vec![s(paths::BUNDLE_ID)])),
        ("KeepAlive", P::Bool(true)),
        ("Label", s(paths::AGENT_LABEL)),
        ("LimitLoadToSessionType", P::Arr(vec![s("Aqua"), s("LoginWindow")])),
        ("ProcessType", s("Interactive")),
        ("ProgramArguments", P::Arr(vec![s(paths::BINARY_PATH), s("helper")])),
        ("RunAtLoad", P::Bool(true)),
        ("ThrottleInterval", P::Int(10)),
    ]))
}

/// The hardened runtime's entitlements: none. Screen capture and input are TCC permissions a person grants, not
/// entitlements, and the app loads no unsigned code, needs no JIT and no debugging.
pub fn entitlements_plist() -> String {
    xml(&P::Dict(vec![]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packaging(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packaging").join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    #[test]
    fn the_committed_packaging_files_are_the_generated_ones() {
        assert_eq!(packaging("Info.plist"), info_plist("@VERSION@"));
        assert_eq!(packaging("Info-join.plist"), join_info_plist("@VERSION@"));
        assert_eq!(packaging(&format!("{}.plist", paths::DAEMON_LABEL)), daemon_plist());
        assert_eq!(packaging(&format!("{}.plist", paths::AGENT_LABEL)), agent_plist());
        assert_eq!(packaging("entitlements.plist"), entitlements_plist());
    }

    #[test]
    fn the_plists_parse_and_say_what_the_design_pins() {
        let read = |text: &str| plist::Value::from_reader_xml(text.as_bytes()).unwrap().into_dictionary().unwrap();
        let info = read(&info_plist("1.2.3"));
        assert_eq!(info["CFBundleIdentifier"].as_string(), Some("io.github.sukardaddy.supportmcp"));
        assert_eq!(info["CFBundleShortVersionString"].as_string(), Some("1.2.3"));
        assert_eq!(info["LSMinimumSystemVersion"].as_string(), Some("14.0"));
        assert_eq!(info["LSUIElement"].as_boolean(), Some(true));
        assert_eq!(info["CFBundleExecutable"].as_string(), Some("support"));

        let daemon = read(&daemon_plist());
        assert_eq!(daemon["Label"].as_string(), Some(paths::DAEMON_LABEL));
        let args: Vec<_> = daemon["ProgramArguments"].as_array().unwrap().iter().map(|v| v.as_string().unwrap()).collect();
        assert_eq!(args, vec![paths::BINARY_PATH, "device-service"]);
        assert_eq!(daemon["KeepAlive"].as_boolean(), Some(true));
        assert!(!daemon.contains_key("UserName"), "a daemon with no UserName runs as root");

        let agent = read(&agent_plist());
        let sessions: Vec<_> = agent["LimitLoadToSessionType"].as_array().unwrap().iter().map(|v| v.as_string().unwrap()).collect();
        assert_eq!(sessions, vec!["Aqua", "LoginWindow"]);
        let args: Vec<_> = agent["ProgramArguments"].as_array().unwrap().iter().map(|v| v.as_string().unwrap()).collect();
        assert_eq!(args, vec![paths::BINARY_PATH, "helper"]);

        assert!(read(&entitlements_plist()).is_empty(), "the app asks for no entitlement");
    }

    #[test]
    fn only_the_join_bundle_has_the_link_scheme_and_an_id_of_its_own() {
        let read = |text: &str| plist::Value::from_reader_xml(text.as_bytes()).unwrap().into_dictionary().unwrap();
        let join = read(&join_info_plist("1.2.3"));
        assert_eq!(join["CFBundleIdentifier"].as_string(), Some("io.github.sukardaddy.supportmcp.join"));
        assert_eq!(join["CFBundleExecutable"].as_string(), Some("support-join"));
        assert_eq!(join["CFBundleShortVersionString"].as_string(), Some("1.2.3"));
        assert_eq!(join["LSMinimumSystemVersion"].as_string(), Some("14.0"));
        assert_eq!(join["LSArchitecturePriority"].as_array().unwrap().len(), 1);
        assert!(!join.contains_key("LSUIElement"), "a windowed app, with a Dock icon and a menu");
        let urls = join["CFBundleURLTypes"].as_array().unwrap();
        assert_eq!(urls.len(), 1);
        let schemes: Vec<_> =
            urls[0].as_dictionary().unwrap()["CFBundleURLSchemes"].as_array().unwrap().iter().map(|v| v.as_string().unwrap()).collect();
        assert_eq!(schemes, vec!["supportmcp"]);
        // The saved app registers no scheme, so a link can never reach the root-backed app.
        let saved = read(&info_plist("1.2.3"));
        assert!(!saved.contains_key("CFBundleURLTypes") && !saved.contains_key("CFBundleDocumentTypes"));
        assert_ne!(saved["CFBundleIdentifier"], join["CFBundleIdentifier"]);
        assert_ne!(saved["CFBundleExecutable"], join["CFBundleExecutable"]);
    }

    #[test]
    fn the_distribution_refuses_intel_and_old_macos() {
        let d = packaging("distribution.xml");
        assert!(d.contains("hostArchitectures=\"arm64\""));
        assert!(d.contains("<os-version min=\"14.0\"/>"));
        assert!(d.contains("hw.optional.arm64"));
        assert!(d.contains(paths::PKG_ID));
    }

    #[test]
    fn text_is_escaped() {
        assert_eq!(xml(&s("a<b&c>")).lines().nth(3), Some("<string>a&lt;b&amp;c&gt;</string>"));
    }
}
