//! Helpers for tests that need a real socket.

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Answers each connection once with a canned response and keeps the request it saw.
pub async fn one_shot(status_line: &str, body: Vec<u8>, hold_ms: u64) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let status_line = status_line.to_string();
    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut seen = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = sock.read(&mut buf).await.unwrap();
            seen.extend_from_slice(&buf[..n]);
            let head_end = seen.windows(4).position(|w| w == b"\r\n\r\n");
            if let Some(h) = head_end {
                let head = String::from_utf8_lossy(&seen[..h]).to_lowercase();
                let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length: ")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                if seen.len() >= h + 4 + len {
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        if hold_ms > 0 {
            tokio::time::sleep(Duration::from_millis(hold_ms)).await;
        }
        let head = format!("{status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
        let _ = sock.write_all(head.as_bytes()).await;
        let _ = sock.write_all(&body).await;
        let _ = sock.shutdown().await;
        String::from_utf8_lossy(&seen).into_owned()
    });
    (origin, handle)
}
