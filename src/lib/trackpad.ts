// Precision-touchpad gestures → Android touch events.
//
// WebView2 reports two-finger scrolling and pinching as wheel events, so a
// swipe arrives as a burst of small deltas (plus an inertia tail) instead of
// a drag. Android apps that page between screens — Instagram's tabs, for
// instance — only react to a real DOWN/MOVE/UP sequence, so the burst is
// replayed as one finger held down for as long as the burst lasts.

import { MotionAction, encodeInjectTouch, type Bytes, type Position } from "./control-codec";

export type WheelInputKind = "wheel" | "swipe" | "pinch";
export type GestureAxis = "horizontal" | "vertical";

/** Pointer ids below the mouse/finger ones used by the pointer handlers. */
export const TRACKPAD_POINTER = 0xffff_ffff_ffff_fffdn; // -3
export const PINCH_POINTER_2 = 0xffff_ffff_ffff_fffcn; // -4

/** A burst is over once no wheel event arrives for this long. */
export const GESTURE_IDLE_MS = 120;
/** Wheel deltas are damped compared to the finger travel that caused them. */
const SWIPE_GAIN = 1.35;
/** Fraction of the screen kept on each side of a swipe's starting point. */
const EDGE_MARGIN = 0.25;
/**
 * Travel (video pixels) a burst needs before its axis is decided. A touchpad
 * often opens a vertical flick with a stray sideways pixel or two; locking on
 * that first event alone would drag the app sideways and page it by mistake.
 */
export const AXIS_LOCK_TRAVEL = 12;
/** Single-event delta that counts as deliberately turning onto the other axis. */
const AXIS_TURN_DELTA = 4;

/**
 * Chromium does not expose a device type for WheelEvent. Precision touchpads
 * normally produce a stream of small pixel deltas, while a mouse wheel is a
 * single line/page delta or a 100-pixel notch on WebView2.
 */
export function classifyWheelInput(deltaMode: number, deltaX: number, deltaY: number, ctrlKey: boolean): WheelInputKind {
  if (ctrlKey) return "pinch";
  if (deltaMode !== 0) return "wheel";
  const dominant = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  const minor = Math.min(Math.abs(deltaX), Math.abs(deltaY));
  const discreteNotch = minor < 0.01 && dominant >= 80 && Math.abs(dominant / 100 - Math.round(dominant / 100)) < 0.02;
  return discreteNotch ? "wheel" : "swipe";
}

export function dominantGestureAxis(deltaX: number, deltaY: number): GestureAxis {
  return Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
}

export function clampGestureCoordinate(value: number, extent: number): number {
  return Math.round(Math.min(Math.max(value, 0), Math.max(0, extent - 1)));
}

/** Timer and frame scheduling, injected so this module stays DOM-free. */
export interface GestureHost {
  send: (msg: Bytes) => void;
  /** Coalesces the moves of one burst onto the next rendered frame. */
  requestFrame: (run: () => void) => number;
  cancelFrame: (handle: number) => void;
  /** Ends the gesture when the burst (inertia included) stops. */
  setIdle: (run: () => void, ms: number) => number;
  clearIdle: (handle: number) => void;
}

/** One wheel event, already mapped to the video's coordinate system. */
export interface WheelSample {
  deltaX: number;
  deltaY: number;
  /** Cursor in video pixels; also carries the video size. */
  position: Position;
  /** CSS pixels → video pixels. */
  scaleX: number;
  scaleY: number;
}

interface Swipe {
  kind: "swipe";
  /** null until the burst has moved far enough to say which way it goes. */
  axis: GestureAxis | null;
  position: Position;
  pendingX: number;
  pendingY: number;
  frame: number;
}

interface Pinch {
  kind: "pinch";
  center: Position;
  radius: number;
}

/**
 * Turns wheel bursts into a single Android touch gesture. Successive bursts of
 * the same axis (the inertia tail of a flick) extend the gesture instead of
 * restarting it; a different axis, a pinch, or a pause ends it cleanly.
 */
export class GestureSession {
  private current: Swipe | Pinch | null = null;
  private idle = 0;

  constructor(private readonly host: GestureHost) {}

  get active(): boolean {
    return this.current !== null;
  }

  get axis(): GestureAxis | null {
    return this.current?.kind === "swipe" ? this.current.axis : null;
  }

  swipe(sample: WheelSample): void {
    const running = this.current?.kind === "swipe" ? this.current : null;
    if (!running || crossesAxis(running, sample)) {
      this.finish();
      const start = { ...sample.position };
      // Keep enough travel available on either axis even when the cursor sits
      // near an edge (which way the burst goes is not known yet).
      const span = (value: number, extent: number) =>
        Math.round(Math.min(Math.max(value, extent * EDGE_MARGIN), extent * (1 - EDGE_MARGIN)));
      start.x = span(start.x, start.width);
      start.y = span(start.y, start.height);
      this.current = { kind: "swipe", axis: null, position: start, pendingX: 0, pendingY: 0, frame: 0 };
      this.host.send(encodeInjectTouch(MotionAction.DOWN, TRACKPAD_POINTER, start, 1, 0, 0));
    }
    const swipe = this.current as Swipe;
    // Android moves the content with the finger: the wheel's "scroll down" is
    // a finger travelling up.
    if (swipe.axis !== "vertical") swipe.pendingX += -sample.deltaX * sample.scaleX * SWIPE_GAIN;
    if (swipe.axis !== "horizontal") swipe.pendingY += -sample.deltaY * sample.scaleY * SWIPE_GAIN;
    lockAxis(swipe);
    if (!swipe.frame) swipe.frame = this.host.requestFrame(() => this.flush());
    this.restartIdle();
  }

  pinch(sample: WheelSample): void {
    if (this.current?.kind !== "pinch") {
      this.finish();
      const center = { ...sample.position };
      const radius = Math.max(12, Math.min(center.width, center.height) * 0.08);
      this.current = { kind: "pinch", center, radius };
      this.host.send(encodeInjectTouch(MotionAction.DOWN, TRACKPAD_POINTER, pinchPoint(center, radius, -1), 1, 0, 0));
      this.host.send(encodeInjectTouch(MotionAction.DOWN, PINCH_POINTER_2, pinchPoint(center, radius, 1), 1, 0, 0));
    }
    const pinch = this.current as Pinch;
    const limit = Math.min(pinch.center.width, pinch.center.height) * 0.4;
    pinch.radius = Math.min(Math.max(pinch.radius - sample.deltaY * 0.75, 12), limit);
    this.host.send(encodeInjectTouch(MotionAction.MOVE, TRACKPAD_POINTER, pinchPoint(pinch.center, pinch.radius, -1), 1, 0, 0));
    this.host.send(encodeInjectTouch(MotionAction.MOVE, PINCH_POINTER_2, pinchPoint(pinch.center, pinch.radius, 1), 1, 0, 0));
    this.restartIdle();
  }

  /** Lifts every injected pointer. Safe to call when nothing is running. */
  finish(action: typeof MotionAction.UP | typeof MotionAction.CANCEL = MotionAction.UP): void {
    this.host.clearIdle(this.idle);
    this.idle = 0;
    const gesture = this.current;
    if (!gesture) return;
    this.current = null;
    if (gesture.kind === "swipe") {
      if (gesture.frame) this.host.cancelFrame(gesture.frame);
      gesture.frame = 0;
      // A burst too short to pick an axis on its own still has to go somewhere.
      lockAxis(gesture, true);
      const position = applyPending(gesture);
      if (position) this.host.send(encodeInjectTouch(MotionAction.MOVE, TRACKPAD_POINTER, position, 1, 0, 0));
      this.host.send(encodeInjectTouch(action, TRACKPAD_POINTER, gesture.position, 0, 0, 0));
      return;
    }
    this.host.send(encodeInjectTouch(action, PINCH_POINTER_2, pinchPoint(gesture.center, gesture.radius, 1), 0, 0, 0));
    this.host.send(encodeInjectTouch(action, TRACKPAD_POINTER, pinchPoint(gesture.center, gesture.radius, -1), 0, 0, 0));
  }

  private flush(): void {
    if (this.current?.kind !== "swipe") return;
    this.current.frame = 0;
    const position = applyPending(this.current);
    if (position) this.host.send(encodeInjectTouch(MotionAction.MOVE, TRACKPAD_POINTER, position, 1, 0, 0));
  }

  private restartIdle(): void {
    this.host.clearIdle(this.idle);
    this.idle = this.host.setIdle(() => this.finish(), GESTURE_IDLE_MS);
  }
}

/**
 * True when the burst has clearly turned onto the other axis — the user went
 * on scrolling the other way without pausing. Noise never qualifies: it stays
 * small while the axis in use keeps producing the larger deltas.
 */
function crossesAxis(swipe: Swipe, sample: WheelSample): boolean {
  if (!swipe.axis) return false;
  const horizontal = swipe.axis === "horizontal";
  const along = Math.abs(horizontal ? sample.deltaX : sample.deltaY);
  const across = Math.abs(horizontal ? sample.deltaY : sample.deltaX);
  return across >= AXIS_TURN_DELTA && across > along * 2;
}

/**
 * Decides the axis once the accumulated travel is unambiguous, and drops what
 * was gathered on the other one so the drag stays straight.
 */
function lockAxis(swipe: Swipe, force = false): void {
  if (swipe.axis) return;
  const travel = Math.max(Math.abs(swipe.pendingX), Math.abs(swipe.pendingY));
  if (!force && travel < AXIS_LOCK_TRAVEL) return;
  if (travel === 0) return;
  swipe.axis = dominantGestureAxis(swipe.pendingX, swipe.pendingY);
  if (swipe.axis === "horizontal") swipe.pendingY = 0;
  else swipe.pendingX = 0;
}

function pinchPoint(center: Position, radius: number, side: -1 | 1): Position {
  return { ...center, x: clampGestureCoordinate(center.x + side * radius, center.width) };
}

/** Folds the accumulated delta into the gesture position; null when idle. */
function applyPending(swipe: Swipe): Position | null {
  // Before the axis is known, the movement is still being measured.
  if (!swipe.axis || (swipe.pendingX === 0 && swipe.pendingY === 0)) return null;
  swipe.position = {
    ...swipe.position,
    x: clampGestureCoordinate(swipe.position.x + swipe.pendingX, swipe.position.width),
    y: clampGestureCoordinate(swipe.position.y + swipe.pendingY, swipe.position.height),
  };
  swipe.pendingX = 0;
  swipe.pendingY = 0;
  return swipe.position;
}
