//! What one command frame does: the Mac's own refusals, the clamps and checks, the call into the platform, and the
//! result body that goes back. Numbers and texts are those of `Client.Execute` in src/agent-app.cs and of
//! docs/relay-v1-spec.md, "A Mac on the wire".

use crate::files;
use crate::keys;
use crate::platform::{Platform, RunRequest, ScreenOutput};
use crate::rules::{self, Ruled};
use crate::stop::Stop;
use crate::wire::{self, b64, error_result, Control, Frame, ScreenAction, GET_LENGTH_MAX, IMAGE_B64_MAX, OUTPUT_MAX, PUT_B64_MAX, TYPE_MAX};
use serde_json::{json, Map, Value};

pub const NO_SAS: &str = "send_sas is not available on a Mac";
pub const NO_BLOCK: &str = "block_input is not available on a Mac";
pub const NO_CONTROL_FRAME: &str = "full control is chosen when Support is set up on this Mac";
pub const NO_UI_TREE: &str = "ui_tree is not available on this Mac yet";
pub const NO_UI_ACT: &str = "ui_act is not available on this Mac yet";

/// What a command needs besides the frame.
pub struct Ctx<'a> {
    pub platform: &'a dyn Platform,
    /// A saved Mac's rules. None for a one-off session, which has none.
    pub ruled: Option<&'a dyn Ruled>,
    pub stop: &'a Stop,
}

fn ok_map() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("ok".into(), Value::Bool(true));
    m
}

/// Runs one frame and returns the result's fields (the envelope is added when it is sent).
pub fn execute(frame: &Frame, ctx: &Ctx) -> Map<String, Value> {
    if ctx.stop.is_set() {
        return error_result("stopped");
    }
    let info = ctx.platform.info();
    let limited = info.control != Control::Full;
    if let Some(refusal) = rules::check(ctx.ruled, limited, frame, ctx.stop) {
        return error_result(&refusal);
    }
    let result = match frame.kind.as_str() {
        "power" => power(frame, ctx),
        "programs" => programs(frame, ctx),
        "screen" => screen(frame, ctx, info.uia),
        "control" => Err(NO_CONTROL_FRAME.to_string()),
        "run" => run(frame, ctx, limited),
        "put_file" => put_file(frame, ctx),
        "get_file" => get_file(frame, ctx),
        _ => Err("Unknown operation.".to_string()),
    };
    result.unwrap_or_else(|e| error_result(&e))
}

fn power(frame: &Frame, ctx: &Ctx) -> Result<Map<String, Value>, String> {
    let at = ctx.platform.power(&frame.text("action"), rules::power_delay(frame))?;
    let mut m = ok_map();
    m.insert("at".into(), Value::from(at));
    Ok(m)
}

fn programs(frame: &Frame, ctx: &Ctx) -> Result<Map<String, Value>, String> {
    match frame.text("action").as_str() {
        // Rules::check already answered install and uninstall; this is the same refusal for a caller that skips it.
        "install" | "uninstall" => Err(rules::err("not_supported", rules::NOT_SUPPORTED_PROGRAMS)),
        _ => {
            let fields = ctx.platform.programs(frame)?;
            let mut m = ok_map();
            if let Value::Object(extra) = fields {
                m.extend(extra);
            }
            Ok(m)
        }
    }
}

fn run(frame: &Frame, ctx: &Ctx, limited: bool) -> Result<Map<String, Value>, String> {
    let as_text = frame.text("as");
    if limited && as_text == "system" {
        return Err("as: \"system\" needs full control".to_string());
    }
    if !matches!(as_text.as_str(), "" | "user" | "system") {
        return Err(if limited { "as must be user" } else { "as must be user or system" }.to_string());
    }
    // The relay always sends timeout_s (60 when the caller gave none). A frame without one gets that default.
    let timeout_s = if frame.raw.get("timeout_s").is_some() { frame.number("timeout_s").clamp(1, 600) } else { 60 };
    let out =
        ctx.platform.run(&RunRequest { command: frame.text("command"), timeout_s: timeout_s as u64, as_system: as_text == "system" }, ctx.stop)?;
    let cap = |v: &[u8]| -> Vec<u8> { v[..v.len().min(OUTPUT_MAX)].to_vec() };
    let mut m = ok_map();
    m.insert("exit_code".into(), out.exit_code.map_or(Value::Null, Value::from));
    m.insert("timed_out".into(), Value::Bool(out.timed_out));
    m.insert("stdout_b64".into(), Value::String(b64(&cap(&out.stdout))));
    m.insert("stderr_b64".into(), Value::String(b64(&cap(&out.stderr))));
    m.insert("stdout_truncated".into(), Value::Bool(out.stdout_truncated || out.stdout.len() > OUTPUT_MAX));
    m.insert("stderr_truncated".into(), Value::Bool(out.stderr_truncated || out.stderr.len() > OUTPUT_MAX));
    // The Windows client reports the processes it had to stop. A process group has no cheap count, so these say none.
    m.insert("left_running".into(), Value::from(0));
    m.insert("job_query_failed".into(), Value::Bool(false));
    Ok(m)
}

fn put_file(frame: &Frame, ctx: &Ctx) -> Result<Map<String, Value>, String> {
    let path = files::absolute_path(&frame.text("path"))?;
    let encoded = frame.text("data_b64");
    if encoded.len() > PUT_B64_MAX {
        return Err("File chunk too large.".to_string());
    }
    let data = wire::unb64(&encoded).ok_or("The data is not valid base64.")?;
    let bytes = ctx.platform.put_file(&path, &data, frame.flag("append"))?;
    let mut m = ok_map();
    m.insert("bytes".into(), Value::from(bytes));
    Ok(m)
}

fn get_file(frame: &Frame, ctx: &Ctx) -> Result<Map<String, Value>, String> {
    let path = files::absolute_path(&frame.text("path"))?;
    let offset = frame.number("offset").max(0) as u64;
    let length = if frame.raw.get("length").is_some() { frame.number("length").clamp(1, GET_LENGTH_MAX) } else { GET_LENGTH_MAX };
    let chunk = ctx.platform.get_file(&path, offset, length as usize)?;
    let mut m = ok_map();
    m.insert("data_b64".into(), Value::String(b64(&chunk.data)));
    m.insert("size".into(), Value::from(chunk.size));
    m.insert("eof".into(), Value::Bool(chunk.eof));
    Ok(m)
}

fn screen(frame: &Frame, ctx: &Ctx, uia: bool) -> Result<Map<String, Value>, String> {
    let action = ScreenAction::parse(frame.raw.get("action").unwrap_or(&Value::Null));
    let secret = action.name == "type_secret";
    let mut combos = Vec::new();
    match action.name.as_str() {
        // The relay forwards these whenever the Mac's hello says control full. The Mac refuses them: defence in depth.
        "send_sas" => return Err(NO_SAS.to_string()),
        "block_input" => return Err(NO_BLOCK.to_string()),
        "ui_tree" if !uia => return Err(NO_UI_TREE.to_string()),
        "ui_act" if !uia => return Err(NO_UI_ACT.to_string()),
        "key" => combos = keys::parse(&action.keys)?,
        "type" | "type_secret" => {
            let n = action.text.chars().count();
            if n == 0 || n > if secret { 1000 } else { TYPE_MAX } {
                return Err(if secret { "text must be 1 to 1000 characters" } else { "text must be 1 to 5000 characters" }.to_string());
            }
        }
        _ => {}
    }
    // A secret never comes back in an error: the failure says only that it failed.
    let out = match ctx.platform.screen(&action, &combos, ctx.stop) {
        Ok(out) => out,
        Err(_) if secret => return Err("type_secret failed".to_string()),
        Err(e) => return Err(e),
    };
    screen_result(&action, out, secret)
}

fn screen_result(action: &ScreenAction, out: ScreenOutput, secret: bool) -> Result<Map<String, Value>, String> {
    let mut m = ok_map();
    match out.image {
        Some(img) => {
            let encoded = b64(&img.bytes);
            if encoded.len() >= IMAGE_B64_MAX {
                return Err("the screenshot is too large to send".to_string());
            }
            m.insert("image_b64".into(), Value::String(encoded));
            m.insert("mime".into(), Value::String(img.mime.to_string()));
            m.insert("width".into(), json!(img.width));
            m.insert("height".into(), json!(img.height));
        }
        None if matches!(action.name.as_str(), "screenshot" | "zoom") => return Err("no screenshot could be taken".to_string()),
        None => {}
    }
    m.insert("display".into(), json!(out.display));
    m.insert("displays".into(), json!(out.displays));
    m.insert("desktop".into(), Value::String(out.desktop.as_str().to_string()));
    if let Some(text) = out.text.filter(|_| !secret) {
        m.insert("text".into(), Value::String(text));
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::{FakePlatform, FAKE_SCREEN_JPEG};
    use crate::wire::Frame;

    fn frame(v: Value) -> Frame {
        Frame::parse(&v).unwrap()
    }

    fn exec(platform: &FakePlatform, v: Value) -> Value {
        let stop = Stop::new();
        Value::Object(execute(&frame(v), &Ctx { platform, ruled: None, stop: &stop }))
    }

    #[test]
    fn run_returns_base64_output_and_the_windows_fields() {
        let p = FakePlatform::new(Control::Normal);
        let r = exec(&p, json!({"type":"run","id":"1","lane":"cmd","command":"echo hi","timeout_s":10}));
        assert_eq!(r["ok"], true);
        assert_eq!(wire::unb64(r["stdout_b64"].as_str().unwrap()).unwrap(), b"hi\n");
        assert_eq!(
            (r["exit_code"].clone(), r["timed_out"].clone(), r["left_running"].clone(), r["job_query_failed"].clone()),
            (json!(0), json!(false), json!(0), json!(false))
        );
    }

    #[test]
    fn run_clamps_the_timeout_and_kills_at_it() {
        let p = FakePlatform::new(Control::Normal);
        let r = exec(&p, json!({"type":"run","id":"1","lane":"cmd","command":"sleep 30","timeout_s":0}));
        // 0 is clamped up to 1 second: the command is killed and there is no exit code.
        assert_eq!((r["timed_out"].clone(), r["exit_code"].clone()), (json!(true), Value::Null));
    }

    #[test]
    fn as_is_checked_as_the_windows_client_checks_it() {
        let normal = FakePlatform::new(Control::Normal);
        let r = exec(&normal, json!({"type":"run","id":"1","lane":"cmd","command":"true","as":"system"}));
        assert_eq!(r["error"], "as: \"system\" needs full control");
        let r = exec(&normal, json!({"type":"run","id":"1","lane":"cmd","command":"true","as":"root"}));
        assert_eq!(r["error"], "as must be user");
        let full = FakePlatform::new(Control::Full);
        let r = exec(&full, json!({"type":"run","id":"1","lane":"cmd","command":"true","as":"root"}));
        assert_eq!(r["error"], "as must be user or system");
        assert_eq!(exec(&full, json!({"type":"run","id":"1","lane":"cmd","command":"true","as":"system"}))["ok"], true);
    }

    #[test]
    fn the_macs_own_refusals_use_the_pinned_texts() {
        let p = FakePlatform::new(Control::Full);
        let s = |action: Value| exec(&p, json!({"type":"screen","id":"1","lane":"screen","action":action}));
        assert_eq!(s(json!({"name":"send_sas"}))["error"], NO_SAS);
        assert_eq!(s(json!({"name":"block_input","on":true}))["error"], NO_BLOCK);
        assert_eq!(s(json!({"name":"ui_tree"}))["error"], NO_UI_TREE);
        assert_eq!(s(json!({"name":"ui_act","ref":1,"verb":"invoke"}))["error"], NO_UI_ACT);
        assert_eq!(s(json!({"name":"key","keys":"ctrl+alt+Delete"}))["error"], keys::CTRL_ALT_DEL);
        assert_eq!(s(json!({"name":"key","keys":"nope"}))["error"], "Unknown key \"nope\".");
        let c = exec(&p, json!({"type":"control","id":"2","lane":"screen","action":"request_full_control"}));
        assert_eq!(c["error"], NO_CONTROL_FRAME);
        // None of those reached the platform.
        assert!(p.screen_log.lock().unwrap().is_empty());
    }

    #[test]
    fn a_screenshot_is_the_fake_screens_jpeg() {
        let p = FakePlatform::new(Control::Normal);
        let r = exec(&p, json!({"type":"screen","id":"1","lane":"screen","action":{"name":"screenshot","display":0}}));
        assert_eq!(r["ok"], true);
        assert_eq!(wire::unb64(r["image_b64"].as_str().unwrap()).unwrap(), FAKE_SCREEN_JPEG);
        assert_eq!(
            (r["mime"].clone(), r["width"].clone(), r["height"].clone(), r["displays"].clone(), r["desktop"].clone()),
            (json!("image/jpeg"), json!(1280), json!(800), json!(1), json!("default"))
        );
        assert!(r["image_b64"].as_str().unwrap().starts_with("/9j/"));
    }

    #[test]
    fn an_input_without_a_screenshot_carries_no_image() {
        let p = FakePlatform::new(Control::Normal);
        let r = exec(&p, json!({"type":"screen","id":"1","lane":"screen","action":{"name":"click","x":1,"y":2,"screenshot":false}}));
        assert_eq!(r["ok"], true);
        assert!(r.get("image_b64").is_none() && r.get("mime").is_none());
    }

    #[test]
    fn a_secret_is_never_echoed_and_its_failure_says_only_that_it_failed() {
        struct Failing;
        impl Platform for Failing {
            fn info(&self) -> crate::wire::HostInfo {
                FakePlatform::new(Control::Normal).info()
            }
            fn run(&self, _: &RunRequest, _: &Stop) -> Result<crate::exec::RunOutput, String> {
                Err("x".into())
            }
            fn put_file(&self, _: &str, _: &[u8], _: bool) -> Result<usize, String> {
                Err("x".into())
            }
            fn get_file(&self, _: &str, _: u64, _: usize) -> Result<crate::files::FileChunk, String> {
                Err("x".into())
            }
            fn screen(&self, a: &ScreenAction, _: &[keys::KeyCombo], _: &Stop) -> Result<ScreenOutput, String> {
                Err(format!("could not type {}", a.text))
            }
        }
        let stop = Stop::new();
        let f = frame(json!({"type":"screen","id":"1","lane":"screen","action":{"name":"type_secret","text":"hunter2"}}));
        let r = execute(&f, &Ctx { platform: &Failing, ruled: None, stop: &stop });
        assert_eq!(r["error"], "type_secret failed");
        let f = frame(json!({"type":"screen","id":"1","lane":"screen","action":{"name":"type","text":"visible"}}));
        assert_eq!(execute(&f, &Ctx { platform: &Failing, ruled: None, stop: &stop })["error"], "could not type visible");
    }

    #[test]
    fn files_round_trip_in_chunks_with_the_windows_limits() {
        let p = FakePlatform::new(Control::Normal);
        let dir = std::env::temp_dir().join(format!("support-core-ops-{}", std::process::id()));
        let path = dir.join("a/b.bin").to_string_lossy().into_owned();
        let put =
            |data: &[u8], append: bool| exec(&p, json!({"type":"put_file","id":"1","lane":"cmd","path":path,"data_b64":b64(data),"append":append}));
        assert_eq!(put(b"abc", false)["bytes"], 3);
        assert_eq!(put(b"def", true)["bytes"], 3);
        let g = exec(&p, json!({"type":"get_file","id":"2","lane":"cmd","path":path,"offset":0,"length":100}));
        assert_eq!(
            (wire::unb64(g["data_b64"].as_str().unwrap()).unwrap(), g["size"].clone(), g["eof"].clone()),
            (b"abcdef".to_vec(), json!(6), json!(true))
        );
        // Too long a chunk, a relative path, bad base64.
        let big = "A".repeat(PUT_B64_MAX + 4);
        assert_eq!(exec(&p, json!({"type":"put_file","id":"1","lane":"cmd","path":path,"data_b64":big}))["error"], "File chunk too large.");
        assert_eq!(exec(&p, json!({"type":"get_file","id":"1","lane":"cmd","path":"rel/x"}))["error"], files::NEEDS_ABSOLUTE);
        assert_eq!(exec(&p, json!({"type":"put_file","id":"1","lane":"cmd","path":path,"data_b64":"!!"}))["ok"], false);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_one_off_session_refuses_power_and_programs() {
        let p = FakePlatform::new(Control::Normal);
        let r = exec(&p, json!({"type":"power","id":"1","lane":"cmd","action":"restart","delay_s":30}));
        assert_eq!(r["error"], "not_saved_pc: this works only in a session on a saved PC");
        let r = exec(&p, json!({"type":"programs","id":"1","lane":"cmd","action":"list"}));
        assert_eq!(r["error"], "not_saved_pc: this works only in a session on a saved PC");
    }
}
