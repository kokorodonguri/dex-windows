import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoPipeline } from "./video";
import { Flag, Kind } from "../lib/stream-protocol";

let decoder: FakeDecoder;
class FakeDecoder {
  state = "unconfigured";
  decodeQueueSize = 0;
  decode = vi.fn(() => { this.decodeQueueSize++; });
  configure = vi.fn(() => { this.state = "configured"; });
  reset = vi.fn(() => { this.decodeQueueSize = 0; this.state = "unconfigured"; });
  close = vi.fn(() => { this.state = "closed"; });
  constructor(readonly callbacks: { output: (frame: VideoFrame) => void; error: (e: DOMException) => void }) { decoder = this; }
}
const packet = (pts: number, flags = 0) => ({
  kind: Kind.VIDEO, pts, flags, payload: new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0, 0x28]),
});
beforeEach(() => {
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal("EncodedVideoChunk", class { constructor(readonly init: unknown) {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const requestReset = vi.fn();
  const onFatal = vi.fn();
  const pipeline = new VideoPipeline({ getContext: () => ({ drawImage: vi.fn() }) } as unknown as HTMLCanvasElement,
    { requestReset, onSession: vi.fn(), onFatal });
  pipeline.handleVideo(packet(0, Flag.CONFIG | Flag.KEY));
  return { pipeline, requestReset, onFatal };
}

it("bounds decoder work and resumes only with config and a key frame", () => {
  const { pipeline, requestReset } = setup();
  for (let i = 1; i <= 100; i++) pipeline.handleVideo(packet(i));
  expect(decoder.decode).toHaveBeenCalledTimes(8);
  expect(decoder.reset).toHaveBeenCalledTimes(1);
  expect(requestReset).toHaveBeenCalledTimes(1);
  pipeline.handleVideo(packet(101, Flag.KEY));
  expect(decoder.decode).toHaveBeenCalledTimes(8);
  pipeline.handleVideo(packet(102, Flag.CONFIG | Flag.KEY));
  expect(decoder.decode).toHaveBeenCalledTimes(9);
  pipeline.close();
});

it("releases a pending frame on reset and ignores sessions after close", () => {
  const { pipeline } = setup();
  const close = vi.fn();
  decoder.callbacks.output({ timestamp: 0, close } as unknown as VideoFrame);
  pipeline.handleSession({ width: 1920, height: 1080, clientResized: false });
  expect(close).toHaveBeenCalledTimes(1);
  expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  pipeline.close();
  const previous = decoder;
  pipeline.handleSession({ width: 800, height: 600, clientResized: true });
  expect(decoder).toBe(previous);
});

const decoderError = () => new DOMException("decode failed");
const outputFrame = (pts: number) => ({ timestamp: pts, displayWidth: 1, displayHeight: 1, close: vi.fn() }) as unknown as VideoFrame;

it("treats a decoder error as fatal only when nothing was ever decoded", () => {
  const { pipeline, onFatal } = setup();
  decoder.callbacks.error(decoderError()); // hardware → software fallback
  pipeline.handleVideo(packet(1, Flag.CONFIG | Flag.KEY));
  decoder.callbacks.error(decoderError()); // software also fails, no frame yet
  expect(onFatal).toHaveBeenCalledTimes(1);
  pipeline.close();
});

it("keeps the session alive on a decoder error after frames were decoded, even after stats were read", () => {
  const { pipeline, requestReset, onFatal } = setup();
  decoder.callbacks.error(decoderError()); // hardware → software fallback
  pipeline.handleVideo(packet(1, Flag.CONFIG | Flag.KEY));
  decoder.callbacks.output(outputFrame(1));
  pipeline.takeStats(); // the 1 s stats timer resets its counters
  decoder.callbacks.error(decoderError());
  expect(onFatal).not.toHaveBeenCalled();
  expect(requestReset).toHaveBeenCalledTimes(2);
  pipeline.close();
});
