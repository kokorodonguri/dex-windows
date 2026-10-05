// Mouse / wheel / keyboard / IME → scrcpy control messages.
import {
  KeyAction,
  MotionAction,
  POINTER_ID_GENERIC_FINGER,
  POINTER_ID_MOUSE,
  buttonFromDomIndex,
  encodeInjectKeycode,
  encodeInjectScroll,
  encodeInjectText,
  encodeInjectTouch,
  splitScroll,
  type Bytes,
  type Position,
} from "../lib/control-codec";
import { clientToVideo, type Size } from "../lib/coords";
import { CODE_TO_KEYCODE, META, ModifierState, routeKey } from "../lib/keymap";
import { GestureSession, classifyWheelInput, type WheelSample } from "../lib/trackpad";

export interface InputOptions {
  /** Element whose box contains the letterboxed video (the canvas). */
  surface: HTMLElement;
  /** Hidden textarea holding keyboard focus (IME target). */
  ime: HTMLTextAreaElement;
  send: (msg: Bytes) => void;
  videoSize: () => Size;
  /**
   * Puts committed non-ASCII IME text on the device clipboard; resolves once
   * the SET_CLIPBOARD message is queued (before any later WebSocket input).
   */
  setDeviceClipboard: (text: string) => Promise<void>;
  /** Local shortcuts; return true when handled (not forwarded). */
  onLocalShortcut: (e: KeyboardEvent) => boolean;
  /** Convert precision-touchpad wheel streams to Android touch gestures. */
  trackpadGestures: boolean;
}

const PIXELS_PER_NOTCH = 100;
const isPlainAscii = (s: string) => /^[\x20-\x7e]+$/.test(s);

export class InputController {
  private readonly mods = new ModifierState();
  private readonly repeats = new Map<string, number>();
  private readonly pressedKeys = new Set<string>();
  private buttons = 0;
  private lastMousePosition: Position | null = null;
  private readonly activeTouches = new Map<bigint, Position>();
  private lastMove = { x: -1, y: -1, buttons: -1 };
  private composing = false;
  private imeGeneration = 0;
  private imeQueue: Promise<void> = Promise.resolve();
  private readonly cleanup: Array<() => void> = [];
  private locks = { capsLock: false, numLock: false };
  private readonly gestures: GestureSession;

  constructor(private readonly o: InputOptions) {
    this.gestures = new GestureSession({
      send: (msg) => o.send(msg),
      requestFrame: (run) => window.requestAnimationFrame(run),
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      setIdle: (run, ms) => window.setTimeout(run, ms),
      clearIdle: (handle) => window.clearTimeout(handle),
    });
    const s = o.surface;
    this.on(s, "pointerdown", (e) => this.onPointerDown(e as PointerEvent));
    this.on(s, "pointermove", (e) => this.onPointerMove(e as PointerEvent));
    this.on(s, "pointerup", (e) => this.onPointerUp(e as PointerEvent));
    this.on(s, "pointercancel", (e) => this.onPointerUp(e as PointerEvent));
    this.on(s, "wheel", (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.on(s, "contextmenu", (e) => e.preventDefault());
    // Prevent back/forward mouse buttons from navigating the webview
    this.on(s, "mouseup", (e) => (e as MouseEvent).button > 2 && e.preventDefault());
    this.on(s, "auxclick", (e) => e.preventDefault());

    const t = o.ime;
    this.on(t, "keydown", (e) => this.onKeyDown(e as KeyboardEvent));
    this.on(t, "keyup", (e) => this.onKeyUp(e as KeyboardEvent));
    this.on(t, "compositionstart", () => (this.composing = true));
    this.on(t, "compositionend", (e) => this.onCompositionEnd(e as CompositionEvent));
    this.on(t, "input", (e) => this.onInput(e as InputEvent));
    this.on(t, "blur", () => this.releaseAll());
    this.focus();
  }

  private on(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.cleanup.push(() => target.removeEventListener(type, fn, opts));
  }

  focus(): void {
    this.o.ime.focus({ preventScroll: true });
  }

  setTrackpadGestures(enabled: boolean): void {
    this.o.trackpadGestures = enabled;
  }

  private position(clientX: number, clientY: number): Position {
    const video = this.o.videoSize();
    const r = this.o.surface.getBoundingClientRect();
    const p = clientToVideo(clientX, clientY, r, video);
    return { x: p.x, y: p.y, width: video.width, height: video.height };
  }

  private ready(): boolean {
    const v = this.o.videoSize();
    return v.width > 0 && v.height > 0;
  }

  // ---- pointer ----

  private sendMouse(action: number, e: PointerEvent, actionButton: number): void {
    const pos = this.position(e.clientX, e.clientY);
    this.lastMousePosition = pos;
    const pressure = this.buttons ? 1 : 0;
    this.o.send(encodeInjectTouch(action, POINTER_ID_MOUSE, pos, pressure, actionButton, this.buttons));
  }

  private sendTouch(action: number, e: PointerEvent): void {
    const pos = this.position(e.clientX, e.clientY);
    const id = e.isPrimary ? POINTER_ID_GENERIC_FINGER : BigInt(e.pointerId);
    if (action === MotionAction.UP || action === MotionAction.CANCEL) this.activeTouches.delete(id);
    else this.activeTouches.set(id, pos);
    this.o.send(encodeInjectTouch(action, id, pos, action === MotionAction.UP || action === MotionAction.CANCEL ? 0 : e.pressure || 1, 0, 0));
  }

  private onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    this.focus();
    if (!this.ready()) return;
    // A tap during a fling must not turn into a second finger.
    this.gestures.finish();
    this.o.surface.setPointerCapture(e.pointerId);
    if (e.pointerType === "touch") {
      this.sendTouch(MotionAction.DOWN, e);
      return;
    }
    const button = buttonFromDomIndex(e.button);
    this.buttons = e.buttons;
    this.sendMouse(MotionAction.DOWN, e, button);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.ready()) return;
    if (e.pointerType === "touch") {
      if (e.buttons) this.sendTouch(MotionAction.MOVE, e);
      return;
    }
    // Chorded button change: another button pressed/released while one is down
    if (e.button >= 0 && e.buttons !== this.buttons) {
      const button = buttonFromDomIndex(e.button);
      const pressed = (e.buttons & button) !== 0;
      this.buttons = e.buttons;
      this.sendMouse(pressed ? MotionAction.DOWN : MotionAction.UP, e, button);
      return;
    }
    const pos = this.position(e.clientX, e.clientY);
    this.lastMousePosition = pos;
    if (pos.x === this.lastMove.x && pos.y === this.lastMove.y && this.buttons === this.lastMove.buttons) return;
    this.lastMove = { x: pos.x, y: pos.y, buttons: this.buttons };
    const action = this.buttons ? MotionAction.MOVE : MotionAction.HOVER_MOVE;
    this.o.send(encodeInjectTouch(action, POINTER_ID_MOUSE, pos, this.buttons ? 1 : 0, 0, this.buttons));
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.o.surface.hasPointerCapture(e.pointerId)) this.o.surface.releasePointerCapture(e.pointerId);
    const action = e.type === "pointercancel" ? MotionAction.CANCEL : MotionAction.UP;
    if (e.pointerType === "touch") {
      if (this.ready()) this.sendTouch(action, e);
      else this.activeTouches.delete(e.isPrimary ? POINTER_ID_GENERIC_FINGER : BigInt(e.pointerId));
      return;
    }
    const button = e.button >= 0 ? buttonFromDomIndex(e.button) : this.buttons;
    this.buttons = action === MotionAction.CANCEL ? 0 : e.buttons;
    if (this.ready()) this.sendMouse(action, e, button);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this.ready()) return;
    if (this.o.trackpadGestures) {
      const kind = classifyWheelInput(e.deltaMode, e.deltaX, e.deltaY, e.ctrlKey);
      if (kind === "swipe") {
        this.gestures.swipe(this.wheelSample(e));
        return;
      }
      if (kind === "pinch") {
        this.gestures.pinch(this.wheelSample(e));
        return;
      }
    }
    this.gestures.finish();
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 800 : 1;
    // Android: AXIS_VSCROLL > 0 scrolls up, AXIS_HSCROLL > 0 scrolls right.
    const v = splitScroll((-e.deltaY * unit) / PIXELS_PER_NOTCH);
    const h = splitScroll((e.deltaX * unit) / PIXELS_PER_NOTCH);
    const pos = this.position(e.clientX, e.clientY);
    const n = Math.max(v.length, h.length);
    for (let i = 0; i < n; i++) {
      this.o.send(encodeInjectScroll(pos, h[i] ?? 0, v[i] ?? 0, this.buttons));
    }
  }

  /** Wheel event → gesture input, in video pixels. */
  private wheelSample(e: WheelEvent): WheelSample {
    const rect = this.o.surface.getBoundingClientRect();
    const video = this.o.videoSize();
    return {
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      position: this.position(e.clientX, e.clientY),
      scaleX: rect.width > 0 ? video.width / rect.width : 1,
      scaleY: rect.height > 0 ? video.height / rect.height : 1,
    };
  }

  // ---- keyboard ----

  private updateLocks(e: KeyboardEvent): void {
    this.locks = { capsLock: e.getModifierState("CapsLock"), numLock: e.getModifierState("NumLock") };
  }

  /** Shared by DOM events and the low-level keyboard hook. */
  handleKey(code: string, key: string, down: boolean, repeat: boolean): void {
    if (!this.ready()) return;
    if (down) {
      this.mods.update(code, true);
      const route = routeKey(code, key, this.mods);
      if (route.kind === "text") {
        this.o.send(encodeInjectText(route.text));
        return;
      }
      if (route.kind === "ignore") return;
      const count = repeat ? (this.repeats.get(code) ?? 0) + 1 : 0;
      this.repeats.set(code, count);
      this.pressedKeys.add(code);
      this.o.send(encodeInjectKeycode(KeyAction.DOWN, route.keycode, count, this.mods.metastate(this.locks)));
    } else {
      const keycode = CODE_TO_KEYCODE[code];
      const wasPressed = this.pressedKeys.delete(code);
      this.repeats.delete(code);
      this.mods.update(code, false);
      if (keycode !== undefined && wasPressed) {
        this.o.send(encodeInjectKeycode(KeyAction.UP, keycode, 0, this.mods.metastate(this.locks)));
      }
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Let the IME consume keys while composing.
    if (e.isComposing || e.keyCode === 229 || this.composing) return;
    this.updateLocks(e);
    if (this.o.onLocalShortcut(e)) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    this.handleKey(e.code, e.key, true, e.repeat);
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return;
    this.updateLocks(e);
    e.preventDefault();
    this.handleKey(e.code, e.key, false, false);
  }

  private onCompositionEnd(e: CompositionEvent): void {
    this.composing = false;
    const text = e.data;
    this.o.ime.value = "";
    if (!text) return;
    this.commitText(text);
  }

  private onInput(e: InputEvent): void {
    // Text inserted without a composition (e.g. emoji picker, dictation)
    if (!e.isComposing && !this.composing && e.data && e.inputType === "insertText") {
      this.commitText(e.data);
    }
    if (!this.composing) this.o.ime.value = "";
  }

  private commitText(text: string): void {
    if (isPlainAscii(text)) {
      this.o.send(encodeInjectText(text));
      return;
    }
    // Non-ASCII: set the device clipboard, then paste with Ctrl+V (the
    // clipboard message is queued before these key events).
    const generation = this.imeGeneration;
    const send = async () => {
      try {
        await this.o.setDeviceClipboard(text);
        if (generation !== this.imeGeneration) return;
        const ctrl = META.CTRL_ON | META.CTRL_LEFT_ON;
        this.o.send(encodeInjectKeycode(KeyAction.DOWN, CODE_TO_KEYCODE.ControlLeft!, 0, ctrl));
        this.o.send(encodeInjectKeycode(KeyAction.DOWN, CODE_TO_KEYCODE.KeyV!, 0, ctrl));
        this.o.send(encodeInjectKeycode(KeyAction.UP, CODE_TO_KEYCODE.KeyV!, 0, ctrl));
        this.o.send(encodeInjectKeycode(KeyAction.UP, CODE_TO_KEYCODE.ControlLeft!, 0, this.mods.metastate(this.locks)));
      } catch (err) {
        console.warn("IME text failed", err);
      }
    };
    // Composition events can arrive faster than the ADB/WebSocket command
    // queue. Serialize clipboard replacement and paste so the paste always
    // follows the replacement for the same text.
    this.imeQueue = this.imeQueue.then(send, send);
  }

  /** Releases every pressed key/button (focus loss), so nothing stays stuck. */
  releaseAll(): void {
    this.imeGeneration++;
    // The gesture is interrupted, not completed: CANCEL keeps the app from
    // treating the last position as a fling or a tap.
    this.gestures.finish(MotionAction.CANCEL);
    for (const code of [...this.pressedKeys]) this.handleKey(code, "", false, false);
    if (this.buttons !== 0 && this.lastMousePosition) {
      this.o.send(encodeInjectTouch(MotionAction.UP, POINTER_ID_MOUSE, this.lastMousePosition, 0, 0, 0));
    }
    this.buttons = 0;
    this.lastMove = { x: -1, y: -1, buttons: -1 };
    for (const [id, position] of this.activeTouches) {
      this.o.send(encodeInjectTouch(MotionAction.CANCEL, id, position, 0, 0, 0));
    }
    this.activeTouches.clear();
    this.mods.clear();
    this.composing = false;
  }

  dispose(): void {
    this.releaseAll();
    for (const fn of this.cleanup.splice(0)) fn();
  }
}
