import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { events, type TransferEvent } from "../lib/tauri";

type Tone = "info" | "success" | "error";

interface Toast {
  id: number;
  tone: Tone;
  title: string;
  detail?: string;
  /** 0..1 for transfers */
  progress?: number;
}

interface ToastApi {
  show: (tone: Tone, title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export const useToast = () => useContext(ToastContext);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, number>());

  const dismissLater = useCallback((id: number, ms: number) => {
    const old = timers.current.get(id);
    if (old) window.clearTimeout(old);
    timers.current.set(
      id,
      window.setTimeout(() => {
        timers.current.delete(id);
        setToasts((list) => list.filter((t) => t.id !== id));
      }, ms),
    );
  }, []);

  const show = useCallback(
    (tone: Tone, title: string, detail?: string) => {
      const id = nextId++;
      setToasts((list) => [...list.slice(-5), { id, tone, title, detail }]);
      dismissLater(id, tone === "error" ? 8000 : 4000);
    },
    [dismissLater],
  );

  // File transfer progress toasts (ids offset to avoid collisions)
  useEffect(() => {
    const un = events.transfer((e: TransferEvent) => {
      const id = 1_000_000 + e.id;
      setToasts((list) => {
        const rest = list.filter((t) => t.id !== id);
        let toast: Toast;
        switch (e.state) {
          case "queued":
            toast = { id, tone: "info", title: e.name, detail: "転送待ち", progress: 0 };
            break;
          case "progress":
            toast = { id, tone: "info", title: e.name, detail: `${formatBytes(e.sent)} / ${formatBytes(e.total)}`, progress: e.total ? e.sent / e.total : 1 };
            break;
          case "done":
            toast = { id, tone: "success", title: e.name, detail: `転送完了 → ${e.remote}`, progress: 1 };
            break;
          case "error":
            toast = { id, tone: "error", title: e.name, detail: e.error };
            break;
        }
        return [...rest.slice(-8), toast];
      });
      if (e.state === "done") dismissLater(id, 4000);
      if (e.state === "error") dismissLater(id, 10000);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [dismissLater]);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            // A click on a toast must not take the focus off the DeX input sink (IME off on <body>).
            onMouseDown={(e) => e.preventDefault()}
            className="pointer-events-auto rounded-2xl border border-hairline bg-surface/80 px-3.5 py-2.5 text-sm shadow-popover backdrop-blur-xl"
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${t.tone === "error" ? "bg-danger" : t.tone === "success" ? "bg-ok" : "bg-accent"}`} />
              <span className="truncate font-medium">{t.title}</span>
            </div>
            {t.detail && <div className="mt-0.5 break-words text-xs text-label-2">{t.detail}</div>}
            {t.progress !== undefined && t.tone === "info" && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-fill">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(t.progress * 100)}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
