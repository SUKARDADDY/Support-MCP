//! Administrator authorization for setup and uninstall (Authorization Services).
//!
//! The asking side (the helper's setup window, or the CLI) gets `system.privilege.admin` with the system's own
//! password prompt and sends the AuthorizationRef's 32-byte external form. The service then checks it itself:
//!
//! 1. it internalizes the form and asks for `system.privilege.admin` again with no prompt allowed, which succeeds only
//!    if the credential behind the reference already satisfies the right;
//! 2. for a person's peer (not root), it also reads who authenticated (`username` from the reference's information)
//!    and checks that this account is in the `admin` group.
//!
//! A root peer (`sudo support ...`) passes on the first step alone: root holds the right already, and could do all of
//! this by hand. The asking side keeps its reference alive until the service has answered, then frees it with
//! `DestroyRights`, so no administrator right stays behind.

use crate::ipc::AUTH_LEN;
use crate::peer::Peer;
use crate::service::NOT_ADMIN;
use objc2_security::{
    errAuthorizationSuccess, AuthorizationCopyInfo, AuthorizationCopyRights, AuthorizationCreate, AuthorizationCreateFromExternalForm,
    AuthorizationExternalForm, AuthorizationFlags, AuthorizationFree, AuthorizationFreeItemSet, AuthorizationItem, AuthorizationItemSet,
    AuthorizationRef,
};
use std::ffi::CStr;
use std::ptr::{self, NonNull};

const RIGHT: &CStr = c"system.privilege.admin";
const PROMPT_KEY: &CStr = c"prompt";
const USERNAME_KEY: &CStr = c"username";
const CANCELED: i32 = -60006;
const DENIED: i32 = -60005;

/// An administrator's authorization, held until it is dropped.
pub struct AdminAuth {
    reference: AuthorizationRef,
    pub external: [u8; AUTH_LEN],
}

// SAFETY: an AuthorizationRef is an opaque handle that Authorization Services may use from any thread.
unsafe impl Send for AdminAuth {}

impl Drop for AdminAuth {
    fn drop(&mut self) {
        // SAFETY: a reference this struct created and owns.
        unsafe {
            AuthorizationFree(self.reference, AuthorizationFlags::DestroyRights);
        }
    }
}

fn right_set(item: &mut AuthorizationItem) -> AuthorizationItemSet {
    *item = AuthorizationItem { name: RIGHT.as_ptr(), valueLength: 0, value: ptr::null_mut(), flags: 0 };
    AuthorizationItemSet { count: 1, items: item }
}

/// Asks for an administrator's name and password with `prompt` as the reason (the system's own dialog).
pub fn acquire(prompt: &str) -> Result<AdminAuth, String> {
    let mut reference: AuthorizationRef = ptr::null();
    // SAFETY: the out-pointer is valid; no rights or environment yet.
    let status = unsafe { AuthorizationCreate(ptr::null(), ptr::null(), AuthorizationFlags::Defaults, &mut reference) };
    if status != errAuthorizationSuccess || reference.is_null() {
        return Err(format!("Authorization Services refused ({status})."));
    }
    let auth = AdminAuth { reference, external: [0; AUTH_LEN] };
    let mut item = AuthorizationItem { name: ptr::null(), valueLength: 0, value: ptr::null_mut(), flags: 0 };
    let mut rights = right_set(&mut item);
    let mut prompt_bytes = prompt.as_bytes().to_vec();
    let mut env_item =
        AuthorizationItem { name: PROMPT_KEY.as_ptr(), valueLength: prompt_bytes.len(), value: prompt_bytes.as_mut_ptr().cast(), flags: 0 };
    let env = AuthorizationItemSet { count: 1, items: &mut env_item };
    let flags = AuthorizationFlags::InteractionAllowed | AuthorizationFlags::ExtendRights | AuthorizationFlags::PreAuthorize;
    // SAFETY: every pointer is to a live local; nothing is returned through the last argument.
    let status = unsafe { AuthorizationCopyRights(auth.reference, NonNull::from(&mut rights), &env, flags, ptr::null_mut()) };
    match status {
        s if s == errAuthorizationSuccess => {}
        CANCELED => return Err("Setup was cancelled at the password prompt.".into()),
        DENIED => return Err(NOT_ADMIN.into()),
        s => return Err(format!("{NOT_ADMIN} ({s})")),
    }
    let mut form = AuthorizationExternalForm { bytes: [0; 32] };
    // SAFETY: a live reference and a local out-parameter.
    let status = unsafe { objc2_security::AuthorizationMakeExternalForm(auth.reference, NonNull::from(&mut form)) };
    if status != errAuthorizationSuccess {
        return Err(format!("Authorization Services refused ({status})."));
    }
    let mut auth = auth;
    for (o, b) in auth.external.iter_mut().zip(form.bytes.iter()) {
        *o = *b as u8;
    }
    Ok(auth)
}

/// Whether `user` is in the `admin` group (nested groups included), by the directory's own answer.
fn is_admin(user: &str) -> bool {
    if user.is_empty() || user.starts_with('-') || user.chars().any(|c| c.is_control()) {
        return false;
    }
    std::process::Command::new("/usr/sbin/dseditgroup")
        .args(["-o", "checkmember", "-m", user, "admin"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// The account that authenticated for a reference, from its information.
fn username(reference: AuthorizationRef) -> Option<String> {
    let mut info: *mut AuthorizationItemSet = ptr::null_mut();
    // SAFETY: a live reference, a static tag, a local out-pointer; the set is freed below.
    let status = unsafe { AuthorizationCopyInfo(reference, USERNAME_KEY.as_ptr(), NonNull::from(&mut info)) };
    if status != errAuthorizationSuccess || info.is_null() {
        return None;
    }
    let mut found = None;
    // SAFETY: Authorization Services filled `info` with `count` items.
    unsafe {
        let set = &*info;
        for i in 0..set.count as usize {
            let item = &*set.items.add(i);
            if !item.name.is_null() && CStr::from_ptr(item.name) == USERNAME_KEY && !item.value.is_null() {
                let bytes = std::slice::from_raw_parts(item.value as *const u8, item.valueLength);
                let text = String::from_utf8_lossy(bytes).trim_end_matches('\0').to_string();
                found = Some(text);
            }
        }
        AuthorizationFreeItemSet(NonNull::new_unchecked(info));
    }
    found
}

/// The service's check of an external form, as described at the top.
pub fn verify(external: &[u8; AUTH_LEN], peer: Peer) -> Result<(), String> {
    let mut form = AuthorizationExternalForm { bytes: [0; 32] };
    for (o, b) in form.bytes.iter_mut().zip(external.iter()) {
        *o = *b as _;
    }
    let mut reference: AuthorizationRef = ptr::null();
    // SAFETY: local in and out parameters.
    let status = unsafe { AuthorizationCreateFromExternalForm(NonNull::from(&mut form), NonNull::from(&mut reference)) };
    if status != errAuthorizationSuccess || reference.is_null() {
        return Err(NOT_ADMIN.into());
    }
    let result = (|| {
        let mut item = AuthorizationItem { name: ptr::null(), valueLength: 0, value: ptr::null_mut(), flags: 0 };
        let mut rights = right_set(&mut item);
        // No InteractionAllowed: nothing is asked here, the right must already be held.
        // SAFETY: a live reference and local sets.
        let status =
            unsafe { AuthorizationCopyRights(reference, NonNull::from(&mut rights), ptr::null(), AuthorizationFlags::ExtendRights, ptr::null_mut()) };
        if status != errAuthorizationSuccess {
            return Err(NOT_ADMIN.to_string());
        }
        match peer {
            Peer::Root => Ok(()),
            Peer::ConsoleUser(_) => match username(reference) {
                Some(user) if is_admin(&user) => Ok(()),
                Some(_) => Err(NOT_ADMIN.to_string()),
                None => Err(format!("{NOT_ADMIN} The Mac did not say who signed in for it.")),
            },
        }
    })();
    // SAFETY: the reference this function made from the form. Its rights belong to the asking side, which destroys
    // them when it frees its own reference.
    unsafe {
        AuthorizationFree(reference, AuthorizationFlags::Defaults);
    }
    result
}
