//! xdotool-style key names ("ctrl+s", "alt+tab", "Return", "F5", "ctrl+a Delete") parsed into an abstract key enum.
//! The macOS app turns the enum into key codes. This is the Windows client's `KeySpec` (src/agent-app.cs) with Mac
//! modifier names: super, win, meta, cmd and command are Command, and alt and option are Option.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Modifier {
    Ctrl,
    Option,
    Shift,
    Command,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    /// A letter (lower case) or a digit.
    Char(char),
    /// F1 to F24. (macOS keyboards go to F20; the platform decides what it can send.)
    F(u8),
    Return,
    Tab,
    Escape,
    Space,
    Backspace,
    /// The forward delete key. xdotool's `Delete` is this one; a Mac's "delete" key is `BackSpace`.
    ForwardDelete,
    Insert,
    Home,
    End,
    PageUp,
    PageDown,
    Up,
    Down,
    Left,
    Right,
    Minus,
    Equal,
    Comma,
    Period,
    Slash,
    Backslash,
    Semicolon,
    Apostrophe,
    Grave,
    BracketLeft,
    BracketRight,
    CapsLock,
}

/// One chord: the modifiers held, then the keys pressed in order. Modifiers are listed first as they were given, with
/// repeats dropped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyCombo {
    pub modifiers: Vec<Modifier>,
    pub keys: Vec<Key>,
}

pub const CTRL_ALT_DEL: &str = "Ctrl+Alt+Del is not available on a Mac.";

fn modifier(name: &str) -> Option<Modifier> {
    Some(match name {
        "ctrl" | "control" => Modifier::Ctrl,
        "alt" | "option" | "opt" => Modifier::Option,
        "shift" => Modifier::Shift,
        "super" | "win" | "meta" | "cmd" | "command" => Modifier::Command,
        _ => return None,
    })
}

fn named(name: &str) -> Option<Key> {
    Some(match name {
        "return" | "enter" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::ForwardDelete,
        "insert" => Key::Insert,
        "home" => Key::Home,
        "end" => Key::End,
        "page_up" | "prior" | "pageup" => Key::PageUp,
        "page_down" | "next" | "pagedown" => Key::PageDown,
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        "minus" => Key::Minus,
        "equal" => Key::Equal,
        "comma" => Key::Comma,
        "period" => Key::Period,
        "slash" => Key::Slash,
        "backslash" => Key::Backslash,
        "semicolon" => Key::Semicolon,
        "apostrophe" => Key::Apostrophe,
        "grave" => Key::Grave,
        "bracketleft" => Key::BracketLeft,
        "bracketright" => Key::BracketRight,
        "capslock" => Key::CapsLock,
        _ => return None,
    })
}

fn function_key(name: &str) -> Option<Key> {
    let n: u8 = name.strip_prefix('f')?.parse().ok()?;
    // "f01" is not a key name: the digits must be a plain number from 1 to 24.
    ((1..=24).contains(&n) && name.len() == 1 + n.to_string().len()).then_some(Key::F(n))
}

/// Space-separated chords, each `+`-separated names. Names are case-insensitive. Fails with the text the tool returns.
pub fn parse(keys: &str) -> Result<Vec<KeyCombo>, String> {
    let mut combos = Vec::new();
    for combo in keys.split(' ').filter(|c| !c.is_empty()) {
        let mut modifiers: Vec<Modifier> = Vec::new();
        let mut pressed: Vec<Key> = Vec::new();
        let mut delete = false;
        for raw in combo.split('+') {
            let t = raw.to_lowercase();
            if let Some(m) = modifier(&t) {
                if !modifiers.contains(&m) {
                    modifiers.push(m);
                }
                continue;
            }
            let key = named(&t).or_else(|| function_key(&t)).or_else(|| {
                let mut chars = t.chars();
                match (chars.next(), chars.next()) {
                    (Some(c), None) if c.is_ascii_lowercase() || c.is_ascii_digit() => Some(Key::Char(c)),
                    _ => None,
                }
            });
            match key {
                Some(k) => {
                    delete |= k == Key::ForwardDelete;
                    pressed.push(k);
                }
                None => return Err(format!("Unknown key \"{raw}\".")),
            }
        }
        if modifiers.contains(&Modifier::Ctrl) && modifiers.contains(&Modifier::Option) && delete {
            return Err(CTRL_ALT_DEL.to_string());
        }
        combos.push(KeyCombo { modifiers, keys: pressed });
    }
    if combos.is_empty() {
        return Err("No keys given.".to_string());
    }
    Ok(combos)
}

#[cfg(test)]
mod tests {
    use super::*;
    use Key::*;
    use Modifier::*;

    fn one(keys: &str) -> KeyCombo {
        let mut c = parse(keys).unwrap();
        assert_eq!(c.len(), 1, "{keys}");
        c.remove(0)
    }

    #[test]
    fn a_chord_has_its_modifiers_and_its_key() {
        assert_eq!(one("ctrl+s"), KeyCombo { modifiers: vec![Ctrl], keys: vec![Char('s')] });
        assert_eq!(one("cmd+shift+4"), KeyCombo { modifiers: vec![Command, Shift], keys: vec![Char('4')] });
        assert_eq!(one("Return"), KeyCombo { modifiers: vec![], keys: vec![Return] });
        assert_eq!(one("alt+Tab"), KeyCombo { modifiers: vec![Option], keys: vec![Tab] });
    }

    #[test]
    fn mac_names_for_the_modifiers_all_work() {
        for name in ["super", "win", "meta", "cmd", "command", "SUPER", "Cmd"] {
            assert_eq!(one(&format!("{name}+space")).modifiers, vec![Command], "{name}");
        }
        for name in ["alt", "option", "opt"] {
            assert_eq!(one(&format!("{name}+a")).modifiers, vec![Option], "{name}");
        }
        assert_eq!(one("control+c").modifiers, vec![Ctrl]);
    }

    #[test]
    fn modifiers_come_first_whatever_the_order_given() {
        let c = one("a+ctrl");
        assert_eq!((c.modifiers, c.keys), (vec![Ctrl], vec![Char('a')]));
        assert_eq!(one("ctrl+ctrl+a").modifiers, vec![Ctrl]);
    }

    #[test]
    fn several_chords_are_split_on_spaces() {
        let c = parse("ctrl+a  Delete  F5").unwrap();
        assert_eq!(c.len(), 3);
        assert_eq!(c[1].keys, vec![ForwardDelete]);
        assert_eq!(c[2].keys, vec![F(5)]);
    }

    #[test]
    fn function_keys_run_from_f1_to_f24() {
        assert_eq!(one("f1").keys, vec![F(1)]);
        assert_eq!(one("F24").keys, vec![F(24)]);
        for bad in ["f0", "f25", "f01", "f100"] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn named_keys_and_their_aliases() {
        for (name, key) in [
            ("enter", Return),
            ("esc", Escape),
            ("BackSpace", Backspace),
            ("del", ForwardDelete),
            ("Page_Up", PageUp),
            ("prior", PageUp),
            ("next", PageDown),
            ("minus", Minus),
            ("bracketleft", BracketLeft),
            ("capslock", CapsLock),
        ] {
            assert_eq!(one(name).keys, vec![key], "{name}");
        }
    }

    #[test]
    fn an_unknown_name_is_refused_as_typed() {
        assert_eq!(parse("ctrl+Frobnicate").unwrap_err(), "Unknown key \"Frobnicate\".");
        assert_eq!(parse("ctrl++s").unwrap_err(), "Unknown key \"\".");
        assert_eq!(parse("é").unwrap_err(), "Unknown key \"é\".");
        assert_eq!(parse("ab").unwrap_err(), "Unknown key \"ab\".");
    }

    #[test]
    fn no_keys_is_an_error() {
        assert_eq!(parse("").unwrap_err(), "No keys given.");
        assert_eq!(parse("   ").unwrap_err(), "No keys given.");
    }

    #[test]
    fn ctrl_alt_delete_is_refused_on_a_mac() {
        for k in ["ctrl+alt+Delete", "ctrl+alt+del", "alt+ctrl+DELETE", "control+option+delete"] {
            assert_eq!(parse(k).unwrap_err(), CTRL_ALT_DEL, "{k}");
        }
        // Either one alone is fine.
        assert!(parse("ctrl+Delete").is_ok());
        assert!(parse("alt+Delete").is_ok());
        // And so is Ctrl+Alt+Delete spread over two chords: they are separate presses.
        assert!(parse("ctrl+alt Delete").is_ok());
    }
}
