//! The socket's framing: a 4-byte big-endian length, then that many bytes of UTF-8 JSON holding one object, at most
//! 1 MiB. Anything else (a zero or oversized length, bytes that are not UTF-8 JSON, JSON that is not an object, a frame
//! cut short, or a frame that takes too long to arrive) is an error, and the reader closes the connection on any error.

use serde_json::{Map, Value};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The longest frame body. A screenshot (under 700,000 base64 characters) fits with room for its fields.
pub const FRAME_MAX: usize = 1 << 20;
/// Once a frame has started, the rest of it must arrive within this long.
pub const BODY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The other side closed the connection between frames.
    Closed,
    /// No frame started within the idle time.
    Idle,
    Empty,
    TooLarge(usize),
    Truncated,
    Slow,
    NotJson,
    NotObject,
    Io(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Closed => write!(f, "closed"),
            FrameError::Idle => write!(f, "idle"),
            FrameError::Empty => write!(f, "an empty frame"),
            FrameError::TooLarge(n) => write!(f, "a frame of {n} bytes is over the limit"),
            FrameError::Truncated => write!(f, "a frame was cut short"),
            FrameError::Slow => write!(f, "a frame took too long"),
            FrameError::NotJson => write!(f, "a frame that is not UTF-8 JSON"),
            FrameError::NotObject => write!(f, "a frame that is not a JSON object"),
            FrameError::Io(e) => write!(f, "{e}"),
        }
    }
}

/// The bytes of one frame.
pub fn encode(message: &Map<String, Value>) -> Result<Vec<u8>, FrameError> {
    let body = serde_json::to_vec(message).map_err(|_| FrameError::NotJson)?;
    if body.len() > FRAME_MAX {
        return Err(FrameError::TooLarge(body.len()));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// Checks a frame body: UTF-8 JSON with an object at the top.
pub fn decode(body: &[u8]) -> Result<Map<String, Value>, FrameError> {
    let text = std::str::from_utf8(body).map_err(|_| FrameError::NotJson)?;
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(FrameError::NotObject),
        Err(_) => Err(FrameError::NotJson),
    }
}

/// Reads one frame. `idle` bounds the wait for its first byte (None waits for ever); the rest must follow within
/// `BODY_TIMEOUT`. A connection closed between frames is `Closed`, one closed inside a frame is `Truncated`.
pub async fn read<R: AsyncRead + Unpin>(r: &mut R, idle: Option<Duration>) -> Result<Map<String, Value>, FrameError> {
    read_with(r, idle, BODY_TIMEOUT).await
}

pub async fn read_with<R: AsyncRead + Unpin>(r: &mut R, idle: Option<Duration>, body_timeout: Duration) -> Result<Map<String, Value>, FrameError> {
    let mut first = [0u8; 1];
    let n = match idle {
        Some(d) => tokio::time::timeout(d, r.read(&mut first)).await.map_err(|_| FrameError::Idle)?,
        None => r.read(&mut first).await,
    }
    .map_err(|e| FrameError::Io(e.to_string()))?;
    if n == 0 {
        return Err(FrameError::Closed);
    }
    let rest = async {
        let mut len = [0u8; 4];
        len[0] = first[0];
        r.read_exact(&mut len[1..]).await.map_err(|_| FrameError::Truncated)?;
        let len = u32::from_be_bytes(len) as usize;
        if len == 0 {
            return Err(FrameError::Empty);
        }
        if len > FRAME_MAX {
            return Err(FrameError::TooLarge(len));
        }
        let mut body = vec![0u8; len];
        r.read_exact(&mut body).await.map_err(|_| FrameError::Truncated)?;
        decode(&body)
    };
    tokio::time::timeout(body_timeout, rest).await.map_err(|_| FrameError::Slow)?
}

pub async fn write<W: AsyncWrite + Unpin>(w: &mut W, message: &Map<String, Value>) -> Result<(), FrameError> {
    let bytes = encode(message)?;
    w.write_all(&bytes).await.map_err(|e| FrameError::Io(e.to_string()))?;
    w.flush().await.map_err(|e| FrameError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => unreachable!(),
        }
    }

    async fn read_bytes(bytes: Vec<u8>) -> Result<Map<String, Value>, FrameError> {
        let (mut a, mut b) = tokio::io::duplex(4 << 20);
        tokio::spawn(async move {
            a.write_all(&bytes).await.unwrap();
            // Keep the writer open a moment, so a short frame reads as cut short only when it is.
            drop(a);
        });
        read_with(&mut b, Some(Duration::from_secs(2)), Duration::from_secs(2)).await
    }

    #[tokio::test]
    async fn a_frame_round_trips() {
        let m = obj(json!({"type":"status","n":1,"s":"héllo"}));
        let bytes = encode(&m).unwrap();
        assert_eq!(&bytes[..4], &(bytes.len() as u32 - 4).to_be_bytes());
        assert_eq!(read_bytes(bytes).await.unwrap(), m);
    }

    #[tokio::test]
    async fn two_frames_in_one_write_read_as_two() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        let mut both = encode(&obj(json!({"a":1}))).unwrap();
        both.extend(encode(&obj(json!({"b":2}))).unwrap());
        a.write_all(&both).await.unwrap();
        assert_eq!(read(&mut b, None).await.unwrap()["a"], 1);
        assert_eq!(read(&mut b, None).await.unwrap()["b"], 2);
        drop(a);
        assert_eq!(read(&mut b, None).await.unwrap_err(), FrameError::Closed);
    }

    #[tokio::test]
    async fn a_frame_of_exactly_1_mib_is_read_and_one_byte_more_is_refused_before_its_body() {
        let filler = "x".repeat(FRAME_MAX - 8);
        let m = obj(json!({ "f": filler }));
        let body = serde_json::to_vec(&m).unwrap();
        assert_eq!(body.len(), FRAME_MAX);
        assert!(read_bytes(encode(&m).unwrap()).await.is_ok());
        let over = obj(json!({ "f": "x".repeat(FRAME_MAX - 7) }));
        assert_eq!(encode(&over).unwrap_err(), FrameError::TooLarge(FRAME_MAX + 1));
        // A header that claims 4 GiB is refused from the header alone: nothing is allocated for it.
        assert_eq!(read_bytes(vec![0xff, 0xff, 0xff, 0xff]).await.unwrap_err(), FrameError::TooLarge(u32::MAX as usize));
        assert_eq!(read_bytes(((FRAME_MAX + 1) as u32).to_be_bytes().to_vec()).await.unwrap_err(), FrameError::TooLarge(FRAME_MAX + 1));
    }

    #[tokio::test]
    async fn malformed_frames_are_refused() {
        let framed = |body: &[u8]| {
            let mut v = (body.len() as u32).to_be_bytes().to_vec();
            v.extend_from_slice(body);
            v
        };
        assert_eq!(read_bytes(vec![0, 0, 0, 0]).await.unwrap_err(), FrameError::Empty);
        assert_eq!(read_bytes(framed(b"[1,2]")).await.unwrap_err(), FrameError::NotObject);
        assert_eq!(read_bytes(framed(b"\"text\"")).await.unwrap_err(), FrameError::NotObject);
        assert_eq!(read_bytes(framed(b"{\"a\":")).await.unwrap_err(), FrameError::NotJson);
        assert_eq!(read_bytes(framed(b"{\"a\":\"\xff\"}")).await.unwrap_err(), FrameError::NotJson);
        assert_eq!(read_bytes(framed(b"{} {}")).await.unwrap_err(), FrameError::NotJson);
        // Cut short: in the header, and in the body.
        assert_eq!(read_bytes(vec![0, 0]).await.unwrap_err(), FrameError::Truncated);
        let mut short = framed(b"{\"a\":1}");
        short.truncate(7);
        assert_eq!(read_bytes(short).await.unwrap_err(), FrameError::Truncated);
        assert_eq!(read_bytes(vec![]).await.unwrap_err(), FrameError::Closed);
    }

    #[tokio::test]
    async fn a_slow_frame_and_an_idle_connection_time_out() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&[0, 0, 0]).await.unwrap();
        let started = std::time::Instant::now();
        assert_eq!(read_with(&mut b, None, Duration::from_millis(200)).await.unwrap_err(), FrameError::Slow);
        assert!(started.elapsed() < Duration::from_secs(2));
        let (_a, mut b) = tokio::io::duplex(64);
        assert_eq!(read_with(&mut b, Some(Duration::from_millis(100)), Duration::from_secs(1)).await.unwrap_err(), FrameError::Idle);
    }
}
