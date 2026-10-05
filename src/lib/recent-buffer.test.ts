import { describe, expect, it } from "vitest";
import { RecentBuffer } from "./recent-buffer";

describe("RecentBuffer", () => {
  it("keeps the newest items in chronological order across repeated wraps", () => {
    const buffer = new RecentBuffer<number>(3);
    expect(buffer.snapshot()).toEqual([]);
    buffer.push(0);
    const snapshot = buffer.snapshot();
    for (let i = 1; i < 100; i++) buffer.push(i);
    expect(buffer.snapshot()).toEqual([97, 98, 99]);
    expect(snapshot).toEqual([0]);
  });
  it("handles capacity one and rejects invalid capacities", () => {
    const buffer = new RecentBuffer<number>(1);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.snapshot()).toEqual([2]);
    for (const n of [0, -1, 1.5, NaN]) expect(() => new RecentBuffer(n)).toThrow();
  });
});
