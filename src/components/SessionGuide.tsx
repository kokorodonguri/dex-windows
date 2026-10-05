import { Button, Icon } from "./ui";

export const SESSION_GUIDE_KEY = "modern-dex.session-guide.v1";

export function hasSeenSessionGuide(storage: Pick<Storage, "getItem">): boolean {
  return storage.getItem(SESSION_GUIDE_KEY) === "done";
}

export function markSessionGuideSeen(storage: Pick<Storage, "setItem">): void {
  storage.setItem(SESSION_GUIDE_KEY, "done");
}

export function SessionGuide({ onClose }: { onClose: () => void }) {
  const items = [
    { icon: "more" as const, title: "操作バー", text: "マウスを画面の一番上に少し止める、上端のハンドルを押す、またはAltキーで表示します。" },
    { icon: "home" as const, title: "基本操作", text: "マウスとキーボードはそのまま使えます。戻る・ホーム・履歴は操作バーから選べます。" },
    { icon: "upload" as const, title: "ファイル転送", text: "ファイルをこの画面へドロップすると、Galaxy へ転送します。" },
    { icon: "fullscreen" as const, title: "ショートカット", text: "F11 で全画面、Ctrl+Shift+S で統計表示を切り替えます。" },
  ];
  return <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="session-guide-title">
    <div className="w-full max-w-md rounded-2xl border border-white/[0.08] bg-[#1e1e1e]/85 p-6 text-white shadow-popover backdrop-blur-xl">
      <div className="mb-5 flex items-start justify-between gap-4"><div><h2 id="session-guide-title" className="text-xl font-semibold">DeX の操作を始めましょう</h2><p className="mt-1 text-sm text-white/60">よく使う操作はすべて画面上端にあります。</p></div><button type="button" onClick={onClose} aria-label="閉じる" className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"><Icon name="close" /></button></div>
      <ul className="flex flex-col gap-4">{items.map((item) => <li key={item.title} className="flex gap-3"><Icon name={item.icon} className="mt-0.5 h-5 w-5 shrink-0 text-accent" /><div><div className="text-sm font-semibold">{item.title}</div><p className="mt-0.5 text-sm leading-5 text-white/60">{item.text}</p></div></li>)}</ul>
      <Button variant="primary" className="mt-6 w-full" onClick={onClose}>使い始める</Button>
    </div>
  </div>;
}

export function DisconnectConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true" aria-labelledby="disconnect-title">
    <div className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#1e1e1e]/85 p-5 text-white shadow-popover backdrop-blur-xl"><h2 id="disconnect-title" className="text-lg font-semibold">DeX を切断しますか？</h2><p className="mt-2 text-sm leading-6 text-white/65">現在 DeX で開いているアプリは終了します。</p><div className="mt-5 flex justify-end gap-2"><Button onClick={onCancel}>キャンセル</Button><Button variant="danger" onClick={onConfirm}>切断</Button></div></div>
  </div>;
}
