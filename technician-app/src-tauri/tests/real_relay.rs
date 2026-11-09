// The core against a real relay (wrangler dev), not a stand-in. It is ignored in a plain
// `cargo test`; `node e2e/core-check.mjs` starts the relay, seeds it, runs this test and
// walks the browser's sign-in pages for it (docs/technician-app.md, "How it is tested").
//
//   RELAY_URL         the relay, such as http://127.0.0.1:8787
//   AUTHORIZE_FILE    where the sign-in writes the authorize address, which the script opens
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use technician_app::core::{Core, CoreConfig};
use technician_app::feed::{Emitter, FeedItem, Notifier};
use technician_app::oauth::FileBrowser;
use technician_app::seal::DevSealer;
use technician_app::store::{Store, Tokens};

struct Quiet;
impl Emitter for Quiet {
    fn emit(&self, _event: &str, _payload: Value) {}
}
#[derive(Default)]
struct Shown(Mutex<Vec<String>>);
impl Notifier for Shown {
    fn show(&self, _account: &str, item: &FeedItem) {
        self.0.lock().unwrap().push(item.event.clone());
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a running relay: node e2e/core-check.mjs"]
async fn the_core_signs_in_calls_the_relay_refreshes_and_hears_the_feed() {
    let relay = std::env::var("RELAY_URL").expect("RELAY_URL");
    let file = std::env::var("AUTHORIZE_FILE").expect("AUTHORIZE_FILE");
    let dir = std::env::temp_dir().join(format!("support-real-relay-{}", std::process::id()));
    let store = Arc::new(Store::open(&dir, Arc::new(DevSealer)).unwrap());
    let shown = Arc::new(Shown::default());
    let core = Core::new(store.clone(), Arc::new(Quiet), shown.clone(), Arc::new(FileBrowser { path: file.into() }), CoreConfig::NORMAL);

    // Sign in: the script opens the address the core wrote and approves it.
    let account = core.sign_in(&relay, "default").await.expect("sign in");
    assert!(account.signed_in);
    assert_eq!(account.team, "default");
    assert!(account.email.as_deref().unwrap_or("").contains('@'), "who you are: {account:?}");
    let id = account.id.clone();

    // The team API through the app's address.
    let me = core.request(&id, "GET", "/api", None).await.expect("whoami");
    let perms = me["me"]["permissions"].as_array().unwrap();
    assert!(perms.iter().any(|p| p == "sessions.control"), "{perms:?}");
    let devices = core.request(&id, "GET", "/api/devices", None).await.expect("devices");
    assert!(devices["devices"].as_array().unwrap().iter().any(|d| d["name"] == "E2E front counter"), "{devices}");
    let teams = core.request(&id, "GET", "/teams", None).await.expect("teams");
    assert_eq!(teams["teams"][0]["slug"], "default");
    let pairing = core.request(&id, "POST", "/api/pairing", Some(json!({}))).await.expect("pairing");
    assert!(pairing["pairing"]["code"].as_str().unwrap().len() >= 8);
    let settings = core.request(&id, "PATCH", "/notifications/settings", Some(json!({ "events": { "task_finished": false } }))).await.expect("settings");
    assert_eq!(settings["events"]["task_finished"], false);

    // The same person through the MCP tools of the app's own address.
    let listed = core.tool(&id, "device_list", json!({})).await.expect("device_list");
    assert!(listed.data["devices"].as_array().unwrap().iter().any(|d| d["name"] == "E2E front counter" && d["online"] == false));
    let link = core.tool(&id, "session_create", json!({})).await.expect("session_create");
    assert!(link.data["download_url"].as_str().unwrap().contains("/j/"), "{}", link.data);
    let models = core.tool(&id, "agent_status", json!({})).await.expect("agent_status");
    assert!(models.data["models"].is_array());
    // A tool the app does not use is refused before it reaches the relay.
    assert!(core.tool(&id, "run", json!({ "session_id": "x", "command": "dir" })).await.is_err());

    // The feed: a PC asks to join, and its notification arrives within seconds.
    let http = reqwest::Client::new();
    let joined = http
        .post(format!("{relay}/device/pair"))
        .json(&json!({ "workspace": "default", "name": "Real relay PC", "os": "Windows 11", "machine": "W", "app_version": env!("CARGO_PKG_VERSION"), "access": "ask", "control": "limited", "protocol": 1 }))
        .send()
        .await
        .unwrap();
    let status = joined.status().as_u16();
    let joined: Value = joined.json().await.unwrap();
    assert_eq!(status, 202, "{joined}");
    let waiting_id = joined["device_id"].as_str().unwrap().to_string();
    let confirm = joined["confirm"].as_str().unwrap().to_string();
    let mut found = false;
    for _ in 0..40 {
        if core.recent_items().iter().any(|i| i.item.event == "device_waiting" && i.item.body.contains("Real relay PC")) {
            found = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(found, "the device_waiting notification reached the feed: {:?}", core.recent_items());
    assert!(shown.0.lock().unwrap().iter().any(|e| e == "device_waiting"), "and raised a notification");

    // Approve it with the wrong number, then the right one.
    let wrong = core.request(&id, "PATCH", &format!("/api/devices/{waiting_id}"), Some(json!({ "approve": { "confirm": "000000" } }))).await.unwrap_err();
    assert_eq!(wrong.code(), "confirm_wrong", "{wrong}");
    let ok = core.request(&id, "PATCH", &format!("/api/devices/{waiting_id}"), Some(json!({ "approve": { "confirm": confirm } }))).await.expect("approve");
    assert_eq!(ok["device"]["status"], "active");

    // Refresh: let the access token run out, and the next call renews it (the refresh token rotates).
    let before = store.tokens(&id).unwrap();
    store.set_tokens(&id, &Tokens { expires_at_ms: 1, ..before.clone() }).unwrap();
    let again = core.request(&id, "GET", "/api", None).await.expect("a call after the access token ended");
    assert!(again["me"]["identity"].is_string());
    let after = store.tokens(&id).unwrap();
    assert_ne!(after.access, before.access, "a new access token");
    assert_ne!(after.refresh, before.refresh, "the refresh token rotated");

    // Signing out removes the account.
    core.sign_out(&id).await.unwrap();
    assert!(core.accounts().is_empty());
}
