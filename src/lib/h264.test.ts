import { describe, expect, it } from "vitest";
import { avcCodecFromAnnexB, containsIdr, nalUnits } from "./h264";

const sps = [0x67, 0x64, 0x00, 0x28, 0xac, 0xd9]; // High profile, level 4.0
const pps = [0x68, 0xee, 0x3c, 0x80];
const idr = [0x65, 0x88, 0x84];

describe("h264", () => {
  it("splits NAL units with 3- and 4-byte start codes", () => {
    const data = new Uint8Array([0, 0, 0, 1, ...sps, 0, 0, 1, ...pps, 0, 0, 0, 1, ...idr]);
    const units = [...nalUnits(data)].map((u) => [...u]);
    expect(units).toEqual([sps, pps, idr]);
  });

  it("derives the codec string from the SPS", () => {
    const data = new Uint8Array([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 0, 1, ...idr]);
    expect(avcCodecFromAnnexB(data)).toBe("avc1.640028");
    // Constrained Baseline 3.1
    expect(avcCodecFromAnnexB(new Uint8Array([0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0x00]))).toBe("avc1.42c01f");
  });

  it("returns null without an SPS", () => {
    expect(avcCodecFromAnnexB(new Uint8Array([0, 0, 0, 1, ...idr]))).toBeNull();
    expect(avcCodecFromAnnexB(new Uint8Array([]))).toBeNull();
  });

  it("detects IDR slices", () => {
    expect(containsIdr(new Uint8Array([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...idr]))).toBe(true);
    expect(containsIdr(new Uint8Array([0, 0, 0, 1, 0x41, 0x9a]))).toBe(false);
  });
});
