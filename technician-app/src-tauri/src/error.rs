// One error type for the core. It serialises to { code, message, status } so a screen can
// show the message and branch on the code.
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// The relay no longer accepts this sign-in (401, or invalid_grant on a refresh). The
    /// account's tokens are gone and the person has to sign in again.
    #[error("You were signed out. Sign in again to continue.")]
    SignedOut,
    /// The relay or the network could not answer (503, a timeout, no connection). The sign-in
    /// is kept: nothing is lost by trying again.
    #[error("{0}")]
    Unavailable(String),
    /// The relay answered with an error of its own: { "error": { "code", "message" } }.
    #[error("{message}")]
    Relay { status: u16, code: String, message: String },
    /// An MCP tool answered isError. The message is the tool's own text.
    #[error("{0}")]
    Tool(String),
    /// The screens asked for something the core refuses.
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Other(String),
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

    pub fn other(message: impl Into<String>) -> Self {
        CoreError::Other(message.into())
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        CoreError::Invalid(message.into())
    }
}

impl Serialize for CoreError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut out = s.serialize_struct("CoreError", 3)?;
        out.serialize_field("code", self.code())?;
        out.serialize_field("message", &self.to_string())?;
        out.serialize_field("status", &self.status())?;
        out.end()
    }
}

impl From<reqwest::Error> for CoreError {
    fn from(e: reqwest::Error) -> Self {
        // The text of a reqwest error can carry the address, never a token. Keep it short.
        if e.is_timeout() {
            CoreError::Unavailable("The relay did not answer in time. Try again.".into())
        } else if e.is_connect() {
            CoreError::Unavailable("Could not reach the relay. Check the address and your network.".into())
        } else {
            CoreError::Unavailable("The connection to the relay failed. Try again.".into())
        }
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        CoreError::Other(format!("File error: {e}"))
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(e: serde_json::Error) -> Self {
        CoreError::Other(format!("Bad data: {e}"))
    }
}
