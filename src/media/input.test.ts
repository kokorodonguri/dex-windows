import { afterEach, describe, expect, it, vi } from "vitest";
import { MotionAction } from "../lib/control-codec";
import { InputController } from "./input";

class Target {
  private readonly handlers = new Map<string, EventListener>();
  addEventListener(type: string, handler: EventListener): void { this.handlers.set(type, handler); }
  removeEventListener(type: string): void { this.handlers.delete(type); }
  dispatch(type: string, event: unknown): void { this.handlers.get(type)?.(event as Event); }
  focus(): void {}
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 1920, height: 1080 } as DOMRect;
  }
  setPointerCapture(): void {}
  hasPointerCapture(): boolean { return false; }
  releasePointerCapture(): void {}
}

function pointer(pointerType: "mouse" | "touch") {
  return {
    pointerType,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: pointerType === "mouse" ? 1 : 1,
    clientX: 100,
    clientY: 100,
    pressure: 1,
    type: "pointerdown",
    preventDefault: vi.fn(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("InputController focus cleanup", () => {
  it("releases a held mouse button when the IME target loses focus", () => {
    const window = {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    };
    vi.stubGlobal("window", window);
    const surface = new Target();
    const ime = new Target();
    const messages: Uint8Array[] = [];
    new InputController({
      surface: surface as unknown as HTMLElement,
      ime: ime as unknown as HTMLTextAreaElement,
      send: (message) => messages.push(message),
      videoSize: () => ({ width: 1920, height: 1080 }),
      setDeviceClipboard: async () => {},
      onLocalShortcut: () => false,
      trackpadGestures: false,
    });

    surface.dispatch("pointerdown", pointer("mouse"));
    ime.dispatch("blur", {});

    expect(messages.map((message) => message[1])).toEqual([MotionAction.DOWN, MotionAction.UP]);
    const release = messages[1]!;
    expect(new DataView(release.buffer, release.byteOffset, release.byteLength).getUint32(28)).toBe(0);
  });

  it("cancels active touch contacts on focus loss", () => {
    const window = {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    };
    vi.stubGlobal("window", window);
    const surface = new Target();
    const ime = new Target();
    const messages: Uint8Array[] = [];
    new InputController({
      surface: surface as unknown as HTMLElement,
      ime: ime as unknown as HTMLTextAreaElement,
      send: (message) => messages.push(message),
      videoSize: () => ({ width: 1920, height: 1080 }),
      setDeviceClipboard: async () => {},
      onLocalShortcut: () => false,
      trackpadGestures: false,
    });

    surface.dispatch("pointerdown", pointer("touch"));
    ime.dispatch("blur", {});

    expect(messages.map((message) => message[1])).toEqual([MotionAction.DOWN, MotionAction.CANCEL]);
  });

  it("serializes non-ASCII IME clipboard replacements before pasting", async () => {
    const window = {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    };
    vi.stubGlobal("window", window);
    const surface = new Target();
    const ime = new Target();
    const messages: Uint8Array[] = [];
    const resolvers: Array<() => void> = [];
    new InputController({
      surface: surface as unknown as HTMLElement,
      ime: ime as unknown as HTMLTextAreaElement,
      send: (message) => messages.push(message),
      videoSize: () => ({ width: 1920, height: 1080 }),
      setDeviceClipboard: async () => await new Promise<void>((resolve) => resolvers.push(resolve)),
      onLocalShortcut: () => false,
      trackpadGestures: false,
    });

    ime.dispatch("compositionend", { data: "あ" });
    ime.dispatch("compositionend", { data: "い" });
    await Promise.resolve();
    expect(resolvers).toHaveLength(1);
    expect(messages).toHaveLength(0);

    resolvers[0]!();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(resolvers).toHaveLength(2);
    expect(messages).toHaveLength(4);
  });
});
