//! TLS for the whole client: rustls with the ring provider and the operating system's trust roots
//! (rustls-platform-verifier: Security.framework on a Mac, the system's certificate files on Linux). No OpenSSL.

use std::sync::{Arc, Once};

static INIT: Once = Once::new();

/// Installs the crypto provider for the process. reqwest is built without one, so this must run before the first
/// connection. It is safe to call more than once.
pub fn init() {
    INIT.call_once(|| {
        // An error here means a provider is already installed, which is just as good.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// The client configuration for the doorbell's WebSocket. Same roots as the HTTP client, TLS 1.2 and up.
pub fn client_config() -> Result<Arc<rustls::ClientConfig>, String> {
    use rustls_platform_verifier::BuilderVerifierExt;
    init();
    let config = rustls::ClientConfig::builder().with_platform_verifier().map_err(|e| format!("no system trust roots: {e}"))?.with_no_client_auth();
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_client_config_builds_with_the_system_roots() {
        init();
        init();
        assert!(client_config().is_ok());
    }
}
