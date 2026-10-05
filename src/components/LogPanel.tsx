import { useEffect, useRef, useState } from "react";
import { attachLogger } from "@tauri-apps/plugin-log";
import { RecentBuffer } from "../lib/recent-buffer";
import { Button, Icon } from "./ui";

export interface LogLine {
  id: number;
  level: number; // 1 trace … 5 error (tauri-plugin-log)
  message: string;
  time: string;
}

const levelClass = (level: number) =>
  level >= 5 ? "text-danger" : level === 4 ? "text-warn" : level <= 2 ? "text-label-2" : "text-label";

/** Remains mounted while hidden, without publishing log traffic into Shell. */
export function SessionLog({ open, logDir, onClose }: { open: boolean; logDir: string | null; onClose: () => void }) {
  const [history] = useState(() => new RecentBuffer<LogLine>(800));
  const [lines, setLines] = useState<LogLine[]>([]);
  const revision = useRef(0);
  useEffect(() => {
    let disposed = false;
    const unlisten = attachLogger(({ level, message }) => {
      if (disposed) return;
      history.push({ id: revision.current++, level, message, time: new Date().toLocaleTimeString() });
    });
    return () => { disposed = true; void unlisten.then((fn) => fn()); };
  }, [history]);
  useEffect(() => {
    if (!open) return;
    let lastRevision = revision.current;
    setLines(history.snapshot());
    const timer = window.setInterval(() => {
      if (lastRevision === revision.current) return;
      lastRevision = revision.current;
      setLines(history.snapshot());
    }, 100);
    return () => window.clearInterval(timer);
  }, [open, history]);
  return open ? <LogPanel lines={lines} logDir={logDir} onClose={onClose} /> : null;
}

export function LogPanel({ lines, logDir, onClose }: { lines: LogLine[]; logDir: string | null; onClose: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  // Follow new lines only while the reader is at the bottom; scrolling up to
  // read must not be yanked back by the next log line.
  const following = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="fixed inset-x-4 bottom-4 z-40 flex h-72 flex-col rounded-2xl border border-hairline bg-surface/85 shadow-popover backdrop-blur-xl">
      <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-1.5">
        <div className="min-w-0 truncate text-sm font-medium">
          ログ {logDir && <span className="ml-2 select-text text-xs font-normal text-label-2">{logDir}</span>}
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="閉じる">
          <Icon name="close" />
        </Button>
      </div>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="scroll-thin flex-1 select-text overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
      >
        {lines.length === 0 && <div className="text-label-2">ログはまだありません</div>}
        {lines.map((l) => (
          <div key={l.id} className={levelClass(l.level)}>
            <span className="mr-2 text-label-2">{l.time}</span>
            {l.message}
          </div>
        ))}
      </div>
    </div>
  );
}
