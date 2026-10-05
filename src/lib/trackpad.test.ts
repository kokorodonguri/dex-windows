import { describe, expect, it } from "vitest";
import { MotionAction, type Bytes, type Position } from "./control-codec";
import {
  GestureSession,
  PINCH_POINTER_2,
  TRACKPAD_POINTER,
  clampGestureCoordinate,
  classifyWheelInput,
  dominantGestureAxis,
  type GestureHost,
  type WheelSample,
} from "./trackpad";

describe("trackpad wheel classification", () => {
  it("recognizes WebView2 pinch and precision streams", () => {
    expect(classifyWheelInput(0, 0, -4.5, true)).toBe("pinch");
    expect(classifyWheelInput(0, 2.25, 0.5, false)).toBe("swipe");
    expect(classifyWheelInput(0, 0, 18, false)).toBe("swipe");
  });

  it("preserves discrete mouse wheels", () => {
    expect(classifyWheelInput(1, 0, 3, false)).toBe("wheel");
    expect(classifyWheelInput(2, 0, 1, false)).toBe("wheel");
    expect(classifyWheelInput(0, 0, -100, false)).toBe("wheel");
    expect(classifyWheelInput(0, 200, 0, false)).toBe("wheel");
  });
});

describe("trackpad gesture geometry", () => {
  it("locks to the dominant axis", () => {
    expect(dominantGestureAxis(30, 4)).toBe("horizontal");
    expect(dominantGestureAxis(3, -20)).toBe("vertical");
  });

  it("keeps injected points inside the video", () => {
    expect(clampGestureCoordinate(-20, 100)).toBe(0);
    expect(clampGestureCoordinate(40.4, 100)).toBe(40);
    expect(clampGestureCoordinate(120, 100)).toBe(99);
  });
});

const VIDEO = { width: 1920, height: 1080 };

interface Touch {
  action: number;
  pointer: bigint;
  x: number;
  y: number;
  pressure: number;
}

function decode(msg: Bytes): Touch {
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  expect(view.getUint8(0)).toBe(2); // INJECT_TOUCH_EVENT
  return {
    action: view.getUint8(1),
    pointer: view.getBigUint64(2),
    x: view.getInt32(10),
    y: view.getInt32(14),
    pressure: view.getUint16(22),
  };
}

/** Drives a GestureSession with frames and idle timeouts under test control. */
class Harness implements GestureHost {
  readonly touches: Touch[] = [];
  readonly session = new GestureSession(this);
  private frames: Array<(() => void) | null> = [];
  private idles: Array<(() => void) | null> = [];

  send = (msg: Bytes) => void this.touches.push(decode(msg));
  requestFrame = (run: () => void) => this.frames.push(run);
  cancelFrame = (handle: number) => void (this.frames[handle - 1] = null);
  setIdle = (run: () => void) => this.idles.push(run);
  clearIdle = (handle: number) => void (this.idles[handle - 1] = null);

  /** Runs the pending animation frame, as the browser would. */
  frame(): this {
    const pending = this.frames.splice(0);
    this.frames = [];
    for (const run of pending) run?.();
    return this;
  }

  /** Fires the idle timer: the wheel burst (and its inertia) is over. */
  idle(): this {
    const pending = this.idles.splice(0);
    this.idles = [];
    for (const run of pending) run?.();
    return this;
  }

  get pendingFrames(): number {
    return this.frames.filter(Boolean).length;
  }

  get pendingIdles(): number {
    return this.idles.filter(Boolean).length;
  }

  wheel(deltaX: number, deltaY: number, at: Partial<Position> = {}): WheelSample {
    return { deltaX, deltaY, position: { x: 960, y: 540, ...VIDEO, ...at }, scaleX: 1, scaleY: 1 };
  }
}

describe("trackpad gesture session", () => {
  it("replays a two-finger swipe as one down/move/up finger", () => {
    const h = new Harness();
    h.session.swipe(h.wheel(-40, 2));
    h.frame();
    h.session.swipe(h.wheel(-40, -1));
    h.frame().idle();

    expect(h.touches.map((t) => t.action)).toEqual([MotionAction.DOWN, MotionAction.MOVE, MotionAction.MOVE, MotionAction.UP]);
    expect(h.touches.every((t) => t.pointer === TRACKPAD_POINTER)).toBe(true);
    expect(h.touches[0]!.pressure).toBeGreaterThan(0);
    expect(h.touches.at(-1)!.pressure).toBe(0);
    expect(h.session.active).toBe(false);
  });

  it("swipes with the fingers and keeps the locked axis", () => {
    const h = new Harness();
    // Scrolling left (deltaX < 0) drags the content to the right.
    h.session.swipe(h.wheel(-30, 0));
    h.frame();
    expect(h.session.axis).toBe("horizontal");
    expect(h.touches[1]!.x).toBeGreaterThan(h.touches[0]!.x);

    // Diagonal noise mid-burst must not restart the gesture on the other axis.
    h.session.swipe(h.wheel(-30, 6));
    h.frame();
    expect(h.session.axis).toBe("horizontal");
    expect(h.touches.map((t) => t.action)).toEqual([MotionAction.DOWN, MotionAction.MOVE, MotionAction.MOVE]);
    expect(h.touches.at(-1)!.y).toBe(h.touches[0]!.y);

    // Vertical scrolling drags the content down, the way a finger would.
    h.idle();
    h.session.swipe(h.wheel(0, 30));
    h.frame();
    expect(h.session.axis).toBe("vertical");
    expect(h.touches.at(-1)!.y).toBeLessThan(h.touches.at(-2)!.y);
  });

  it("starts far enough from the edges to have room to travel", () => {
    const h = new Harness();
    // Which axis the burst will take is not known at DOWN, so both get room.
    h.session.swipe(h.wheel(-30, 0, { x: 1900, y: 1000 }));
    expect(h.touches[0]!.x).toBe(1440); // 75% of 1920
    expect(h.touches[0]!.y).toBe(810); // 75% of 1080

    h.idle();
    h.session.swipe(h.wheel(0, -30, { x: 10, y: 8 }));
    expect(h.touches.at(-1)!.y).toBe(270); // 25% of 1080
  });

  it("ignores a stray sideways pixel at the start of a vertical flick", () => {
    const h = new Harness();
    // A precision touchpad opens a downward flick like this; locking on the
    // first event alone would drag sideways and page the app by mistake.
    h.session.swipe(h.wheel(2.25, 0.5));
    h.frame();
    expect(h.session.axis).toBe(null);
    expect(h.touches.map((t) => t.action)).toEqual([MotionAction.DOWN]);

    h.session.swipe(h.wheel(1, 20));
    h.frame();
    expect(h.session.axis).toBe("vertical");
    expect(h.touches.at(-1)!.x).toBe(h.touches[0]!.x); // no sideways drag at all
    expect(h.touches.at(-1)!.y).toBeLessThan(h.touches[0]!.y);
  });

  it("starts a new gesture when the user turns onto the other axis", () => {
    const h = new Harness();
    h.session.swipe(h.wheel(-40, 0));
    h.frame();
    expect(h.session.axis).toBe("horizontal");

    // Scrolling on without pausing must not be swallowed by the locked axis.
    h.session.swipe(h.wheel(-2, 30));
    h.frame();
    expect(h.session.axis).toBe("vertical");
    expect(h.touches.map((t) => t.action)).toEqual([
      MotionAction.DOWN,
      MotionAction.MOVE,
      MotionAction.UP,
      MotionAction.DOWN,
      MotionAction.MOVE,
    ]);
    expect(h.touches.at(-1)!.y).toBeLessThan(h.touches.at(-2)!.y);
  });

  it("still delivers a burst too small to pick an axis on its own", () => {
    const h = new Harness();
    h.session.swipe(h.wheel(0, 3));
    h.frame();
    expect(h.touches.map((t) => t.action)).toEqual([MotionAction.DOWN]);
    h.idle();
    expect(h.touches.map((t) => t.action)).toEqual([MotionAction.DOWN, MotionAction.MOVE, MotionAction.UP]);
    expect(h.touches[1]!.y).toBeLessThan(h.touches[0]!.y);
  });

  it("coalesces a burst into one move per frame and never leaves the video", () => {
    const h = new Harness();
    for (let i = 0; i < 20; i++) h.session.swipe(h.wheel(-200, 0));
    expect(h.pendingFrames).toBe(1);
    expect(h.touches.length).toBe(1); // only the DOWN so far
    h.frame();
    expect(h.touches.length).toBe(2);
    expect(h.touches[1]!.x).toBe(VIDEO.width - 1);
    h.idle();
    expect(h.touches.at(-1)!.action).toBe(MotionAction.UP);
  });

  it("merges the inertia tail into the same gesture", () => {
    const h = new Harness();
    h.session.swipe(h.wheel(-60, 0));
    h.frame();
    for (const delta of [-30, -12, -4, -1]) {
      h.session.swipe(h.wheel(delta, 0));
      h.frame();
    }
    expect(h.touches.filter((t) => t.action === MotionAction.DOWN).length).toBe(1);
    expect(h.pendingIdles).toBe(1); // one live timer, restarted by each event
    h.idle();
    expect(h.touches.filter((t) => t.action === MotionAction.UP).length).toBe(1);
  });

  it("turns a pinch into two pointers moving apart around the cursor", () => {
    const h = new Harness();
    h.session.pinch(h.wheel(0, -50));
    const [left, right] = [h.touches[0]!, h.touches[1]!];
    expect(left.pointer).toBe(TRACKPAD_POINTER);
    expect(right.pointer).toBe(PINCH_POINTER_2);
    expect(left.x).toBeLessThan(960);
    expect(right.x).toBeGreaterThan(960);

    const spread = h.touches[3]!.x - h.touches[2]!.x;
    expect(spread).toBeGreaterThan(right.x - left.x); // zooming in spreads them
    h.session.pinch(h.wheel(0, 400));
    expect(h.touches.at(-1)!.x - h.touches.at(-2)!.x).toBeLessThan(spread); // and back

    h.idle();
    expect(h.touches.slice(-2).map((t) => t.action)).toEqual([MotionAction.UP, MotionAction.UP]);
    expect(h.touches.slice(-2).every((t) => t.pressure === 0)).toBe(true);
  });

  it("switching from swipe to pinch lifts the swipe first", () => {
    const h = new Harness();
    h.session.swipe(h.wheel(0, 30));
    h.frame();
    h.session.pinch(h.wheel(0, -50));
    const actions = h.touches.map((t) => t.action);
    expect(actions).toEqual([MotionAction.DOWN, MotionAction.MOVE, MotionAction.UP, MotionAction.DOWN, MotionAction.DOWN, MotionAction.MOVE, MotionAction.MOVE]);
    expect(h.touches[2]!.pointer).toBe(TRACKPAD_POINTER);
  });

  it("cancels cleanly on focus loss and leaves nothing scheduled", () => {
    const h = new Harness();
    h.session.swipe(h.wheel(-60, 0));
    h.session.finish(MotionAction.CANCEL);
    expect(h.session.active).toBe(false);
    // The delta accumulated before the interruption is still delivered.
    expect(h.touches.map((t) => t.action)).toEqual([MotionAction.DOWN, MotionAction.MOVE, MotionAction.CANCEL]);
    expect(h.pendingFrames).toBe(0);
    expect(h.pendingIdles).toBe(0);

    const before = h.touches.length;
    h.session.finish();
    h.frame().idle();
    expect(h.touches.length).toBe(before); // nothing stuck, nothing repeated
  });
});
