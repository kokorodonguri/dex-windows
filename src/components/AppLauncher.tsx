import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type LaunchableApp } from "../lib/tauri";

export function AppLauncher({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
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
    dialog.current?.showModal();
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
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="app-launcher-title" className="m-auto w-[min(40rem,95vw)] rounded-2xl border border-white/[0.08] bg-[#1e1e1e] p-5 text-white shadow-popover backdrop:bg-black/40 backdrop:backdrop-blur-sm">
    <div className="flex items-center justify-between gap-4"><h2 id="app-launcher-title" className="text-lg font-semibold">アプリを開く</h2><button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/10 hover:text-white">閉じる</button></div>
    <p className="mt-1 text-xs text-white/60">選んだアプリをPC側の画面で開きます。</p>
    <input autoFocus aria-label="アプリを検索" placeholder="アプリ名で検索" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} className="my-4 h-8 w-full rounded-lg border border-white/[0.08] bg-white/[0.06] px-3 text-sm outline-accent placeholder:text-white/40" />
    {error && <p role="alert" className="mb-3 break-words text-sm text-[#ff453a]">{error}{!apps && <> <button type="button" onClick={() => setRetry((n) => n + 1)} className="underline">一覧を再取得</button></>}</p>}
    {!apps && !error && <p role="status" className="py-6 text-sm text-white/65">アプリ一覧を取得しています…</p>}
    {apps && <><div className="grid max-h-[55vh] gap-2 overflow-y-auto sm:grid-cols-2">
      {filtered.slice(page * 60, (page + 1) * 60).map((app) => <button type="button" key={app.component} disabled={busy} onClick={() => void launch(app)} className="min-w-0 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/10 active:bg-white/[0.15] focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"><span className="block truncate text-sm font-medium">{app.name}</span><span className="block truncate text-[11px] text-white/45">{app.component.split('/')[0]}</span></button>)}
      {filtered.length === 0 && <p className="py-6 text-sm text-white/65">該当するアプリがありません。</p>}
    </div><div className="mt-3 flex items-center justify-between text-xs text-white/65"><button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="rounded px-3 py-2 disabled:opacity-30">前へ</button><span>{busy ? "起動しています…" : `${filtered.length}件 · ${page + 1} / ${Math.max(1, Math.ceil(filtered.length / 60))}`}</span><button disabled={(page + 1) * 60 >= filtered.length} onClick={() => setPage((p) => p + 1)} className="rounded px-3 py-2 disabled:opacity-30">次へ</button></div></>}
  </dialog>;
}
