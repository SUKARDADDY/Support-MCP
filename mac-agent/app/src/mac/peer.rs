//! The kernel's facts about a socket peer, for the decision in `crate::peer`.
//!
//! The audit token (`LOCAL_PEERTOKEN`) names the process for good: its pid and the pid's version, so a pid reused
//! after the peer exits cannot pass for it. The code signing check runs on the guest the token names
//! (`SecCodeCopyGuestWithAttributes` with `kSecGuestAttributeAudit`), against the designated requirement of this
//! service's own code, and the path is read both from the kernel by pid and from that same guest's code.

use crate::peer::{Inspector, PeerFacts};
use objc2_core_foundation::{CFData, CFDictionary, CFRetained, CFString, CFType};
use objc2_security::{kSecGuestAttributeAudit, SecCSFlags, SecCode, SecRequirement, SecStaticCode};
use std::os::fd::RawFd;
use std::ptr::{self, NonNull};

pub struct MacInspector {
    requirement: CFRetained<SecRequirement>,
}

// SAFETY: a SecRequirement is immutable once made; Code Signing Services may use it from any thread.
unsafe impl Send for MacInspector {}
unsafe impl Sync for MacInspector {}

fn static_code(code: &SecCode) -> Result<CFRetained<SecStaticCode>, String> {
    let mut out: *const SecStaticCode = ptr::null();
    // SAFETY: a live code object and a local out-pointer.
    let status = unsafe { code.copy_static_code(SecCSFlags::DefaultFlags, NonNull::from(&mut out)) };
    let nn = NonNull::new(out.cast_mut()).filter(|_| status == 0).ok_or_else(|| format!("SecCodeCopyStaticCode failed ({status})"))?;
    // SAFETY: a +1 reference from a Copy function.
    Ok(unsafe { CFRetained::from_raw(nn) })
}

fn code_path(code: &SecCode) -> Option<String> {
    let st = static_code(code).ok()?;
    let mut url: *const objc2_core_foundation::CFURL = ptr::null();
    // SAFETY: a live static code and a local out-pointer.
    let status = unsafe { SecCode::copy_path(&st, SecCSFlags::DefaultFlags, NonNull::from(&mut url)) };
    let nn = NonNull::new(url.cast_mut()).filter(|_| status == 0)?;
    // SAFETY: a +1 reference from a Copy function.
    let url = unsafe { CFRetained::from_raw(nn) };
    url.to_file_path().map(|p| p.to_string_lossy().into_owned())
}

impl MacInspector {
    /// Reads this process's own designated requirement. An unsigned service has none, and then serves nobody.
    pub fn new() -> Result<MacInspector, String> {
        let mut me: *mut SecCode = ptr::null_mut();
        // SAFETY: a local out-pointer.
        let status = unsafe { SecCode::copy_self(SecCSFlags::DefaultFlags, NonNull::from(&mut me)) };
        let me = NonNull::new(me).filter(|_| status == 0).ok_or_else(|| format!("SecCodeCopySelf failed ({status})"))?;
        // SAFETY: a +1 reference from a Copy function.
        let me = unsafe { CFRetained::from_raw(me) };
        let st = static_code(&me)?;
        let mut req: *mut SecRequirement = ptr::null_mut();
        // SAFETY: a live static code and a local out-pointer.
        let status = unsafe { SecCode::copy_designated_requirement(&st, SecCSFlags::DefaultFlags, NonNull::from(&mut req)) };
        let req = NonNull::new(req)
            .filter(|_| status == 0)
            .ok_or_else(|| format!("this app is not signed, so it has no designated requirement to check its helpers by ({status})"))?;
        // SAFETY: a +1 reference from a Copy function.
        Ok(MacInspector { requirement: unsafe { CFRetained::from_raw(req) } })
    }
}

/// The peer's audit token: 8 words. [1] is the effective uid, [5] the pid.
fn audit_token(fd: RawFd) -> Result<[u32; 8], String> {
    let mut token = [0u32; 8];
    let mut len = std::mem::size_of_val(&token) as libc::socklen_t;
    // SAFETY: the buffer is as long as we say.
    let rc = unsafe { libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERTOKEN, token.as_mut_ptr().cast(), &mut len) };
    if rc != 0 || len as usize != std::mem::size_of_val(&token) {
        return Err(format!("LOCAL_PEERTOKEN: {}", std::io::Error::last_os_error()));
    }
    Ok(token)
}

fn pid_path(pid: i32) -> Option<String> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is as long as we say.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

impl Inspector for MacInspector {
    fn inspect(&self, fd: RawFd) -> Result<PeerFacts, String> {
        let token = audit_token(fd)?;
        let (euid, pid) = (token[1], token[5] as i32);
        let (mut uid, mut gid) = (0u32, 0u32);
        // SAFETY: local out-parameters.
        if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0 || uid != euid {
            return Err("the peer's uid could not be read consistently".into());
        }
        let bytes: Vec<u8> = token.iter().flat_map(|w| w.to_ne_bytes()).collect();
        let data = CFData::from_bytes(&bytes);
        // SAFETY: a framework constant.
        let key: &CFString = unsafe { kSecGuestAttributeAudit };
        let attrs = CFDictionary::<CFString, CFType>::from_slices(&[key], &[data.as_ref()]);
        let mut guest: *mut SecCode = ptr::null_mut();
        // SAFETY: a live dictionary and a local out-pointer.
        let status =
            unsafe { SecCode::copy_guest_with_attributes(None, Some(attrs.as_opaque()), SecCSFlags::DefaultFlags, NonNull::from(&mut guest)) };
        let (signature_ok, code_path) = match NonNull::new(guest).filter(|_| status == 0) {
            Some(g) => {
                // SAFETY: a +1 reference from a Copy function.
                let g = unsafe { CFRetained::from_raw(g) };
                // SAFETY: live objects.
                let valid = unsafe { g.check_validity(SecCSFlags::DefaultFlags, Some(&self.requirement)) } == 0;
                (valid, code_path(&g))
            }
            None => (false, None),
        };
        Ok(PeerFacts { pid, uid: euid, exe: pid_path(pid), code_path, signature_ok })
    }

    fn console_uid(&self) -> Option<u32> {
        super::os::console_uid()
    }
}
