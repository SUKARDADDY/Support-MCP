//! Setting a Mac up: the setup link the team sends (`https://<relay>/install?code=ABCDE-FGH23`, or `?workspace=<slug>`
//! for an owner's own request), the answers the person gives, and the pairing. Nothing is chosen for the person: the
//! name, access and control are all required. The link's rules are those of `installQuery` in src/app.js.

use crate::state::DeviceState;
use support_core::device::{self, DeviceLink, DeviceResult, Identity};
use support_core::wire;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Join {
    /// A technician's pairing code: the Mac joins as active.
    Code(String),
    /// The owner asks to join a team: the Mac waits as pending, with six digits to read to a technician.
    Workspace(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub origin: String,
    pub join: Join,
}

pub const BAD_LINK: &str = "This setup link is not valid. Ask your support team for a new one.";
const CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// A code as the relay shows it (ABCDE-FGH23), from any case, with or without the hyphen and spaces.
pub fn normalize_code(text: &str) -> Option<String> {
    let c: String = text.chars().filter(|ch| !ch.is_whitespace() && *ch != '-').collect::<String>().to_uppercase();
    (c.len() == 10 && c.chars().all(|ch| CODE_ALPHABET.contains(ch))).then(|| format!("{}-{}", &c[..5], &c[5..]))
}

fn valid_slug(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Reads a setup link. `code` is a code typed apart from the link (for a link without one). Exactly one way to join
/// must come out of the two.
pub fn parse_link(link: &str, code: Option<&str>) -> Result<Link, String> {
    let url = url::Url::parse(link.trim()).map_err(|_| BAD_LINK.to_string())?;
    if url.path() != "/install" || url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err(BAD_LINK.into());
    }
    let origin = wire::check_origin(&url.origin().ascii_serialization()).map_err(|_| BAD_LINK.to_string())?;
    let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let typed = code.map(str::trim).filter(|c| !c.is_empty());
    let join = match (pairs.as_slice(), typed) {
        ([], Some(c)) => Join::Code(normalize_code(c).ok_or("That code is not valid. Check it and try again.")?),
        ([], None) => return Err("This setup link has no code. Type the code your support team gave you.".into()),
        ([(k, v)], None) if k == "code" => Join::Code(normalize_code(v).ok_or(BAD_LINK)?),
        ([(k, v)], None) if k == "workspace" && valid_slug(v) => Join::Workspace(v.clone()),
        ([_], Some(_)) => return Err("This setup link already has a code. Leave the code empty.".into()),
        _ => return Err(BAD_LINK.into()),
    };
    Ok(Link { origin, join })
}

/// The name for the team's list: 1 to 100 characters, no control characters.
pub fn check_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 100 || n.chars().any(char::is_control) {
        return Err("Give this Mac a name of 1 to 100 characters.".into());
    }
    Ok(n.to_string())
}

/// What a failed pairing tells the person.
pub fn pair_error(a: &device::Answer, host: &str) -> String {
    match a.result {
        DeviceResult::CodeInvalid => "That code has expired or was already used. Ask your support team for a new one.".into(),
        DeviceResult::Offline => format!("Could not reach {host}. Check the internet connection and try again."),
        DeviceResult::UpdateNeeded => "Your support team's server needs a newer version of Support.".into(),
        _ if !a.message.is_empty() => format!("Your support team's server refused: {}", wire::clean(&a.message, 200)),
        _ => format!("Your support team's server refused the setup (HTTP {}).", a.status),
    }
}

/// Pairs and returns the state to save. The key never leaves the service.
pub async fn pair(link: &Link, name: &str, access: &str, control: &str, id: &Identity) -> Result<DeviceState, String> {
    let host = url::Url::parse(&link.origin).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let dl = DeviceLink::new(&link.origin)?;
    let paired = match &link.join {
        Join::Code(c) => device::pair_with_code(&dl, c, name, access, control, id).await,
        Join::Workspace(w) => device::pair_with_workspace(&dl, w, name, access, control, id).await,
    }
    .map_err(|a| pair_error(&a, &host))?;
    let pending = paired.status == "pending";
    Ok(DeviceState {
        origin: link.origin.clone(),
        key: paired.key,
        device_id: paired.device_id,
        workspace: paired.workspace,
        name: name.to_string(),
        access: access.to_string(),
        control: control.to_string(),
        state: if pending { "pending".into() } else { "active".into() },
        confirm: if pending { paired.confirm } else { None },
        accepted_session: None,
        rules: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_link_and_a_workspace_link_are_read() {
        assert_eq!(
            parse_link("https://support.example/install?code=abcde-fgh23", None),
            Ok(Link { origin: "https://support.example".into(), join: Join::Code("ABCDE-FGH23".into()) })
        );
        assert_eq!(
            parse_link("  https://support.example:8443/install?code=ABCDEFGH23 ", None).unwrap(),
            Link { origin: "https://support.example:8443".into(), join: Join::Code("ABCDE-FGH23".into()) }
        );
        assert_eq!(parse_link("https://support.example/install?workspace=acme-it", None).unwrap().join, Join::Workspace("acme-it".into()));
        assert_eq!(parse_link("http://127.0.0.1:8787/install?code=ABCDEFGH23", None).unwrap().origin, "http://127.0.0.1:8787");
    }

    #[test]
    fn a_link_without_a_code_takes_a_typed_one_and_never_two() {
        assert_eq!(parse_link("https://s.example/install", Some(" abcde fgh23 ")).unwrap().join, Join::Code("ABCDE-FGH23".into()));
        assert!(parse_link("https://s.example/install", None).unwrap_err().contains("no code"));
        assert!(parse_link("https://s.example/install?code=ABCDEFGH23", Some("ABCDEFGH23")).unwrap_err().contains("already"));
        assert!(parse_link("https://s.example/install", Some("ABCDEFGH2")).is_err());
    }

    #[test]
    fn a_bad_link_is_refused() {
        for bad in [
            "http://support.example/install?code=ABCDEFGH23",
            "https://support.example/other?code=ABCDEFGH23",
            "https://support.example/install?code=ABCDEFGH23&x=1",
            "https://support.example/install?code=ABCDEFGH2I",
            "https://support.example/install?code=ABCDEFGH231",
            "https://support.example/install?workspace=Acme",
            "https://support.example/install?workspace=",
            "https://user@support.example/install?code=ABCDEFGH23",
            "https://support.example/install?code=ABCDEFGH23#x",
            "ftp://support.example/install?code=ABCDEFGH23",
            "not a link",
        ] {
            assert!(parse_link(bad, None).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_name_is_1_to_100_plain_characters() {
        assert_eq!(check_name("  Ariel's Mac ").unwrap(), "Ariel's Mac");
        assert!(check_name("").is_err());
        assert!(check_name("   ").is_err());
        assert!(check_name(&"x".repeat(101)).is_err());
        assert!(check_name("a\tb").is_err());
        assert!(check_name(&"é".repeat(100)).is_ok());
    }

    #[test]
    fn a_failed_pairing_says_why_in_plain_words() {
        let a = |result, status, message: &str| device::Answer { result, status, body: None, message: message.into() };
        assert!(pair_error(&a(DeviceResult::CodeInvalid, 404, ""), "h").contains("expired"));
        assert!(pair_error(&a(DeviceResult::Offline, 0, ""), "support.example").contains("support.example"));
        assert!(pair_error(&a(DeviceResult::Refused, 409, "this team has too many PCs"), "h").contains("too many PCs"));
        assert!(pair_error(&a(DeviceResult::Refused, 500, ""), "h").contains("500"));
    }
}
