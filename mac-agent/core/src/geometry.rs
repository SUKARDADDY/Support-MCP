//! Fitting a screenshot to 1280x800 and mapping its coordinates back to the screen. The same maths as
//! `ScreenMath` and `JpegFit` in src/agent-app.cs, so a coordinate means the same pixel on both clients.

pub const MAX_W: i64 = 1280;
pub const MAX_H: i64 = 800;
/// The relay accepts display numbers 0 to 15, so a result may report at most 16 displays.
pub const MAX_DISPLAYS: usize = 16;

/// The size a w x h screen is scaled to: fitted inside 1280x800, never scaled up, at least 1x1. The Windows client
/// rounds half to even (Math.Round), and so does this.
pub fn fit(w: i64, h: i64) -> (i64, i64) {
    let (wf, hf) = (w.max(1) as f64, h.max(1) as f64);
    let s = (MAX_W as f64 / wf).min(MAX_H as f64 / hf).min(1.0);
    (((wf * s).round_ties_even() as i64).max(1), ((hf * s).round_ties_even() as i64).max(1))
}

/// A screenshot pixel to the physical pixel at its centre.
pub fn to_physical(v: i64, image_len: i64, phys_len: i64) -> i64 {
    let p = ((v as f64 + 0.5) * phys_len as f64 / image_len as f64) as i64;
    p.clamp(0, (phys_len - 1).max(0))
}

/// A region edge in screenshot pixels to the nearest physical edge (zoom).
pub fn edge_to_physical(v: i64, image_len: i64, phys_len: i64) -> i64 {
    let p = (v as f64 * phys_len as f64 / image_len as f64).round_ties_even() as i64;
    p.clamp(0, phys_len.max(0))
}

/// A physical pixel back to a screenshot pixel.
pub fn to_image(phys: i64, image_len: i64, phys_len: i64) -> i64 {
    let p = ((phys as f64 + 0.5) * image_len as f64 / phys_len as f64) as i64;
    p.clamp(0, (image_len - 1).max(0))
}

/// The refusal for a point outside the screenshot the caller saw.
pub fn check_point(x: i64, y: i64, width: i64, height: i64) -> Result<(), String> {
    if x < 0 || y < 0 || x >= width || y >= height {
        return Err(format!("coordinate {x},{y} is outside the {width}x{height} screenshot"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i64,
    pub top: i64,
    pub right: i64,
    pub bottom: i64,
}

impl Rect {
    pub fn width(&self) -> i64 {
        self.right - self.left
    }
    pub fn height(&self) -> i64 {
        self.bottom - self.top
    }
}

/// The display numbers the relay sees: the main display is 0, the others follow by x and then y, at most 16. Returns
/// indexes into `rects`.
pub fn order_displays(rects: &[Rect], main: usize) -> Vec<usize> {
    let mut rest: Vec<usize> = (0..rects.len()).filter(|i| *i != main).collect();
    rest.sort_by_key(|i| (rects[*i].left, rects[*i].top));
    let mut order = Vec::with_capacity(rects.len());
    if main < rects.len() {
        order.push(main);
    }
    order.extend(rest);
    order.truncate(MAX_DISPLAYS);
    order
}

/// The display that holds a point, or the nearest one when it is on none of them. None for an empty list.
pub fn monitor_at(rects: &[Rect], x: i64, y: i64) -> Option<usize> {
    let mut best: Option<(usize, i64)> = None;
    for (i, r) in rects.iter().enumerate() {
        let dx = if x < r.left {
            r.left - x
        } else if x >= r.right {
            x - r.right + 1
        } else {
            0
        };
        let dy = if y < r.top {
            r.top - y
        } else if y >= r.bottom {
            y - r.bottom + 1
        } else {
            0
        };
        let d = dx * dx + dy * dy;
        if best.is_none_or(|(_, b)| d < b) {
            best = Some((i, d));
        }
    }
    best.map(|(i, _)| i)
}

/// The base64 length of `len` bytes.
pub fn b64_len(len: usize) -> usize {
    len.div_ceil(3) * 4
}

/// Steps the JPEG quality from 80 down to 10 (in tens) until the base64 text is under `max_chars`. `encode(quality)`
/// makes the JPEG. Returns the bytes and the quality used.
pub fn fit_jpeg(mut encode: impl FnMut(u8) -> Result<Vec<u8>, String>, max_chars: usize) -> Result<(Vec<u8>, u8), String> {
    let mut quality = 80u8;
    loop {
        let bytes = encode(quality)?;
        if b64_len(bytes.len()) < max_chars {
            return Ok((bytes, quality));
        }
        if quality <= 10 {
            return Err("the screenshot is too large to send".to_string());
        }
        quality -= 10;
    }
}

/// The settle before a screenshot after an input, and how the capture is retried (docs: the Windows client's numbers).
pub const SETTLE_MS: u64 = 300;
pub const CAPTURE_RETRY_MS: u64 = 250;
pub const CAPTURE_RETRY_FOR_MS: u64 = 2_000;
/// Input timing: gaps the platform keeps between synthetic events.
pub const CLICK_GAP_MS: u64 = 40;
pub const DRAG_STEPS: u32 = 10;
pub const DRAG_STEP_MS: u64 = 20;
pub const TYPE_CHAR_MS: u64 = 20;
pub const KEY_HOLD_MS: u64 = 30;
pub const KEY_GAP_MS: u64 = 20;
/// The customer's own input pauses ours this long.
pub const CUSTOMER_PAUSE_MS: u64 = 3_000;
pub const PAUSE_TEXT: &str = "customer is using the PC; try again in a few seconds";
pub const OWN_WINDOW_TEXT: &str = "that spot is the support window; use another spot";
pub const OWN_FOCUS_TEXT: &str = "the support window has the keyboard focus; click another window first";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_screen_is_fitted_inside_1280_by_800_and_never_scaled_up() {
        assert_eq!(fit(2560, 1600), (1280, 800));
        assert_eq!(fit(3024, 1964), (1232, 800));
        assert_eq!(fit(1280, 800), (1280, 800));
        assert_eq!(fit(800, 600), (800, 600));
        assert_eq!(fit(1, 1), (1, 1));
        assert_eq!(fit(5000, 10), (1280, 3));
    }

    #[test]
    fn a_screenshot_pixel_maps_to_the_centre_of_a_physical_pixel() {
        // 2560 wide physical, 1280 wide screenshot: pixel 0 covers physical 0..2, centre 1.
        assert_eq!(to_physical(0, 1280, 2560), 1);
        assert_eq!(to_physical(1279, 1280, 2560), 2559);
        assert_eq!(to_physical(10, 1280, 2560), 21);
        // Clamped into the screen.
        assert_eq!(to_physical(5000, 1280, 2560), 2559);
        assert_eq!(to_physical(-4, 1280, 2560), 0);
        // Same size: the pixel itself.
        assert_eq!(to_physical(7, 800, 800), 7);
    }

    #[test]
    fn zoom_edges_round_to_the_nearest_physical_edge() {
        assert_eq!(edge_to_physical(0, 1280, 2560), 0);
        assert_eq!(edge_to_physical(1280, 1280, 2560), 2560);
        assert_eq!(edge_to_physical(3, 1232, 3024), 7);
        assert_eq!(edge_to_physical(99999, 1280, 2560), 2560);
    }

    #[test]
    fn a_physical_pixel_maps_back_into_the_screenshot() {
        assert_eq!(to_image(0, 1280, 2560), 0);
        assert_eq!(to_image(2559, 1280, 2560), 1279);
    }

    #[test]
    fn a_point_outside_the_screenshot_is_refused_with_the_windows_text() {
        assert!(check_point(0, 0, 1280, 800).is_ok());
        assert!(check_point(1279, 799, 1280, 800).is_ok());
        assert_eq!(check_point(1280, 5, 1280, 800).unwrap_err(), "coordinate 1280,5 is outside the 1280x800 screenshot");
        assert!(check_point(-1, 5, 1280, 800).is_err());
    }

    #[test]
    fn displays_go_main_first_then_by_x_then_y_and_stop_at_16() {
        let r = |l, t| Rect { left: l, top: t, right: l + 100, bottom: t + 100 };
        let rects = [r(1920, 0), r(0, 0), r(-1920, 0), r(0, 1080)];
        assert_eq!(order_displays(&rects, 1), vec![1, 2, 3, 0]);
        let many: Vec<Rect> = (0..20).map(|i| r(i * 10, 0)).collect();
        assert_eq!(order_displays(&many, 0).len(), 16);
        assert_eq!(monitor_at(&rects, 50, 50), Some(1));
        assert_eq!(monitor_at(&rects, 2100, 50), Some(0));
        assert_eq!(monitor_at(&[], 0, 0), None);
    }

    #[test]
    fn the_jpeg_quality_steps_down_until_the_base64_fits() {
        // 30,000 bytes at quality 80, 3 times smaller for every ten steps down.
        let mut tried = vec![];
        let out = fit_jpeg(
            |q| {
                tried.push(q);
                Ok(vec![0u8; 600_000 / (1 << ((80 - q) / 10))])
            },
            700_000,
        );
        let (bytes, q) = out.unwrap();
        assert_eq!(tried, vec![80, 70]);
        assert_eq!((q, bytes.len()), (70, 300_000));
        // Never fits: gives up after quality 10.
        let mut count = 0;
        assert!(fit_jpeg(
            |_| {
                count += 1;
                Ok(vec![0u8; 900_000])
            },
            700_000
        )
        .is_err());
        assert_eq!(count, 8);
        // The limit is strict, as in the Windows client.
        assert!(fit_jpeg(|_| Ok(vec![0u8; 525_000]), 700_000).is_err());
        assert!(fit_jpeg(|_| Ok(vec![0u8; 524_997]), 700_000).is_ok());
    }
}
