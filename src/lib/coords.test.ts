import { describe, expect, it } from "vitest";
import { clientToVideo, flexDisplaySize, imeAnchor, letterbox } from "./coords";

const video = { width: 1920, height: 1080 };

describe("letterbox", () => {
  it("pillarboxes a 16:9 video in a 4:3 box", () => {
    const r = letterbox({ left: 0, top: 0, width: 1600, height: 1200 }, video);
    expect(r.scale).toBeCloseTo(1600 / 1920);
    expect(r.left).toBe(0);
    expect(r.top).toBeCloseTo((1200 - 900) / 2);
    expect(r.height).toBeCloseTo(900);
  });

  it("handles an empty video", () => {
    expect(letterbox({ left: 0, top: 0, width: 100, height: 100 }, { width: 0, height: 0 }).scale).toBe(0);
  });
});

describe("clientToVideo", () => {
  const box = { left: 10, top: 20, width: 960, height: 1080 }; // bars top/bottom

  it("maps the center", () => {
    // video drawn at scale 0.5: 960x540, top = 20 + 270
    expect(clientToVideo(10 + 480, 20 + 270 + 270, box, video)).toEqual({ x: 960, y: 540, inside: true });
  });

  it("maps the corners and clamps outside points", () => {
    expect(clientToVideo(10, 290, box, video)).toEqual({ x: 0, y: 0, inside: true });
    expect(clientToVideo(10 + 960, 290 + 540, box, video)).toEqual({ x: 1919, y: 1079, inside: false });
    expect(clientToVideo(0, 0, box, video)).toEqual({ x: 0, y: 0, inside: false });
  });

  it("matches the video after a window resize", () => {
    const full = { left: 0, top: 0, width: 1920, height: 1080 };
    expect(clientToVideo(1000.7, 500.2, full, video)).toEqual({ x: 1000, y: 500, inside: true });
  });
});

describe("flexDisplaySize", () => {
  it("scales by devicePixelRatio and keeps sizes even", () => {
    expect(flexDisplaySize({ width: 1280, height: 720 }, 1.5)).toEqual({ width: 1920, height: 1080 });
    expect(flexDisplaySize({ width: 1281, height: 721 }, 1.25)).toEqual({ width: 1600, height: 900 });
    expect(flexDisplaySize({ width: 1001, height: 601 }, 1)).toEqual({ width: 1000, height: 600 });
  });

  it("caps the largest side", () => {
    const s = flexDisplaySize({ width: 3000, height: 1500 }, 2);
    expect(s.width).toBeLessThanOrEqual(3840);
    expect(s.width / s.height).toBeCloseTo(2, 1);
  });
});

describe("imeAnchor", () => {
  const container = { width: 1000, height: 600 };
  const box = { width: 320, height: 28 };

  it("uses the pointer position when it fits", () => {
    expect(imeAnchor({ x: 100, y: 200 }, container, box)).toEqual({ x: 100, y: 200 });
  });

  it("keeps the box inside the container at every edge", () => {
    expect(imeAnchor({ x: -50, y: -5 }, container, box)).toEqual({ x: 0, y: 0 });
    expect(imeAnchor({ x: 990, y: 599 }, container, box)).toEqual({ x: 680, y: 572 });
  });

  it("falls back to the lower centre before any click", () => {
    expect(imeAnchor(null, container, box)).toEqual({ x: 340, y: 396 });
  });

  it("never returns negative coordinates for a container smaller than the box", () => {
    expect(imeAnchor({ x: 10, y: 10 }, { width: 100, height: 10 }, box)).toEqual({ x: 0, y: 0 });
    expect(imeAnchor(null, { width: 0, height: 0 }, box)).toEqual({ x: 0, y: 0 });
  });
});
