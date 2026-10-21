import { useRef } from "react";
import { Button, CloseButton, Dialog, Icon, darkPanelClass } from "./ui";

export const SESSION_GUIDE_KEY = "modern-dex.session-guide.v1";

export function hasSeenSessionGuide(storage: Pick<Storage, "getItem">): boolean {
  return storage.getItem(SESSION_GUIDE_KEY) === "done";
}

export function markSessionGuideSeen(storage: Pick<Storage, "setItem">): void {
  storage.setItem(SESSION_GUIDE_KEY, "done");
}

export function SessionGuide({ onClose }: { onClose: () => void }) {
  const start = useRef<HTMLButtonElement>(null);
  const items = [
    { icon: "more" as const, title: "操作バー", text: "マウスを画面の一番上に少し止める、上端のハンドルを押す、またはAltキーで表示します。" },
    { icon: "home" as const, title: "基本操作", text: "マウスとキーボードはそのまま使えます。戻る・ホーム・履歴は操作バーから選べます。" },
    { icon: "upload" as const, title: "ファイル転送", text: "ファイルをこの画面へドロップすると、Galaxy へ転送します。" },
    { icon: "fullscreen" as const, title: "ショートカット", text: "F11 で全画面、Ctrl+Shift+S で統計表示を切り替えます。" },
  ];
  return <Dialog labelledBy="session-guide-title" initialFocus={start} onCancel={onClose} className={`w-[min(28rem,calc(100%-2rem))] p-5 ${darkPanelClass}`}>
      <div className="mb-5 flex items-start justify-between gap-4"><div><h2 id="session-guide-title" className="text-lg font-semibold">DeX の操作を始めましょう</h2><p className="mt-1 text-sm text-white/60">よく使う操作はすべて画面上端にあります。</p></div><CloseButton onClick={onClose} /></div>
      <ul className="flex flex-col gap-4">{items.map((item) => <li key={item.title} className="flex gap-3"><Icon name={item.icon} className="mt-0.5 h-5 w-5 shrink-0 text-accent" /><div><div className="text-sm font-semibold">{item.title}</div><p className="mt-0.5 text-sm leading-5 text-white/60">{item.text}</p></div></li>)}</ul>
      <Button ref={start} variant="primary" className="mt-6 w-full" onClick={onClose}>使い始める</Button>
  </Dialog>;
}

export function DisconnectConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  // The safe choice has focus, so a stray Enter does not end the session.
  const cancel = useRef<HTMLButtonElement>(null);
  return <Dialog role="alertdialog" labelledBy="disconnect-title" initialFocus={cancel} onCancel={onCancel} className={`w-[min(24rem,calc(100%-2rem))] p-5 ${darkPanelClass}`}>
    <h2 id="disconnect-title" className="text-lg font-semibold">DeX を切断しますか？</h2><p className="mt-2 text-sm leading-6 text-white/65">現在 DeX で開いているアプリは終了します。</p><div className="mt-5 flex justify-end gap-2"><Button ref={cancel} onClick={onCancel}>キャンセル</Button><Button variant="danger" onClick={onConfirm}>切断</Button></div>
  </Dialog>;
}
