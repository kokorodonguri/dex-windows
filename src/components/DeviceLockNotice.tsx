import { useEffect, useState } from "react";
import { api } from "../lib/tauri";
import { pollSessionStatus } from "../lib/session-status";

/** Diagnostics update locally; they never restart the stream or redraw Shell. */
export function DeviceLockNotice({ sessionId }: { sessionId: number }) {
  const [locked, setLocked] = useState<boolean | null>(null);
  useEffect(() => {
    setLocked(null);
    return pollSessionStatus(sessionId, api.getSessionDeviceStatus, setLocked);
  }, [sessionId]);

  if (locked !== true) return null;
  return (
    <div role="status" className="pointer-events-none absolute inset-x-4 bottom-16 z-20 mx-auto max-w-lg rounded-2xl border border-white/[0.08] bg-[#1e1e1e]/85 px-4 py-3 text-white shadow-popover backdrop-blur-xl">
      <p className="text-sm font-medium text-[#ff9f0a]">スマホ本体のロックを解除してください</p>
      <p className="mt-1 text-xs leading-5 text-white/75">ロック中は、PCに画面が映っていてもアプリの起動やホーム操作が制限される場合があります。解除するとこの案内は自動で消えます。</p>
    </div>
  );
}
