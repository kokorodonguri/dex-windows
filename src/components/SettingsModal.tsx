import { useState, type ReactNode } from "react";
import type { DexStrategy, ImePolicy, Settings } from "../lib/tauri";
import { Button, CloseButton, Dialog, Field, Group, Row, Segmented, Toggle, inputClass } from "./ui";

const PRESETS = [
  { label: "1280 × 720", width: 1280, height: 720 },
  { label: "1600 × 900", width: 1600, height: 900 },
  { label: "1920 × 1080", width: 1920, height: 1080 },
  { label: "2560 × 1440", width: 2560, height: 1440 },
];

const WIDTH_RANGE = { min: 320, max: 7680 };
const HEIGHT_RANGE = { min: 240, max: 4320 };
const inRange = (value: number, { min, max }: { min: number; max: number }) => Number.isInteger(value) && value >= min && value <= max;

interface Props {
  settings: Settings;
  sessionActive: boolean;
  onSave: (s: Settings) => void;
  onClose: () => void;
}

export function SettingsModal({ settings, sessionActive, onSave, onClose }: Props) {
  const [s, setS] = useState<Settings>(settings);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setS((prev) => ({ ...prev, [key]: value }));
  const matchingPreset = PRESETS.find((p) => p.width === s.width && p.height === s.height)?.label;
  // "Custom" is a choice of its own: deriving it from the numbers alone snaps
  // the select back to a preset as soon as the size happens to match one.
  const [customSize, setCustomSize] = useState(matchingPreset === undefined);
  const preset = customSize || matchingPreset === undefined ? "custom" : matchingPreset;
  const widthValid = inRange(s.width, WIDTH_RANGE);
  const heightValid = inRange(s.height, HEIGHT_RANGE);
  return (
    <Dialog
      labelledBy="settings-title"
      closeOnBackdrop
      onCancel={onClose}
      className="max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-4xl flex-col rounded-2xl border border-hairline bg-bg/90 text-label backdrop-blur-xl open:flex"
    >
      <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
        <h2 id="settings-title" className="text-base font-semibold">設定</h2>
        <CloseButton onClick={onClose} />
      </div>

      <div className="scroll-thin grid flex-1 grid-cols-1 items-start gap-x-6 gap-y-6 overflow-auto px-5 py-5 md:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Group title="ディスプレイ">
            <Row label="解像度">
              <select
                className={selectClass}
                value={preset}
                onChange={(e) => {
                  const p = PRESETS.find((x) => x.label === e.target.value);
                  setCustomSize(!p);
                  if (p) setS((prev) => ({ ...prev, width: p.width, height: p.height }));
                }}
              >
                {PRESETS.map((p) => (
                  <option key={p.label}>{p.label}</option>
                ))}
                <option value="custom">カスタム</option>
              </select>
            </Row>
            {preset === "custom" && (
              <>
                <Row label="幅" hint={widthValid ? undefined : <span className="text-danger">{`${WIDTH_RANGE.min}〜${WIDTH_RANGE.max} の整数で入力してください`}</span>}>
                  <input type="number" className={`${inputClass} w-28 text-right`} aria-invalid={!widthValid} {...WIDTH_RANGE} value={s.width} onChange={(e) => set("width", Number(e.target.value))} />
                </Row>
                <Row label="高さ" hint={heightValid ? undefined : <span className="text-danger">{`${HEIGHT_RANGE.min}〜${HEIGHT_RANGE.max} の整数で入力してください`}</span>}>
                  <input type="number" className={`${inputClass} w-28 text-right`} aria-invalid={!heightValid} {...HEIGHT_RANGE} value={s.height} onChange={(e) => set("height", Number(e.target.value))} />
                </Row>
              </>
            )}
            <SliderRow label="DPI" value={String(s.dpi)} hint="大きいほど文字やアイコンが大きく表示されます(既定 240)">
              <input type="range" min={160} max={320} step={10} className="w-full accent-accent" value={s.dpi} onChange={(e) => set("dpi", Number(e.target.value))} />
            </SliderRow>
            <SliderRow label="ビットレート" value={`${s.bitRateMbps} Mbps`}>
              <input type="range" min={2} max={40} className="w-full accent-accent" value={s.bitRateMbps} onChange={(e) => set("bitRateMbps", Number(e.target.value))} />
            </SliderRow>
            <Row label="フレームレート" as="div">
              <Segmented
                label="フレームレート"
                value={s.maxFps}
                options={[
                  { value: 30, label: "30 fps" },
                  { value: 60, label: "60 fps" },
                ]}
                onChange={(v) => set("maxFps", v)}
              />
            </Row>
            <Toggle checked={s.flexDisplay} onChange={(v) => set("flexDisplay", v)} label="Flex モード" hint="ウィンドウサイズに合わせて DeX の解像度を変更" />
          </Group>

          <Group title="DeX">
            <Row label="DeX の起動方法" hint="「明示的」は DeX ランチャーを直接起動します">
              <select className={selectClass} value={s.dexStrategy} onChange={(e) => set("dexStrategy", e.target.value as DexStrategy)}>
                <option value="auto">自動</option>
                <option value="explicit">明示的に起動</option>
              </select>
            </Row>
            <Toggle
              checked={s.freeformWindows}
              onChange={(v) => set("freeformWindows", v)}
              label="アプリをウィンドウで開く"
              hint="仮想ディスプレイをフリーフォームにします(One UI 8.5 では必須)"
            />
            <Toggle
              checked={s.forceDesktopMode}
              onChange={(v) => set("forceDesktopMode", v)}
              label="デスクトップモードを強制"
              hint="開発者オプションの設定を一時的に変更し、終了時に元へ戻します"
            />
            <Toggle
              checked={!s.destroyContent}
              onChange={(v) => set("destroyContent", !v)}
              label="切断時にアプリを端末へ戻す"
              hint="OFF にすると切断時に DeX 上のアプリを終了します"
            />
          </Group>
        </div>

        <div className="flex flex-col gap-6">
          <Group title="入力">
            <Toggle
              checked={s.keyboardHook}
              onChange={(v) => set("keyboardHook", v)}
              label="システムキーを DeX に送る"
              hint="Win / Alt+Tab / Alt+Esc / Ctrl+Esc / Alt+F4 を Windows ではなく DeX で処理"
            />
            <Toggle
              checked={s.trackpadGestures}
              onChange={(v) => set("trackpadGestures", v)}
              label="トラックパッドジェスチャー"
              hint="2本指の縦横スワイプとピンチをタッチ操作として送信"
            />
            <Row label="画面キーボードの表示先" hint="表示しない場合は PC のキーボードを使います">
              <select className={selectClass} value={s.imePolicy} onChange={(e) => set("imePolicy", e.target.value as ImePolicy)}>
                <option value="hide">表示しない</option>
                <option value="local">DeX 画面</option>
                <option value="fallback">スマホ画面</option>
                <option value="default">システム既定</option>
              </select>
            </Row>
          </Group>

          <Group title="連携">
            <Toggle checked={s.audio} onChange={(v) => set("audio", v)} label="音声を PC で再生" hint="Android 11 以降" />
            <Toggle checked={s.clipboardSync} onChange={(v) => set("clipboardSync", v)} label="クリップボードを同期" />
            <div className="px-4 py-2">
              <Field label="ファイル転送先" hint="ドロップしたファイルの保存先(端末上の / から始まるパス。不正な値は既定に戻ります)">
                <input className={inputClass} value={s.transferDir} onChange={(e) => set("transferDir", e.target.value)} />
              </Field>
            </div>
            <Toggle checked={s.statsOverlay} onChange={(v) => set("statsOverlay", v)} label="統計オーバーレイを既定で表示" hint="Ctrl+Shift+S で切替" />
          </Group>

          <Group title="詳細">
            <div className="px-4 py-2">
              <Field label="adb.exe のパス" hint="空欄なら自動検出(同梱 → Android SDK → PATH)">
                <input className={inputClass} placeholder="自動" value={s.adbPath} onChange={(e) => set("adbPath", e.target.value)} />
              </Field>
            </div>
          </Group>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-hairline px-5 py-3">
        <span className="text-xs text-label-2">{sessionActive ? "解像度・音声などは次回の接続から反映されます" : ""}</span>
        <div className="flex gap-2">
          <Button onClick={onClose}>キャンセル</Button>
          <Button variant="primary" disabled={!widthValid || !heightValid} onClick={() => onSave(s)}>
            保存
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const selectClass = `${inputClass} w-44`;

/** Label and current value on one line, the slider full-width below. */
function SliderRow({ label, value, hint, children }: { label: string; value: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block px-4 py-2.5">
      <span className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-label-2">{value}</span>
      </span>
      <span className="mt-1.5 block">{children}</span>
      {hint && <span className="mt-1 block text-xs text-label-2">{hint}</span>}
    </label>
  );
}
