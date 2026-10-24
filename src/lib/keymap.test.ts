import { describe, expect, it } from "vitest";
import { CODE_TO_KEYCODE, META, ModifierState, routeKey } from "./keymap";

const noLocks = { capsLock: false, numLock: false };

describe("keymap", () => {
  it("maps common codes to Android keycodes", () => {
    expect(CODE_TO_KEYCODE.KeyA).toBe(29);
    expect(CODE_TO_KEYCODE.KeyZ).toBe(54);
    expect(CODE_TO_KEYCODE.Digit0).toBe(7);
    expect(CODE_TO_KEYCODE.Enter).toBe(66);
    expect(CODE_TO_KEYCODE.Backspace).toBe(67); // AKEYCODE_DEL
    expect(CODE_TO_KEYCODE.Delete).toBe(112); // AKEYCODE_FORWARD_DEL
    expect(CODE_TO_KEYCODE.Escape).toBe(111);
    expect(CODE_TO_KEYCODE.MetaLeft).toBe(117);
    expect(CODE_TO_KEYCODE.F12).toBe(142);
    expect(CODE_TO_KEYCODE.NumpadEnter).toBe(160);
    expect(CODE_TO_KEYCODE.Convert).toBe(214); // HENKAN
  });

  it("computes metastate with left/right modifiers", () => {
    const m = new ModifierState();
    m.update("ShiftLeft", true);
    expect(m.metastate(noLocks)).toBe(META.SHIFT_ON | META.SHIFT_LEFT_ON);
    m.update("ControlRight", true);
    expect(m.metastate(noLocks)).toBe(META.SHIFT_ON | META.SHIFT_LEFT_ON | META.CTRL_ON | META.CTRL_RIGHT_ON);
    m.update("ShiftLeft", false);
    m.update("MetaLeft", true);
    expect(m.metastate({ capsLock: true, numLock: true })).toBe(
      META.CTRL_ON | META.CTRL_RIGHT_ON | META.META_ON | META.META_LEFT_ON | META.CAPS_LOCK_ON | META.NUM_LOCK_ON,
    );
    m.update("KeyA", true); // not a modifier
    expect(m.pressedCodes().sort()).toEqual(["ControlRight", "MetaLeft"]);
  });

  it("routes letters as keycodes and punctuation as text", () => {
    const m = new ModifierState();
    expect(routeKey("KeyA", "a", m)).toEqual({ kind: "keycode", keycode: 29 });
    expect(routeKey("Space", " ", m)).toEqual({ kind: "keycode", keycode: 62 });
    // JIS layout: Shift+2 produces '"'
    m.update("ShiftLeft", true);
    expect(routeKey("Digit2", '"', m)).toEqual({ kind: "text", text: '"' });
    expect(routeKey("BracketLeft", "`", m)).toEqual({ kind: "text", text: "`" });
    // JIS 半角/全角 toggles the PC IME; it must not reach the device as "`"
    for (const key of ["Zenkaku", "Hankaku", "ZenkakuHankaku", "KanjiMode"]) {
      expect(routeKey("Backquote", key, m)).toEqual({ kind: "ignore" });
    }
    expect(routeKey("Backquote", "`", m)).toEqual({ kind: "text", text: "`" });
    m.update("ShiftLeft", false);
    expect(routeKey("ArrowLeft", "ArrowLeft", m)).toEqual({ kind: "keycode", keycode: 21 });
  });

  it("routes shortcuts as keycodes", () => {
    const m = new ModifierState();
    m.update("ControlLeft", true);
    expect(routeKey("Digit1", "1", m)).toEqual({ kind: "keycode", keycode: 8 });
    expect(routeKey("KeyC", "c", m)).toEqual({ kind: "keycode", keycode: 31 });
  });

  it("ignores unknown codes", () => {
    expect(routeKey("Unidentified", "Unidentified", new ModifierState())).toEqual({ kind: "ignore" });
  });
});
