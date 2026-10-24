// KeyboardEvent.code → Android keycode, metastate tracking, and the
// "mixed" injection policy of scrcpy: letters/space/navigation are sent as
// key events, digits and punctuation as text (so non-US layouts such as JIS
// produce the characters printed on the keycaps).

export const AKEYCODE = {
  HOME: 3,
  BACK: 4,
  APP_SWITCH: 187,
  META_LEFT: 117,
  PASTE: 279,
} as const;

export const CODE_TO_KEYCODE: Readonly<Record<string, number>> = {
  // letters
  KeyA: 29, KeyB: 30, KeyC: 31, KeyD: 32, KeyE: 33, KeyF: 34, KeyG: 35, KeyH: 36, KeyI: 37,
  KeyJ: 38, KeyK: 39, KeyL: 40, KeyM: 41, KeyN: 42, KeyO: 43, KeyP: 44, KeyQ: 45, KeyR: 46,
  KeyS: 47, KeyT: 48, KeyU: 49, KeyV: 50, KeyW: 51, KeyX: 52, KeyY: 53, KeyZ: 54,
  // digits
  Digit0: 7, Digit1: 8, Digit2: 9, Digit3: 10, Digit4: 11, Digit5: 12, Digit6: 13, Digit7: 14, Digit8: 15, Digit9: 16,
  // punctuation (US positions)
  Minus: 69, Equal: 70, BracketLeft: 71, BracketRight: 72, Backslash: 73, Semicolon: 74, Quote: 75,
  Backquote: 68, Comma: 55, Period: 56, Slash: 76, IntlBackslash: 73, IntlRo: 217, IntlYen: 216,
  // whitespace / editing
  Space: 62, Enter: 66, Tab: 61, Backspace: 67, Delete: 112, Insert: 124, Escape: 111,
  // navigation
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  Home: 122, End: 123, PageUp: 92, PageDown: 93,
  // modifiers and locks
  ShiftLeft: 59, ShiftRight: 60, ControlLeft: 113, ControlRight: 114, AltLeft: 57, AltRight: 58,
  MetaLeft: 117, MetaRight: 118, OSLeft: 117, OSRight: 118, CapsLock: 115, NumLock: 143, ScrollLock: 116,
  ContextMenu: 82, PrintScreen: 120, Pause: 121, Fn: 119,
  // function keys
  F1: 131, F2: 132, F3: 133, F4: 134, F5: 135, F6: 136, F7: 137, F8: 138, F9: 139, F10: 140, F11: 141, F12: 142,
  // numpad
  Numpad0: 144, Numpad1: 145, Numpad2: 146, Numpad3: 147, Numpad4: 148, Numpad5: 149, Numpad6: 150,
  Numpad7: 151, Numpad8: 152, Numpad9: 153, NumpadDivide: 154, NumpadMultiply: 155, NumpadSubtract: 156,
  NumpadAdd: 157, NumpadDecimal: 158, NumpadComma: 159, NumpadEnter: 160, NumpadEqual: 161,
  // Japanese keyboard
  Convert: 214, NonConvert: 213, KanaMode: 215, Lang1: 218, Lang2: 212,
  // media
  AudioVolumeUp: 24, AudioVolumeDown: 25, AudioVolumeMute: 164, MediaPlayPause: 85, MediaStop: 86,
  MediaTrackNext: 87, MediaTrackPrevious: 88, BrowserBack: 4, BrowserHome: 3, BrowserSearch: 84,
};

export const META = {
  SHIFT_ON: 0x1,
  ALT_ON: 0x2,
  ALT_LEFT_ON: 0x10,
  ALT_RIGHT_ON: 0x20,
  SHIFT_LEFT_ON: 0x40,
  SHIFT_RIGHT_ON: 0x80,
  CTRL_ON: 0x1000,
  CTRL_LEFT_ON: 0x2000,
  CTRL_RIGHT_ON: 0x4000,
  META_ON: 0x10000,
  META_LEFT_ON: 0x20000,
  META_RIGHT_ON: 0x40000,
  CAPS_LOCK_ON: 0x100000,
  NUM_LOCK_ON: 0x200000,
  SCROLL_LOCK_ON: 0x400000,
} as const;

const MODIFIER_BITS: Readonly<Record<string, number>> = {
  ShiftLeft: META.SHIFT_ON | META.SHIFT_LEFT_ON,
  ShiftRight: META.SHIFT_ON | META.SHIFT_RIGHT_ON,
  ControlLeft: META.CTRL_ON | META.CTRL_LEFT_ON,
  ControlRight: META.CTRL_ON | META.CTRL_RIGHT_ON,
  AltLeft: META.ALT_ON | META.ALT_LEFT_ON,
  AltRight: META.ALT_ON | META.ALT_RIGHT_ON,
  MetaLeft: META.META_ON | META.META_LEFT_ON,
  MetaRight: META.META_ON | META.META_RIGHT_ON,
  OSLeft: META.META_ON | META.META_LEFT_ON,
  OSRight: META.META_ON | META.META_RIGHT_ON,
};

export function isModifier(code: string): boolean {
  return code in MODIFIER_BITS;
}

export interface LockState {
  capsLock: boolean;
  numLock: boolean;
}

/** Tracks pressed modifiers (left/right separately) and computes metastate. */
export class ModifierState {
  private readonly pressed = new Set<string>();

  update(code: string, down: boolean): void {
    if (!isModifier(code)) return;
    if (down) this.pressed.add(code);
    else this.pressed.delete(code);
  }

  has(kind: "shift" | "ctrl" | "alt" | "meta"): boolean {
    const prefix = { shift: "Shift", ctrl: "Control", alt: "Alt", meta: "Meta" }[kind];
    for (const code of this.pressed) {
      if (code.startsWith(prefix) || (kind === "meta" && code.startsWith("OS"))) return true;
    }
    return false;
  }

  metastate(locks: LockState): number {
    let m = 0;
    for (const code of this.pressed) m |= MODIFIER_BITS[code] ?? 0;
    if (locks.capsLock) m |= META.CAPS_LOCK_ON;
    if (locks.numLock) m |= META.NUM_LOCK_ON;
    return m;
  }

  pressedCodes(): string[] {
    return [...this.pressed];
  }

  clear(): void {
    this.pressed.clear();
  }
}

export type KeyRoute = { kind: "keycode"; keycode: number } | { kind: "text"; text: string } | { kind: "ignore" };

const TEXT_ROUTED = /^(Digit\d|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen)$/;

const PC_IME_TOGGLE_KEYS = new Set(["Zenkaku", "Hankaku", "ZenkakuHankaku", "KanjiMode"]);

/**
 * Decides how a key-down is injected. Digits/punctuation typed without
 * Ctrl/Alt/Meta are sent as text using `key` (the character produced by the
 * PC layout); everything else, including shortcuts such as Ctrl+1, as key
 * events with metastate.
 */
export function routeKey(code: string, key: string, mods: ModifierState): KeyRoute {
  // The PC IME's own on/off key (JIS 半角/全角 sits on code "Backquote"):
  // forwarding it would type "`" on the device.
  if (PC_IME_TOGGLE_KEYS.has(key)) return { kind: "ignore" };
  const shortcut = mods.has("ctrl") || mods.has("alt") || mods.has("meta");
  if (!shortcut && TEXT_ROUTED.test(code) && [...key].length === 1) {
    return { kind: "text", text: key };
  }
  const keycode = CODE_TO_KEYCODE[code];
  return keycode === undefined ? { kind: "ignore" } : { kind: "keycode", keycode };
}
