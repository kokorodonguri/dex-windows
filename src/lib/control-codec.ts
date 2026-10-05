// scrcpy control messages encoded by the frontend (sent over the /stream
// WebSocket). Byte layouts follow app/src/control_msg.c of scrcpy v4.1.
// SET_CLIPBOARD / RESET_VIDEO / RESIZE_DISPLAY / SCAN_FILE are encoded in Rust.

export const TYPE_INJECT_KEYCODE = 0;
export const TYPE_INJECT_TEXT = 1;
export const TYPE_INJECT_TOUCH_EVENT = 2;
export const TYPE_INJECT_SCROLL_EVENT = 3;
export const TYPE_BACK_OR_SCREEN_ON = 4;

export const INJECT_TEXT_MAX_LENGTH = 300;

/** Message bytes backed by a plain ArrayBuffer (sendable over a WebSocket). */
export type Bytes = Uint8Array<ArrayBuffer>;

export const KeyAction = { DOWN: 0, UP: 1 } as const;

export const MotionAction = {
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
  HOVER_MOVE: 7,
} as const;

// Same bit layout as MouseEvent.buttons
export const MotionButton = {
  PRIMARY: 1,
  SECONDARY: 2,
  TERTIARY: 4,
  BACK: 8,
  FORWARD: 16,
} as const;

/**
 * MouseEvent.button index → Android button bit. The index order (0 left,
 * 1 middle, 2 right, 3 back, 4 forward) differs from the `buttons` bitmask.
 */
export function buttonFromDomIndex(button: number): number {
  switch (button) {
    case 0:
      return MotionButton.PRIMARY;
    case 1:
      return MotionButton.TERTIARY;
    case 2:
      return MotionButton.SECONDARY;
    case 3:
      return MotionButton.BACK;
    case 4:
      return MotionButton.FORWARD;
    default:
      return 0;
  }
}

export const POINTER_ID_MOUSE = 0xffff_ffff_ffff_ffffn; // -1
export const POINTER_ID_GENERIC_FINGER = 0xffff_ffff_ffff_fffen; // -2

export interface Position {
  x: number;
  y: number;
  /** Must equal the current video size, otherwise the server drops the event. */
  width: number;
  height: number;
}

/** Float in [0, 1] → unsigned 16-bit fixed point (1.0 → 0xffff). */
export function floatToU16fp(f: number): number {
  const u = Math.trunc(Math.min(Math.max(f, 0), 1) * 0x10000);
  return u >= 0xffff ? 0xffff : u;
}

/** Float in [-1, 1] → signed 16-bit fixed point (1.0 → 0x7fff). */
export function floatToI16fp(f: number): number {
  const i = Math.trunc(Math.min(Math.max(f, -1), 1) * 0x8000);
  return i >= 0x7fff ? 0x7fff : i;
}

function writePosition(view: DataView, offset: number, p: Position): void {
  view.setInt32(offset, Math.round(p.x));
  view.setInt32(offset + 4, Math.round(p.y));
  view.setUint16(offset + 8, p.width);
  view.setUint16(offset + 10, p.height);
}

export function encodeInjectKeycode(action: number, keycode: number, repeat: number, metastate: number): Bytes {
  const buf = new Uint8Array(14);
  const view = new DataView(buf.buffer);
  buf[0] = TYPE_INJECT_KEYCODE;
  buf[1] = action;
  view.setUint32(2, keycode);
  view.setUint32(6, repeat);
  view.setUint32(10, metastate >>> 0);
  return buf;
}

const utf8 = new TextEncoder();

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function utf8Truncate(text: string, maxBytes: number): Bytes {
  const bytes = utf8.encode(text);
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  // back off continuation bytes (10xxxxxx)
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

export function encodeInjectText(text: string): Bytes {
  const payload = utf8Truncate(text, INJECT_TEXT_MAX_LENGTH);
  const buf = new Uint8Array(5 + payload.length);
  buf[0] = TYPE_INJECT_TEXT;
  new DataView(buf.buffer).setUint32(1, payload.length);
  buf.set(payload, 5);
  return buf;
}

export function encodeInjectTouch(
  action: number,
  pointerId: bigint,
  position: Position,
  pressure: number,
  actionButton: number,
  buttons: number,
): Bytes {
  const buf = new Uint8Array(32);
  const view = new DataView(buf.buffer);
  buf[0] = TYPE_INJECT_TOUCH_EVENT;
  buf[1] = action;
  view.setBigUint64(2, BigInt.asUintN(64, pointerId));
  writePosition(view, 10, position);
  view.setUint16(22, floatToU16fp(pressure));
  view.setUint32(24, actionButton >>> 0);
  view.setUint32(28, buttons >>> 0);
  return buf;
}

/** hscroll/vscroll in [-16, 16] (one wheel notch = 1). */
export function encodeInjectScroll(position: Position, hscroll: number, vscroll: number, buttons: number): Bytes {
  const buf = new Uint8Array(21);
  const view = new DataView(buf.buffer);
  buf[0] = TYPE_INJECT_SCROLL_EVENT;
  writePosition(view, 1, position);
  view.setInt16(13, floatToI16fp(hscroll / 16));
  view.setInt16(15, floatToI16fp(vscroll / 16));
  view.setUint32(17, buttons >>> 0);
  return buf;
}

export function encodeBackOrScreenOn(action: number): Bytes {
  return new Uint8Array([TYPE_BACK_OR_SCREEN_ON, action]);
}

/**
 * Splits a scroll amount into steps within [-1, 1] so that each message is at
 * most one "notch" (Android apps treat AXIS_VSCROLL = 1 as one notch).
 */
export function splitScroll(amount: number, maxSteps = 16): number[] {
  if (!Number.isFinite(amount) || amount === 0) return [];
  const steps: number[] = [];
  let rest = amount;
  while (Math.abs(rest) > 1e-6 && steps.length < maxSteps) {
    const step = Math.max(-1, Math.min(1, rest));
    steps.push(step);
    rest -= step;
  }
  return steps;
}
