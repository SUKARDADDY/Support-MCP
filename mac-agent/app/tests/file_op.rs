//! The `file-op` role through the real binary, as the service starts it: the data goes in on stdin, one JSON line
//! comes out, and a process that is not root can work only as itself.

use std::path::Path;
use support_mac::as_user::spawn_file_op;
use support_mac::role::FileOp;

fn me() -> u32 {
    // SAFETY: a getter.
    unsafe { libc::getuid() }
}

#[test]
fn a_file_goes_through_the_file_op_role_and_comes_back() {
    let exe = Path::new(env!("CARGO_BIN_EXE_support"));
    let dir = std::env::temp_dir().join(format!("support-mac-fileop-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("a/b.bin").to_string_lossy().into_owned();
    let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let put = spawn_file_op(exe, me(), &FileOp::Put { path: path.clone(), append: false }, &data).unwrap();
    assert_eq!(put["bytes"], 300_000);
    let more = spawn_file_op(exe, me(), &FileOp::Put { path: path.clone(), append: true }, b"tail").unwrap();
    assert_eq!(more["bytes"], 4);
    let got = spawn_file_op(exe, me(), &FileOp::Get { path: path.clone(), offset: 299_998, length: 100 }, &[]).unwrap();
    assert_eq!((got["size"].as_u64(), got["eof"].as_bool()), (Some(300_004), Some(true)));
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(got["data"].as_str().unwrap()).unwrap();
    assert_eq!(bytes, [&data[299_998..], b"tail"].concat());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_file_op_role_refuses_what_it_must() {
    let exe = Path::new(env!("CARGO_BIN_EXE_support"));
    // SAFETY: a getter.
    if unsafe { libc::geteuid() } != 0 {
        // Another account that exists (daemon, bin or nobody): a process that is not root cannot become it.
        let other = [1u32, 2, 65534].into_iter().find(|u| *u != me() && support_mac::as_user::account(*u).is_some()).expect("a second account");
        let e = spawn_file_op(exe, other, &FileOp::Get { path: "/etc/hostname".into(), offset: 0, length: 10 }, &[]).unwrap_err();
        assert_eq!(e, "only root can work as another user");
    }
    let e = spawn_file_op(exe, me(), &FileOp::Get { path: "relative/x".into(), offset: 0, length: 10 }, &[]).unwrap_err();
    assert_eq!(e, support_core::files::NEEDS_ABSOLUTE);
    let too_big = vec![0u8; support_mac::as_user::PUT_MAX + 1];
    let e = spawn_file_op(exe, me(), &FileOp::Put { path: "/tmp/support-mac-never".into(), append: false }, &too_big).unwrap_err();
    assert_eq!(e, "File chunk too large.");
    assert!(!Path::new("/tmp/support-mac-never").exists());
    // Root's work never goes through it: uid 0 is refused before anything runs.
    let out = std::process::Command::new(exe).args(["file-op", "get", "--uid", "0", "--path", "/etc/hostname", "--length", "1"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
}
