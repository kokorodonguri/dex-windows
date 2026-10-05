// H.264 decoding with WebCodecs and rendering of the latest frame only.
import { avcCodecFromAnnexB } from "../lib/h264";
import { Flag, type StreamFrame, type VideoSession } from "../lib/stream-protocol";

// Bound queued compressed work when decoding cannot keep up with the stream.
const MAX_DECODE_QUEUE = 8;

export interface VideoStats {
  drawnFrames: number;
  decodedFrames: number;
  droppedFrames: number;
  /** Mean submit → output latency (ms) since the last read. */
  decodeLatencyMs: number;
  queueSize: number;
  codec: string;
  hardware: HardwareAcceleration;
}

export interface VideoCallbacks {
  onSession: (session: VideoSession) => void;
  onFatal: (message: string) => void;
  /** Called when the decoder needs a fresh key frame with config. */
  requestReset: () => void;
}

export class VideoPipeline {
  private decoder: VideoDecoder | null = null;
  private configured = false;
  private waitingKey = true;
  private hardware: HardwareAcceleration = "prefer-hardware";
  private codec = "";
  private pending: VideoFrame | null = null;
  private rafId = 0;
  private readonly submitTimes = new Map<number, number>();
  private latencySum = 0;
  private latencyCount = 0;
  private drawn = 0;
  private decoded = 0;
  private dropped = 0;
  /** Unlike `decoded`, never reset by `takeStats`: tells "never worked" from "failed later". */
  private everDecoded = false;
  private readonly ctx: CanvasRenderingContext2D;
  private closed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cb: VideoCallbacks,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
  }

  private createDecoder(): VideoDecoder {
    return new VideoDecoder({
      output: (frame) => this.onOutput(frame),
      error: (e) => this.onError(e),
    });
  }

  handleSession(session: VideoSession): void {
    if (this.closed) return;
    // New encoder session (start, reset or resize): the next packet carries
    // fresh SPS/PPS, so reconfigure from scratch.
    this.resetDecoder();
    this.cb.onSession(session);
  }

  private resetDecoder(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.pending) {
      this.pending.close();
      this.pending = null;
      this.dropped++;
    }
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.reset();
      } catch {
        /* ignore */
      }
    } else {
      this.decoder = this.createDecoder();
    }
    this.configured = false;
    this.waitingKey = true;
    this.submitTimes.clear();
  }

  handleVideo(frame: StreamFrame): void {
    if (this.closed) return;
    const decoder = this.decoder ?? (this.decoder = this.createDecoder());
    if (this.configured && decoder.decodeQueueSize >= MAX_DECODE_QUEUE) {
      // Dropping arbitrary H.264 deltas corrupts subsequent reference frames.
      // Discard the backlog and wait for fresh config + key frame instead.
      this.dropped += decoder.decodeQueueSize + 1;
      this.resetDecoder();
      this.cb.requestReset();
      return;
    }
    if (!this.configured) {
      if (!(frame.flags & Flag.CONFIG)) {
        this.dropped++;
        return;
      }
      const codec = avcCodecFromAnnexB(frame.payload);
      if (!codec) {
        this.dropped++;
        return;
      }
      this.codec = codec;
      // No `description`: the stream is Annex B (SPS/PPS in-band).
      try {
        decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: this.hardware });
      } catch (e) {
        this.onError(e instanceof DOMException ? e : new DOMException(String(e)));
        return;
      }
      this.configured = true;
    }
    const key = (frame.flags & Flag.KEY) !== 0;
    if (this.waitingKey) {
      if (!key) {
        this.dropped++;
        return;
      }
      this.waitingKey = false;
    }
    this.submitTimes.set(frame.pts, performance.now());
    if (this.submitTimes.size > 240) {
      const first = this.submitTimes.keys().next().value;
      if (first !== undefined) this.submitTimes.delete(first);
    }
    try {
      decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: frame.pts, data: frame.payload }));
    } catch (e) {
      this.onError(e instanceof DOMException ? e : new DOMException(String(e)));
    }
  }

  private onOutput(frame: VideoFrame): void {
    this.decoded++;
    this.everDecoded = true;
    const submitted = this.submitTimes.get(frame.timestamp);
    if (submitted !== undefined) {
      this.submitTimes.delete(frame.timestamp);
      this.latencySum += performance.now() - submitted;
      this.latencyCount++;
    }
    if (this.closed) {
      frame.close();
      return;
    }
    if (this.pending) {
      this.pending.close();
      this.dropped++;
    }
    this.pending = frame;
    if (!this.rafId) this.rafId = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    this.rafId = 0;
    const frame = this.pending;
    this.pending = null;
    if (!frame) return;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    try {
      this.ctx.drawImage(frame, 0, 0, w, h);
    } finally {
      frame.close();
    }
    this.drawn++;
  }

  private onError(e: DOMException): void {
    console.error("VideoDecoder error", e);
    if (this.closed) return;
    this.decoder = null; // a decoder in error state is closed
    this.configured = false;
    this.waitingKey = true;
    if (this.hardware === "prefer-hardware") {
      // Some GPUs/drivers reject a stream: retry in software once.
      this.hardware = "no-preference";
      console.warn("falling back to software decoding");
    } else if (!this.everDecoded) {
      this.cb.onFatal(`映像をデコードできません (${this.codec}): ${e.message}`);
      return;
    }
    this.cb.requestReset();
  }

  /** Returns counters accumulated since the previous call. */
  takeStats(): VideoStats {
    const stats: VideoStats = {
      drawnFrames: this.drawn,
      decodedFrames: this.decoded,
      droppedFrames: this.dropped,
      decodeLatencyMs: this.latencyCount ? this.latencySum / this.latencyCount : 0,
      queueSize: this.decoder && this.decoder.state !== "closed" ? this.decoder.decodeQueueSize : 0,
      codec: this.codec,
      hardware: this.hardware,
    };
    this.drawn = 0;
    this.decoded = 0;
    this.dropped = 0;
    this.latencySum = 0;
    this.latencyCount = 0;
    return stats;
  }

  close(): void {
    this.closed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.pending?.close();
    this.pending = null;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
    this.submitTimes.clear();
  }
}

/** Checks WebCodecs support for the stream formats used by the app. */
export async function checkCodecSupport(): Promise<{ h264: boolean; h264Hardware: boolean; opus: boolean }> {
  const result = { h264: false, h264Hardware: false, opus: false };
  if (typeof VideoDecoder === "undefined") return result;
  try {
    result.h264Hardware = !!(await VideoDecoder.isConfigSupported({ codec: "avc1.640028", hardwareAcceleration: "prefer-hardware" })).supported;
    result.h264 = result.h264Hardware || !!(await VideoDecoder.isConfigSupported({ codec: "avc1.640028" })).supported;
  } catch {
    /* unsupported */
  }
  try {
    if (typeof AudioDecoder !== "undefined") {
      result.opus = !!(await AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 })).supported;
    }
  } catch {
    /* unsupported */
  }
  return result;
}
