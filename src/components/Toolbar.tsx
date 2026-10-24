import { useEffect, useRef } from "react";
import { Icon } from "./ui";

interface Props {
  visible: boolean; menuOpen: boolean; connected: boolean; deviceName: string; fullscreen: boolean;
  volume: number; muted: boolean; audio: boolean; statsVisible: boolean; phoneScreenOff: boolean;
  onShow: () => void; onInteractionChange: (active: boolean) => void; onMenuOpenChange: (open: boolean) => void;
  onTogglePhoneScreen: () => void; onBack: () => void; onHome: () => void; onRecents: () => void;
  onVolume: (v: number) => void; onToggleMute: () => void; onToggleStats: () => void;
  onToggleFullscreen: () => void; onOpenSettings: () => void; onOpenLog: () => void;
  onOpenGuide: () => void; onOpenApps: () => void; onDisconnect: () => void;
}

/** Every clickable control on the bar shares this look (size, hover, focus, disabled). */
const barButton = "flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-white/95 transition-colors hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white disabled:pointer-events-none disabled:opacity-40";

function NavButton({ onClick, label, icon, disabled }: { onClick: () => void; label: string; icon: "back" | "home" | "recents"; disabled: boolean }) {
  return <button type="button" disabled={disabled} onClick={onClick} className={barButton}><Icon name={icon} /><span>{label}</span></button>;
}

type MenuIcon = "phone" | "stats" | "fullscreen" | "exitFullscreen" | "settings" | "log" | "help" | "power";
function MenuButton({ icon, label, detail, active, danger, onClick }: { icon: MenuIcon; label: string; detail?: string; active?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-accent ${danger ? "text-[#ff453a]" : "text-white/95"}`}>
      <span className={`rounded-md p-1.5 ${active ? "bg-accent text-white" : "bg-white/8 text-white/75"}`}><Icon name={icon} /></span>
      <span className="min-w-0 flex-1"><span className="block">{label}</span>{detail && <span className="block text-[11px] text-white/50">{detail}</span>}</span>
      {active && <span className="text-[11px] text-accent">ON</span>}
    </button>
  );
}

export function Toolbar(p: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!p.menuOpen) return;
    const outside = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) p.onMenuOpenChange(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") p.onMenuOpenChange(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [p.menuOpen, p.onMenuOpenChange]);
  const run = (action: () => void) => { p.onMenuOpenChange(false); action(); };

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-2 pt-2" onMouseEnter={() => p.onInteractionChange(true)} onMouseLeave={() => p.onInteractionChange(false)}>
      <button type="button" aria-label="操作バーを表示" title="操作バーを表示" inert={p.visible} onClick={p.onShow} onMouseDown={(e) => e.preventDefault()} className={`absolute top-0 h-3 w-24 rounded-b-lg border-x border-b border-white/15 bg-[#1e1e1e]/75 backdrop-blur-xl transition-all hover:h-4 ${p.visible ? "pointer-events-none opacity-0" : "pointer-events-auto opacity-100"}`}><span className="sr-only">操作バーを表示</span></button>
      <div aria-hidden={!p.visible} inert={!p.visible} className={`relative max-w-full transition-all duration-200 ${p.visible ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-16 opacity-0"}`} onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
        {/* The material lives on this element only: a backdrop-filter nested inside another one cannot see what is behind the page, so the menu below is its sibling. */}
        <div className="flex items-center gap-1 rounded-2xl border border-white/[0.08] bg-[#1e1e1e]/75 px-2 py-1 shadow-popover backdrop-blur-xl">
        <span role="img" aria-label={p.connected ? "接続済み" : "接続中"} title={p.connected ? "接続済み" : "接続中"} className={`ml-1 h-2 w-2 shrink-0 rounded-full ${p.connected ? "bg-[#30d158]" : "animate-pulse bg-[#ff9f0a]"}`} />
        <span className="hidden max-w-32 truncate px-1 text-xs text-white/70 md:block">{p.deviceName}</span>
        <div className="mx-1 h-6 w-px bg-white/[0.12]" />
        <NavButton label="戻る" icon="back" disabled={!p.connected} onClick={p.onBack} />
        <NavButton label="ホーム" icon="home" disabled={!p.connected} onClick={p.onHome} />
        <NavButton label="履歴" icon="recents" disabled={!p.connected} onClick={p.onRecents} />
        <button type="button" disabled={!p.connected} onClick={p.onOpenApps} className={barButton}><Icon name="apps" /><span>アプリ</span></button>
        {p.audio && <><div className="mx-1 h-6 w-px bg-white/[0.12]" /><button type="button" aria-label={p.muted ? "ミュート解除" : "ミュート"} title={p.muted ? "ミュート解除" : "ミュート"} onClick={p.onToggleMute} className={barButton}><Icon name={p.muted ? "mute" : "volume"} /></button><input type="range" min={0} max={1} step={0.05} value={p.volume} onChange={(e) => p.onVolume(Number(e.target.value))} onPointerUp={(e) => e.currentTarget.blur()} className="hidden w-16 accent-accent sm:block" aria-label="音量" /></>}
        <div className="mx-1 h-6 w-px bg-white/[0.12]" />
        <button type="button" aria-haspopup="menu" aria-expanded={p.menuOpen} onClick={() => p.onMenuOpenChange(!p.menuOpen)} className={`${barButton} ${p.menuOpen ? "bg-white/15" : ""}`}><Icon name="more" /> その他</button>
        </div>
        {p.menuOpen && <div role="menu" className="absolute right-0 top-[calc(100%+8px)] w-72 rounded-2xl border border-white/[0.08] bg-[#1e1e1e]/85 p-1.5 shadow-popover backdrop-blur-xl">
          <div className="mb-1 px-3 py-1 text-[11px] text-white/45">表示と操作</div>
          <MenuButton icon="phone" active={p.phoneScreenOff} label={p.phoneScreenOff ? "スマホ画面をオン" : "スマホ画面をオフ"} detail="DeX はそのまま動作します" onClick={() => run(p.onTogglePhoneScreen)} />
          <MenuButton icon="stats" active={p.statsVisible} label="パフォーマンス統計" detail="Ctrl+Shift+S" onClick={() => run(p.onToggleStats)} />
          <MenuButton icon={p.fullscreen ? "exitFullscreen" : "fullscreen"} active={p.fullscreen} label={p.fullscreen ? "全画面を終了" : "全画面表示"} detail="F11" onClick={() => run(p.onToggleFullscreen)} />
          <div className="my-1 h-px bg-white/[0.08]" />
          <MenuButton icon="settings" label="設定" onClick={() => run(p.onOpenSettings)} /><MenuButton icon="log" label="ログ" onClick={() => run(p.onOpenLog)} /><MenuButton icon="help" label="操作ガイド" onClick={() => run(p.onOpenGuide)} />
          <div className="my-1 h-px bg-white/[0.08]" /><MenuButton icon="power" danger label="DeX を切断" onClick={() => run(p.onDisconnect)} />
        </div>}
      </div>
    </div>
  );
}
