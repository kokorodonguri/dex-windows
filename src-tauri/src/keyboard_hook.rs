//! Low-level keyboard hook (WH_KEYBOARD_LL) that captures system shortcuts
//! Windows would otherwise consume — Win, Win+<key>, Alt+Tab, Alt+Esc,
//! Ctrl+Esc, Alt+F4 — and forwards them to the frontend (over the `/events`
//! WebSocket, as DOM `code` names) so they reach DeX instead.
//!
//! The hook is only active while the window is focused, a session is
//! streaming and the setting is on. The callback only pushes to a channel.
//! Ctrl+Alt+Del and Win+L cannot be intercepted by any user-mode hook.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde::Serialize;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HookKeyEvent {
    pub t: &'static str,
    pub code: &'static str,
    pub down: bool,
    pub repeat: bool,
}

static ACTIVE: AtomicBool = AtomicBool::new(false);
static SENDER: OnceLock<mpsc::UnboundedSender<HookKeyEvent>> = OnceLock::new();

pub fn set_active(active: bool) {
    let prev = ACTIVE.swap(active, Ordering::SeqCst);
    if prev != active {
        log::debug!(
            "keyboard hook {}",
            if active { "active" } else { "inactive" }
        );
    }
}

// Virtual-key codes (winuser.h)
const VK_BACK: u32 = 0x08;
const VK_TAB: u32 = 0x09;
const VK_RETURN: u32 = 0x0D;
const VK_PAUSE: u32 = 0x13;
const VK_CAPITAL: u32 = 0x14;
const VK_ESCAPE: u32 = 0x1B;
const VK_SPACE: u32 = 0x20;
const VK_PRIOR: u32 = 0x21;
const VK_NEXT: u32 = 0x22;
const VK_END: u32 = 0x23;
const VK_HOME: u32 = 0x24;
const VK_LEFT: u32 = 0x25;
const VK_UP: u32 = 0x26;
const VK_RIGHT: u32 = 0x27;
const VK_DOWN: u32 = 0x28;
const VK_SNAPSHOT: u32 = 0x2C;
const VK_INSERT: u32 = 0x2D;
const VK_DELETE: u32 = 0x2E;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const VK_APPS: u32 = 0x5D;
const VK_NUMPAD0: u32 = 0x60;
const VK_MULTIPLY: u32 = 0x6A;
const VK_ADD: u32 = 0x6B;
const VK_SUBTRACT: u32 = 0x6D;
const VK_DECIMAL: u32 = 0x6E;
const VK_DIVIDE: u32 = 0x6F;
const VK_F1: u32 = 0x70;
const VK_F4: u32 = 0x73;
const VK_NUMLOCK: u32 = 0x90;
const VK_SCROLL: u32 = 0x91;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;
const VK_OEM_1: u32 = 0xBA;
const VK_OEM_PLUS: u32 = 0xBB;
const VK_OEM_COMMA: u32 = 0xBC;
const VK_OEM_MINUS: u32 = 0xBD;
const VK_OEM_PERIOD: u32 = 0xBE;
const VK_OEM_2: u32 = 0xBF;
const VK_OEM_3: u32 = 0xC0;
const VK_OEM_4: u32 = 0xDB;
const VK_OEM_5: u32 = 0xDC;
const VK_OEM_6: u32 = 0xDD;
const VK_OEM_7: u32 = 0xDE;
const VK_OEM_102: u32 = 0xE2;

const LETTERS: [&str; 26] = [
    "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK", "KeyL",
    "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV", "KeyW", "KeyX",
    "KeyY", "KeyZ",
];
const DIGITS: [&str; 10] = [
    "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8",
    "Digit9",
];
const NUMPAD: [&str; 10] = [
    "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4", "Numpad5", "Numpad6", "Numpad7",
    "Numpad8", "Numpad9",
];
const FKEYS: [&str; 12] = [
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
];

/// Maps a virtual-key code to the equivalent `KeyboardEvent.code` name.
/// `extended` distinguishes e.g. NumpadEnter from Enter.
pub fn vk_to_code(vk: u32, extended: bool) -> Option<&'static str> {
    Some(match vk {
        0x41..=0x5A => LETTERS[(vk - 0x41) as usize],
        0x30..=0x39 => DIGITS[(vk - 0x30) as usize],
        v if (VK_NUMPAD0..VK_NUMPAD0 + 10).contains(&v) => NUMPAD[(v - VK_NUMPAD0) as usize],
        v if (VK_F1..VK_F1 + 12).contains(&v) => FKEYS[(v - VK_F1) as usize],
        VK_BACK => "Backspace",
        VK_TAB => "Tab",
        VK_RETURN => {
            if extended {
                "NumpadEnter"
            } else {
                "Enter"
            }
        }
        VK_PAUSE => "Pause",
        VK_CAPITAL => "CapsLock",
        VK_ESCAPE => "Escape",
        VK_SPACE => "Space",
        VK_PRIOR => "PageUp",
        VK_NEXT => "PageDown",
        VK_END => "End",
        VK_HOME => "Home",
        VK_LEFT => "ArrowLeft",
        VK_UP => "ArrowUp",
        VK_RIGHT => "ArrowRight",
        VK_DOWN => "ArrowDown",
        VK_SNAPSHOT => "PrintScreen",
        VK_INSERT => "Insert",
        VK_DELETE => "Delete",
        VK_LWIN => "MetaLeft",
        VK_RWIN => "MetaRight",
        VK_APPS => "ContextMenu",
        VK_MULTIPLY => "NumpadMultiply",
        VK_ADD => "NumpadAdd",
        VK_SUBTRACT => "NumpadSubtract",
        VK_DECIMAL => "NumpadDecimal",
        VK_DIVIDE => "NumpadDivide",
        VK_NUMLOCK => "NumLock",
        VK_SCROLL => "ScrollLock",
        VK_LSHIFT => "ShiftLeft",
        VK_RSHIFT => "ShiftRight",
        VK_LCONTROL => "ControlLeft",
        VK_RCONTROL => "ControlRight",
        VK_LMENU => "AltLeft",
        VK_RMENU => "AltRight",
        VK_OEM_1 => "Semicolon",
        VK_OEM_PLUS => "Equal",
        VK_OEM_COMMA => "Comma",
        VK_OEM_MINUS => "Minus",
        VK_OEM_PERIOD => "Period",
        VK_OEM_2 => "Slash",
        VK_OEM_3 => "Backquote",
        VK_OEM_4 => "BracketLeft",
        VK_OEM_5 => "Backslash",
        VK_OEM_6 => "BracketRight",
        VK_OEM_7 => "Quote",
        VK_OEM_102 => "IntlBackslash",
        _ => return None,
    })
}

/// Pure decision logic, separated from the Win32 callback for testing.
#[derive(Default)]
pub struct HookState {
    /// Keys whose key-down was swallowed (their key-up must be swallowed too).
    swallowed: std::collections::HashSet<u32>,
    /// A key was swallowed while Alt/Ctrl (which Windows still sees) was
    /// held. Windows would then see the modifier pressed and released alone:
    /// a lone Alt opens the window menu, and Alt+Shift / Ctrl+Shift switch
    /// the input language or keyboard layout (e.g. away from the Japanese
    /// IME). The hook must slip an unassigned key in between (`MASK_VK`).
    mask_pending: bool,
}

/// Unassigned virtual-key code, used only to break up modifier-only presses.
pub const MASK_VK: u16 = 0xE8;

pub struct KeyInput {
    pub vk: u32,
    pub down: bool,
    pub alt: bool,
    pub ctrl: bool,
    pub extended: bool,
}

impl HookState {
    /// Whether the key just swallowed by `process` needs `MASK_VK` injected.
    pub fn take_mask(&mut self) -> bool {
        std::mem::take(&mut self.mask_pending)
    }

    /// Returns the event to forward when the key must be swallowed.
    pub fn process(&mut self, k: &KeyInput, active: bool) -> Option<HookKeyEvent> {
        self.mask_pending = false;
        let code = vk_to_code(k.vk, k.extended);
        if !k.down {
            // Always complete a swallowed press, even if the hook became
            // inactive meanwhile, so Windows never sees a lone key-up.
            if self.swallowed.remove(&k.vk) {
                return Some(HookKeyEvent {
                    t: "key",
                    code: code.unwrap_or(""),
                    down: false,
                    repeat: false,
                })
                .filter(|e| !e.code.is_empty());
            }
            return None;
        }
        if !active {
            return None;
        }
        let win_held = self.swallowed.contains(&VK_LWIN) || self.swallowed.contains(&VK_RWIN);
        let capture = k.vk == VK_LWIN
            || k.vk == VK_RWIN
            || win_held
            || (k.alt && (k.vk == VK_TAB || k.vk == VK_ESCAPE || k.vk == VK_F4))
            || (k.ctrl && k.vk == VK_ESCAPE)
            || self.swallowed.contains(&k.vk); // auto-repeat of a swallowed key
        if !capture {
            return None;
        }
        let code = code?;
        let repeat = !self.swallowed.insert(k.vk);
        self.mask_pending = !repeat && (k.alt || k.ctrl);
        Some(HookKeyEvent {
            t: "key",
            code,
            down: true,
            repeat,
        })
    }
}

#[cfg(windows)]
mod win {
    use std::cell::RefCell;
    use std::sync::atomic::Ordering;

    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
        KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
        HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, LLKHF_EXTENDED, LLKHF_INJECTED, MSG,
        WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    use super::{HookState, KeyInput, ACTIVE, MASK_VK, SENDER};

    thread_local! {
        static STATE: RefCell<HookState> = RefCell::new(HookState::default());
    }

    /// Taps `MASK_VK` (flagged as injected, so this hook ignores it) so the
    /// held Alt/Ctrl is not seen as pressed alone. See `HookState::mask_pending`.
    fn inject_mask_key() {
        let key = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(MASK_VK),
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            log::warn!("SendInput (mask key) sent {sent} of {} events", inputs.len());
        }
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            let msg = wparam.0 as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if (down || up) && kb.flags.0 & LLKHF_INJECTED.0 == 0 {
                let input = KeyInput {
                    vk: kb.vkCode,
                    down,
                    alt: kb.flags.0 & LLKHF_ALTDOWN.0 != 0,
                    ctrl: unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } as u16 & 0x8000 != 0,
                    extended: kb.flags.0 & LLKHF_EXTENDED.0 != 0,
                };
                let active = ACTIVE.load(Ordering::Relaxed);
                let swallowed = STATE.with(|s| {
                    let mut s = s.borrow_mut();
                    s.process(&input, active).map(|event| (event, s.take_mask()))
                });
                if let Some((event, mask)) = swallowed {
                    if mask {
                        inject_mask_key();
                    }
                    if let Some(tx) = SENDER.get() {
                        let _ = tx.send(event);
                    }
                    return LRESULT(1);
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    pub fn run() {
        unsafe {
            let module = GetModuleHandleW(None).ok();
            let hook =
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), module.map(|m| m.into()), 0);
            if let Err(e) = hook {
                log::error!("SetWindowsHookExW failed: {e}");
                return;
            }
            log::info!("low-level keyboard hook installed");
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}

/// Installs the hook on a dedicated thread; captured keys are delivered to
/// `on_event` from a Tokio task.
pub fn start(on_event: impl Fn(HookKeyEvent) + Send + 'static) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    if SENDER.set(tx).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            on_event(ev);
        }
    });
    #[cfg(windows)]
    std::thread::Builder::new()
        .name("keyboard-hook".into())
        .spawn(win::run)
        .expect("spawn keyboard hook thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(vk: u32, down: bool) -> KeyInput {
        KeyInput {
            vk,
            down,
            alt: false,
            ctrl: false,
            extended: false,
        }
    }

    #[test]
    fn win_key_and_combos_are_captured() {
        let mut s = HookState::default();
        let e = s.process(&key(VK_LWIN, true), true).unwrap();
        assert_eq!((e.code, e.down, e.repeat), ("MetaLeft", true, false));
        // auto-repeat
        assert!(s.process(&key(VK_LWIN, true), true).unwrap().repeat);
        // Win+D
        assert_eq!(s.process(&key(0x44, true), true).unwrap().code, "KeyD");
        assert!(!s.process(&key(0x44, false), true).unwrap().down);
        assert_eq!(
            s.process(&key(VK_LWIN, false), true).unwrap().code,
            "MetaLeft"
        );
        // plain D is not captured anymore
        assert!(s.process(&key(0x44, true), true).is_none());
    }

    #[test]
    fn alt_tab_alt_esc_ctrl_esc() {
        let mut s = HookState::default();
        let alt_tab = KeyInput {
            vk: VK_TAB,
            down: true,
            alt: true,
            ctrl: false,
            extended: false,
        };
        assert_eq!(s.process(&alt_tab, true).unwrap().code, "Tab");
        assert!(s
            .process(
                &KeyInput {
                    down: false,
                    ..alt_tab
                },
                true
            )
            .is_some());
        let alt_esc = KeyInput {
            vk: VK_ESCAPE,
            down: true,
            alt: true,
            ctrl: false,
            extended: false,
        };
        assert!(s.process(&alt_esc, true).is_some());
        let ctrl_esc = KeyInput {
            vk: VK_ESCAPE,
            down: true,
            alt: false,
            ctrl: true,
            extended: false,
        };
        assert!(s.process(&ctrl_esc, true).is_some());
        // Tab alone goes through the normal DOM path
        assert!(s.process(&key(VK_TAB, true), true).is_none());
    }

    #[test]
    fn inactive_passes_through_but_completes_swallowed_keys() {
        let mut s = HookState::default();
        assert!(s.process(&key(VK_LWIN, true), false).is_none());
        assert!(s.process(&key(VK_LWIN, true), true).is_some());
        // focus lost before release: the key-up is still swallowed and forwarded
        let up = s.process(&key(VK_LWIN, false), false).unwrap();
        assert!(!up.down);
        assert!(s.process(&key(VK_LWIN, false), false).is_none());
    }

    #[test]
    fn swallowing_under_alt_or_ctrl_requests_a_mask_key() {
        let mut s = HookState::default();
        let alt_tab = KeyInput {
            vk: VK_TAB,
            down: true,
            alt: true,
            ctrl: false,
            extended: false,
        };
        assert!(s.process(&alt_tab, true).is_some());
        assert!(s.take_mask());
        assert!(!s.take_mask(), "taken once");
        // auto-repeat of the swallowed Tab: Windows already saw the mask
        assert!(s.process(&alt_tab, true).unwrap().repeat);
        assert!(!s.take_mask());
        // key-up: nothing to mask
        assert!(s
            .process(
                &KeyInput {
                    down: false,
                    ..alt_tab
                },
                true
            )
            .is_some());
        assert!(!s.take_mask());
        let ctrl_esc = KeyInput {
            vk: VK_ESCAPE,
            down: true,
            alt: false,
            ctrl: true,
            extended: false,
        };
        assert!(s.process(&ctrl_esc, true).is_some());
        assert!(s.take_mask());
        // Win itself is swallowed: Windows sees no modifier to mask
        assert!(s.process(&key(VK_LWIN, true), true).is_some());
        assert!(!s.take_mask());
        // passed-through keys never ask for a mask
        assert!(s.process(&key(VK_LWIN, false), true).is_some());
        let alt_a = KeyInput {
            vk: 0x41,
            down: true,
            alt: true,
            ctrl: false,
            extended: false,
        };
        assert!(s.process(&alt_a, true).is_none());
        assert!(!s.take_mask());
    }

    #[test]
    fn vk_mapping() {
        assert_eq!(vk_to_code(VK_RETURN, true), Some("NumpadEnter"));
        assert_eq!(vk_to_code(VK_RETURN, false), Some("Enter"));
        assert_eq!(vk_to_code(0x70, false), Some("F1"));
        assert_eq!(vk_to_code(0x39, false), Some("Digit9"));
        assert_eq!(vk_to_code(0xFF, false), None);
    }
}
