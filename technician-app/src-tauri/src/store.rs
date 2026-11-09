// What the app keeps on disk, in one file (app.json) in the app's data folder: the accounts
// (a relay address and a team each), the sign-in tokens sealed by the Sealer, the client id
// each relay gave us, how far each feed has been read, and the app's own preferences.
// Nothing but the tokens is secret, and the tokens never reach the file unsealed.
use crate::error::CoreResult;
use crate::seal::Sealer;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Tokens {
    pub access: String,
    pub refresh: String,
    /// When the access token ends, in milliseconds since 1970.
    pub expires_at_ms: u64,
}

// Written by hand so a token never reaches a log line, a panic message or a failed assert.
impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens").field("access", &"[redacted]").field("refresh", &"[redacted]").field("expires_at_ms", &self.expires_at_ms).finish()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StoredAccount {
    pub id: String,
    pub relay: String,
    pub team: String,
    pub team_name: Option<String>,
    pub email: Option<String>,
    pub client_id: String,
    /// The relay's token address, from its discovery document.
    pub token_endpoint: String,
    /// The tokens, sealed and base64. None after the relay refused the sign-in.
    pub sealed: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Prefs {
    /// Show a Windows notification for each new item in the feed.
    pub desktop_notifications: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { desktop_notifications: true }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct FileData {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    accounts: Vec<StoredAccount>,
    /// relay address -> the client id its registration gave us.
    #[serde(default)]
    clients: BTreeMap<String, String>,
    /// account id -> the last notification id the app has read.
    #[serde(default)]
    cursors: BTreeMap<String, u64>,
    #[serde(default)]
    prefs: Prefs,
}

/// The id of an account: the same relay address and team always give the same id.
pub fn account_id(relay: &str, team: &str) -> String {
    let digest = Sha256::digest(format!("{relay}\n{team}").as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub struct Store {
    path: PathBuf,
    sealer: Arc<dyn Sealer>,
    data: Mutex<FileData>,
}

impl Store {
    /// Opens (or starts) the store in `dir`. A file that cannot be read is set aside as
    /// app.json.bad and the app starts signed out, rather than refusing to start.
    pub fn open(dir: &Path, sealer: Arc<dyn Sealer>) -> CoreResult<Store> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("app.json");
        let data = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<FileData>(&text) {
                Ok(d) => d,
                Err(_) => {
                    let _ = std::fs::rename(&path, dir.join("app.json.bad"));
                    FileData::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileData::default(),
            Err(e) => return Err(e.into()),
        };
        Ok(Store { path, sealer, data: Mutex::new(data) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FileData> {
        self.data.lock().unwrap_or_else(|p| p.into_inner())
    }

    // Writes the file next to itself and renames it over, so a crash never leaves half a file.
    fn persist(&self, data: &FileData) -> CoreResult<()> {
        let mut out = data.clone();
        out.version = 1;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&out)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    fn change<T>(&self, f: impl FnOnce(&mut FileData) -> T) -> CoreResult<T> {
        let mut data = self.lock();
        let out = f(&mut data);
        self.persist(&data)?;
        Ok(out)
    }

    pub fn accounts(&self) -> Vec<StoredAccount> {
        self.lock().accounts.clone()
    }

    pub fn account(&self, id: &str) -> Option<StoredAccount> {
        self.lock().accounts.iter().find(|a| a.id == id).cloned()
    }

    fn seal_tokens(&self, tokens: &Tokens) -> CoreResult<String> {
        Ok(B64.encode(self.sealer.seal(&serde_json::to_vec(tokens)?)?))
    }

    /// Adds an account, or replaces the one with the same relay and team, with fresh tokens.
    pub fn put_account(&self, mut account: StoredAccount, tokens: &Tokens) -> CoreResult<()> {
        account.id = account_id(&account.relay, &account.team);
        account.sealed = Some(self.seal_tokens(tokens)?);
        self.change(|d| {
            d.clients.insert(account.relay.clone(), account.client_id.clone());
            match d.accounts.iter_mut().find(|a| a.id == account.id) {
                Some(existing) => *existing = account,
                None => d.accounts.push(account),
            }
        })
    }

    /// The account's tokens, or None when it is signed out or the seal cannot be opened.
    pub fn tokens(&self, id: &str) -> Option<Tokens> {
        let sealed = self.account(id)?.sealed?;
        let bytes = self.sealer.unseal(&B64.decode(sealed).ok()?).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub fn set_tokens(&self, id: &str, tokens: &Tokens) -> CoreResult<()> {
        let sealed = self.seal_tokens(tokens)?;
        self.change(|d| {
            if let Some(a) = d.accounts.iter_mut().find(|a| a.id == id) {
                a.sealed = Some(sealed);
            }
        })
    }

    /// The relay no longer accepts this sign-in: drop the tokens, keep the account so the
    /// screens can offer to sign in again.
    pub fn clear_tokens(&self, id: &str) -> CoreResult<()> {
        self.change(|d| {
            if let Some(a) = d.accounts.iter_mut().find(|a| a.id == id) {
                a.sealed = None;
            }
        })
    }

    pub fn set_profile(&self, id: &str, team_name: Option<String>, email: Option<String>) -> CoreResult<()> {
        self.change(|d| {
            if let Some(a) = d.accounts.iter_mut().find(|a| a.id == id) {
                if team_name.is_some() {
                    a.team_name = team_name;
                }
                if email.is_some() {
                    a.email = email;
                }
            }
        })
    }

    /// Removes the account, its tokens and its feed cursor.
    pub fn remove_account(&self, id: &str) -> CoreResult<bool> {
        self.change(|d| {
            let before = d.accounts.len();
            d.accounts.retain(|a| a.id != id);
            d.cursors.remove(id);
            d.accounts.len() != before
        })
    }

    pub fn client_for(&self, relay: &str) -> Option<String> {
        self.lock().clients.get(relay).cloned()
    }

    pub fn set_client(&self, relay: &str, client_id: &str) -> CoreResult<()> {
        self.change(|d| {
            d.clients.insert(relay.to_string(), client_id.to_string());
        })
    }

    pub fn forget_client(&self, relay: &str) -> CoreResult<()> {
        self.change(|d| {
            d.clients.remove(relay);
        })
    }

    pub fn cursor(&self, id: &str) -> Option<u64> {
        self.lock().cursors.get(id).copied()
    }

    pub fn set_cursor(&self, id: &str, value: u64) -> CoreResult<()> {
        self.change(|d| {
            d.cursors.insert(id.to_string(), value);
        })
    }

    pub fn prefs(&self) -> Prefs {
        self.lock().prefs.clone()
    }

    pub fn set_prefs(&self, prefs: Prefs) -> CoreResult<()> {
        self.change(|d| d.prefs = prefs)
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seal::DevSealer;

    #[test]
    fn tokens_print_without_their_secrets() {
        let t = Tokens { access: "access-secret-123".into(), refresh: "refresh-secret-456".into(), expires_at_ms: 1_794_000_000_000 };
        let shown = format!("{t:?} {t:#?}");
        assert!(!shown.contains("secret"), "{shown}");
        assert!(shown.contains("[redacted]") && shown.contains("1794000000000"), "{shown}");
        let account = StoredAccount { id: "a".into(), relay: "r".into(), team: "t".into(), team_name: None, email: None, client_id: "c".into(), token_endpoint: "e".into(), sealed: None };
        assert!(!format!("{account:?}").contains("secret"));
    }

    fn tmp(name: &str) -> PathBuf {
        crate::testkit::temp_dir(name)
    }

    fn account() -> StoredAccount {
        StoredAccount {
            id: String::new(),
            relay: "https://relay.example".into(),
            team: "default".into(),
            team_name: Some("Default".into()),
            email: None,
            client_id: "client-1".into(),
            token_endpoint: "https://relay.example/oauth/token".into(),
            sealed: None,
        }
    }

    fn tokens() -> Tokens {
        Tokens { access: "ACCESS-SECRET".into(), refresh: "REFRESH-SECRET".into(), expires_at_ms: 5000 }
    }

    #[test]
    fn tokens_round_trip_and_never_reach_the_file_in_the_clear() {
        let dir = tmp("round");
        let store = Store::open(&dir, Arc::new(DevSealer)).unwrap();
        store.put_account(account(), &tokens()).unwrap();
        let id = account_id("https://relay.example", "default");
        assert_eq!(store.tokens(&id), Some(tokens()));
        let text = std::fs::read_to_string(dir.join("app.json")).unwrap();
        assert!(!text.contains("ACCESS-SECRET") && !text.contains("REFRESH-SECRET"));
        // A second start reads the same account and tokens.
        let again = Store::open(&dir, Arc::new(DevSealer)).unwrap();
        assert_eq!(again.accounts().len(), 1);
        assert_eq!(again.tokens(&id), Some(tokens()));
        assert_eq!(again.client_for("https://relay.example").as_deref(), Some("client-1"));
    }

    #[test]
    fn clearing_the_tokens_keeps_the_account_and_removing_drops_it() {
        let dir = tmp("clear");
        let store = Store::open(&dir, Arc::new(DevSealer)).unwrap();
        store.put_account(account(), &tokens()).unwrap();
        let id = account_id("https://relay.example", "default");
        store.set_cursor(&id, 12).unwrap();
        store.clear_tokens(&id).unwrap();
        assert_eq!(store.tokens(&id), None);
        assert_eq!(store.accounts().len(), 1);
        assert_eq!(store.cursor(&id), Some(12));
        assert!(store.remove_account(&id).unwrap());
        assert!(store.accounts().is_empty());
        assert_eq!(store.cursor(&id), None);
    }

    #[test]
    fn a_seal_that_cannot_be_opened_reads_as_signed_out() {
        let dir = tmp("badseal");
        let store = Store::open(&dir, Arc::new(DevSealer)).unwrap();
        store.put_account(account(), &tokens()).unwrap();
        let id = account_id("https://relay.example", "default");
        let mut text = std::fs::read_to_string(dir.join("app.json")).unwrap();
        let start = text.find("\"sealed\": \"").unwrap() + 11;
        text.replace_range(start..start + 4, "AAAA");
        std::fs::write(dir.join("app.json"), text).unwrap();
        let again = Store::open(&dir, Arc::new(DevSealer)).unwrap();
        assert_eq!(again.tokens(&id), None);
    }

    #[test]
    fn a_damaged_file_is_set_aside_and_the_app_starts_signed_out() {
        let dir = tmp("damaged");
        std::fs::write(dir.join("app.json"), "{ not json").unwrap();
        let store = Store::open(&dir, Arc::new(DevSealer)).unwrap();
        assert!(store.accounts().is_empty());
        assert!(dir.join("app.json.bad").exists());
    }

    #[test]
    fn the_account_id_depends_on_relay_and_team() {
        assert_eq!(account_id("https://a", "x"), account_id("https://a", "x"));
        assert_ne!(account_id("https://a", "x"), account_id("https://a", "y"));
        assert_ne!(account_id("https://a", "x"), account_id("https://b", "x"));
        assert_eq!(account_id("https://a", "x").len(), 16);
    }

    #[test]
    fn prefs_default_to_notifications_on_and_persist() {
        let dir = tmp("prefs");
        let store = Store::open(&dir, Arc::new(DevSealer)).unwrap();
        assert!(store.prefs().desktop_notifications);
        store.set_prefs(Prefs { desktop_notifications: false }).unwrap();
        assert!(!Store::open(&dir, Arc::new(DevSealer)).unwrap().prefs().desktop_notifications);
    }
}
