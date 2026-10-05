import { useEffect, useState, type RefObject } from "react";

export interface SessionStats {
  fps: number;
  decodeLatencyMs: number;
  bitrateMbps: number;
  width: number;
  height: number;
  connection: string;
  queue: number;
  dropped: number;
  codec: string;
  hardware: string;
  audioBufferedMs: number | null;
  audioUnderruns: number;
}

export function StatsOverlay({ stats }: { stats: SessionStats | null }) {
  if (!stats) return null;
  const rows: Array<[string, string]> = [
    ["FPS", stats.fps.toFixed(1)],
    ["デコード遅延", `${stats.decodeLatencyMs.toFixed(1)} ms`],
    ["ビットレート", `${stats.bitrateMbps.toFixed(2)} Mbps`],
    ["解像度", `${stats.width}×${stats.height}`],
    ["接続", stats.connection === "wifi" ? "Wi-Fi" : "USB"],
    ["デコードキュー", String(stats.queue)],
    ["スキップ", String(stats.dropped)],
    ["コーデック", `${stats.codec || "-"} (${stats.hardware === "prefer-hardware" ? "HW" : "SW"})`],
    ["音声バッファ", stats.audioBufferedMs === null ? "無効" : `${stats.audioBufferedMs.toFixed(0)} ms / 途切れ ${stats.audioUnderruns}`],
  ];
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-xl border border-white/[0.08] bg-[#1e1e1e]/75 px-3 py-2 font-mono text-[11px] leading-5 text-white shadow-material backdrop-blur-xl">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-6">
          <span className="text-white/60">{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}
export function LiveStatsOverlay({ source }: { source: RefObject<SessionStats | null> }) {
  const [stats, setStats] = useState(source.current);
  useEffect(() => {
    const timer = window.setInterval(() => setStats(source.current), 1000);
    return () => window.clearInterval(timer);
  }, [source]);
  return <StatsOverlay stats={stats} />;
}
