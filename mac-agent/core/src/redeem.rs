//! The one-off link's redeem call (docs/relay-v1-spec.md, "One-off links for Macs"). A Mac cannot carry a session key
//! inside its signed file as the Windows exe does, so the join app asks the relay for it: `POST /j/<code>/redeem`.
//!
//! Two calls share the route. `preview` changes nothing and returns the session's label, so the person sees which
//! relay and which session they are joining before anything is used up. `redeem` uses the code up and returns the
//! session's id and key. The relay refuses a request with an `Origin` header and one without the JSON content type
//! and the `X-Support-Client` header, which a web page cannot send, so these two headers are what make this the app.

use crate::session::OneOff;
use crate::wire::{self, clean};
use serde_json::{json, Value};
use std::time::Duration;

pub const CLIENT_HEADER: &str = "macos-app-1";
const TIMEOUT: Duration = Duration::from_secs(30);
/// The answer is a few hundred bytes; anything over this is not the relay.
const ANSWER_MAX: usize = 16_384;
/// The first-connect window a link allows, in ms (the relay's two hours).
pub const STARTUP_MAX_MS: u64 = 7_200_000;

#[derive(Debug, PartialEq, Eq)]
pub enum RedeemError {
    /// The relay said no, or said something this client cannot use. The text is for the person.
    Refused(String),
    /// No answer: the relay could not be reached. The code is unused unless the answer was lost on its way back.
    Network(String),
}

impl RedeemError {
    pub fn text(&self) -> &str {
        match self {
            RedeemError::Refused(t) | RedeemError::Network(t) => t,
        }
    }
}

/// What the person is shown before joining.
#[derive(Debug, PartialEq, Eq)]
pub struct Preview {
    pub label: Option<String>,
}

/// A used-up code: the session to join.
#[derive(Debug)]
pub struct Redeemed {
    pub one_off: OneOff,
    pub origin: String,
    /// The first-connect deadline on the relay's clock, Unix ms.
    pub startup_expires_at: i64,
    /// What is left of the first-connect window now, counted on this Mac's own clock: 1 ms to two hours.
    pub startup_ms: u64,
}

/// A link code: 16 characters, a to z and 2 to 7 (what `newCode` in src/app.js makes).
pub fn is_link_code(code: &str) -> bool {
    code.len() == 16 && code.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

/// The text for a relay's refusal. `reason` is the Session's own word.
fn refusal(status: u16, reason: &str) -> String {
    match (status, reason) {
        (_, "not-pending") => "This support link was already used. Ask your support team for a new one.".into(),
        (_, "expired") => "This support link has expired. Ask your support team for a new one.".into(),
        (_, "wrong-client") => "This support link is not for the Support Join app. Ask your support team for a new one.".into(),
        (404, _) => "This is not a valid support link.".into(),
        (403, _) | (415, _) => "The support server refused this request. Update Support Join, or ask your support team for help.".into(),
        _ => format!("The support server answered with an error ({status}). Try again in a moment."),
    }
}

fn read_ok(status: u16, body: &Value) -> Result<(), RedeemError> {
    if status == 200 && body.get("ok") == Some(&Value::Bool(true)) {
        return Ok(());
    }
    Err(RedeemError::Refused(refusal(status, &wire::text(body, "reason"))))
}

/// The answer to `{"preview":true}`. `origin` is the relay this client asked.
pub fn read_preview(status: u16, body: &Value, origin: &str) -> Result<Preview, RedeemError> {
    read_ok(status, body)?;
    check_same_origin(body, origin)?;
    let label = clean(&wire::text(body, "label"), 100);
    Ok(Preview { label: (!label.is_empty()).then_some(label) })
}

/// The answer to the redeem itself. A key for another relay than the one asked is never taken.
pub fn read_redeemed(status: u16, body: &Value, origin: &str) -> Result<Redeemed, RedeemError> {
    read_ok(status, body)?;
    check_same_origin(body, origin)?;
    let bad = || RedeemError::Refused("The support server gave an answer this app cannot use.".into());
    let one_off = OneOff::new(&wire::text(body, "sid"), &wire::text(body, "key")).map_err(|_| bad())?;
    let startup_expires_at = wire::number(body, "startup_expires_at");
    let startup_ms = wire::number(body, "startup_ms");
    if startup_expires_at <= 0 || startup_ms <= 0 {
        return Err(bad());
    }
    Ok(Redeemed { one_off, origin: origin.to_string(), startup_expires_at, startup_ms: (startup_ms as u64).min(STARTUP_MAX_MS) })
}

fn check_same_origin(body: &Value, origin: &str) -> Result<(), RedeemError> {
    let said = wire::text(body, "origin");
    if said.trim_end_matches('/') != origin {
        return Err(RedeemError::Refused("The support server named a different address than the link. Nothing was used.".into()));
    }
    Ok(())
}

async fn call(origin: &str, code: &str, body: &Value) -> Result<(u16, Value), RedeemError> {
    let origin = wire::check_origin(origin).map_err(RedeemError::Refused)?;
    if !is_link_code(code) {
        return Err(RedeemError::Refused("This is not a valid support link.".into()));
    }
    crate::tls::init();
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|e| RedeemError::Network(e.to_string()))?;
    let url = format!("{origin}/j/{code}/redeem");
    let offline = |e: reqwest::Error| RedeemError::Network(format!("Could not reach the support server: {e}"));
    let mut response = client
        .post(url)
        .header("content-type", "application/json")
        .header("x-support-client", CLIENT_HEADER)
        .timeout(TIMEOUT)
        .body(serde_json::to_vec(body).unwrap_or_default())
        .send()
        .await
        .map_err(offline)?;
    let status = response.status().as_u16();
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(offline)? {
        if data.len() + chunk.len() > ANSWER_MAX {
            return Err(RedeemError::Refused("The support server gave an answer this app cannot use.".into()));
        }
        data.extend_from_slice(&chunk);
    }
    // A reply that is not JSON (a proxy's error page) is read as an empty answer: its status still decides.
    Ok((status, serde_json::from_slice(&data).unwrap_or(Value::Null)))
}

/// Asks the relay what the link is for, without using it up.
pub async fn preview(origin: &str, code: &str) -> Result<Preview, RedeemError> {
    let origin = wire::check_origin(origin).map_err(RedeemError::Refused)?;
    let (status, body) = call(&origin, code, &json!({ "preview": true })).await?;
    read_preview(status, &body, &origin)
}

/// Uses the code up and returns the session. The code works once: an error after this call may have used it.
pub async fn redeem(origin: &str, code: &str) -> Result<Redeemed, RedeemError> {
    let origin = wire::check_origin(origin).map_err(RedeemError::Refused)?;
    let (status, body) = call(&origin, code, &json!({})).await?;
    read_redeemed(status, &body, &origin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::one_shot;

    const SID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const KEY: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn link_codes_are_sixteen_characters_of_the_relays_alphabet() {
        assert!(is_link_code("abcdefg234567abc"));
        assert!(is_link_code("abcdefghijklmnop"));
        for bad in ["", "short", "ABCDEFGHIJKLMNOP", "abcdefghijklmno1", "abcdefghijklmno8", "abcdefghijklmnop1", "abcd efghijklmnop"] {
            assert!(!is_link_code(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_good_answer_gives_the_session_and_what_is_left_of_its_window() {
        let body =
            json!({"ok":true,"sid":SID,"key":KEY,"origin":"https://r.example","startup_expires_at":1_700_000_000_000i64,"startup_ms":7_199_000});
        let r = read_redeemed(200, &body, "https://r.example").unwrap();
        assert_eq!((r.one_off.sid.as_str(), r.one_off.key.as_str(), r.startup_ms), (SID, KEY, 7_199_000));
        // More than two hours is cut to two.
        let long = json!({"ok":true,"sid":SID,"key":KEY,"origin":"https://r.example","startup_expires_at":1,"startup_ms":99_999_999});
        assert_eq!(read_redeemed(200, &long, "https://r.example").unwrap().startup_ms, STARTUP_MAX_MS);
    }

    #[test]
    fn an_answer_for_another_relay_or_with_a_bad_key_is_never_taken() {
        let other = json!({"ok":true,"sid":SID,"key":KEY,"origin":"https://evil.example","startup_expires_at":1,"startup_ms":1});
        assert!(matches!(read_redeemed(200, &other, "https://r.example"), Err(RedeemError::Refused(_))));
        for (sid, key, at, ms) in [("short", KEY, 1, 1), (SID, "XYZ", 1, 1), (SID, KEY, 0, 1), (SID, KEY, 1, 0)] {
            let b = json!({"ok":true,"sid":sid,"key":key,"origin":"https://r.example","startup_expires_at":at,"startup_ms":ms});
            assert!(read_redeemed(200, &b, "https://r.example").is_err(), "{sid} {key} {at} {ms}");
        }
        assert!(read_redeemed(200, &json!({"sid":SID,"key":KEY}), "https://r.example").is_err());
    }

    #[test]
    fn the_relays_reasons_become_plain_sentences() {
        for (status, reason, needle) in [
            (409, "not-pending", "already used"),
            (410, "expired", "expired"),
            (409, "wrong-client", "not for the Support Join app"),
            (404, "invalid", "not a valid support link"),
            (403, "forbidden", "refused"),
            (500, "", "error (500)"),
        ] {
            match read_redeemed(status, &json!({"ok":false,"reason":reason}), "https://r.example") {
                Err(RedeemError::Refused(t)) => assert!(t.contains(needle), "{status} {reason}: {t}"),
                other => panic!("{other:?}"),
            }
        }
        // A reply that is not JSON still gets its status read.
        assert!(matches!(read_redeemed(502, &Value::Null, "https://r.example"), Err(RedeemError::Refused(_))));
    }

    #[test]
    fn a_preview_gives_the_label_cleaned_and_cut() {
        let b = json!({"ok":true,"label":"  Mrs Cohen\u{7}'s laptop ","origin":"https://r.example"});
        assert_eq!(read_preview(200, &b, "https://r.example").unwrap().label.as_deref(), Some("Mrs Cohen's laptop"));
        let none = json!({"ok":true,"label":null,"origin":"https://r.example"});
        assert_eq!(read_preview(200, &none, "https://r.example").unwrap().label, None);
        assert!(read_preview(409, &json!({"ok":false,"reason":"not-pending"}), "https://r.example").is_err());
    }

    #[tokio::test]
    async fn the_call_sends_what_the_relay_requires_and_nothing_else() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let (origin2, seen) = one_shot("HTTP/1.1 409 Conflict", br#"{"ok":false,"reason":"not-pending"}"#.to_vec(), 0).await;
        let e = redeem(&origin2, "abcdefg234567abc").await.unwrap_err();
        assert!(e.text().contains("already used"), "{e:?}");
        let request = seen.await.unwrap().to_lowercase();
        assert!(request.starts_with("post /j/abcdefg234567abc/redeem http/1.1"), "{request}");
        assert!(request.contains("content-type: application/json"));
        assert!(request.contains("x-support-client: macos-app-1"));
        assert!(!request.contains("\r\norigin:"), "never an Origin header");
        assert!(request.ends_with("{}"), "{request}");
        // Nobody listening: a network error, not a refusal.
        assert!(matches!(redeem(&origin, "abcdefg234567abc").await, Err(RedeemError::Network(_))));
        // A bad code never reaches the network.
        assert!(matches!(redeem(&origin, "nope").await, Err(RedeemError::Refused(_))));
        assert!(matches!(redeem("http://relay.example.com", "abcdefg234567abc").await, Err(RedeemError::Refused(_))));
    }
}
