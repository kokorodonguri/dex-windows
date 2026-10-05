// Typed wrappers around the Rust commands and events (src-tauri/src/lib.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Connection = "usb" | "wifi";

export interface DeviceInfo {
  serial: string;
  state: string;
  model: string;
  manufacturer: string;
  android: string;
  sdk: string;
  oneui: string;
  connection: Connection;
}

export type DexStrategy = "auto" | "explicit";
export type ImePolicy = "default" | "local" | "fallback" | "hide";

export interface Settings {
  width: number;
  height: number;
  dpi: number;
  bitRateMbps: number;
  maxFps: number;
  audio: boolean;
  volume: number;
  muted: boolean;
  flexDisplay: boolean;
  dexStrategy: DexStrategy;
  freeformWindows: boolean;
  forceDesktopMode: boolean;
  destroyContent: boolean;
  imePolicy: ImePolicy;
  keyboardHook: boolean;
  trackpadGestures: boolean;
  clipboardSync: boolean;
  transferDir: string;
  statsOverlay: boolean;
  adbPath: string;
  /** Backend-owned state, preserved as-is by set_settings. */
  pendingRestore: unknown;
  pendingRestores: unknown;
  activeForward: unknown;
}

export interface Endpoint {
  port: number;
  token: string;
}

export interface EnvInfo {
  adbPath: string | null;
  adbVersion: string | null;
  serverPath: string | null;
  serverVersion: string;
  endpoint: Endpoint;
  logDir: string | null;
  appVersion: string;
}

export interface SessionInfo {
  id: number;
  serial: string;
  deviceName: string;
  displayId: number;
  width: number;
  height: number;
  dpi: number;
  connection: Connection;
  audio: boolean;
  flex: boolean;
  launcher: string | null;
}

export interface SessionEnded {
  id: number;
  reason: string;
}

export interface SessionDeviceStatus {
  sessionId: number;
  keyguardShowing: boolean | null;
}

export interface LaunchableApp { name: string; component: string }

export type TransferEvent =
  | { state: "queued"; id: number; name: string; total: number }
  | { state: "progress"; id: number; name: string; sent: number; total: number }
  | { state: "done"; id: number; name: string; remote: string }
  | { state: "error"; id: number; name: string; error: string };

export const api = {
  getEnv: () => invoke<EnvInfo>("get_env"),
  getDevices: () => invoke<DeviceInfo[]>("get_devices"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<Settings>("set_settings", { settings }),
  adbConnect: (address: string) => invoke<string>("adb_connect", { address }),
  adbPair: (address: string, code: string) => invoke<string>("adb_pair", { address, code }),
  getSession: () => invoke<SessionInfo | null>("get_session"),
  listSessionApps: (sessionId: number) => invoke<LaunchableApp[]>("list_session_apps", { sessionId }),
  launchSessionApp: (sessionId: number, component: string) => invoke<void>("launch_session_app", { sessionId, component }),
  getSessionDeviceStatus: (sessionId: number) => invoke<SessionDeviceStatus>("get_session_device_status", { sessionId }),
  startSession: (serial: string) => invoke<SessionInfo>("start_session", { serial }),
  stopSession: () => invoke<void>("stop_session"),
  sendImeText: (sessionId: number, text: string) => invoke<void>("send_ime_text", { sessionId, text }),
  resetVideo: (sessionId: number) => invoke<void>("reset_video", { sessionId }),
  setPhoneScreen: (sessionId: number, on: boolean) => invoke<void>("set_phone_screen", { sessionId, on }),
  resizeDisplay: (sessionId: number, width: number, height: number) => invoke<void>("resize_display", { sessionId, width, height }),
  transferFiles: (paths: string[]) => invoke<number>("transfer_files", { paths }),
};

export const events = {
  devices: (cb: (list: DeviceInfo[]) => void): Promise<UnlistenFn> => listen<DeviceInfo[]>("devices", (e) => cb(e.payload)),
  sessionEnded: (cb: (e: SessionEnded) => void): Promise<UnlistenFn> => listen<SessionEnded>("session-ended", (e) => cb(e.payload)),
  transfer: (cb: (e: TransferEvent) => void): Promise<UnlistenFn> => listen<TransferEvent>("transfer", (e) => cb(e.payload)),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  const json = JSON.stringify(e);
  return json ?? String(e);
}
