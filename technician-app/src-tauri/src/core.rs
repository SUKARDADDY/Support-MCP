// The core of the app, behind the commands the screens call: the accounts (each a relay and
// a team), signing in and out, calls to the relay on the screens' behalf, and one feed loop
// per signed-in account. Nothing here touches Tauri, so it is tested without a window.
use crate::error::{CoreError, CoreResult};
use crate::feed::{run_feed, AccountItem, CoreSink, Emitter, FeedTuning, Notifier, Recent};
use crate::oauth::{self, Browser, SignInCtx, SIGN_IN_TIMEOUT};
use crate::relay::{http_client, normalize_relay, route_allowed, valid_team, AccountClient, AccountEvents, RetryPolicy, ToolOutput, TOOLS};
use crate::store::{Prefs, Store, StoredAccount};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tokio::sync::Notify;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct AccountView {
    pub id: String,
    pub relay: String,
    pub team: String,
    pub team_name: Option<String>,
    pub email: Option<String>,
    pub signed_in: bool,
}

fn view(a: &StoredAccount) -> AccountView {
    AccountView {
        id: a.id.clone(),
        relay: a.relay.clone(),
        team: a.team.clone(),
        team_name: a.team_name.clone(),
        email: a.email.clone(),
        signed_in: a.sealed.is_some(),
    }
}

// Tells the screens when an account's sign-in is gone.
struct ClientEvents {
    emitter: Arc<dyn Emitter>,
}

impl AccountEvents for ClientEvents {
    fn signed_out(&self, account_id: &str) {
        self.emitter.emit("account://changed", serde_json::json!({ "account": account_id, "signed_out": true }));
    }
}

pub struct CoreConfig {
    pub retry: RetryPolicy,
    pub feed: FeedTuning,
    pub sign_in_timeout: Duration,
}

impl CoreConfig {
    pub const NORMAL: CoreConfig = CoreConfig { retry: RetryPolicy::NORMAL, feed: FeedTuning::NORMAL, sign_in_timeout: SIGN_IN_TIMEOUT };
}

pub struct Core {
    pub store: Arc<Store>,
    http: reqwest::Client,
    emitter: Arc<dyn Emitter>,
    notifier: Arc<dyn Notifier>,
    browser: Arc<dyn Browser>,
    config: CoreConfig,
    pub recent: Arc<Recent>,
    clients: Mutex<HashMap<String, Arc<AccountClient>>>,
    feeds: Mutex<HashMap<String, JoinHandle<()>>>,
    signing_in: tokio::sync::Mutex<()>,
    cancel: Mutex<Option<Arc<Notify>>>,
}

impl Core {
    pub fn new(store: Arc<Store>, emitter: Arc<dyn Emitter>, notifier: Arc<dyn Notifier>, browser: Arc<dyn Browser>, config: CoreConfig) -> Arc<Core> {
        Arc::new(Core {
            store,
            http: http_client(),
            emitter,
            notifier,
            browser,
            config,
            recent: Arc::new(Recent::default()),
            clients: Mutex::new(HashMap::new()),
            feeds: Mutex::new(HashMap::new()),
            signing_in: tokio::sync::Mutex::new(()),
            cancel: Mutex::new(None),
        })
    }

    /// Starts a feed loop for every account that is signed in.
    pub fn start(self: &Arc<Self>) {
        for a in self.store.accounts() {
            if a.sealed.is_some() {
                let _ = self.ensure_feed(&a.id);
            }
        }
    }

    pub fn accounts(&self) -> Vec<AccountView> {
        self.store.accounts().iter().map(view).collect()
    }

    fn client(&self, id: &str) -> CoreResult<Arc<AccountClient>> {
        let mut clients = self.clients.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = clients.get(id) {
            if !c.is_signed_out() {
                return Ok(c.clone());
            }
            clients.remove(id);
        }
        let account = self.store.account(id).ok_or_else(|| CoreError::invalid("No such account."))?;
        if account.sealed.is_none() {
            return Err(CoreError::SignedOut);
        }
        let events: Arc<dyn AccountEvents> = Arc::new(ClientEvents { emitter: self.emitter.clone() });
        let c = Arc::new(AccountClient::new(self.store.clone(), self.http.clone(), events, id, self.config.retry)?);
        clients.insert(id.to_string(), c.clone());
        Ok(c)
    }

    fn ensure_feed(self: &Arc<Self>, id: &str) -> CoreResult<()> {
        let client = self.client(id)?;
        let sink = Arc::new(CoreSink {
            recent: self.recent.clone(),
            emitter: self.emitter.clone(),
            notifier: self.notifier.clone(),
            store: self.store.clone(),
        });
        let handle = tauri::async_runtime::spawn(run_feed(client, self.store.clone(), sink, self.config.feed));
        if let Some(old) = self.feeds.lock().unwrap_or_else(|p| p.into_inner()).insert(id.to_string(), handle) {
            old.abort();
        }
        Ok(())
    }

    fn stop_feed(&self, id: &str) {
        if let Some(h) = self.feeds.lock().unwrap_or_else(|p| p.into_inner()).remove(id) {
            h.abort();
        }
    }

    /// Signs in to `team` on `relay`: opens the browser and waits for the person to approve.
    /// Returns the account. One sign-in at a time.
    pub async fn sign_in(self: &Arc<Self>, relay: &str, team: &str) -> CoreResult<AccountView> {
        let relay = normalize_relay(relay)?;
        let team = team.trim().to_ascii_lowercase();
        if !valid_team(&team) {
            return Err(CoreError::invalid("A team name has lower-case letters, digits and dashes only."));
        }
        let _one = self
            .signing_in
            .try_lock()
            .map_err(|_| CoreError::invalid("A sign-in is already open in your browser. Finish it, or cancel it here."))?;
        let cancel = Arc::new(Notify::new());
        *self.cancel.lock().unwrap_or_else(|p| p.into_inner()) = Some(cancel.clone());
        let ctx = SignInCtx {
            http: self.http.clone(),
            store: self.store.clone(),
            browser: self.browser.clone(),
            retry: self.config.retry,
            timeout: self.config.sign_in_timeout,
        };
        let outcome = tokio::select! {
            r = oauth::sign_in(&ctx, &relay, &team) => r,
            _ = cancel.notified() => Err(CoreError::invalid("Sign-in was cancelled.")),
        };
        *self.cancel.lock().unwrap_or_else(|p| p.into_inner()) = None;
        let id = outcome?;
        self.clients.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        self.fill_profile(&id).await;
        self.ensure_feed(&id)?;
        self.emitter.emit("account://changed", serde_json::json!({ "account": id, "signed_out": false }));
        self.store.account(&id).map(|a| view(&a)).ok_or_else(|| CoreError::other("The account was not saved."))
    }

    // The team's name and the person's address, for the screens. Failing here changes nothing.
    async fn fill_profile(&self, id: &str) {
        let Ok(client) = self.client(id) else { return };
        let mut team_name = None;
        let mut email = None;
        if let Ok(v) = client.request(Method::GET, "/teams", None, None).await {
            team_name = v["teams"].as_array().and_then(|t| t.iter().find(|x| x["slug"] == client.team.as_str())).and_then(|x| x["name"].as_str()).map(str::to_string);
        }
        if let Ok(v) = client.request(Method::GET, "/api", None, None).await {
            email = v["me"]["identity"].as_str().map(str::to_string);
        }
        let _ = self.store.set_profile(id, team_name, email);
    }

    pub fn cancel_sign_in(&self) {
        if let Some(n) = self.cancel.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            n.notify_one();
        }
    }

    /// Removes the account and its tokens from this PC.
    pub fn sign_out(&self, id: &str) -> CoreResult<()> {
        self.stop_feed(id);
        self.clients.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
        self.recent.clear_account(id);
        self.store.remove_account(id)?;
        self.emitter.emit("account://changed", serde_json::json!({ "account": id, "signed_out": true }));
        Ok(())
    }

    /// A call to a relay route the screens may reach (see relay::route_allowed).
    pub async fn request(&self, id: &str, method: &str, path: &str, body: Option<Value>) -> CoreResult<Value> {
        if !route_allowed(method, path) {
            return Err(CoreError::invalid("The app does not make that request."));
        }
        let m = Method::from_bytes(method.as_bytes()).map_err(|_| CoreError::invalid("Bad method."))?;
        // A held-open call needs a longer wait than the default.
        let timeout = path
            .split_once("wait_s=")
            .and_then(|(_, rest)| rest.split('&').next())
            .and_then(|n| n.parse::<u64>().ok())
            .map(|n| Duration::from_secs(n.min(25) + 15));
        self.client(id)?.request(m, path, body.as_ref(), timeout).await
    }

    /// One MCP tool, from the short list in relay::TOOLS.
    pub async fn tool(&self, id: &str, name: &str, args: Value) -> CoreResult<ToolOutput> {
        if !TOOLS.contains(&name) {
            return Err(CoreError::invalid("The app does not use that tool."));
        }
        if !args.is_object() {
            return Err(CoreError::invalid("A tool's arguments are an object."));
        }
        self.client(id)?.tool(name, args).await
    }

    pub fn recent_items(&self) -> Vec<AccountItem> {
        self.recent.all()
    }

    pub fn prefs(&self) -> Prefs {
        self.store.prefs()
    }

    pub fn set_prefs(&self, prefs: Prefs) -> CoreResult<()> {
        self.store.set_prefs(prefs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feed::FeedItem;
    use crate::seal::DevSealer;
    use crate::testkit::*;
    use serde_json::json;

    #[derive(Default)]
    struct Emits(Mutex<Vec<(String, Value)>>);
    impl Emitter for Emits {
        fn emit(&self, e: &str, p: Value) {
            self.0.lock().unwrap().push((e.to_string(), p));
        }
    }
    struct NoNotifier;
    impl Notifier for NoNotifier {
        fn show(&self, _a: &str, _i: &FeedItem) {}
    }
    // Plays the person: approves at once.
    struct Approver;
    impl Browser for Approver {
        fn open(&self, url: &str) -> CoreResult<()> {
            let u = url::Url::parse(url).unwrap();
            let get = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned()).unwrap();
            let target = format!("{}?code=C1&state={}", get("redirect_uri"), get("state"));
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                let _ = reqwest::get(&target).await;
            });
            Ok(())
        }
    }
    struct Silent;
    impl Browser for Silent {
        fn open(&self, _url: &str) -> CoreResult<()> {
            Ok(())
        }
    }

    const CONFIG: CoreConfig = CoreConfig {
        retry: FAST,
        feed: FeedTuning { wait_s: 1, backoff_base: Duration::from_millis(5), backoff_cap: Duration::from_millis(20), min_gap: Duration::from_millis(30) },
        sign_in_timeout: Duration::from_secs(5),
    };

    fn relay(base: Arc<Mutex<String>>) -> impl Fn(&Req) -> Resp + Send + Sync + 'static {
        move |r| {
            let o = base.lock().unwrap().clone();
            match (r.method.as_str(), r.path()) {
                ("GET", "/.well-known/oauth-protected-resource/app/w/default") => Resp::json(200, json!({ "resource": format!("{o}/app/w/default"), "authorization_servers": [o] })),
                ("GET", "/.well-known/oauth-authorization-server") => Resp::json(200, json!({
                    "authorization_endpoint": format!("{o}/oauth/authorize"), "token_endpoint": format!("{o}/oauth/token"), "registration_endpoint": format!("{o}/oauth/register") })),
                ("POST", "/oauth/register") => Resp::json(201, json!({ "client_id": "cid" })),
                ("POST", "/oauth/token") => Resp::json(200, json!({ "access_token": "ACC", "refresh_token": "REF", "expires_in": 3600 })),
                ("GET", "/app/w/default/teams") => Resp::json(200, json!({ "teams": [{ "slug": "default", "name": "Default" }, { "slug": "acme", "name": "Acme Support" }] })),
                ("GET", "/app/w/default/api") => Resp::json(200, json!({ "workspace": { "slug": "default", "open": false }, "me": { "identity": "tech@example.com", "role_id": "technician", "permissions": ["devices.view"] } })),
                ("GET", "/app/w/default/notifications") => Resp::json(200, json!({ "items": [], "next": 0 })).after(30),
                ("GET", "/app/w/default/api/devices") => Resp::json(200, json!({ "devices": [], "next": null })),
                ("POST", "/app/w/default/mcp") => Resp::json(200, json!({ "result": { "content": [{ "type": "text", "text": "{\"sessions\":[]}" }] } })),
                _ => Resp::json(404, json!({ "error": { "code": "not_found", "message": "not found" } })),
            }
        }
    }

    async fn core_with(browser: Arc<dyn Browser>) -> (Arc<Core>, FakeServer, Arc<Emits>) {
        let base = Arc::new(Mutex::new(String::new()));
        let server = FakeServer::start(relay(base.clone())).await;
        *base.lock().unwrap() = server.url();
        let emits = Arc::new(Emits::default());
        let store = Arc::new(Store::open(&temp_dir("core"), Arc::new(DevSealer)).unwrap());
        let core = Core::new(store, emits.clone(), Arc::new(NoNotifier), browser, CONFIG);
        (core, server, emits)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn signing_in_saves_the_account_fills_its_profile_and_starts_the_feed() {
        let (core, server, emits) = core_with(Arc::new(Approver)).await;
        let acc = core.sign_in(&server.url(), "Default").await.unwrap();
        assert!(acc.signed_in);
        assert_eq!((acc.team.as_str(), acc.team_name.as_deref(), acc.email.as_deref()), ("default", Some("Default"), Some("tech@example.com")));
        assert_eq!(core.accounts(), vec![acc.clone()]);
        assert!(emits.0.lock().unwrap().iter().any(|(e, _)| e == "account://changed"));
        for _ in 0..100 {
            if server.count("/app/w/default/notifications") > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(server.count("/app/w/default/notifications") > 0, "the feed loop is running");
        // A call for the screens goes out with the sign-in.
        let v = core.request(&acc.id, "GET", "/api/devices", None).await.unwrap();
        assert!(v["devices"].is_array());
        let out = core.tool(&acc.id, "session_list", json!({})).await.unwrap();
        assert!(out.data["sessions"].is_array());
        assert!(server.seen().iter().all(|r| !r.headers.contains_key("origin")));
        // Signing out removes the account and stops the feed.
        core.sign_out(&acc.id).unwrap();
        assert!(core.accounts().is_empty());
        tokio::time::sleep(Duration::from_millis(100)).await;
        let polls = server.count("/app/w/default/notifications");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(server.count("/app/w/default/notifications"), polls, "no more polling");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_core_refuses_what_the_app_does_not_do() {
        let (core, server, _e) = core_with(Arc::new(Approver)).await;
        let acc = core.sign_in(&server.url(), "default").await.unwrap();
        for (m, p) in [("GET", "/api/members"), ("POST", "/mcp"), ("DELETE", "/api/devices/abcdefghijklmnopqrst"), ("GET", "/notifications?after=0")] {
            let err = core.request(&acc.id, m, p, None).await.unwrap_err();
            assert_eq!(err.code(), "invalid", "{m} {p}");
        }
        for tool in ["click", "run", "type_text", "agent_start", "put_file"] {
            assert_eq!(core.tool(&acc.id, tool, json!({})).await.unwrap_err().code(), "invalid", "{tool}");
        }
        assert!(core.tool(&acc.id, "session_list", json!("x")).await.is_err());
        assert_eq!(core.request("no-such-account", "GET", "/api", None).await.unwrap_err().code(), "invalid");
        // Nothing reached the relay for the refused ones.
        assert_eq!(server.count("/app/w/default/api/members"), 0);
        assert_eq!(server.count("/app/w/default/mcp"), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_sign_in_is_refused_while_one_is_open_and_cancel_ends_it() {
        let (core, server, _e) = core_with(Arc::new(Silent)).await;
        let first = {
            let core = core.clone();
            let url = server.url();
            tokio::spawn(async move { core.sign_in(&url, "default").await })
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
        let second = core.sign_in(&server.url(), "default").await.unwrap_err();
        assert_eq!(second.code(), "invalid");
        core.cancel_sign_in();
        let r = first.await.unwrap();
        assert!(r.is_err());
        assert!(core.accounts().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bad_addresses_and_team_names_are_refused_before_any_request() {
        let (core, server, _e) = core_with(Arc::new(Approver)).await;
        assert!(core.sign_in("http://relay.example", "default").await.is_err());
        assert!(core.sign_in(&server.url(), "Not A Team!").await.is_err());
        assert!(server.seen().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_signed_out_account_stays_listed_and_calls_say_so() {
        let (core, server, _e) = core_with(Arc::new(Approver)).await;
        let acc = core.sign_in(&server.url(), "default").await.unwrap();
        core.store.clear_tokens(&acc.id).unwrap();
        core.stop_feed(&acc.id);
        let listed = core.accounts();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].signed_in);
        assert_eq!(core.request(&acc.id, "GET", "/api/devices", None).await.unwrap_err().code(), "signed_out");
    }
}
