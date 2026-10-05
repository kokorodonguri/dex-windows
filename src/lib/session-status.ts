import type { SessionDeviceStatus } from "./tauri";

/** One request at a time, including on failure. Results belong to one session. */
export function pollSessionStatus(
  sessionId: number,
  request: (id: number) => Promise<SessionDeviceStatus>,
  publish: (locked: boolean | null) => void,
): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const status = await request(sessionId);
      if (!disposed) publish(status.sessionId === sessionId ? status.keyguardShowing : null);
    } catch {
      if (!disposed) publish(null);
    } finally {
      if (!disposed) timer = setTimeout(poll, 3000);
    }
  };
  void poll();
  return () => { disposed = true; clearTimeout(timer); };
}
