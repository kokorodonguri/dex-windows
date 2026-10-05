// Frames sent by Rust over the /stream WebSocket:
// [kind u8][flags u8][pts u64 BE][payload]  (see src-tauri/src/demuxer.rs)

export const WS_HEADER_LEN = 10;

export const Kind = {
  VIDEO_SESSION: 0,
  VIDEO: 1,
  AUDIO_CONFIG: 2,
  AUDIO: 3,
  AUDIO_DISABLED: 4,
} as const;

export const Flag = {
  KEY: 1,
  CONFIG: 2,
  CLIENT_RESIZED: 4,
} as const;

export interface StreamFrame {
  kind: number;
  flags: number;
  /** Presentation timestamp in microseconds. */
  pts: number;
  payload: Uint8Array;
}

export function parseFrame(buffer: ArrayBuffer): StreamFrame | null {
  if (buffer.byteLength < WS_HEADER_LEN) return null;
  const view = new DataView(buffer);
  return {
    kind: view.getUint8(0),
    flags: view.getUint8(1),
    pts: Number(view.getBigUint64(2)),
    payload: new Uint8Array(buffer, WS_HEADER_LEN),
  };
}

export interface VideoSession {
  width: number;
  height: number;
  clientResized: boolean;
}

export function parseSession(frame: StreamFrame): VideoSession | null {
  if (frame.payload.length < 8) return null;
  const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  if (width < 320 || width > 7680 || height < 240 || height > 4320) return null;
  return { width, height, clientResized: (frame.flags & Flag.CLIENT_RESIZED) !== 0 };
}
