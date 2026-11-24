//! `support-join`: the one-off join app, `Support Join.app`. It is built from the same crate as `support` but has the
//! join role only: no root service, no helper socket, no setup or uninstall, and no way to ask for an administrator's
//! password. The saved app (`support`) has no join role, so the two bundles never share a permission.

#[cfg(target_os = "macos")]
fn main() {
    std::process::exit(support_mac::mac::join::main());
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Support Join runs only on a Mac.");
    std::process::exit(2);
}
