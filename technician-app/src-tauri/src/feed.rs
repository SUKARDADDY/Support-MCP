// The notification feed. One loop per signed-in account holds a long poll open on the relay's
// /notifications route (the relay answers within 25 seconds, at once when there is a new
// item) and hands what arrives to a sink: the app's in-app list, an event for the screens,
// and a Windows notification when the person has them on.
//
// When the loop starts it first reads what is already there without notifying (items the app
// has not seen, or the person's whole backlog on a new account): the list shows them, but
// nothing pops up for old news. Only items that arrive after that are "live".
use crate::error::{CoreError, Msg};
use crate::relay::AccountClient;
use crate::store::Store;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const WAIT_S: u64 = 25;
/// How many recent items the app keeps for its list.
pub const RECENT_MAX: usize = 100;
const PAGE_MAX: usize = 50;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FeedItem {
    pub id: u64,
    pub event: String,
    pub at: u64,
    pub title: String,
    pub body: String,
    pub device_id: Option<String>,
    pub task_id: Option<String>,
    pub session_id: Option<String>,
}

/// What the screens get with each item: which account it is from.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct AccountItem {
    pub account: String,
    #[serde(flatten)]
    pub item: FeedItem,
}

/// Where a feed loop sends what it reads.
pub trait FeedSink: Send + Sync {
    /// `live` is false for the items read when the loop starts.
    fn items(&self, account: &str, items: &[FeedItem], live: bool);
    /// Whether the relay can be reached right now.
    fn status(&self, account: &str, online: bool);
}

#[derive(Clone, Copy)]
pub struct FeedTuning {
    pub wait_s: u64,
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
    /// The least time between two polls that came back empty, so a relay that answers a
    /// wait at once cannot make the loop spin.
    pub min_gap: Duration,
}

impl FeedTuning {
    pub const NORMAL: FeedTuning = FeedTuning {
        wait_s: WAIT_S,
        backoff_base: Duration::from_secs(2),
        backoff_cap: Duration::from_secs(60),
        min_gap: Duration::from_secs(2),
    };
}

fn parse_page(v: &Value) -> Option<(Vec<FeedItem>, u64)> {
    let items = serde_json::from_value::<Vec<FeedItem>>(v["items"].clone()).ok()?;
    let next = v["next"].as_u64()?;
    Some((items, next))
}

/// Strips control characters, which text from a customer's PC may carry into a title.
pub fn plain(s: &str) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// How much of a task's first line the relay keeps for its title (src/agent.js), in UTF-16 units.
const TASK_TITLE_CUT: usize = 100;

/// Cuts text the relay stopped at TASK_TITLE_CUT at the last whole word, and ends it with an
/// ellipsis, so a toast does not end in half a word.
fn cut_at_word(kept: &str) -> String {
    let head = match kept.rfind(char::is_whitespace) {
        Some(i) if i > 0 => &kept[..i],
        _ => kept,
    };
    format!("{}\u{2026}", head.trim_end_matches(|c: char| c.is_whitespace() || ",;:-".contains(c)))
}

/// The text of a task notification as a toast should show it. The relay keeps the first 100
/// characters of the instructions as the task's title and puts it in the body: alone for a
/// finished task, before ": <why>" for one that needs attention. A body whose title is exactly
/// that long was probably cut, so it is cut again at a word and ends in an ellipsis. Every other
/// event is returned as it is. (The screens show the full instructions where the app has them.)
pub fn tidy_task_body(event: &str, body: &str) -> String {
    let units = |s: &str| s.encode_utf16().count();
    match event {
        "task_finished" if units(body) == TASK_TITLE_CUT => cut_at_word(body),
        "task_problem" => {
            let mut seen = 0;
            for (at, c) in body.char_indices() {
                if seen == TASK_TITLE_CUT {
                    return match body[at..].strip_prefix(": ") {
                        Some(_) => format!("{}{}", cut_at_word(&body[..at]), &body[at..]),
                        None => body.to_string(),
                    };
                }
                seen += c.len_utf16();
            }
            body.to_string()
        }
        _ => body.to_string(),
    }
}

async fn read_page(client: &AccountClient, after: u64, wait_s: u64) -> Result<(Vec<FeedItem>, u64), CoreError> {
    let path = format!("/notifications?after={after}&wait_s={wait_s}");
    let timeout = Duration::from_secs(wait_s + 15);
    let v = client.request(Method::GET, &path, None, Some(timeout)).await?;
    parse_page(&v).ok_or_else(|| CoreError::other(Msg::RelayAnswerUnclear))
}

/// Runs until the account is signed out. Never returns otherwise: failures are waited out.
pub async fn run_feed(client: Arc<AccountClient>, store: Arc<Store>, sink: Arc<dyn FeedSink>, tuning: FeedTuning) {
    let id = client.id.clone();
    let mut after = store.cursor(&id).unwrap_or(0);
    let mut failures: u32 = 0;
    let mut caught_up = false;
    let mut online = true;
    loop {
        // Until it has caught up, the loop reads without waiting.
        let wait = if caught_up { tuning.wait_s } else { 0 };
        let started = Instant::now();
        match read_page(&client, after, wait).await {
            Ok((items, next)) => {
                failures = 0;
                if !online || !caught_up {
                    online = true;
                    sink.status(&id, true);
                }
                if !items.is_empty() {
                    let live = caught_up;
                    let count = items.len();
                    sink.items(&id, &items, live);
                    after = after.max(next);
                    let _ = store.set_cursor(&id, after);
                    if !caught_up && count >= PAGE_MAX {
                        continue; // more is waiting
                    }
                }
                if !caught_up {
                    caught_up = true;
                    // A new account has no cursor yet: remember where it starts.
                    let _ = store.set_cursor(&id, after);
                    continue;
                }
                if items.is_empty() && started.elapsed() < tuning.min_gap {
                    tokio::time::sleep(tuning.min_gap - started.elapsed()).await;
                }
            }
            Err(CoreError::SignedOut) => return,
            Err(e) => {
                if online {
                    online = false;
                    sink.status(&id, false);
                }
                let cap = if matches!(e, CoreError::Relay { .. }) { tuning.backoff_cap * 5 } else { tuning.backoff_cap };
                let delay = (tuning.backoff_base * 2u32.saturating_pow(failures.min(10))).min(cap);
                failures = failures.saturating_add(1);
                tokio::time::sleep(delay).await;
            }
        }
        if client.is_signed_out() {
            return;
        }
    }
}

/// The items the screens show in their notification list, newest last.
#[derive(Default)]
pub struct Recent {
    items: Mutex<VecDeque<AccountItem>>,
}

impl Recent {
    pub fn push(&self, account: &str, items: &[FeedItem]) {
        let mut q = self.items.lock().unwrap_or_else(|p| p.into_inner());
        for item in items {
            if q.iter().any(|x| x.account == account && x.item.id == item.id) {
                continue;
            }
            q.push_back(AccountItem { account: account.to_string(), item: item.clone() });
        }
        while q.len() > RECENT_MAX {
            q.pop_front();
        }
    }

    pub fn all(&self) -> Vec<AccountItem> {
        self.items.lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect()
    }

    pub fn clear_account(&self, account: &str) {
        self.items.lock().unwrap_or_else(|p| p.into_inner()).retain(|x| x.account != account);
    }
}

/// Sends events to the screens.
pub trait Emitter: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// Raises a Windows notification.
pub trait Notifier: Send + Sync {
    fn show(&self, account: &str, item: &FeedItem);
}

/// The sink the app uses: the list, an event, and (for live items, with notifications on) a
/// Windows notification.
pub struct CoreSink {
    pub recent: Arc<Recent>,
    pub emitter: Arc<dyn Emitter>,
    pub notifier: Arc<dyn Notifier>,
    pub store: Arc<Store>,
}

impl FeedSink for CoreSink {
    fn items(&self, account: &str, items: &[FeedItem], live: bool) {
        let clean: Vec<FeedItem> = items
            .iter()
            .map(|i| FeedItem { title: plain(&i.title), body: plain(&i.body), ..i.clone() })
            .collect();
        self.recent.push(account, &clean);
        self.emitter.emit("feed://items", json!({ "account": account, "items": clean, "live": live }));
        if live && self.store.prefs().desktop_notifications {
            for item in &clean {
                self.notifier.show(account, &FeedItem { body: tidy_task_body(&item.event, &item.body), ..item.clone() });
            }
        }
    }

    fn status(&self, account: &str, online: bool) {
        self.emitter.emit("feed://status", json!({ "account": account, "online": online }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::http_client;
    use crate::testkit::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const FASTFEED: FeedTuning = FeedTuning {
        wait_s: 25,
        backoff_base: Duration::from_millis(5),
        backoff_cap: Duration::from_millis(20),
        min_gap: Duration::from_millis(30),
    };

    #[derive(Default)]
    struct RecordingSink {
        batches: Mutex<Vec<(Vec<u64>, bool)>>,
        statuses: Mutex<Vec<bool>>,
    }

    impl FeedSink for RecordingSink {
        fn items(&self, _a: &str, items: &[FeedItem], live: bool) {
            self.batches.lock().unwrap().push((items.iter().map(|i| i.id).collect(), live));
        }
        fn status(&self, _a: &str, online: bool) {
            self.statuses.lock().unwrap().push(online);
        }
    }

    fn item(id: u64) -> Value {
        json!({ "id": id, "event": "device_waiting", "at": 1000 + id, "title": format!("t{id}"), "body": "b", "device_id": "abcdefghijklmnopqrst", "task_id": null, "session_id": null })
    }

    fn page(ids: &[u64], next: u64) -> Resp {
        Resp::json(200, json!({ "items": ids.iter().map(|i| item(*i)).collect::<Vec<_>>(), "next": next }))
    }

    async fn feed_client(url: &str, name: &str) -> (Arc<AccountClient>, Arc<Store>, String) {
        let (store, id) = store_with_account(name, url, &tokens("tok", "ref", 3_600_000));
        let c = AccountClient::new(store.clone(), http_client(), Arc::new(Events::default()), &id, FAST).unwrap();
        (Arc::new(c), store, id)
    }

    async fn until(what: &str, f: impl Fn() -> bool) {
        for _ in 0..200 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_new_account_reads_its_backlog_silently_then_goes_live() {
        let n = Arc::new(AtomicUsize::new(0));
        let counter = n.clone();
        let server = FakeServer::start(move |r| {
            assert_eq!(r.path(), "/app/w/default/notifications");
            assert!(!r.headers.contains_key("origin"));
            let after: u64 = r.query("after").unwrap().parse().unwrap();
            match (after, r.query("wait_s").unwrap().as_str()) {
                (0, "0") => page(&[1, 2, 3], 3),
                (3, "0") => page(&[], 3),
                (3, "25") => {
                    if counter.fetch_add(1, Ordering::SeqCst) == 0 { page(&[4], 4) } else { page(&[], 3).after(40) }
                }
                (4, "25") => page(&[], 4).after(40),
                other => panic!("unexpected poll {other:?}"),
            }
        })
        .await;
        let (client, store, id) = feed_client(&server.url(), "feed1").await;
        let sink = Arc::new(RecordingSink::default());
        let task = tokio::spawn(run_feed(client, store.clone(), sink.clone(), FASTFEED));
        until("the live item", || sink.batches.lock().unwrap().len() == 2).await;
        task.abort();
        assert_eq!(*sink.batches.lock().unwrap(), vec![(vec![1, 2, 3], false), (vec![4], true)]);
        assert_eq!(store.cursor(&id), Some(4));
        assert!(sink.statuses.lock().unwrap().first() == Some(&true));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_known_cursor_is_where_the_loop_starts() {
        let server = FakeServer::start(|r| match r.query("after").unwrap().as_str() {
            "7" => page(&[], 7).after(40),
            other => panic!("unexpected after {other}"),
        })
        .await;
        let (client, store, id) = feed_client(&server.url(), "feed2").await;
        store.set_cursor(&id, 7).unwrap();
        let sink = Arc::new(RecordingSink::default());
        let task = tokio::spawn(run_feed(client, store, sink.clone(), FASTFEED));
        until("two polls", || server.seen().len() >= 2).await;
        task.abort();
        assert!(sink.batches.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_full_page_of_backlog_is_followed_by_the_next() {
        let server = FakeServer::start(|r| {
            let after: u64 = r.query("after").unwrap().parse().unwrap();
            match after {
                0 => page(&(1..=50).collect::<Vec<_>>(), 50),
                50 => page(&[51, 52], 52),
                _ => page(&[], after).after(40),
            }
        })
        .await;
        let (client, store, _id) = feed_client(&server.url(), "feed3").await;
        let sink = Arc::new(RecordingSink::default());
        let task = tokio::spawn(run_feed(client, store, sink.clone(), FASTFEED));
        until("both pages", || sink.batches.lock().unwrap().len() == 2).await;
        task.abort();
        let b = sink.batches.lock().unwrap();
        assert_eq!(b[0].0.len(), 50);
        assert_eq!(b[1].0, vec![51, 52]);
        assert!(!b[0].1 && !b[1].1, "all of it is backlog");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_outage_is_reported_and_waited_out_then_the_feed_resumes() {
        let n = Arc::new(AtomicUsize::new(0));
        let counter = n.clone();
        let server = FakeServer::start(move |r| {
            let k = counter.fetch_add(1, Ordering::SeqCst);
            let after: u64 = r.query("after").unwrap().parse().unwrap();
            if (2..6).contains(&k) {
                return Resp::json(503, json!({ "error": "temporarily_unavailable" }));
            }
            if k == 6 { page(&[9], 9) } else { page(&[], after).after(40) }
        })
        .await;
        let (client, store, _id) = feed_client(&server.url(), "feed4").await;
        let sink = Arc::new(RecordingSink::default());
        let task = tokio::spawn(run_feed(client, store, sink.clone(), FASTFEED));
        until("the item after the outage", || sink.batches.lock().unwrap().iter().any(|b| b.0 == vec![9])).await;
        task.abort();
        let st = sink.statuses.lock().unwrap().clone();
        assert!(st.contains(&false), "the outage was reported: {st:?}");
        assert_eq!(st.last(), Some(&true), "and so was the recovery: {st:?}");
        assert!(sink.batches.lock().unwrap().iter().any(|b| b.0 == vec![9] && b.1));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_relay_that_answers_a_wait_at_once_cannot_make_the_loop_spin() {
        let server = FakeServer::start(|_| page(&[], 0)).await;
        let (client, store, _id) = feed_client(&server.url(), "feed5").await;
        let sink = Arc::new(RecordingSink::default());
        let task = tokio::spawn(run_feed(client, store, sink, FASTFEED));
        tokio::time::sleep(Duration::from_millis(300)).await;
        task.abort();
        // 30 ms between polls: about ten in 300 ms, never hundreds.
        assert!(server.seen().len() < 30, "{} polls", server.seen().len());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn being_signed_out_ends_the_loop() {
        let server = FakeServer::start(|_| Resp::json(401, json!({ "error": "invalid_token" }))).await;
        let (client, store, id) = feed_client(&server.url(), "feed6").await;
        // The refresh also answers 401, so the sign-in is dropped and the loop returns.
        let sink = Arc::new(RecordingSink::default());
        tokio::time::timeout(Duration::from_secs(5), run_feed(client, store.clone(), sink, FASTFEED)).await.expect("the loop ended");
        assert_eq!(store.tokens(&id), None);
    }

    #[derive(Default)]
    struct Emits(Mutex<Vec<(String, Value)>>);
    impl Emitter for Emits {
        fn emit(&self, e: &str, p: Value) {
            self.0.lock().unwrap().push((e.to_string(), p));
        }
    }
    #[derive(Default)]
    struct Shown(Mutex<Vec<(String, u64)>>);
    impl Notifier for Shown {
        fn show(&self, a: &str, i: &FeedItem) {
            self.0.lock().unwrap().push((a.to_string(), i.id));
        }
    }

    fn fi(id: u64, title: &str) -> FeedItem {
        FeedItem { id, event: "task_finished".into(), at: 1, title: title.into(), body: "b".into(), device_id: None, task_id: Some("x".into()), session_id: None }
    }

    #[test]
    fn the_sink_notifies_live_items_only_and_only_with_notifications_on() {
        let (store, _id) = store_with_account("sink", "http://127.0.0.1:1", &tokens("a", "b", 1000));
        let emits = Arc::new(Emits::default());
        let shown = Arc::new(Shown::default());
        let sink = CoreSink { recent: Arc::new(Recent::default()), emitter: emits.clone(), notifier: shown.clone(), store: store.clone() };
        sink.items("acc", &[fi(1, "old")], false);
        assert!(shown.0.lock().unwrap().is_empty(), "backlog raises no notification");
        sink.items("acc", &[fi(2, "new")], true);
        assert_eq!(*shown.0.lock().unwrap(), vec![("acc".to_string(), 2)]);
        store.set_prefs(crate::store::Prefs { desktop_notifications: false }).unwrap();
        sink.items("acc", &[fi(3, "quiet")], true);
        assert_eq!(shown.0.lock().unwrap().len(), 1, "switched off");
        // Every item still reaches the screens and the list.
        assert_eq!(emits.0.lock().unwrap().len(), 3);
        assert_eq!(sink.recent.all().len(), 3);
    }

    #[test]
    fn an_approval_request_is_raised_like_any_live_item_and_carries_its_session_for_the_screens() {
        let (store, _id) = store_with_account("sink4", "http://127.0.0.1:1", &tokens("a", "b", 1000));
        let emits = Arc::new(Emits::default());
        let shown = Arc::new(Shown::default());
        let sink = CoreSink { recent: Arc::new(Recent::default()), emitter: emits.clone(), notifier: shown.clone(), store };
        let sid = "0123456789abcdef".repeat(4);
        let ask = FeedItem {
            id: 7,
            event: "approval_requested".into(),
            at: 1,
            title: "Approval needed".into(),
            body: "tech@example.com asks to: Restart the PC in 30 seconds on Till. Approve or deny it in the app.".into(),
            device_id: Some("abcdefghijklmnopqrst".into()),
            task_id: None,
            session_id: Some(sid.clone()),
        };
        sink.items("acc", &[ask], true);
        assert_eq!(*shown.0.lock().unwrap(), vec![("acc".to_string(), 7)], "a Windows notification, though the item has no switch");
        // The screens read the session from the item to find the approval waiting on it.
        let sent = emits.0.lock().unwrap();
        assert_eq!(sent[0].0, "feed://items");
        assert_eq!(sent[0].1["items"][0]["event"], "approval_requested");
        assert_eq!(sent[0].1["items"][0]["session_id"], json!(sid));
    }

    struct Bodies(Mutex<Vec<String>>);
    impl Notifier for Bodies {
        fn show(&self, _a: &str, i: &FeedItem) {
            self.0.lock().unwrap().push(i.body.clone());
        }
    }

    #[test]
    fn a_task_title_the_relay_cut_ends_at_a_whole_word_in_the_toast_and_the_list_keeps_what_it_got() {
        let long = "Check why the receipt printer at the front counter stopped printing after the update, then finish wi";
        assert_eq!(long.len(), 100);
        let cut = "Check why the receipt printer at the front counter stopped printing after the update, then finish\u{2026}";
        assert_eq!(tidy_task_body("task_finished", long), cut);
        // "Task needs attention": the title is followed by why.
        assert_eq!(tidy_task_body("task_problem", &format!("{long}: the agent got stuck")), format!("{cut}: the agent got stuck"));
        // A title that fits, other events and other bodies are left alone.
        assert_eq!(tidy_task_body("task_finished", "Fix the printer"), "Fix the printer");
        assert_eq!(tidy_task_body("task_problem", "Fix the printer: stuck"), "Fix the printer: stuck");
        assert_eq!(tidy_task_body("device_waiting", long), long);
        // A cut with no space in it keeps what it has.
        let solid = "x".repeat(100);
        assert_eq!(tidy_task_body("task_finished", &solid), format!("{solid}\u{2026}"));

        let (store, _id) = store_with_account("sink3", "http://127.0.0.1:1", &tokens("a", "b", 1000));
        let emits = Arc::new(Emits::default());
        let bodies = Arc::new(Bodies(Mutex::new(Vec::new())));
        let sink = CoreSink { recent: Arc::new(Recent::default()), emitter: emits, notifier: bodies.clone(), store };
        let item = FeedItem { body: long.into(), ..fi(1, "Task finished") };
        sink.items("acc", &[item], true);
        assert_eq!(*bodies.0.lock().unwrap(), vec![cut.to_string()], "the toast");
        assert_eq!(sink.recent.all()[0].item.body, long, "the list gets the relay's text; the screens tidy it");
    }

    #[test]
    fn customer_pc_text_is_flattened_to_plain_text_and_the_list_is_bounded() {
        let (store, _id) = store_with_account("sink2", "http://127.0.0.1:1", &tokens("a", "b", 1000));
        let emits = Arc::new(Emits::default());
        let sink = CoreSink { recent: Arc::new(Recent::default()), emitter: emits.clone(), notifier: Arc::new(Shown::default()), store };
        sink.items("acc", &[fi(1, "<b>Front\u{0007}\ncounter</b>")], false);
        let all = sink.recent.all();
        assert_eq!(all[0].item.title, "<b>Front  counter</b>", "markup stays as text, control characters go");
        let many: Vec<FeedItem> = (2..=150).map(|i| fi(i, "t")).collect();
        sink.items("acc", &many, false);
        sink.items("acc", &many[many.len() - 10..], false); // ids already listed add nothing
        let all = sink.recent.all();
        assert_eq!(all.len(), RECENT_MAX);
        assert_eq!(all.last().unwrap().item.id, 150);
        sink.recent.clear_account("acc");
        assert!(sink.recent.all().is_empty());
    }
}
