import { describe, expect, it } from "vitest";
import { Flag, Kind, parseFrame, parseSession } from "./stream-protocol";

function frame(kind: number, flags: number, pts: bigint, payload: number[]): ArrayBuffer {
  const buf = new Uint8Array(10 + payload.length);
  const view = new DataView(buf.buffer);
  buf[0] = kind;
  buf[1] = flags;
  view.setBigUint64(2, pts);
  buf.set(payload, 10);
  return buf.buffer;
}

describe("stream protocol", () => {
  it("parses media frames", () => {
    const f = parseFrame(frame(Kind.VIDEO, Flag.KEY | Flag.CONFIG, 123456789n, [0, 0, 0, 1, 0x65]))!;
    expect(f.kind).toBe(Kind.VIDEO);
    expect(f.flags & Flag.KEY).toBeTruthy();
    expect(f.pts).toBe(123456789);
    expect([...f.payload]).toEqual([0, 0, 0, 1, 0x65]);
  });

  it("parses session frames", () => {
    const f = parseFrame(frame(Kind.VIDEO_SESSION, Flag.CLIENT_RESIZED, 0n, [0, 0, 0x07, 0x80, 0, 0, 0x04, 0x38]))!;
    expect(parseSession(f)).toEqual({ width: 1920, height: 1080, clientResized: true });
  });

  it("rejects short buffers", () => {
    expect(parseFrame(new ArrayBuffer(4))).toBeNull();
  });

  it("rejects impossible session dimensions", () => {
    const f = parseFrame(frame(Kind.VIDEO_SESSION, 0, 0n, [0, 0, 0, 1, 0, 0, 0, 1080]))!;
    expect(parseSession(f)).toBeNull();
  });
});
