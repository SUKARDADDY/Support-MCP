//! File reads and writes for `put_file` and `get_file`, and the path check that comes first.

use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};

pub const NEEDS_ABSOLUTE: &str = "A local absolute file path is required.";

/// A path the Mac accepts: it starts with `/` and holds no NUL. It is returned with `.` and `..` parts and repeated
/// slashes resolved in the text (as `Path.GetFullPath` does on Windows), so the rules see the file that will be
/// opened. A `..` at the root stays at the root.
pub fn absolute_path(path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err(NEEDS_ABSOLUTE.to_string());
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

/// Writes `data` to `path`, creating missing parent folders. Replaces the file, or appends when `append` is set.
pub fn put(path: &str, data: &[u8], append: bool) -> Result<usize, String> {
    let p = std::path::Path::new(path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut opts = OpenOptions::new();
    opts.create(true).write(true);
    if append {
        opts.append(true);
    } else {
        opts.truncate(true);
    }
    let mut f = opts.open(p).map_err(|e| e.to_string())?;
    f.write_all(data).map_err(|e| e.to_string())?;
    Ok(data.len())
}

pub struct FileChunk {
    pub data: Vec<u8>,
    pub size: u64,
    pub eof: bool,
}

/// Reads up to `length` bytes from `offset`.
pub fn get(path: &str, offset: u64, length: usize) -> Result<FileChunk, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut data = vec![0u8; length];
    let mut total = 0;
    while total < length {
        let n = f.read(&mut data[total..]).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n;
    }
    data.truncate(total);
    Ok(FileChunk { eof: offset + total as u64 >= size, data, size })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_local_absolute_path_is_accepted() {
        assert_eq!(absolute_path("/Users/a/x.txt").unwrap(), "/Users/a/x.txt");
        for bad in ["", "x.txt", "./x", "~/x", "C:\\x", "//server/share\0", "/a\0b"] {
            assert_eq!(absolute_path(bad).unwrap_err(), NEEDS_ABSOLUTE, "{bad:?}");
        }
    }

    #[test]
    fn dots_and_repeated_slashes_are_resolved_in_the_text() {
        assert_eq!(absolute_path("/a/./b//c/../d").unwrap(), "/a/b/d");
        assert_eq!(absolute_path("/../../etc").unwrap(), "/etc");
        assert_eq!(absolute_path("/").unwrap(), "/");
        assert_eq!(absolute_path("//x").unwrap(), "/x");
    }

    #[test]
    fn a_file_is_written_in_chunks_and_read_back() {
        let dir = std::env::temp_dir().join(format!("support-core-files-{}", std::process::id()));
        let path = dir.join("deep/er/file.bin");
        let path = path.to_str().unwrap();
        assert_eq!(put(path, b"hello ", false).unwrap(), 6);
        assert_eq!(put(path, b"world", true).unwrap(), 5);
        let all = get(path, 0, 100).unwrap();
        assert_eq!((all.data.as_slice(), all.size, all.eof), (&b"hello world"[..], 11, true));
        let part = get(path, 2, 4).unwrap();
        assert_eq!((part.data.as_slice(), part.size, part.eof), (&b"llo "[..], 11, false));
        let tail = get(path, 6, 5).unwrap();
        assert!(tail.eof);
        assert_eq!(put(path, b"x", false).unwrap(), 1);
        assert_eq!(get(path, 0, 10).unwrap().data, b"x");
        assert!(get(dir.join("missing").to_str().unwrap(), 0, 1).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
