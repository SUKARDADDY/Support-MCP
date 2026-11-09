// One error type for the core. It serialises to { code, message, status, reason } so a screen can
// branch on the code and show a message in its own words: `reason` is the stable key of one of
// our messages (Msg), which the screens translate through "error.<reason>" in src/i18n/en.json.
// The English `message` is the fallback and what a log or a test reads. A message from the relay
// itself (Relay, Tool) has no reason: it is the relay's own text and is shown as it is.
use serde::{Serialize, Serializer};

macro_rules! messages {
    ($($variant:ident, $key:literal, $text:literal;)*) => {
        /// A message of ours that a person may read. Add one here and in en.json together: a
        /// test fails when a key has no "error.<key>" there.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Msg {
            $($variant),*
        }

        impl Msg {
            pub const ALL: &'static [Msg] = &[$(Msg::$variant),*];

            /// The stable key the screens translate.
            pub fn key(self) -> &'static str {
                match self {
                    $(Msg::$variant => $key),*
                }
            }

            /// The English text, for logs and as the fallback.
            pub fn text(self) -> &'static str {
                match self {
                    $(Msg::$variant => $text),*
                }
            }
        }
    };
}

messages! {
    NoAccount, "no_account", "No such account.";
    BadTeam, "bad_team", "A team name has lower-case letters, digits and dashes only.";
    SignInOpen, "sign_in_open", "A sign-in is already open in your browser. Finish it, or cancel it here.";
    SignInCancelled, "sign_in_cancelled", "Sign-in was cancelled.";
    AccountNotSaved, "account_not_saved", "The account was not saved.";
    RequestRefused, "request_refused", "The app does not make that request.";
    BadMethod, "bad_method", "Bad method.";
    ToolRefused, "tool_refused", "The app does not use that tool.";
    ToolArgs, "tool_args", "A tool's arguments are an object.";
    RelayAnswerUnclear, "relay_answer_unclear", "The relay's answer was not understood.";
    NoTeam, "no_team", "This relay has no team with that name, or sign-in is not set up on it.";
    RelayBusy, "relay_busy", "The relay is busy. Try again in a moment.";
    NotSupportRelay, "not_support_relay", "That address did not answer like a Support relay.";
    RelayNamesOther, "relay_names_other", "The relay names a different address for itself. Use the address it names.";
    RelayOtherServer, "relay_other_server", "The relay uses another server to sign in, which this app does not accept.";
    RelayAddressesNotOwn, "relay_addresses_not_own", "The relay's sign-in addresses are not its own.";
    NoClientId, "no_client_id", "The relay sent no client id.";
    BadAuthorizeAddress, "bad_authorize_address", "Bad authorize address.";
    ListenFailed, "listen_failed", "Could not listen for the browser on this PC.";
    ListenerStopped, "listener_stopped", "The listener for the browser stopped.";
    SignInDenied, "sign_in_denied", "Sign-in was not approved.";
    RelayForgotApp, "relay_forgot_app", "The relay no longer knows this app. Try signing in again.";
    SignInTimeout, "sign_in_timeout", "Sign-in took too long. Try again.";
    WebOnly, "web_only", "Only web addresses are opened.";
    BrowserOpen, "browser_open", "Could not open your browser.";
    NotRelayAddress, "not_relay_address", "That is not a relay address.";
    RelayHttps, "relay_https", "The relay address must start with https://.";
    RelayAddressOnly, "relay_address_only", "Give the relay address only, with no path or login.";
    NoRefreshToken, "no_refresh_token", "The relay sent no refresh token.";
    RenewFailed, "renew_failed", "The sign-in could not be renewed. Try again.";
    SealOpen, "seal_open", "The saved sign-in could not be opened.";
    SealProtect, "seal_protect", "Windows could not protect the sign-in.";
    SealOtherAccount, "seal_other_account", "The saved sign-in could not be opened by this Windows account.";
    ReleaseKeyBad, "release_key_bad", "The release key is not valid.";
    InstallerStart, "installer_start", "Could not start the installer.";
    WindowsOnly, "windows_only", "Updates install on Windows only.";
    ReleaseAddress, "release_address", "Bad release address.";
    ReleaseHost, "release_host", "The release is not on GitHub.";
    ReleaseFileLarge, "release_file_large", "A release file was larger than expected.";
    ReleaseFileText, "release_file_text", "A release file was not text.";
    ReleaseListUnclear, "release_list_unclear", "The release list was not understood.";
    UpdateSignature, "update_signature", "The update's signature did not check out, so it was ignored.";
    UpdateNoteForm, "update_note_form", "The update note was not in the expected form, so it was ignored.";
    UpdateNoteName, "update_note_name", "The update note and its file name name different versions, so it was ignored.";
    UpdateSize, "update_size", "The update's size was not acceptable, so it was ignored.";
    UpdateVersion, "update_version", "The update's version was not understood.";
    UpdateNoInstaller, "update_no_installer", "The release has a note but no installer.";
    InstallerSize, "installer_size", "The installer's size is not the size in the signed note, so it was thrown away.";
    InstallerBigger, "installer_bigger", "The installer is bigger than the signed note says, so it was thrown away.";
    InstallerHash, "installer_hash", "The installer's SHA-256 is not the one in the signed note, so it was thrown away.";
    AutostartRead, "autostart_read", "Could not read the start setting.";
    AutostartWrite, "autostart_write", "Could not change the start setting.";
    GithubStatus, "github_status", "GitHub did not give the release as expected. Try again later.";
    RelayTimeout, "relay_timeout", "The relay did not answer in time. Try again.";
    RelayUnreachable, "relay_unreachable", "Could not reach the relay. Check the address and your network.";
    RelayConnectionFailed, "relay_connection_failed", "The connection to the relay failed. Try again.";
    FileError, "file_error", "A file could not be read or written.";
    BadData, "bad_data", "Saved data could not be read.";
    ToolFailed, "tool_failed", "The tool failed.";
}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// The relay no longer accepts this sign-in (401, or invalid_grant on a refresh). The
    /// account's tokens are gone and the person has to sign in again.
    #[error("You were signed out. Sign in again to continue.")]
    SignedOut,
    /// The relay or the network could not answer (503, a timeout, no connection). The sign-in
    /// is kept: nothing is lost by trying again.
    #[error("{}", .0.text())]
    Unavailable(Msg),
    /// The relay answered with an error of its own: { "error": { "code", "message" } }.
    #[error("{message}")]
    Relay { status: u16, code: String, message: String },
    /// An MCP tool answered isError. The message is the tool's own text.
    #[error("{0}")]
    Tool(String),
    /// The screens asked for something the core refuses.
    #[error("{}", .0.text())]
    Invalid(Msg),
    #[error("{}", .0.text())]
    Other(Msg),
}

pub type CoreResult<T> = Result<T, CoreError>;

impl CoreError {
    pub fn code(&self) -> &str {
        match self {
            CoreError::SignedOut => "signed_out",
            CoreError::Unavailable(_) => "unavailable",
            CoreError::Relay { code, .. } => code,
            CoreError::Tool(_) => "tool",
            CoreError::Invalid(_) => "invalid",
            CoreError::Other(_) => "internal",
        }
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            CoreError::SignedOut => Some(401),
            CoreError::Relay { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// The key of our message to translate, or None for the relay's own words.
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            CoreError::SignedOut => Some("signed_out"),
            CoreError::Unavailable(m) | CoreError::Invalid(m) | CoreError::Other(m) => Some(m.key()),
            CoreError::Relay { .. } | CoreError::Tool(_) => None,
        }
    }

    pub fn other(message: Msg) -> Self {
        CoreError::Other(message)
    }

    pub fn invalid(message: Msg) -> Self {
        CoreError::Invalid(message)
    }
}

impl Serialize for CoreError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut out = s.serialize_struct("CoreError", 4)?;
        out.serialize_field("code", self.code())?;
        out.serialize_field("message", &self.to_string())?;
        out.serialize_field("status", &self.status())?;
        out.serialize_field("reason", &self.reason())?;
        out.end()
    }
}

impl From<reqwest::Error> for CoreError {
    fn from(e: reqwest::Error) -> Self {
        // The text of a reqwest error can carry the address, never a token. Keep it short.
        if e.is_timeout() {
            CoreError::Unavailable(Msg::RelayTimeout)
        } else if e.is_connect() {
            CoreError::Unavailable(Msg::RelayUnreachable)
        } else {
            CoreError::Unavailable(Msg::RelayConnectionFailed)
        }
    }
}

impl From<std::io::Error> for CoreError {
    fn from(_: std::io::Error) -> Self {
        CoreError::Other(Msg::FileError)
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(_: serde_json::Error) -> Self {
        CoreError::Other(Msg::BadData)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashMap};

    const STRINGS: &str = include_str!("../../src/i18n/en.json");

    // The screens translate a message of ours through "error.<key>" in en.json. A message with no
    // entry there would show as the bare key, so each one needs its line, and each line its message.
    #[test]
    fn every_message_has_its_line_in_the_screens_string_table_and_no_line_is_left_over() {
        let table: HashMap<String, String> = serde_json::from_str(STRINGS).unwrap();
        let mut keys = BTreeSet::new();
        for m in Msg::ALL {
            assert!(keys.insert(m.key()), "the key {} is used twice", m.key());
            assert_eq!(table.get(&format!("error.{}", m.key())).map(String::as_str), Some(m.text()), "error.{} in en.json says what the Rust text says", m.key());
            assert!(!m.text().contains('\u{2014}') && !m.text().ends_with(' '), "{}", m.text());
        }
        let ours: BTreeSet<&str> = table.keys().filter_map(|k| k.strip_prefix("error.")).collect();
        let known: BTreeSet<&str> = keys.iter().copied().chain(["generic", "signed_out"]).collect();
        assert_eq!(ours, known, "en.json has error lines the core does not send");
        assert_eq!(table["error.signed_out"], CoreError::SignedOut.to_string());
    }

    #[test]
    fn an_error_carries_a_stable_reason_the_screens_translate_and_the_relays_own_words_carry_none() {
        let busy = serde_json::to_value(CoreError::Unavailable(Msg::RelayBusy)).unwrap();
        assert_eq!(busy, serde_json::json!({ "code": "unavailable", "message": "The relay is busy. Try again in a moment.", "status": null, "reason": "relay_busy" }));
        let invalid = serde_json::to_value(CoreError::invalid(Msg::BadTeam)).unwrap();
        assert_eq!((invalid["code"].as_str(), invalid["reason"].as_str()), (Some("invalid"), Some("bad_team")));
        let out = serde_json::to_value(CoreError::SignedOut).unwrap();
        assert_eq!((out["code"].as_str(), out["status"].as_u64(), out["reason"].as_str()), (Some("signed_out"), Some(401), Some("signed_out")));
        let relay = serde_json::to_value(CoreError::Relay { status: 409, code: "confirm_wrong".into(), message: "That number is wrong".into() }).unwrap();
        assert_eq!((relay["code"].as_str(), relay["reason"].is_null()), (Some("confirm_wrong"), true));
        let tool = serde_json::to_value(CoreError::Tool("agent busy".into())).unwrap();
        assert!(tool["reason"].is_null());
    }
}
