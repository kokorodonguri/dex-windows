// AudioWorklet: plays decoded PCM from a ring buffer, keeping latency near a
// target (~60 ms). On overflow the oldest samples are dropped; on underrun
// playback pauses until the target is buffered again.

// Minimal AudioWorkletGlobalScope typings (kept local so they do not clash
// with the DOM lib used by the rest of the project).
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: Options }) => AudioWorkletProcessorBase): void;
declare class AudioWorkletProcessorBase {
  readonly port: MessagePort;
}
declare const AudioWorkletProcessor: typeof AudioWorkletProcessorBase;

interface Options {
  targetMs?: number;
  maxMs?: number;
}

interface PcmMessage {
  channels: Float32Array[];
}

const CHANNELS = 2;

class RingPlayer extends AudioWorkletProcessor {
  private readonly capacity: number;
  private readonly buffers: Float32Array[];
  private readIdx = 0;
  private writeIdx = 0;
  private count = 0;
  private playing = false;
  private readonly target: number;
  private readonly max: number;
  private underruns = 0;
  private overflows = 0;
  private framesSinceReport = 0;

  constructor(options: { processorOptions?: Options }) {
    super();
    const opts = options.processorOptions ?? {};
    this.target = Math.round((sampleRate * (opts.targetMs ?? 60)) / 1000);
    this.max = Math.round((sampleRate * (opts.maxMs ?? 200)) / 1000);
    this.capacity = sampleRate; // 1 s
    this.buffers = Array.from({ length: CHANNELS }, () => new Float32Array(this.capacity));
    this.port.onmessage = (e: MessageEvent<PcmMessage | "reset">) => {
      if (e.data === "reset") {
        this.readIdx = this.writeIdx = this.count = 0;
        this.playing = false;
      } else {
        this.push(e.data.channels);
      }
    };
  }

  private push(channels: Float32Array[]): void {
    const first = channels[0];
    if (!first) return;
    const n = Math.min(first.length, this.capacity);
    for (let ch = 0; ch < CHANNELS; ch++) {
      const src = channels[Math.min(ch, channels.length - 1)]!;
      const dst = this.buffers[ch]!;
      let w = this.writeIdx;
      for (let i = first.length - n; i < first.length; i++) {
        dst[w] = src[i] ?? 0;
        if (++w === this.capacity) w = 0;
      }
    }
    this.writeIdx = (this.writeIdx + n) % this.capacity;
    this.count = Math.min(this.count + n, this.capacity);
    if (this.count > this.max) {
      // Too much latency accumulated: skip ahead to the target.
      const drop = this.count - this.target;
      this.readIdx = (this.readIdx + drop) % this.capacity;
      this.count -= drop;
      this.overflows++;
    }
    // A full ring would have overwritten unread samples: keep indices sane.
    if (this.count === this.capacity) this.readIdx = this.writeIdx;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const frames = out[0]!.length;

    if (!this.playing && this.count >= this.target) this.playing = true;
    if (this.playing && this.count < frames) {
      this.playing = false;
      this.underruns++;
    }

    if (this.playing) {
      for (let ch = 0; ch < out.length; ch++) {
        const dst = out[ch]!;
        const src = this.buffers[Math.min(ch, CHANNELS - 1)]!;
        let r = this.readIdx;
        for (let i = 0; i < frames; i++) {
          dst[i] = src[r]!;
          if (++r === this.capacity) r = 0;
        }
      }
      this.readIdx = (this.readIdx + frames) % this.capacity;
      this.count -= frames;
    } else {
      for (const dst of out) dst.fill(0);
    }

    this.framesSinceReport += frames;
    if (this.framesSinceReport >= sampleRate / 2) {
      this.framesSinceReport = 0;
      this.port.postMessage({ bufferedMs: (this.count / sampleRate) * 1000, underruns: this.underruns, overflows: this.overflows });
    }
    return true;
  }
}

registerProcessor("ring-player", RingPlayer);

export {};
