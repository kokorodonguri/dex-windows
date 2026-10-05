import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pollSessionStatus } from "./session-status";
import type { SessionDeviceStatus } from "./tauri";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("does not overlap slow requests and discards responses after disconnect", async () => {
  let resolve!: (status: SessionDeviceStatus) => void;
  const request = vi.fn(() => new Promise<SessionDeviceStatus>((done) => { resolve = done; }));
  const publish = vi.fn();
  const stop = pollSessionStatus(7, request, publish);
  await vi.advanceTimersByTimeAsync(30000);
  expect(request).toHaveBeenCalledTimes(1);
  stop();
  resolve({ sessionId: 7, keyguardShowing: true });
  await vi.advanceTimersByTimeAsync(6000);
  expect(publish).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

it("handles lock changes, failed diagnostics, and a stale session ID", async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ sessionId: 7, keyguardShowing: true })
    .mockResolvedValueOnce({ sessionId: 7, keyguardShowing: false })
    .mockRejectedValueOnce(new Error("ADB unavailable"))
    .mockResolvedValueOnce({ sessionId: 8, keyguardShowing: false });
  const publish = vi.fn();
  const stop = pollSessionStatus(7, request, publish);
  await vi.advanceTimersByTimeAsync(9000);
  expect(publish.mock.calls).toEqual([[true], [false], [null], [null]]);
  stop();
  await vi.advanceTimersByTimeAsync(9000);
  expect(request).toHaveBeenCalledTimes(4);
});
