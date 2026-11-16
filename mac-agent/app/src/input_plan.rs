//! What the helper's input does, worked out before any event is made, so it is tested on Linux: key codes for the
//! core's key names (macOS virtual key codes, ANSI layout), the steps of typing a text, the scroll wheel's direction,
//! and where a screenshot pixel lands on the screen.

use support_core::geometry::{self, Rect};
use support_core::keys::{Key, KeyCombo, Modifier};

/// The modifier keys' own codes, pressed before the chord's keys and released after them.
pub fn modifier_code(m: Modifier) -> u16 {
    match m {
        Modifier::Command => 0x37,
        Modifier::Shift => 0x38,
        Modifier::Option => 0x3A,
        Modifier::Ctrl => 0x3B,
    }
}

/// The CGEventFlags bit a modifier sets on the events of its chord.
pub fn modifier_flag(m: Modifier) -> u64 {
    match m {
        Modifier::Shift => 1 << 17,
        Modifier::Ctrl => 1 << 18,
        Modifier::Option => 1 << 19,
        Modifier::Command => 1 << 20,
    }
}

fn char_code(c: char) -> Option<u16> {
    Some(match c {
        'a' => 0x00,
        's' => 0x01,
        'd' => 0x02,
        'f' => 0x03,
        'h' => 0x04,
        'g' => 0x05,
        'z' => 0x06,
        'x' => 0x07,
        'c' => 0x08,
        'v' => 0x09,
        'b' => 0x0B,
        'q' => 0x0C,
        'w' => 0x0D,
        'e' => 0x0E,
        'r' => 0x0F,
        'y' => 0x10,
        't' => 0x11,
        '1' => 0x12,
        '2' => 0x13,
        '3' => 0x14,
        '4' => 0x15,
        '6' => 0x16,
        '5' => 0x17,
        '9' => 0x19,
        '7' => 0x1A,
        '8' => 0x1C,
        '0' => 0x1D,
        'o' => 0x1F,
        'u' => 0x20,
        'i' => 0x22,
        'p' => 0x23,
        'l' => 0x25,
        'j' => 0x26,
        'k' => 0x28,
        'n' => 0x2D,
        'm' => 0x2E,
        _ => return None,
    })
}

fn function_code(n: u8) -> Option<u16> {
    Some(match n {
        1 => 0x7A,
        2 => 0x78,
        3 => 0x63,
        4 => 0x76,
        5 => 0x60,
        6 => 0x61,
        7 => 0x62,
        8 => 0x64,
        9 => 0x65,
        10 => 0x6D,
        11 => 0x67,
        12 => 0x6F,
        13 => 0x69,
        14 => 0x6B,
        15 => 0x71,
        16 => 0x6A,
        17 => 0x40,
        18 => 0x4F,
        19 => 0x50,
        20 => 0x5A,
        _ => return None,
    })
}

/// The virtual key code of a key, or the reason it cannot be sent on a Mac.
pub fn key_code(k: Key) -> Result<u16, String> {
    Ok(match k {
        Key::Char(c) => char_code(c).ok_or_else(|| format!("Unknown key \"{c}\"."))?,
        Key::F(n) => function_code(n).ok_or_else(|| format!("F{n} is not available on a Mac."))?,
        Key::Return => 0x24,
        Key::Tab => 0x30,
        Key::Escape => 0x35,
        Key::Space => 0x31,
        Key::Backspace => 0x33,
        Key::ForwardDelete => 0x75,
        // A Mac keyboard has no Insert; the key in its place is Help.
        Key::Insert => 0x72,
        Key::Home => 0x73,
        Key::End => 0x77,
        Key::PageUp => 0x74,
        Key::PageDown => 0x79,
        Key::Left => 0x7B,
        Key::Right => 0x7C,
        Key::Down => 0x7D,
        Key::Up => 0x7E,
        Key::Minus => 0x1B,
        Key::Equal => 0x18,
        Key::Comma => 0x2B,
        Key::Period => 0x2F,
        Key::Slash => 0x2C,
        Key::Backslash => 0x2A,
        Key::Semicolon => 0x29,
        Key::Apostrophe => 0x27,
        Key::Grave => 0x32,
        Key::BracketLeft => 0x21,
        Key::BracketRight => 0x1E,
        Key::CapsLock => 0x39,
    })
}

/// One chord as key codes: the modifiers' codes, the keys' codes and the flags the key events carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub modifiers: Vec<u16>,
    pub keys: Vec<u16>,
    pub flags: u64,
}

pub fn chords(combos: &[KeyCombo]) -> Result<Vec<Chord>, String> {
    combos
        .iter()
        .map(|c| {
            Ok(Chord {
                modifiers: c.modifiers.iter().map(|m| modifier_code(*m)).collect(),
                keys: c.keys.iter().map(|k| key_code(*k)).collect::<Result<_, _>>()?,
                flags: c.modifiers.iter().fold(0, |f, m| f | modifier_flag(*m)),
            })
        })
        .collect()
}

/// One step of typing a text: a key (Return, Tab) or a piece of text sent as Unicode (one character, which may be a
/// surrogate pair).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeStep {
    Key(u16),
    Text(Vec<u16>),
}

/// `\n` is Return, `\t` is Tab, `\r` is skipped, everything else goes as its UTF-16 units, one character per event.
pub fn type_steps(text: &str) -> Vec<TypeStep> {
    let mut out = Vec::new();
    for c in text.chars() {
        match c {
            '\r' => {}
            '\n' => out.push(TypeStep::Key(0x24)),
            '\t' => out.push(TypeStep::Key(0x30)),
            c => {
                let mut buf = [0u16; 2];
                out.push(TypeStep::Text(c.encode_utf16(&mut buf).to_vec()));
            }
        }
    }
    out
}

/// The scroll wheel's lines for a direction: (vertical, horizontal). Up and left are positive.
pub fn scroll_wheels(direction: &str, amount: i64) -> Result<(i32, i32), String> {
    let n = amount.clamp(1, 50) as i32;
    match direction {
        "" | "down" => Ok((-n, 0)),
        "up" => Ok((n, 0)),
        "left" => Ok((0, n)),
        "right" => Ok((0, -n)),
        _ => Err("direction must be up, down, left or right".into()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

pub fn button(name: &str) -> Result<Button, String> {
    match name {
        "" | "left" => Ok(Button::Left),
        "right" => Ok(Button::Right),
        "middle" => Ok(Button::Middle),
        _ => Err("button must be left, right or middle".into()),
    }
}

/// One display as a screenshot shows it: its bounds in global points (what events use) and the picture's size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct View {
    pub bounds: Rect,
    pub image_w: i64,
    pub image_h: i64,
}

impl View {
    /// The view of a display whose pixels are `pixels` (w, h): the picture is those pixels fitted inside 1280x800.
    pub fn of(bounds: Rect, pixels: (i64, i64)) -> View {
        let (w, h) = geometry::fit(pixels.0, pixels.1);
        View { bounds, image_w: w, image_h: h }
    }

    /// A screenshot pixel as a global point, after the check that it is inside the picture.
    pub fn point(&self, x: i64, y: i64) -> Result<(f64, f64), String> {
        geometry::check_point(x, y, self.image_w, self.image_h)?;
        let px = geometry::to_physical(x, self.image_w, self.bounds.width());
        let py = geometry::to_physical(y, self.image_h, self.bounds.height());
        Ok(((self.bounds.left + px) as f64, (self.bounds.top + py) as f64))
    }

    /// A zoom region in screenshot pixels as a rectangle in the display's own points (x, y, w, h).
    pub fn region(&self, x1: i64, y1: i64, x2: i64, y2: i64) -> Result<(i64, i64, i64, i64), String> {
        let (l, r) = (x1.min(x2), x1.max(x2));
        let (t, b) = (y1.min(y2), y1.max(y2));
        let ex = |v| geometry::edge_to_physical(v, self.image_w, self.bounds.width());
        let ey = |v| geometry::edge_to_physical(v, self.image_h, self.bounds.height());
        let (pl, pr, pt, pb) = (ex(l), ex(r), ey(t), ey(b));
        if pr - pl < 1 || pb - pt < 1 {
            return Err("the zoom region is empty".into());
        }
        Ok((pl, pt, pr - pl, pb - pt))
    }
}

/// Whether a global point is inside one of the app's own windows (global points, top-left origin).
pub fn in_own_window(own: &[Rect], x: f64, y: f64) -> bool {
    own.iter().any(|r| x >= r.left as f64 && x < r.right as f64 && y >= r.top as f64 && y < r.bottom as f64)
}

/// The person's input pauses the app's: milliseconds since their last input, or -1 when the last input was the app's
/// own. `last_event_ms` is how long ago the system saw any input; `own_ms` how long ago the app sent its last event.
pub fn customer_ago_ms(last_event_ms: i64, own_ms: Option<i64>) -> i64 {
    const SLACK_MS: i64 = 50;
    match own_ms {
        // The system's last input is no newer than the app's own (with a little slack): it was the app's.
        Some(own) if last_event_ms + SLACK_MS >= own => -1,
        _ => last_event_ms.max(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use support_core::keys;

    #[test]
    fn key_names_become_mac_key_codes() {
        let c = chords(&keys::parse("cmd+s").unwrap()).unwrap();
        assert_eq!(c, vec![Chord { modifiers: vec![0x37], keys: vec![0x01], flags: 1 << 20 }]);
        let c = chords(&keys::parse("ctrl+shift+Tab Return F5 alt+Left Delete BackSpace").unwrap()).unwrap();
        assert_eq!(c[0], Chord { modifiers: vec![0x3B, 0x38], keys: vec![0x30], flags: (1 << 18) | (1 << 17) });
        assert_eq!(c[1].keys, vec![0x24]);
        assert_eq!(c[2].keys, vec![0x60]);
        assert_eq!((c[3].modifiers.clone(), c[3].keys.clone()), (vec![0x3A], vec![0x7B]));
        assert_eq!(c[4].keys, vec![0x75], "xdotool's Delete is the forward delete");
        assert_eq!(c[5].keys, vec![0x33]);
        assert_eq!(chords(&keys::parse("cmd+space").unwrap()).unwrap()[0].keys, vec![0x31]);
        assert!(chords(&keys::parse("F21").unwrap()).unwrap_err().contains("not available on a Mac"));
        // Every letter and digit has a code.
        for c in ('a'..='z').chain('0'..='9') {
            assert!(key_code(Key::Char(c)).is_ok(), "{c}");
        }
        for n in 1..=20 {
            assert!(key_code(Key::F(n)).is_ok(), "F{n}");
        }
    }

    #[test]
    fn typing_turns_newlines_and_tabs_into_keys_and_skips_returns() {
        assert_eq!(
            type_steps("a\r\nb\tç😀"),
            vec![
                TypeStep::Text(vec![0x61]),
                TypeStep::Key(0x24),
                TypeStep::Text(vec![0x62]),
                TypeStep::Key(0x30),
                TypeStep::Text(vec![0xE7]),
                TypeStep::Text(vec![0xD83D, 0xDE00]),
            ]
        );
        assert!(type_steps("\r").is_empty());
    }

    #[test]
    fn scroll_and_buttons_take_only_the_known_names() {
        assert_eq!(scroll_wheels("down", 3), Ok((-3, 0)));
        assert_eq!(scroll_wheels("up", 99), Ok((50, 0)));
        assert_eq!(scroll_wheels("left", 0), Ok((0, 1)));
        assert_eq!(scroll_wheels("right", 2), Ok((0, -2)));
        assert!(scroll_wheels("sideways", 1).is_err());
        assert_eq!(button("right"), Ok(Button::Right));
        assert!(button("back").is_err());
    }

    #[test]
    fn a_screenshot_pixel_lands_on_the_display_in_global_points() {
        // A Retina display: 1512x982 points, 3024x1964 pixels, the picture 1232x800.
        let main = View::of(Rect { left: 0, top: 0, right: 1512, bottom: 982 }, (3024, 1964));
        assert_eq!((main.image_w, main.image_h), (1232, 800));
        assert_eq!(main.point(0, 0).unwrap(), (0.0, 0.0));
        assert_eq!(main.point(1231, 799).unwrap(), (1511.0, 981.0));
        assert_eq!(main.point(616, 400).unwrap(), (756.0, 491.0));
        assert_eq!(main.point(1232, 0).unwrap_err(), "coordinate 1232,0 is outside the 1232x800 screenshot");
        // A second display to the left of the main one: negative global x.
        let left = View::of(Rect { left: -1920, top: 0, right: 0, bottom: 1080 }, (1920, 1080));
        assert_eq!((left.image_w, left.image_h), (1280, 720));
        assert_eq!(left.point(0, 0).unwrap(), (-1920.0, 0.0));
        let (x, _) = left.point(1279, 0).unwrap();
        assert_eq!(x, -1.0);
        // A zoom region, in the display's own points.
        assert_eq!(main.region(616, 400, 0, 0).unwrap(), (0, 0, 756, 491));
        assert!(main.region(5, 5, 5, 9).is_err());
    }

    #[test]
    fn the_apps_own_windows_and_the_customer_pause() {
        let own = [Rect { left: 1200, top: 900, right: 1500, bottom: 980 }];
        assert!(in_own_window(&own, 1300.0, 950.0));
        assert!(!in_own_window(&own, 1199.0, 950.0));
        assert!(!in_own_window(&own, 1500.0, 950.0));
        // The person typed 500 ms ago, the app sent its last event 2 s ago: the person's.
        assert_eq!(customer_ago_ms(500, Some(2_000)), 500);
        // The system's last input is the app's own event.
        assert_eq!(customer_ago_ms(2_000, Some(2_000)), -1);
        assert_eq!(customer_ago_ms(2_030, Some(2_000)), -1);
        assert_eq!(customer_ago_ms(700, None), 700);
    }
}
