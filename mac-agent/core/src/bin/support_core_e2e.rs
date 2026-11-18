//! The end-to-end client: the core with a fake platform, pointed at a real relay by mac-agent/e2e/run.mjs.
//!
//!   support-core-e2e --origin http://127.0.0.1:8787 --code ABCDE-FGH23 [--control full|limited] [--name <name>]
//!
//! It pairs with the code (access "any"), checks in, listens on the doorbell, runs the one session the relay points it
//! to with a platform that runs commands with `sh -c`, reads and writes real files and serves a fixed JPEG for the
//! screen, and exits when that session ends. It prints one JSON object per line on stdout for the script to read and
//! never prints the device key. Each install or uninstall that reaches the fake platform is printed as a "program" event.
//!
//!   support-core-e2e --origin http://127.0.0.1:8787 --join <link code> [--decline]
//!
//! The one-off mode: it previews the link, redeems it with the core's redeem client, and joins the session with the
//! session key (`Auth::Attach`) and the same fake platform, until the session ends. With `--decline` it says
//! "Don't allow" instead of joining. It never prints the session key.

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support_core::clock::SystemClock;
use support_core::device::{self, DeviceConfig, DeviceLink, DeviceService, DoorbellConfig, Hooks, Identity};
use support_core::platform::FakePlatform;
use support_core::redeem;
use support_core::release::MacNote;
use support_core::rules::rules_tag;
use support_core::session::{send_decline, Client, Events, HttpTransport, SessionConfig, SessionEnd};
use support_core::wire::Control;

fn say(v: Value) {
    println!("{v}");
}

struct Printer {
    stop: Arc<support_core::stop::Stop>,
    seen_session: Mutex<bool>,
}

impl Hooks for Printer {
    fn state(&self, state: &str) {
        say(json!({ "event": "state", "state": state }));
    }
    fn history(&self, line: &str) {
        say(json!({ "event": "history", "line": line }));
    }
    fn session_accepted(&self, id: &str) {
        say(json!({ "event": "session_accepted", "id": id }));
    }
    fn update_offered(&self, note: &MacNote) {
        say(json!({ "event": "update_offered", "version": note.version }));
    }
    fn session(&self, by: Option<&str>) {
        match by {
            Some(by) => {
                *self.seen_session.lock().unwrap() = true;
                say(json!({ "event": "session_started", "by": by }));
            }
            None => {
                say(json!({ "event": "session_ended" }));
                if *self.seen_session.lock().unwrap() {
                    self.stop.set();
                }
            }
        }
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let (Some(origin), Some(code)) = (arg(&args, "--origin"), arg(&args, "--join")) {
        join(&origin, &code, args.iter().any(|a| a == "--decline")).await;
        return;
    }
    let (Some(origin), Some(code)) = (arg(&args, "--origin"), arg(&args, "--code")) else {
        eprintln!("usage: support-core-e2e --origin <relay> --code <pairing code> [--control full|limited] [--name <name>]");
        std::process::exit(2);
    };
    let control = arg(&args, "--control").unwrap_or_else(|| "full".into());
    let name = arg(&args, "--name").unwrap_or_else(|| "E2E Mac".into());
    // The relay tells a Mac by this text and no other (src/release.js isMacOs).
    let identity = Identity { os: device::os_string("26.1", "25B78"), machine: "E2E-Mac".into(), app_version: support_core::VERSION.into() };

    let link = DeviceLink::new(&origin).unwrap_or_else(|e| fail(&format!("origin: {e}")));
    let paired = match device::pair_with_code(&link, &code, &name, "any", &control, &identity).await {
        Ok(p) => p,
        Err(a) => fail(&format!("pairing failed: {:?} {} {}", a.result, a.status, a.message)),
    };
    say(json!({ "event": "paired", "status": paired.status, "device_id": paired.device_id, "workspace": paired.workspace }));

    let platform = Arc::new(FakePlatform::new(if control == "full" { Control::Full } else { Control::Normal }));
    // What reached the platform's install and uninstall, printed as it comes, so the script can tell what the relay refused.
    let fake = platform.clone();
    let mut told_programs = 0;
    let clock = SystemClock::new();
    let cfg = DeviceConfig {
        origin: origin.clone(),
        key: paired.key,
        identity,
        access: "any".into(),
        control,
        accepted_session: None,
        doorbell: DoorbellConfig::default(),
    };
    // The printer sets `quit` when the session ends, and a task turns that into a stop of the service.
    let quit = support_core::stop::Stop::new();
    let hooks = Arc::new(Printer { stop: quit.clone(), seen_session: Mutex::new(false) });
    let service = DeviceService::new(cfg, platform, hooks, clock, None).unwrap_or_else(|e| fail(&e));
    tokio::spawn({
        let service = service.clone();
        async move {
            quit.stopped().await;
            service.stop();
        }
    });

    let runner = tokio::spawn({
        let service = service.clone();
        async move { service.run().await }
    });
    let started = tokio::time::Instant::now();
    let mut told_bell = false;
    let mut told_rules = false;
    let max = arg(&args, "--max-seconds").and_then(|s| s.parse().ok()).unwrap_or(300u64);
    while !runner.is_finished() {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if !told_bell && service.doorbell_connected() {
            told_bell = true;
            say(json!({ "event": "doorbell", "connected": true }));
        }
        let view = service.rules().now();
        if !told_rules && view.timed {
            told_rules = true;
            // The tag the relay sent is the tag of the document it sent: this client reads the document as the relay hashed it.
            say(json!({ "event": "rules", "tag": view.tag, "tag_matches": rules_tag(&view.doc.raw) == view.tag, "folders": view.doc.folders }));
        }
        let programs: Vec<String> = fake.program_log.lock().unwrap()[told_programs..].to_vec();
        for line in programs {
            told_programs += 1;
            say(json!({ "event": "program", "line": line }));
        }
        if started.elapsed() > Duration::from_secs(max) {
            say(json!({ "event": "timeout" }));
            service.stop();
            break;
        }
    }
    let _ = runner.await;
    say(json!({ "event": "exit" }));
}

struct JoinPrinter;

impl Events for JoinPrinter {
    fn connected(&self) {
        say(json!({ "event": "connected" }));
    }
}

/// The one-off mode: preview, redeem, then decline or join.
async fn join(origin: &str, code: &str, decline: bool) {
    let preview = redeem::preview(origin, code).await.unwrap_or_else(|e| fail(&format!("preview: {}", e.text())));
    say(json!({ "event": "preview", "label": preview.label }));
    let redeemed = redeem::redeem(origin, code).await.unwrap_or_else(|e| fail(&format!("redeem: {}", e.text())));
    say(json!({ "event": "redeemed", "sid": redeemed.one_off.sid, "startup_ms": redeemed.startup_ms }));
    let transport = Arc::new(
        HttpTransport::new(&redeemed.origin, &redeemed.one_off.sid, redeemed.one_off.auth()).unwrap_or_else(|e| fail(&format!("transport: {e}"))),
    );
    if decline {
        let sent = send_decline(&*transport, "declined").await;
        say(json!({ "event": "declined", "sent": sent }));
        return;
    }
    let platform = Arc::new(FakePlatform::new(Control::Normal));
    let stop = support_core::stop::Stop::new();
    let client = Client::new(transport, platform, None, Arc::new(JoinPrinter), SessionConfig::new(Duration::from_millis(redeemed.startup_ms)), stop);
    let end = client.run().await;
    say(
        json!({ "event": "session_end", "how": match end { SessionEnd::Relay => "relay".to_string(), SessionEnd::Stopped => "stopped".to_string(), SessionEnd::Failed(e) => format!("failed: {e}") } }),
    );
}

fn fail(message: &str) -> ! {
    say(json!({ "event": "error", "message": message }));
    std::process::exit(1);
}
