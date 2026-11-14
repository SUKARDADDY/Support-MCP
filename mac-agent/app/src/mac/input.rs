//! Mouse and keyboard through CGEvent, posted at the HID level, with the Windows client's timings: clicks 40 ms
//! apart, drags in 10 steps 20 ms apart, keys held 30 ms with 20 ms between chords, one character every 20 ms.
//!
//! Before each step the helper checks the guards it is given: the person's own input (3 seconds of pause), the
//! app's own windows (never a click there), and the keyboard focus (never typing into the app's own window).

use crate::input_plan::{self, Button, Chord, TypeStep};
use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation, CGEventType, CGMouseButton, CGScrollEventUnit,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use support_core::geometry::{CLICK_GAP_MS, DRAG_STEPS, DRAG_STEP_MS, KEY_GAP_MS, KEY_HOLD_MS, PAUSE_TEXT, TYPE_CHAR_MS};

/// When the app last sent an event, to tell the person's input from its own.
static LAST_SENT: Mutex<Option<Instant>> = Mutex::new(None);

/// What every input step checks before it goes.
pub trait Guard {
    /// Err when the person used the Mac in the last 3 seconds, or the action was cancelled.
    fn free(&self) -> Result<(), String>;
    /// Err when the point is in one of the app's own windows.
    fn target(&self, x: f64, y: f64) -> Result<(), String>;
    /// Err when the app's own window has the keyboard focus.
    fn key_target(&self) -> Result<(), String>;
}

/// Milliseconds since the person last used the mouse or keyboard, -1 when the last input was the app's own.
pub fn customer_ago_ms() -> i64 {
    // kCGAnyInputEventType is ~0.
    let secs = CGEventSource::seconds_since_last_event_type(CGEventSourceStateID::HIDSystemState, CGEventType(u32::MAX));
    let own = LAST_SENT.lock().unwrap().map(|t| t.elapsed().as_millis() as i64);
    input_plan::customer_ago_ms((secs * 1000.0) as i64, own)
}

pub fn paused() -> bool {
    (0..support_core::geometry::CUSTOMER_PAUSE_MS as i64).contains(&customer_ago_ms())
}

fn post(e: Option<objc2_core_foundation::CFRetained<CGEvent>>) -> Result<(), String> {
    let e = e.ok_or("macOS refused to make the input event")?;
    CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&e));
    *LAST_SENT.lock().unwrap() = Some(Instant::now());
    Ok(())
}

fn wait(ms: u64, cancel: &AtomicBool) -> Result<(), String> {
    let until = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < until {
        if cancel.load(Ordering::SeqCst) {
            return Err("support access ended".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

fn mouse(kind: CGEventType, x: f64, y: f64, button: CGMouseButton) -> Option<objc2_core_foundation::CFRetained<CGEvent>> {
    CGEvent::new_mouse_event(None, kind, CGPoint::new(x, y), button)
}

pub fn move_to(x: f64, y: f64) -> Result<(), String> {
    post(mouse(CGEventType::MouseMoved, x, y, CGMouseButton::Left))
}

fn button_events(b: Button) -> (CGEventType, CGEventType, CGMouseButton) {
    match b {
        Button::Left => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left),
        Button::Right => (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right),
        Button::Middle => (CGEventType::OtherMouseDown, CGEventType::OtherMouseUp, CGMouseButton::Center),
    }
}

pub fn click(x: f64, y: f64, b: Button, count: i64, guard: &dyn Guard, cancel: &AtomicBool) -> Result<(), String> {
    guard.free()?;
    guard.target(x, y)?;
    move_to(x, y)?;
    let (down, up, button) = button_events(b);
    for i in 1..=count.clamp(1, 3) {
        if i > 1 {
            wait(CLICK_GAP_MS, cancel)?;
            guard.free()?;
        }
        for kind in [down, up] {
            let e = mouse(kind, x, y, button).ok_or("macOS refused to make the input event")?;
            // The click count makes a double click a double click.
            CGEvent::set_integer_value_field(Some(&e), CGEventField::MouseEventClickState, i);
            post(Some(e))?;
        }
    }
    Ok(())
}

/// The button is released even when the drag stops part way, so it is never left held down.
pub fn drag(a: (f64, f64), b: (f64, f64), guard: &dyn Guard, cancel: &AtomicBool) -> Result<(), String> {
    guard.free()?;
    guard.target(a.0, a.1)?;
    guard.target(b.0, b.1)?;
    move_to(a.0, a.1)?;
    wait(50, cancel)?;
    post(mouse(CGEventType::LeftMouseDown, a.0, a.1, CGMouseButton::Left))?;
    let moved = (|| {
        for i in 1..=DRAG_STEPS {
            wait(DRAG_STEP_MS, cancel)?;
            guard.free()?;
            let t = i as f64 / DRAG_STEPS as f64;
            post(mouse(CGEventType::LeftMouseDragged, a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t, CGMouseButton::Left))?;
        }
        wait(50, cancel)
    })();
    let released = post(mouse(CGEventType::LeftMouseUp, b.0, b.1, CGMouseButton::Left));
    moved.and(released)
}

pub fn scroll(at: Option<(f64, f64)>, wheels: (i32, i32), guard: &dyn Guard) -> Result<(), String> {
    guard.free()?;
    if let Some((x, y)) = at {
        guard.target(x, y)?;
        move_to(x, y)?;
    }
    post(CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Line, 2, wheels.0, wheels.1, 0))
}

fn key(code: u16, down: bool, flags: u64) -> Result<(), String> {
    let e = CGEvent::new_keyboard_event(None, code, down).ok_or("macOS refused to make the key event")?;
    CGEvent::set_flags(Some(&e), CGEventFlags(flags));
    post(Some(e))
}

/// Presses each chord: its modifiers down in order, its keys down and up, the modifiers up in reverse.
pub fn chords(list: &[Chord], guard: &dyn Guard, cancel: &AtomicBool) -> Result<(), String> {
    for (n, c) in list.iter().enumerate() {
        if n > 0 {
            wait(KEY_GAP_MS, cancel)?;
        }
        guard.free()?;
        guard.key_target()?;
        // Every event of the chord carries all its modifiers' flags, as a keyboard reports once they are down.
        for code in &c.modifiers {
            key(*code, true, c.flags)?;
        }
        let result = (|| {
            for k in &c.keys {
                key(*k, true, c.flags)?;
                wait(KEY_HOLD_MS, cancel)?;
                key(*k, false, c.flags)?;
            }
            Ok::<(), String>(())
        })();
        // Modifiers always come up, even when a key failed.
        for code in c.modifiers.iter().rev() {
            let _ = key(*code, false, 0);
        }
        result?;
    }
    Ok(())
}

/// Types the text one character every 20 ms. A pause or a focus change stops it where it is.
pub fn type_text(text: &str, guard: &dyn Guard, cancel: &AtomicBool) -> Result<(), String> {
    for (n, step) in input_plan::type_steps(text).iter().enumerate() {
        if n > 0 {
            wait(TYPE_CHAR_MS, cancel)?;
        }
        guard.free().map_err(|e| if e == PAUSE_TEXT { format!("{PAUSE_TEXT} (typing stopped after {n} characters)") } else { e })?;
        guard.key_target()?;
        match step {
            TypeStep::Key(code) => {
                key(*code, true, 0)?;
                key(*code, false, 0)?;
            }
            TypeStep::Text(units) => {
                for down in [true, false] {
                    let e = CGEvent::new_keyboard_event(None, 0, down).ok_or("macOS refused to make the key event")?;
                    // SAFETY: the pointer and length describe `units`, which outlives the call.
                    unsafe { CGEvent::keyboard_set_unicode_string(Some(&e), units.len() as _, units.as_ptr()) };
                    post(Some(e))?;
                }
            }
        }
    }
    Ok(())
}
