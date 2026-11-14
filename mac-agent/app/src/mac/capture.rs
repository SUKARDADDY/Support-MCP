//! Screenshots through ScreenCaptureKit (SCScreenshotManager, macOS 14), scaled by ScreenCaptureKit itself to the
//! picture size and encoded as JPEG by ImageIO, quality 80 down to 10 until it fits.
//!
//! Without the Screen Recording permission there is no picture: the answer is the Mac's own error, never a black
//! image (research file, section 2.5).

use crate::input_plan::View;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_core_foundation::{CFDictionary, CFMutableData, CFNumber, CFRetained, CFString, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGDisplayBounds, CGDisplayCopyDisplayMode, CGDisplayMode, CGError, CGGetActiveDisplayList, CGImage, CGMainDisplayID,
    CGPreflightScreenCaptureAccess,
};
use objc2_foundation::{NSArray, NSError};
use objc2_image_io::{kCGImageDestinationLossyCompressionQuality, CGImageDestination};
use objc2_screen_capture_kit::{SCContentFilter, SCDisplay, SCScreenshotManager, SCShareableContent, SCStreamConfiguration};
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;
use support_core::geometry::{self, Rect};

const WAIT: Duration = Duration::from_secs(10);

/// Moves a framework object to the thread that waits for it. The objects are immutable once made.
struct Sent<T>(T);
// SAFETY: SCShareableContent, SCDisplay and CGImage are immutable results that the frameworks hand between queues.
unsafe impl<T> Send for Sent<T> {}

pub fn permission_error() -> String {
    crate::service::permission_text(false, true).unwrap_or_default()
}

fn ns_error_text(e: *mut NSError) -> String {
    if e.is_null() {
        return "unknown error".into();
    }
    // SAFETY: a live NSError from the framework, retained for the call.
    unsafe { Retained::retain(e) }.map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "unknown error".into())
}

/// One display, in the order the relay numbers them: its id, the picture's view of it, and its size in pixels.
pub struct Display {
    pub id: u32,
    pub view: View,
    pub pixels: (i64, i64),
}

/// The displays from CoreGraphics alone (no permission needed): the main one first, then by x and y, at most 16.
pub fn displays() -> Vec<Display> {
    let mut ids = [0u32; 32];
    let mut count = 0u32;
    // SAFETY: the buffer holds 32 ids, as we say.
    let err = unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
    if err != CGError::Success {
        return Vec::new();
    }
    let main = CGMainDisplayID();
    let mut all = Vec::new();
    for &id in &ids[..(count as usize).min(ids.len())] {
        let b = CGDisplayBounds(id);
        let bounds = Rect {
            left: b.origin.x.round() as i64,
            top: b.origin.y.round() as i64,
            right: (b.origin.x + b.size.width).round() as i64,
            bottom: (b.origin.y + b.size.height).round() as i64,
        };
        let mode = CGDisplayCopyDisplayMode(id);
        let pixels = match mode.as_deref() {
            Some(m) => (CGDisplayMode::pixel_width(Some(m)) as i64, CGDisplayMode::pixel_height(Some(m)) as i64),
            None => (bounds.width(), bounds.height()),
        };
        all.push(Display { id, view: View::of(bounds, pixels), pixels });
    }
    let rects: Vec<Rect> = all.iter().map(|d| d.view.bounds).collect();
    let main_index = all.iter().position(|d| d.id == main).unwrap_or(0);
    let order = geometry::order_displays(&rects, main_index);
    let mut slots: Vec<Option<Display>> = all.into_iter().map(Some).collect();
    order.into_iter().filter_map(|i| slots[i].take()).collect()
}

fn shareable() -> Result<Retained<SCShareableContent>, String> {
    let (tx, rx) = mpsc::channel::<Sent<Result<Retained<SCShareableContent>, String>>>();
    let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        // SAFETY: the framework passes a live object or null.
        let r = unsafe { Retained::retain(content) }.ok_or_else(|| ns_error_text(error));
        let _ = tx.send(Sent(r));
    });
    // SAFETY: the block lives until the call returns, and the framework copies it.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&block) };
    rx.recv_timeout(WAIT).map_err(|_| "the screen list did not come".to_string())?.0
}

fn sc_display(id: u32) -> Result<Retained<SCDisplay>, String> {
    let content =
        shareable()
            .map_err(|e| if CGPreflightScreenCaptureAccess() { format!("the screens could not be listed: {e}") } else { permission_error() })?;
    // SAFETY: a live object.
    let list = unsafe { content.displays() };
    list.iter().find(|d| unsafe { d.displayID() } == id).ok_or_else(|| "the display went away".to_string())
}

/// The display's picture, or a part of it (`source`, in the display's own points), at `size` pixels.
pub fn capture(id: u32, source: Option<(i64, i64, i64, i64)>, size: (i64, i64)) -> Result<CFRetained<CGImage>, String> {
    if !CGPreflightScreenCaptureAccess() {
        return Err(permission_error());
    }
    let display = sc_display(id)?;
    // SAFETY: framework constructors with live arguments.
    let filter = unsafe { SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &NSArray::new()) };
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(size.0.max(1) as usize);
        config.setHeight(size.1.max(1) as usize);
        config.setShowsCursor(true);
        if let Some((x, y, w, h)) = source {
            config.setSourceRect(CGRect::new(CGPoint::new(x as f64, y as f64), CGSize::new(w as f64, h as f64)));
        }
    }
    let (tx, rx) = mpsc::channel::<Sent<Result<CFRetained<CGImage>, String>>>();
    let block = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        let r = match NonNull::new(image) {
            // SAFETY: the image is valid for the handler's duration; retaining keeps it.
            Some(i) => Ok(unsafe { CFRetained::retain(i) }),
            None => Err(ns_error_text(error)),
        };
        let _ = tx.send(Sent(r));
    });
    // SAFETY: live arguments; the framework copies the block.
    unsafe { SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &config, Some(&block)) };
    let r = rx.recv_timeout(WAIT).map_err(|_| "the screenshot did not come".to_string())?.0;
    r.map_err(|e| if CGPreflightScreenCaptureAccess() { format!("the screen could not be captured: {e}") } else { permission_error() })
}

/// One JPEG of the image at `quality` (10 to 80).
fn jpeg(image: &CGImage, quality: u8) -> Result<Vec<u8>, String> {
    let data = CFMutableData::new(None, 0).ok_or("no memory for the picture")?;
    let kind = CFString::from_static_str("public.jpeg");
    // SAFETY: live arguments; no options.
    let dest = unsafe { CGImageDestination::with_data(&data, &kind, 1, None) }.ok_or("JPEG is not available")?;
    let q = CFNumber::new_f64(quality as f64 / 100.0);
    // SAFETY: a framework constant.
    let key: &CFString = unsafe { kCGImageDestinationLossyCompressionQuality };
    let props = CFDictionary::<CFString, CFNumber>::from_slices(&[key], &[&q]);
    // SAFETY: a live destination and image; the dictionary holds what ImageIO expects.
    unsafe {
        dest.add_image(image, Some(props.as_opaque()));
        if !dest.finalize() {
            return Err("the picture could not be encoded".into());
        }
    }
    Ok(data.to_vec())
}

/// The smallest step down in quality that fits the relay's limit.
pub fn encode(image: &CGImage) -> Result<Vec<u8>, String> {
    geometry::fit_jpeg(|q| jpeg(image, q), support_core::wire::IMAGE_B64_MAX).map(|(b, _)| b)
}
