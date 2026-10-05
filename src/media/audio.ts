// Opus decoding with WebCodecs, played through the ring-buffer AudioWorklet.
import workletUrl from "./ring-player.worklet.ts?worker&url";

export interface AudioStats {
  bufferedMs: number;
  underruns: number;
  overflows: number;
  active: boolean;
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private decoder: AudioDecoder | null = null;
  private ready: Promise<void> | null = null;
  private streamGeneration = 0;
  private static readonly MAX_DECODE_QUEUE = 32;
  private volume = 1;
  private muted = false;
  private stats: AudioStats = { bufferedMs: 0, underruns: 0, overflows: 0, active: false };

  /** Must be called from a user gesture (autoplay policy). */
  init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
        await ctx.audioWorklet.addModule(workletUrl);
        const node = new AudioWorkletNode(ctx, "ring-player", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { targetMs: 60, maxMs: 200 },
        });
        node.port.onmessage = (e: MessageEvent<Omit<AudioStats, "active">>) => {
          this.stats = { ...e.data, active: this.decoder !== null };
        };
        const gain = ctx.createGain();
        node.connect(gain).connect(ctx.destination);
        this.ctx = ctx;
        this.node = node;
        this.gain = gain;
        this.applyGain();
        if (ctx.state === "suspended") await ctx.resume();
      })();
    }
    return this.ready;
  }

  async resume(): Promise<void> {
    await this.init();
    if (this.ctx?.state === "suspended") await this.ctx.resume();
  }

  setVolume(volume: number, muted: boolean): void {
    this.volume = volume;
    this.muted = muted;
    this.applyGain();
  }

  private applyGain(): void {
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
  }

  /** Config packet: the OpusHead block, passed as `description`. */
  async configure(opusHead: Uint8Array): Promise<void> {
    const generation = ++this.streamGeneration;
    await this.init();
    if (generation !== this.streamGeneration) return;
    this.decoder?.close();
    this.node?.port.postMessage("reset");
    let decoder: AudioDecoder;
    decoder = new AudioDecoder({
      output: (data) => {
        if (this.decoder !== decoder) data.close();
        else this.onOutput(data);
      },
      error: (e) => {
        console.error("AudioDecoder error", e);
        if (this.decoder === decoder) this.decoder = null;
      },
    });
    try {
      decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, description: opusHead.slice() });
      this.decoder = decoder;
    } catch (e) {
      decoder.close();
      console.warn("AudioDecoder configure failed", e);
    }
  }

  decode(pts: number, data: Uint8Array): void {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== "configured") return;
    if (decoder.decodeQueueSize >= AudioPlayer.MAX_DECODE_QUEUE) return;
    try {
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: pts, data }));
    } catch (e) {
      console.warn("AudioDecoder decode failed", e);
      if (this.decoder === decoder) this.decoder = null;
    }
  }

  private onOutput(data: AudioData): void {
    const node = this.node;
    if (!node) {
      data.close();
      return;
    }
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < data.numberOfChannels; ch++) {
      const buf = new Float32Array(data.numberOfFrames);
      data.copyTo(buf, { planeIndex: ch, format: "f32-planar" });
      channels.push(buf);
    }
    data.close();
    node.port.postMessage({ channels }, channels.map((c) => c.buffer as ArrayBuffer));
  }

  getStats(): AudioStats {
    return { ...this.stats, active: this.decoder !== null };
  }

  stopStream(): void {
    this.streamGeneration++;
    this.decoder?.close();
    this.decoder = null;
    this.node?.port.postMessage("reset");
  }

  async close(): Promise<void> {
    this.stopStream();
    this.node?.disconnect();
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.node = null;
    this.gain = null;
    this.ready = null;
  }
}
