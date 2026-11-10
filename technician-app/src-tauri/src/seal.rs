// Sealing the sign-in tokens. On Windows the sealer is DPAPI (CryptProtectData), so the
// tokens can be opened only by the same Windows account on the same PC. Everything around it
// talks to the Sealer trait, so the store is tested on any system with the test sealer.
use crate::error::{CoreError, CoreResult, Msg};
use std::sync::Arc;

pub trait Sealer: Send + Sync {
    fn seal(&self, plain: &[u8]) -> CoreResult<Vec<u8>>;
    fn unseal(&self, sealed: &[u8]) -> CoreResult<Vec<u8>>;
}

/// The sealer this build uses: DPAPI on Windows, the development sealer elsewhere.
pub fn default_sealer() -> Arc<dyn Sealer> {
    #[cfg(windows)]
    {
        Arc::new(DpapiSealer)
    }
    #[cfg(not(windows))]
    {
        Arc::new(DevSealer)
    }
}

/// Not encryption. It only keeps a token from sitting in a file as readable text, so a
/// Linux development run and the unit tests can exercise the store. The product is
/// Windows only and uses DPAPI there.
#[derive(Default)]
pub struct DevSealer;

const DEV_MARK: &[u8] = b"DEV1";
const DEV_KEY: u8 = 0x5a;

impl Sealer for DevSealer {
    fn seal(&self, plain: &[u8]) -> CoreResult<Vec<u8>> {
        let mut out = DEV_MARK.to_vec();
        out.extend(plain.iter().map(|b| b ^ DEV_KEY));
        Ok(out)
    }

    fn unseal(&self, sealed: &[u8]) -> CoreResult<Vec<u8>> {
        match sealed.strip_prefix(DEV_MARK) {
            Some(rest) => Ok(rest.iter().map(|b| b ^ DEV_KEY).collect()),
            None => Err(CoreError::other(Msg::SealOpen)),
        }
    }
}

#[cfg(windows)]
pub use dpapi::DpapiSealer;

#[cfg(windows)]
mod dpapi {
    use super::Sealer;
    use crate::error::{CoreError, CoreResult, Msg};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    // Extra bytes DPAPI mixes into the key, so a blob from another program of the same
    // Windows account does not open here.
    const ENTROPY: &[u8] = b"support-mcp technician app sign-in v1";

    pub struct DpapiSealer;

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
    }

    // Copies the bytes DPAPI allocated and frees them.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let copy = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
        copy
    }

    impl Sealer for DpapiSealer {
        fn seal(&self, plain: &[u8]) -> CoreResult<Vec<u8>> {
            let input = blob(plain);
            let entropy = blob(ENTROPY);
            let mut out = CRYPT_INTEGER_BLOB::default();
            // SAFETY: the blobs point at slices that outlive the call; `out` is filled by DPAPI.
            unsafe {
                CryptProtectData(&input, PCWSTR::null(), Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
                    .map_err(|_| CoreError::other(Msg::SealProtect))?;
                Ok(take(out))
            }
        }

        fn unseal(&self, sealed: &[u8]) -> CoreResult<Vec<u8>> {
            let input = blob(sealed);
            let entropy = blob(ENTROPY);
            let mut out = CRYPT_INTEGER_BLOB::default();
            // SAFETY: as in seal.
            unsafe {
                CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
                    .map_err(|_| CoreError::other(Msg::SealOtherAccount))?;
                Ok(take(out))
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn dpapi_round_trip_and_tamper() {
            let s = DpapiSealer;
            let sealed = s.seal(b"refresh-token-value").unwrap();
            assert!(!sealed.windows(5).any(|w| w == b"refre"));
            assert_eq!(s.unseal(&sealed).unwrap(), b"refresh-token-value");
            let mut bad = sealed.clone();
            let last = bad.len() - 1;
            bad[last] ^= 1;
            assert!(s.unseal(&bad).is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dev_sealer_round_trips_and_hides_the_text() {
        let s = DevSealer;
        let sealed = s.seal(b"secret-token").unwrap();
        assert!(!sealed.windows(6).any(|w| w == b"secret"));
        assert_eq!(s.unseal(&sealed).unwrap(), b"secret-token");
        assert!(s.unseal(b"not sealed").is_err());
    }
}
