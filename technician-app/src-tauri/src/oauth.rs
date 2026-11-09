// Signing in. The app is a public OAuth client of the relay, as Claude Code is, with its own
// address per team (<relay>/app/w/<team>):
//   1. read the relay's discovery documents (they must name the relay's own address)
//   2. register as a public client (token_endpoint_auth_method none), once per relay
//   3. listen on 127.0.0.1 at a random port, /callback
//   4. open the system browser at the authorize address (PKCE S256, state, resource)
//   5. take the code the browser brings back, and exchange it for tokens
// The tokens are sealed into the store. No secret is held: a desktop app cannot keep one.
use crate::error::{CoreError, CoreResult};
use crate::relay::{relay_error, tokens_from_answer, RetryPolicy};
use crate::store::{StoredAccount, Store};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The redirect address registered with the relay. Any port on a loopback host matches it.
pub const REGISTERED_REDIRECT: &str = "http://127.0.0.1/callback";
pub const CLIENT_NAME: &str = "Support technician app";
/// How long the person has to finish signing in in the browser.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(600);

/// Opens an address for the person. The system browser in a release build; a file in the
/// end-to-end build, so a test can walk the pages in a browser of its own.
pub trait Browser: Send + Sync {
    fn open(&self, url: &str) -> CoreResult<()>;
}

/// The end-to-end build's "browser": writes the address to a file.
pub struct FileBrowser {
    pub path: std::path::PathBuf,
}

impl Browser for FileBrowser {
    fn open(&self, url: &str) -> CoreResult<()> {
        std::fs::write(&self.path, url)?;
        Ok(())
    }
}

pub struct SignInCtx {
    pub http: reqwest::Client,
    pub store: Arc<Store>,
    pub browser: Arc<dyn Browser>,
    pub retry: RetryPolicy,
    pub timeout: Duration,
}

pub struct Discovery {
    pub resource: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: String,
}

fn b64url(bytes: &[u8]) -> String {
    B64URL.encode(bytes)
}

fn random_b64url(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::rng().fill_bytes(&mut buf);
    b64url(&buf)
}

/// A PKCE verifier (43 characters) and its S256 challenge.
pub fn pkce() -> (String, String) {
    let verifier = random_b64url(32);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn same_origin(address: &str, relay: &str) -> bool {
    address == relay || address.starts_with(&format!("{relay}/"))
}

async fn get_json(http: &reqwest::Client, url: &str) -> CoreResult<(u16, Value)> {
    let resp = http.get(url).send().await?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

/// Reads the relay's two discovery documents. Both must name the relay's own address, so a
/// relay cannot send the sign-in, or the tokens, anywhere else.
pub async fn discover(http: &reqwest::Client, relay: &str, team: &str) -> CoreResult<Discovery> {
    let resource = format!("{relay}/app/w/{team}");
    let (status, doc) = get_json(http, &format!("{relay}/.well-known/oauth-protected-resource/app/w/{team}")).await?;
    match status {
        200 => {}
        404 => return Err(CoreError::invalid("This relay has no team with that name, or sign-in is not set up on it.")),
        503 => return Err(CoreError::Unavailable("The relay is busy. Try again in a moment.".into())),
        _ => return Err(CoreError::invalid("That address did not answer like a Support relay.")),
    }
    if doc["resource"].as_str() != Some(resource.as_str()) {
        return Err(CoreError::invalid("The relay names a different address for itself. Use the address it names."));
    }
    if doc["authorization_servers"].as_array().and_then(|a| a.first()).and_then(Value::as_str) != Some(relay) {
        return Err(CoreError::invalid("The relay uses another server to sign in, which this app does not accept."));
    }
    let (status, meta) = get_json(http, &format!("{relay}/.well-known/oauth-authorization-server")).await?;
    if status != 200 {
        return Err(CoreError::invalid("That address did not answer like a Support relay."));
    }
    let endpoint = |name: &str| -> CoreResult<String> {
        let v = meta[name].as_str().unwrap_or_default();
        if same_origin(v, relay) {
            Ok(v.to_string())
        } else {
            Err(CoreError::invalid("The relay's sign-in addresses are not its own."))
        }
    };
    Ok(Discovery {
        resource,
        authorization_endpoint: endpoint("authorization_endpoint")?,
        token_endpoint: endpoint("token_endpoint")?,
        registration_endpoint: endpoint("registration_endpoint")?,
    })
}

/// Registers the app as a public client. Returns its client id.
pub async fn register(http: &reqwest::Client, d: &Discovery) -> CoreResult<String> {
    let body = json!({
        "client_name": CLIENT_NAME,
        "redirect_uris": [REGISTERED_REDIRECT],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let resp = http.post(&d.registration_endpoint).json(&body).send().await?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if status == 503 {
        return Err(CoreError::Unavailable("The relay is busy. Try again in a moment.".into()));
    }
    if status != 201 && status != 200 {
        return Err(relay_error(status, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| CoreError::other("The relay's registration answer was not understood."))?;
    v["client_id"].as_str().map(str::to_string).ok_or_else(|| CoreError::other("The relay sent no client id."))
}

/// The address the person opens to sign in.
pub fn authorize_url(d: &Discovery, client_id: &str, redirect_uri: &str, state: &str, challenge: &str) -> CoreResult<String> {
    let mut url = url::Url::parse(&d.authorization_endpoint).map_err(|_| CoreError::other("Bad authorize address."))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("resource", &d.resource);
    Ok(url.to_string())
}

const DONE_PAGE: &str = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Support</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111827}</style><h1>You are signed in</h1><p>You can close this tab and go back to the Support app.</p></html>";
const FAIL_PAGE: &str = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Support</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111827}</style><h1>Sign-in did not finish</h1><p>Go back to the Support app and try again.</p></html>";

async fn reply(sock: &mut TcpStream, status: &str, body: &str) {
    let out = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\ncache-control: no-store\r\ncontent-security-policy: default-src 'none'; style-src 'unsafe-inline'\r\nreferrer-policy: no-referrer\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(out.as_bytes()).await;
    let _ = sock.shutdown().await;
}

/// The listener on 127.0.0.1 that takes the browser's return.
pub struct Loopback {
    listener: TcpListener,
    pub port: u16,
}

/// How long one connection to the listener may take to send its request.
const CONNECTION_LIMIT: Duration = Duration::from_secs(5);
/// How many connections to the listener are read at the same time.
const MAX_OPEN: usize = 256;

enum Callback {
    Code(String),
    Denied,
    Ignore,
}

impl Loopback {
    pub async fn bind() -> CoreResult<Loopback> {
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| CoreError::other("Could not listen for the browser on this PC."))?;
        let port = listener.local_addr().map_err(|_| CoreError::other("Could not listen for the browser on this PC."))?.port();
        Ok(Loopback { listener, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    /// Waits for the browser's return with this `state`. A request that is not it (another
    /// path, another host name, a wrong state) is answered and ignored: only the right
    /// return ends the wait.
    ///
    /// Each connection is read on its own task with its own 5 second limit, so a process on
    /// this PC that connects and says nothing (or sends a byte at a time) cannot hold up the
    /// browser's return. At most MAX_OPEN connections are read at once; more are closed.
    pub async fn wait_for_code(&self, state: &str) -> CoreResult<String> {
        let mut open = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = self.listener.accept() => {
                    let (sock, _) = accepted.map_err(|_| CoreError::other("The listener for the browser stopped."))?;
                    if open.len() >= MAX_OPEN {
                        continue; // dropped: closed without a word
                    }
                    let (port, state) = (self.port, state.to_string());
                    open.spawn(async move {
                        let mut sock = sock;
                        tokio::time::timeout(CONNECTION_LIMIT, Self::handle(port, &mut sock, &state)).await.unwrap_or(Callback::Ignore)
                    });
                }
                Some(done) = open.join_next(), if !open.is_empty() => match done {
                    Ok(Callback::Code(code)) => return Ok(code),
                    Ok(Callback::Denied) => return Err(CoreError::invalid("Sign-in was not approved.")),
                    _ => {}
                },
            }
        }
    }

    async fn handle(port: u16, sock: &mut TcpStream, state: &str) -> Callback {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 2048];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            match sock.read(&mut chunk).await {
                Ok(0) | Err(_) => return Callback::Ignore,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
            if buf.len() > 8192 {
                reply(sock, "431 Request Header Fields Too Large", FAIL_PAGE).await;
                return Callback::Ignore;
            }
        }
        let head = String::from_utf8_lossy(&buf).to_string();
        let mut lines = head.split("\r\n");
        let mut first = lines.next().unwrap_or("").split(' ');
        let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
        let host = lines.find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("host")).map(|(_, v)| v.trim().to_string()));
        // Only the address the person's own browser was sent to.
        if host.as_deref() != Some(&format!("127.0.0.1:{port}")) {
            reply(sock, "400 Bad Request", FAIL_PAGE).await;
            return Callback::Ignore;
        }
        let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else {
            reply(sock, "400 Bad Request", FAIL_PAGE).await;
            return Callback::Ignore;
        };
        if method != "GET" || url.path() != "/callback" {
            reply(sock, "404 Not Found", FAIL_PAGE).await;
            return Callback::Ignore;
        }
        let param = |k: &str| url.query_pairs().find(|(name, _)| name == k).map(|(_, v)| v.into_owned());
        if param("state").as_deref() != Some(state) {
            reply(sock, "400 Bad Request", FAIL_PAGE).await;
            return Callback::Ignore;
        }
        if param("error").is_some() {
            reply(sock, "200 OK", FAIL_PAGE).await;
            return Callback::Denied;
        }
        match param("code") {
            Some(code) if !code.is_empty() && code.len() < 2000 => {
                reply(sock, "200 OK", DONE_PAGE).await;
                Callback::Code(code)
            }
            _ => {
                reply(sock, "400 Bad Request", FAIL_PAGE).await;
                Callback::Ignore
            }
        }
    }
}

async fn exchange(ctx: &SignInCtx, relay: &str, d: &Discovery, client_id: &str, code: &str, redirect_uri: &str, verifier: &str) -> CoreResult<crate::store::Tokens> {
    let mut attempt = 0;
    loop {
        let resp = ctx
            .http
            .post(&d.token_endpoint)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("client_id", client_id),
                ("code_verifier", verifier),
                ("resource", d.resource.as_str()),
            ])
            .send()
            .await?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        match status {
            200 => return tokens_from_answer(&text, None),
            // A refusal never uses up a code, so a busy relay is asked again.
            503 if attempt < ctx.retry.retries => {
                tokio::time::sleep((ctx.retry.base * 2u32.saturating_pow(attempt)).min(ctx.retry.cap)).await;
                attempt += 1;
            }
            503 => return Err(CoreError::Unavailable("The relay is busy. Try again in a moment.".into())),
            _ => {
                let err: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                if err["error"] == "invalid_client" {
                    // The relay does not know the client id we kept (its database was reset).
                    let _ = ctx.store.forget_client(relay);
                    return Err(CoreError::invalid("The relay no longer knows this app. Try signing in again."));
                }
                return Err(relay_error(status, &text));
            }
        }
    }
}

/// Signs in to `team` on `relay` (both already checked). Opens the browser, waits for the
/// person to approve, and saves the account with its sealed tokens. Returns the account id.
/// Dropping the future (the person cancelled) closes the listener.
pub async fn sign_in(ctx: &SignInCtx, relay: &str, team: &str) -> CoreResult<String> {
    let d = discover(&ctx.http, relay, team).await?;
    let client_id = match ctx.store.client_for(relay) {
        Some(id) => id,
        None => {
            let id = register(&ctx.http, &d).await?;
            ctx.store.set_client(relay, &id)?;
            id
        }
    };
    let loopback = Loopback::bind().await?;
    let redirect = loopback.redirect_uri();
    let (verifier, challenge) = pkce();
    let state = random_b64url(16);
    let url = authorize_url(&d, &client_id, &redirect, &state, &challenge)?;
    ctx.browser.open(&url)?;
    let code = tokio::time::timeout(ctx.timeout, loopback.wait_for_code(&state))
        .await
        .map_err(|_| CoreError::invalid("Sign-in took too long. Try again."))??;
    drop(loopback);
    let tokens = exchange(ctx, relay, &d, &client_id, &code, &redirect, &verifier).await?;
    let account = StoredAccount {
        id: String::new(),
        relay: relay.to_string(),
        team: team.to_string(),
        team_name: None,
        email: None,
        client_id,
        token_endpoint: d.token_endpoint.clone(),
        sealed: None,
    };
    ctx.store.put_account(account, &tokens)?;
    Ok(crate::store::account_id(relay, team))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::http_client;
    use crate::seal::DevSealer;
    use crate::testkit::*;
    use std::sync::Mutex;

    // What the person's browser does with an authorize address: the addresses it then visits.
    type Behave = Box<dyn Fn(&url::Url) -> Vec<String> + Send + Sync>;

    // A browser that plays the person: it reads the authorize address, then sends the
    // browser's return to the app's listener.
    struct ScriptedBrowser {
        urls: Arc<Mutex<Vec<String>>>,
        behave: Behave,
    }

    impl Browser for ScriptedBrowser {
        fn open(&self, url: &str) -> CoreResult<()> {
            self.urls.lock().unwrap().push(url.to_string());
            let parsed = url::Url::parse(url).unwrap();
            for target in (self.behave)(&parsed) {
                tokio::spawn(async move {
                    // The "browser" follows the redirect with a plain GET.
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    let _ = reqwest::get(&target).await;
                });
            }
            Ok(())
        }
    }

    fn q(url: &url::Url, k: &str) -> String {
        url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned()).unwrap_or_default()
    }

    fn approve(url: &url::Url) -> Vec<String> {
        vec![format!("{}?code=CODE-1&state={}", q(url, "redirect_uri"), q(url, "state"))]
    }

    // The relay, as the real one answers (src/oauth.js, src/app.js).
    fn relay_handler(base: Arc<Mutex<String>>) -> impl Fn(&Req) -> Resp + Send + Sync + 'static {
        move |r| {
            let origin = base.lock().unwrap().clone();
            match (r.method.as_str(), r.path()) {
                ("GET", "/.well-known/oauth-protected-resource/app/w/default") => Resp::json(200, json!({
                    "resource": format!("{origin}/app/w/default"), "authorization_servers": [origin], "bearer_methods_supported": ["header"], "resource_name": "Support-MCP" })),
                ("GET", p) if p.starts_with("/.well-known/oauth-protected-resource/app/w/") => Resp::json(404, json!({ "error": "not_found" })),
                ("GET", "/.well-known/oauth-authorization-server") => Resp::json(200, json!({
                    "issuer": origin, "authorization_endpoint": format!("{origin}/oauth/authorize"),
                    "token_endpoint": format!("{origin}/oauth/token"), "registration_endpoint": format!("{origin}/oauth/register") })),
                ("POST", "/oauth/register") => Resp::json(201, json!({ "client_id": "client-from-register" })),
                ("POST", "/oauth/token") => Resp::json(200, json!({ "access_token": "ACC-1", "refresh_token": "REF-1", "expires_in": 3600, "token_type": "bearer" })),
                _ => Resp::json(404, json!({})),
            }
        }
    }

    async fn setup(behave: impl Fn(&url::Url) -> Vec<String> + Send + Sync + 'static) -> (FakeServer, SignInCtx, Arc<Mutex<Vec<String>>>) {
        let base = Arc::new(Mutex::new(String::new()));
        let server = FakeServer::start(relay_handler(base.clone())).await;
        *base.lock().unwrap() = server.url();
        let urls = Arc::new(Mutex::new(Vec::new()));
        let ctx = SignInCtx {
            http: http_client(),
            store: Arc::new(Store::open(&temp_dir("oauth"), Arc::new(DevSealer)).unwrap()),
            browser: Arc::new(ScriptedBrowser { urls: urls.clone(), behave: Box::new(behave) }),
            retry: FAST,
            timeout: Duration::from_secs(5),
        };
        (server, ctx, urls)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_whole_flow_against_a_fake_relay() {
        let (server, ctx, urls) = setup(approve).await;
        let id = sign_in(&ctx, &server.url(), "default").await.unwrap();

        // Registration: a public client with the loopback redirect.
        let reg = server.seen().into_iter().find(|r| r.path() == "/oauth/register").unwrap().json();
        assert_eq!(reg["token_endpoint_auth_method"], "none");
        assert_eq!(reg["redirect_uris"][0], "http://127.0.0.1/callback");
        assert_eq!(reg["grant_types"], json!(["authorization_code", "refresh_token"]));

        // The authorize address: PKCE S256, a state, the resource, a random loopback port.
        let url = url::Url::parse(&urls.lock().unwrap()[0]).unwrap();
        assert_eq!(url.path(), "/oauth/authorize");
        assert_eq!(q(&url, "response_type"), "code");
        assert_eq!(q(&url, "client_id"), "client-from-register");
        assert_eq!(q(&url, "code_challenge_method"), "S256");
        assert_eq!(q(&url, "resource"), format!("{}/app/w/default", server.url()));
        let redirect = url::Url::parse(&q(&url, "redirect_uri")).unwrap();
        assert_eq!((redirect.scheme(), redirect.host_str(), redirect.path()), ("http", Some("127.0.0.1"), "/callback"));
        assert!(redirect.port().unwrap() > 1024);
        assert!(q(&url, "state").len() >= 20);

        // The token request proves the verifier that made the challenge.
        let token = server.seen().into_iter().find(|r| r.path() == "/oauth/token").unwrap();
        let verifier = token.form("code_verifier").unwrap();
        assert_eq!(verifier.len(), 43);
        assert_eq!(b64url(&Sha256::digest(verifier.as_bytes())), q(&url, "code_challenge"));
        assert_eq!(token.form("grant_type").as_deref(), Some("authorization_code"));
        assert_eq!(token.form("code").as_deref(), Some("CODE-1"));
        assert_eq!(token.form("redirect_uri").unwrap(), q(&url, "redirect_uri"));
        assert!(token.form("client_secret").is_none());

        // No request to the relay carried an Origin header.
        assert!(server.seen().iter().all(|r| !r.headers.contains_key("origin")));

        // The account is saved with sealed tokens.
        let t = ctx.store.tokens(&id).unwrap();
        assert_eq!((t.access.as_str(), t.refresh.as_str()), ("ACC-1", "REF-1"));
        let a = ctx.store.account(&id).unwrap();
        assert_eq!(a.token_endpoint, format!("{}/oauth/token", server.url()));
        assert_eq!(a.client_id, "client-from-register");

        // A second sign-in reuses the client id: no second registration.
        sign_in(&ctx, &server.url(), "default").await.unwrap();
        assert_eq!(server.count("/oauth/register"), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_stray_request_is_ignored_and_only_the_right_state_finishes() {
        let (server, ctx, _urls) = setup(|url| {
            let redirect = q(url, "redirect_uri");
            vec![
                format!("{redirect}?code=EVIL&state=wrong"),
                redirect.replace("/callback", "/favicon.ico"),
                format!("{redirect}?code=CODE-1&state={}", q(url, "state")),
            ]
        })
        .await;
        sign_in(&ctx, &server.url(), "default").await.unwrap();
        assert_eq!(server.seen().iter().find(|r| r.path() == "/oauth/token").unwrap().form("code").as_deref(), Some("CODE-1"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_denied_sign_in_fails_and_saves_nothing() {
        let (server, ctx, _u) = setup(|url| vec![format!("{}?error=access_denied&state={}", q(url, "redirect_uri"), q(url, "state"))]).await;
        let err = sign_in(&ctx, &server.url(), "default").await.unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{err:?}");
        assert!(ctx.store.accounts().is_empty());
        assert_eq!(server.count("/oauth/token"), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_sign_in_nobody_finishes_times_out() {
        let (server, mut ctx, _u) = setup(|_| vec![]).await;
        ctx.timeout = Duration::from_millis(200);
        assert!(matches!(sign_in(&ctx, &server.url(), "default").await.unwrap_err(), CoreError::Invalid(_)));
        assert!(ctx.store.accounts().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn discovery_refuses_a_relay_that_names_another_address() {
        // Unknown team.
        let (server, ctx, _u) = setup(approve).await;
        let err = sign_in(&ctx, &server.url(), "nowhere").await.unwrap_err();
        assert!(err.to_string().contains("no team"), "{err}");

        // A relay whose documents point at other hosts.
        let evil = FakeServer::start(|r| match r.path() {
            "/.well-known/oauth-protected-resource/app/w/default" => Resp::json(200, json!({ "resource": "https://evil.example/app/w/default", "authorization_servers": ["https://evil.example"] })),
            _ => Resp::json(404, json!({})),
        })
        .await;
        assert!(discover(&http_client(), &evil.url(), "default").await.is_err());

        let base = Arc::new(Mutex::new(String::new()));
        let split = FakeServer::start({
            let base = base.clone();
            move |r| {
                let origin = base.lock().unwrap().clone();
                match r.path() {
                    "/.well-known/oauth-protected-resource/app/w/default" => Resp::json(200, json!({ "resource": format!("{origin}/app/w/default"), "authorization_servers": [origin] })),
                    "/.well-known/oauth-authorization-server" => Resp::json(200, json!({
                        "authorization_endpoint": format!("{origin}/oauth/authorize"), "token_endpoint": "https://evil.example/oauth/token", "registration_endpoint": format!("{origin}/oauth/register") })),
                    _ => Resp::json(404, json!({})),
                }
            }
        })
        .await;
        *base.lock().unwrap() = split.url();
        assert!(discover(&http_client(), &split.url(), "default").await.is_err(), "a token endpoint on another host is refused");
        assert_eq!(server.count("/oauth/token"), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_listener_answers_only_the_returning_browser() {
        let lb = Loopback::bind().await.unwrap();
        let port = lb.port;
        let wait = tokio::spawn(async move { lb.wait_for_code("S").await });
        let base = format!("http://127.0.0.1:{port}");
        let http = http_client();
        assert_eq!(http.get(format!("{base}/other?code=x&state=S")).send().await.unwrap().status(), 404);
        assert_eq!(http.get(format!("{base}/callback?code=x&state=T")).send().await.unwrap().status(), 400);
        assert_eq!(http.get(format!("{base}/callback?state=S")).send().await.unwrap().status(), 400);
        // A Host header that is not the loopback address (a rebinding attempt) is refused.
        let bad_host = http.get(format!("{base}/callback?code=x&state=S")).header("host", "evil.example").send().await.unwrap();
        assert_eq!(bad_host.status(), 400);
        assert!(!wait.is_finished());
        let ok = http.get(format!("{base}/callback?code=GOOD&state=S")).send().await.unwrap();
        assert_eq!(ok.status(), 200);
        let page = ok.text().await.unwrap();
        assert!(page.contains("signed in") || page.contains("You are signed in"));
        assert_eq!(wait.await.unwrap().unwrap(), "GOOD");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn connections_that_say_nothing_cannot_hold_up_the_browsers_return() {
        let lb = Loopback::bind().await.unwrap();
        let port = lb.port;
        let wait = tokio::spawn(async move { lb.wait_for_code("S").await });
        // Far more silent connections than a listener that reads one at a time could wait out
        // inside the test's limit (each would take its 5 seconds).
        let mut idle = Vec::new();
        for _ in 0..40 {
            idle.push(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap());
        }
        let http = http_client();
        let ok = tokio::time::timeout(Duration::from_secs(2), http.get(format!("http://127.0.0.1:{port}/callback?code=GOOD&state=S")).send()).await.expect("answered while others sit silent").unwrap();
        assert_eq!(ok.status(), 200);
        assert_eq!(tokio::time::timeout(Duration::from_secs(2), wait).await.unwrap().unwrap().unwrap(), "GOOD");
        drop(idle);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_client_the_relay_forgot_is_dropped_so_the_next_try_registers_again() {
        let base = Arc::new(Mutex::new(String::new()));
        let server = FakeServer::start({
            let base = base.clone();
            let inner = relay_handler(base.clone());
            move |r| if r.path() == "/oauth/token" { Resp::json(400, json!({ "error": "invalid_client" })) } else { inner(r) }
        })
        .await;
        *base.lock().unwrap() = server.url();
        let urls = Arc::new(Mutex::new(Vec::new()));
        let ctx = SignInCtx {
            http: http_client(),
            store: Arc::new(Store::open(&temp_dir("forgot"), Arc::new(DevSealer)).unwrap()),
            browser: Arc::new(ScriptedBrowser { urls, behave: Box::new(approve) }),
            retry: FAST,
            timeout: Duration::from_secs(5),
        };
        assert!(sign_in(&ctx, &server.url(), "default").await.is_err());
        assert_eq!(ctx.store.client_for(&server.url()), None);
        assert!(ctx.store.accounts().is_empty());
    }

    #[test]
    fn the_end_to_end_browser_writes_the_address_to_a_file() {
        let path = temp_dir("e2e").join("authorize.txt");
        let b = FileBrowser { path: path.clone() };
        b.open("http://127.0.0.1:8787/oauth/authorize?x=1").unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "http://127.0.0.1:8787/oauth/authorize?x=1");
    }

    #[test]
    fn pkce_challenges_are_s256_of_the_verifier() {
        let (v, c) = pkce();
        assert_eq!(v.len(), 43);
        assert_eq!(c.len(), 43);
        assert_eq!(b64url(&Sha256::digest(v.as_bytes())), c);
        assert_ne!(pkce().0, v);
    }
}
