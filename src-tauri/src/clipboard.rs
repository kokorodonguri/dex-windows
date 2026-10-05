//! Bidirectional clipboard sync.
//!
//! * device → PC: device message CLIPBOARD (sent by the server because of
//!   `clipboard_autosync=true`) is written with arboard.
//! * PC → device: a clipboard-master listener (AddClipboardFormatListener)
//!   sends SET_CLIPBOARD(paste=false).
//!
//! The last text exchanged in either direction is remembered and never sent
//! back, which breaks the echo loop (writing the PC clipboard triggers the
//! listener; the server already suppresses its own echo).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use clipboard_master::{CallbackResult, ClipboardHandler, Master};

use crate::control;
use crate::ws::StreamHub;

pub struct ClipboardSync {
    hub: Arc<StreamHub>,
    enabled: AtomicBool,
    last_text: Mutex<Option<String>>,
    sequence: AtomicU64,
}

impl ClipboardSync {
    pub fn new(hub: Arc<StreamHub>) -> Arc<Self> {
        Arc::new(Self {
            hub,
            enabled: AtomicBool::new(false),
            last_text: Mutex::new(None),
            sequence: AtomicU64::new(1),
        })
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            *self.last_text.lock().unwrap() = None;
        }
    }

    /// Returns true if `text` differs from the last synced text (and records it).
    fn remember(&self, text: &str) -> bool {
        let mut last = self.last_text.lock().unwrap();
        if last.as_deref() == Some(text) {
            return false;
        }
        *last = Some(text.to_string());
        true
    }

    pub fn on_device_clipboard(&self, text: String) {
        if !self.enabled.load(Ordering::SeqCst) || !self.remember(&text) {
            return;
        }
        std::thread::spawn(move || {
            for attempt in 0..5 {
                match arboard::Clipboard::new().and_then(|mut c| c.set_text(text.clone())) {
                    Ok(()) => {
                        log::info!("device → PC clipboard ({} chars)", text.chars().count());
                        return;
                    }
                    Err(e) if attempt == 4 => log::warn!("could not write the PC clipboard: {e}"),
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        });
    }

    fn read_pc_clipboard() -> Option<String> {
        for _ in 0..5 {
            match arboard::Clipboard::new().and_then(|mut c| c.get_text()) {
                Ok(text) => return Some(text),
                Err(arboard::Error::ContentNotAvailable) => return None,
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        None
    }

    fn push_to_device(&self, text: String) {
        let Some(tx) = self.hub.control_sender() else {
            return;
        };
        let seq = self.sequence.fetch_add(1, Ordering::Relaxed);
        let len = text.chars().count();
        if tx
            .blocking_send(control::set_clipboard(seq, &text, false))
            .is_ok()
        {
            log::info!("PC → device clipboard ({len} chars)");
        }
    }

    /// Called when a session starts: the current PC clipboard becomes the
    /// device clipboard, so Ctrl+V in DeX pastes what was copied on the PC.
    pub fn sync_initial(self: &Arc<Self>) {
        let this = self.clone();
        std::thread::spawn(move || {
            if !this.enabled.load(Ordering::SeqCst) {
                return;
            }
            if let Some(text) = Self::read_pc_clipboard() {
                if !text.is_empty() && this.remember(&text) {
                    this.push_to_device(text);
                }
            }
        });
    }

    /// Starts the PC clipboard listener thread (lives for the whole app).
    pub fn start_listener(self: &Arc<Self>) {
        struct Handler(Arc<ClipboardSync>);
        impl ClipboardHandler for Handler {
            fn on_clipboard_change(&mut self) -> CallbackResult {
                let sync = &self.0;
                if sync.enabled.load(Ordering::SeqCst) {
                    if let Some(text) = ClipboardSync::read_pc_clipboard() {
                        if !text.is_empty() && sync.remember(&text) {
                            sync.push_to_device(text);
                        }
                    }
                }
                CallbackResult::Next
            }

            fn on_clipboard_error(&mut self, error: std::io::Error) -> CallbackResult {
                log::warn!("clipboard listener error: {error}");
                CallbackResult::Next
            }
        }

        let this = self.clone();
        std::thread::Builder::new()
            .name("clipboard-listener".into())
            .spawn(move || match Master::new(Handler(this)) {
                Ok(mut master) => {
                    if let Err(e) = master.run() {
                        log::error!("clipboard listener stopped: {e}");
                    }
                }
                Err(e) => log::error!("could not start the clipboard listener: {e}"),
            })
            .expect("spawn clipboard thread");
    }
}

/// Committed IME text (Japanese, emoji…) goes through the device clipboard,
/// because INJECT_TEXT can only type characters present in the device's key
/// character map. The clipboard is set with paste=false and the frontend then
/// injects Ctrl+V: KEYCODE_PASTE (paste=true) is ignored by some One UI text
/// fields, while Ctrl+V works everywhere. The frontend types plain ASCII with
/// INJECT_TEXT itself.
pub fn ime_clipboard_message(text: &str) -> Option<Vec<u8>> {
    (!text.is_empty()).then(|| control::set_clipboard(0, text, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remember_breaks_loops() {
        let sync = ClipboardSync::new(Arc::new(StreamHub::default()));
        assert!(sync.remember("a"));
        assert!(!sync.remember("a"));
        assert!(sync.remember("b"));
        assert!(sync.remember("a"));
    }

    #[test]
    fn ime_text_goes_through_the_clipboard() {
        let msg = ime_clipboard_message("日本語").unwrap();
        assert_eq!(msg[0], control::TYPE_SET_CLIPBOARD);
        assert_eq!(&msg[1..9], &[0; 8]); // no ack requested
        assert_eq!(msg[9], 0); // no KEYCODE_PASTE: the frontend sends Ctrl+V
        assert_eq!(&msg[14..], "日本語".as_bytes());
        assert!(ime_clipboard_message("").is_none());
    }
}
