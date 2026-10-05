import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage, type DeviceInfo, type EnvInfo, type Settings } from "../lib/tauri";
import { checkCodecSupport } from "../media/video";
import { useToast } from "./Toasts";
import { Button, Field, Group, Icon, inputClass } from "./ui";

interface Props {
  env: EnvInfo | null;
  settings: Settings | null;
  devices: DeviceInfo[];
  starting: string | null;
  onStart: (serial: string) => void;
  onOpenSettings: () => void;
  onOpenLog: () => void;
}

const stateLabel: Record<string, string> = {
  device: "接続済み",
  unauthorized: "USB デバッグの許可待ち",
  offline: "オフライン",
  "no permissions": "権限なし",
  authorizing: "認証中",
  connecting: "接続中",
};

/** Why "DeX を開始" is disabled, and what to do about it. */
const notReadyHint: Record<string, string> = {
  unauthorized: "端末の画面に表示される「USB デバッグを許可」で許可してください",
  offline: "ケーブルを挿し直すか、端末を再接続してください",
  "no permissions": "USB ドライバーと端末側の USB デバッグ設定を確認してください",
};

export function ConnectScreen({ env, settings, devices, starting, onStart, onOpenSettings, onOpenLog }: Props) {
  return (
    // The header sticks inside the scroller, so content passes under its blur.
    <div className="scroll-thin h-full overflow-auto">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-hairline bg-bg/70 px-8 py-4 backdrop-blur-xl">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Modern DeX for PC</h1>
          <p className="text-sm text-label-2">Galaxy の DeX デスクトップを Windows のウィンドウで使う</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={onOpenLog}>
            <Icon name="log" /> ログ
          </Button>
          <Button onClick={onOpenSettings}>
            <Icon name="settings" /> 設定
          </Button>
        </div>
      </header>

      <main className="grid grid-cols-1 items-start gap-x-8 gap-y-6 px-8 py-6 lg:grid-cols-[1fr_340px]">
        <section>
          {devices.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <Icon name="phone" className="mx-auto mb-3 h-10 w-10 text-label-2" />
              <div className="text-base font-semibold">デバイスが見つかりません</div>
              <p className="mx-auto mt-1 max-w-sm text-sm text-label-2">
                USB ケーブルで接続し、端末の「開発者向けオプション → USB デバッグ」を ON にしてください。Wi-Fi の場合は右のフォームから接続できます。
              </p>
            </div>
          ) : (
            <Group title="デバイス" footer={settings && settingsSummary(settings)}>
              {devices.map((d) => (
                <DeviceRow key={d.serial} device={d} starting={starting} onStart={onStart} />
              ))}
            </Group>
          )}
        </section>

        <aside className="flex flex-col gap-6">
          <WifiCard />
          <StatusCard env={env} />
        </aside>
      </main>
    </div>
  );
}

/** Applies to every "DeX を開始" above, so it is stated once under the list. */
function settingsSummary(s: Settings): string {
  const size = s.flexDisplay ? "Flex(ウィンドウに追従)" : `${s.width}×${s.height}`;
  return `${size} · ${s.dpi} dpi · ${s.bitRateMbps} Mbps · ${s.maxFps} fps${s.audio ? " · 音声" : ""}`;
}

function DeviceRow({ device: d, starting, onStart }: { device: DeviceInfo; starting: string | null; onStart: (s: string) => void }) {
  const ready = d.state === "device";
  const busy = starting === d.serial;
  const hint = !ready ? notReadyHint[d.state] : undefined;
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Icon name="phone" className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{d.model || d.serial}</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-label-2">
            <Icon name={d.connection === "wifi" ? "wifi" : "usb"} className="h-3 w-3" />
            {d.connection === "wifi" ? "Wi-Fi" : "USB"}
          </span>
        </div>
        <div className="truncate text-xs text-label-2">
          {[d.serial !== d.model ? d.serial : "", d.android && `Android ${d.android}`, d.oneui && `One UI ${d.oneui}`].filter(Boolean).join(" · ")}
        </div>
        <div className={`text-xs ${ready ? "text-ok" : "text-warn"}`}>
          {stateLabel[d.state] ?? d.state}
          {hint && <span className="text-label-2"> — {hint}</span>}
        </div>
      </div>
      <Button variant="primary" disabled={!ready || starting !== null} onClick={() => onStart(d.serial)} className="shrink-0">
        {busy ? "起動中…" : "DeX を開始"}
      </Button>
    </div>
  );
}

function WifiCard() {
  const toast = useToast();
  const [address, setAddress] = useState("");
  const [pairAddress, setPairAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const run = async (failTitle: string, fn: () => Promise<string>) => {
    if (busyRef.current) return; // Enter and the button can both fire
    busyRef.current = true;
    setBusy(true);
    try {
      toast.show("success", await fn());
    } catch (e) {
      toast.show("error", failTitle, errorMessage(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const canConnect = address.trim() !== "";
  const canPair = pairAddress.trim() !== "" && /^\d{6}$/.test(code);
  const submit = (ok: boolean, action: () => void) => (e: FormEvent) => {
    e.preventDefault();
    if (ok && !busy) action();
  };

  return (
    <Group title="Wi-Fi 接続" footer="端末の「ワイヤレスデバッグ」画面に表示される IP アドレスとポートを入力します">
      <form className="px-4 py-2" onSubmit={submit(canConnect, () => void run("接続できませんでした", () => api.adbConnect(address.trim())))}>
        <Field label="接続先 (IP:ポート)">
          <div className="flex gap-2">
            <input className={inputClass} placeholder="192.168.1.20:37123" value={address} onChange={(e) => setAddress(e.target.value)} />
            <Button type="submit" className="shrink-0 whitespace-nowrap" disabled={busy || !canConnect}>
              {busy ? "接続中…" : "接続"}
            </Button>
          </div>
        </Field>
      </form>
      <details className="px-4 py-2.5">
        <summary className="cursor-pointer text-sm text-accent">初回のみ: ペアリングコードでペア設定</summary>
        <form onSubmit={submit(canPair, () => void run("ペア設定できませんでした", () => api.adbPair(pairAddress.trim(), code)))}>
          <Field label="ペアリング用 IP:ポート">
            <input className={inputClass} placeholder="192.168.1.20:41234" value={pairAddress} onChange={(e) => setPairAddress(e.target.value)} />
          </Field>
          <Field label="Wi-Fi ペアリングコード (6 桁)">
            <div className="flex gap-2">
              <input
                className={inputClass}
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
              <Button type="submit" className="shrink-0 whitespace-nowrap" disabled={busy || !canPair}>
                {busy ? "ペア設定中…" : "ペア設定"}
              </Button>
            </div>
          </Field>
        </form>
      </details>
    </Group>
  );
}

/** Module-level (not declared inside StatusCard) so rows keep their identity across renders. */
function StatusRow({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string | null }) {
  return (
    <div className="flex items-start gap-2.5 px-4 py-2.5">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ok === null ? "bg-fill-strong" : ok ? "bg-ok" : "bg-danger"}`} />
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {/* Windows verbatim paths (\?\C:\…) are noise for users */}
        {detail && <div className="break-all text-xs text-label-2">{detail.replaceAll("\\\\?\\", "")}</div>}
      </div>
    </div>
  );
}

function StatusCard({ env }: { env: EnvInfo | null }) {
  const [codecs, setCodecs] = useState<{ h264: boolean; h264Hardware: boolean; opus: boolean } | null>(null);
  useEffect(() => {
    void checkCodecSupport().then(setCodecs);
  }, []);

  return (
    <Group title="環境チェック" footer={env && `バージョン ${env.appVersion}`}>
      <StatusRow ok={env ? !!env.adbPath : null} label="ADB" detail={env?.adbPath ? `${env.adbVersion ?? ""} — ${env.adbPath}` : "adb.exe が見つかりません"} />
      <StatusRow
        ok={env ? !!env.serverPath : null}
        label={`scrcpy-server v${env?.serverVersion ?? "4.1"}`}
        detail={env?.serverPath ?? "npm run fetch:bin を実行してください"}
      />
      <StatusRow
        ok={codecs ? codecs.h264 : null}
        label="H.264 デコード (WebCodecs)"
        detail={codecs ? (codecs.h264Hardware ? "ハードウェアデコード対応" : codecs.h264 ? "ソフトウェアデコード" : "非対応 (N エディションは Media Feature Pack が必要)") : null}
      />
      <StatusRow ok={codecs ? codecs.opus : null} label="Opus 音声デコード" detail={codecs && !codecs.opus ? "非対応のため映像のみで動作します" : null} />
    </Group>
  );
}
