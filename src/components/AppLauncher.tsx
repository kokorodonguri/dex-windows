import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type LaunchableApp } from "../lib/tauri";
import { CloseButton, Dialog, darkPanelClass, inputClass } from "./ui";

const PAGE_SIZE = 60;
const pagerButton = "rounded-lg px-3 py-2 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-30";

export function AppLauncher({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  const search = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const [apps, setApps] = useState<LaunchableApp[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    let disposed = false;
    setError("");
    setApps(null);
    void api.listSessionApps(sessionId).then((list) => {
      if (!disposed) setApps(list.sort((a, b) => a.name.localeCompare(b.name, "ja") || a.component.localeCompare(b.component)));
    }).catch((e) => { if (!disposed) setError(errorMessage(e)); });
    return () => { disposed = true; };
  }, [sessionId, retry]);
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return (apps ?? []).filter((a) => `${a.name} ${a.component}`.toLocaleLowerCase().includes(q));
  }, [apps, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const launch = async (app: LaunchableApp) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await api.launchSessionApp(sessionId, app.component);
      if (alive.current) onClose();
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return <Dialog labelledBy="app-launcher-title" initialFocus={search} onCancel={onClose} className={`w-[min(40rem,calc(100%-2rem))] p-5 ${darkPanelClass}`}>
    <div className="flex items-center justify-between gap-4"><h2 id="app-launcher-title" className="text-lg font-semibold">アプリを開く</h2><CloseButton onClick={onClose} /></div>
    <p className="mt-1 text-xs text-white/60">選んだアプリをPC側の画面で開きます。</p>
    <input ref={search} aria-label="アプリを検索" placeholder="アプリ名で検索" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} className={`${inputClass} my-4`} />
    {error && <p role="alert" className="mb-3 break-words text-sm text-[#ff453a]">{error}{!apps && <> <button type="button" onClick={() => setRetry((n) => n + 1)} className="rounded underline focus-visible:outline-2 focus-visible:outline-accent">一覧を再取得</button></>}</p>}
    {!apps && !error && <p role="status" className="py-6 text-sm text-white/65">アプリ一覧を取得しています…</p>}
    {apps && <><div className="grid max-h-[55vh] gap-2 overflow-y-auto sm:grid-cols-2">
      {filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((app) => <button type="button" key={app.component} disabled={busy} title={app.name} onClick={() => void launch(app)} className="min-w-0 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/10 active:bg-white/[0.15] focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40"><span className="block truncate text-sm font-medium">{app.name}</span><span className="block truncate text-[11px] text-white/45">{app.component.split('/')[0]}</span></button>)}
      {filtered.length === 0 && <p className="py-6 text-sm text-white/65 sm:col-span-2">{apps.length === 0 ? "起動できるアプリが見つかりませんでした。" : "該当するアプリがありません。"}</p>}
    </div><div className="mt-3 flex items-center justify-between text-xs text-white/65"><button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className={pagerButton}>前へ</button><span role="status">{busy ? "起動しています…" : `${filtered.length}件 · ${page + 1} / ${pages}`}</span><button type="button" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} className={pagerButton}>次へ</button></div></>}
  </Dialog>;
}
