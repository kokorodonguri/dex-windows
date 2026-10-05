import { describe, expect, it } from "vitest";
import {
  KeyAction,
  MotionAction,
  MotionButton,
  POINTER_ID_MOUSE,
  TYPE_BACK_OR_SCREEN_ON,
  TYPE_INJECT_KEYCODE,
  TYPE_INJECT_SCROLL_EVENT,
  TYPE_INJECT_TEXT,
  TYPE_INJECT_TOUCH_EVENT,
  buttonFromDomIndex,
  encodeBackOrScreenOn,
  encodeInjectKeycode,
  encodeInjectScroll,
  encodeInjectText,
  encodeInjectTouch,
  floatToI16fp,
  floatToU16fp,
  splitScroll,
  utf8Truncate,
} from "./control-codec";

// Vectors ported from scrcpy app/tests/test_control_msg_serialize.c (v4.1)

const AKEYCODE_ENTER = 66;
const AMETA_SHIFT_ON = 0x01;
const AMETA_SHIFT_LEFT_ON = 0x40;

describe("control message serialization", () => {
  it("INJECT_KEYCODE", () => {
    const buf = encodeInjectKeycode(KeyAction.UP, AKEYCODE_ENTER, 5, AMETA_SHIFT_ON | AMETA_SHIFT_LEFT_ON);
    expect([...buf]).toEqual([
      TYPE_INJECT_KEYCODE,
      0x01, // AKEY_EVENT_ACTION_UP
      0x00, 0x00, 0x00, 0x42, // AKEYCODE_ENTER
      0x00, 0x00, 0x00, 0x05, // repeat
      0x00, 0x00, 0x00, 0x41, // AMETA_SHIFT_ON | AMETA_SHIFT_LEFT_ON
    ]);
  });

  it("INJECT_TEXT", () => {
    const buf = encodeInjectText("hello, world!");
    expect(buf.length).toBe(18);
    expect([...buf]).toEqual([TYPE_INJECT_TEXT, 0x00, 0x00, 0x00, 0x0d, ..."hello, world!"].map((c) => (typeof c === "string" ? c.charCodeAt(0) : c)));
  });

  it("INJECT_TEXT long is truncated to 300 bytes", () => {
    const buf = encodeInjectText("a".repeat(400));
    expect(buf.length).toBe(5 + 300);
    expect([...buf.subarray(0, 5)]).toEqual([TYPE_INJECT_TEXT, 0x00, 0x00, 0x01, 0x2c]);
  });

  it("INJECT_TOUCH_EVENT", () => {
    const buf = encodeInjectTouch(
      MotionAction.DOWN,
      0x1234567887654321n,
      { x: 100, y: 200, width: 1080, height: 1920 },
      1.0,
      MotionButton.PRIMARY,
      MotionButton.PRIMARY,
    );
    expect([...buf]).toEqual([
      TYPE_INJECT_TOUCH_EVENT,
      0x00, // AKEY_EVENT_ACTION_DOWN
      0x12, 0x34, 0x56, 0x78, 0x87, 0x65, 0x43, 0x21, // pointer id
      0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0xc8, // 100 200
      0x04, 0x38, 0x07, 0x80, // 1080 1920
      0xff, 0xff, // pressure
      0x00, 0x00, 0x00, 0x01, // AMOTION_EVENT_BUTTON_PRIMARY (action button)
      0x00, 0x00, 0x00, 0x01, // AMOTION_EVENT_BUTTON_PRIMARY (buttons)
    ]);
  });

  it("INJECT_TOUCH_EVENT mouse pointer id is -1", () => {
    const buf = encodeInjectTouch(MotionAction.HOVER_MOVE, POINTER_ID_MOUSE, { x: 1, y: 2, width: 1920, height: 1080 }, 0, 0, 0);
    expect([...buf.subarray(2, 10)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(buf[1]).toBe(7);
  });

  it("INJECT_SCROLL_EVENT", () => {
    const buf = encodeInjectScroll({ x: 260, y: 1026, width: 1080, height: 1920 }, 16, -16, 1);
    expect([...buf]).toEqual([
      TYPE_INJECT_SCROLL_EVENT,
      0x00, 0x00, 0x01, 0x04, 0x00, 0x00, 0x04, 0x02, // 260 1026
      0x04, 0x38, 0x07, 0x80, // 1080 1920
      0x7f, 0xff, // 16
      0x80, 0x00, // -16
      0x00, 0x00, 0x00, 0x01, // 1
    ]);
  });

  it("BACK_OR_SCREEN_ON", () => {
    expect([...encodeBackOrScreenOn(KeyAction.UP)]).toEqual([TYPE_BACK_OR_SCREEN_ON, 0x01]);
  });
});

describe("fixed point", () => {
  it("u16", () => {
    expect(floatToU16fp(1)).toBe(0xffff);
    expect(floatToU16fp(0)).toBe(0);
    expect(floatToU16fp(0.5)).toBe(0x8000);
    expect(floatToU16fp(2)).toBe(0xffff);
  });
  it("i16", () => {
    expect(floatToI16fp(1)).toBe(0x7fff);
    expect(floatToI16fp(-1)).toBe(-0x8000);
    expect(floatToI16fp(0.5)).toBe(0x4000);
  });
});

describe("helpers", () => {
  it("maps DOM button indexes to Android buttons", () => {
    expect(buttonFromDomIndex(0)).toBe(MotionButton.PRIMARY);
    expect(buttonFromDomIndex(1)).toBe(MotionButton.TERTIARY); // middle
    expect(buttonFromDomIndex(2)).toBe(MotionButton.SECONDARY); // right
    expect(buttonFromDomIndex(3)).toBe(MotionButton.BACK);
    expect(buttonFromDomIndex(4)).toBe(MotionButton.FORWARD);
    expect(buttonFromDomIndex(-1)).toBe(0);
  });

  it("splitScroll keeps each step within [-1, 1]", () => {
    expect(splitScroll(2.5)).toEqual([1, 1, 0.5]);
    expect(splitScroll(-1.2).map((v) => Math.round(v * 10) / 10)).toEqual([-1, -0.2]);
    expect(splitScroll(0.3)).toEqual([0.3]);
    expect(splitScroll(0)).toEqual([]);
    expect(splitScroll(100).length).toBe(16);
  });

  it("utf8Truncate never splits a character", () => {
    const bytes = utf8Truncate("ああ", 4); // 3 bytes each
    expect(bytes.length).toBe(3);
    expect(new TextDecoder().decode(bytes)).toBe("あ");
  });
});
