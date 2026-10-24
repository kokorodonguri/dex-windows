// Plumbing for browser E2E runs: the Vite dev server, a stand-in for the
// backend WebSocket endpoint, and a mocked Tauri IPC injected into the page.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...args) => console.error("[e2e]", ...args);
export const firstLine = (e) => String(e?.message ?? e).split("\n")[0];

/** Project-local playwright (`npm i --no-save playwright`) first, then the global install. */
export async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    // not installed in this checkout
  }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return createRequire(import.meta.url)(join(globalRoot, "playwright"));
  } catch {
    throw new Error("playwright が見つかりません。`npm i --no-save playwright@1.56.1` を実行してください");
  }
}

/** Playwright's own Chromium lookup first; the preinstalled binary if its revision does not match. */
export async function launchChromium(chromium, { headless = true } = {}) {
  try {
    return await chromium.launch({ headless });
  } catch (e) {
    const fallback = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
    if (!existsSync(fallback)) throw e;
    log(`Chromium の起動に失敗 (${firstLine(e)})。${fallback} で再試行します`);
    return chromium.launch({ headless, executablePath: fallback });
  }
}

function listen(server) {
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res(server.address().port));
  });
}

export async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

export async function startVite(port) {
  const bin = join(ROOT, "node_modules/vite/bin/vite.js");
  if (!existsSync(bin)) throw new Error("node_modules がありません。先に `npm ci` を実行してください");
  const child = spawn(process.execPath, [bin, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`vite が終了しました (code ${child.exitCode}):\n${output}`);
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stopChild(child);
      throw new Error(`vite が 60 秒以内に応答しませんでした:\n${output}`);
    }
    await sleep(200);
  }
  return { url, output: () => output, stop: () => stopChild(child) };
}

/**
 * Accepts the app's WebSockets (/stream, /events) and ignores what the client
 * sends. /stream upgrades are held until `release()`, so the test decides when
 * the session counts as connected.
 */
export async function startStreamServer() {
  const sockets = new Set();
  const streams = new Set();
  const held = [];
  const accepted = { stream: 0, events: 0 };
  let released = false;
  const server = createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", () => undefined);
    const isStream = req.url.startsWith("/stream");
    if (isStream) {
      streams.add(socket);
      socket.on("close", () => streams.delete(socket));
    }
    const accept = () => {
      if (socket.destroyed) return;
      const key = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
      accepted[isStream ? "stream" : "events"]++;
    };
    if (isStream && !released) held.push(accept);
    else accept();
  });
  const port = await listen(server);
  return {
    port,
    accepted: () => ({ ...accepted }),
    release() {
      released = true;
      for (const accept of held.splice(0)) accept();
    },
    /** Drops the connected /stream sockets and holds the reconnects until `release()`. */
    hold() {
      released = false;
      for (const s of streams) s.destroy();
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

export function fixtures(wsPort) {
  const serial = "R5CT10E2E01";
  return {
    env: {
      adbPath: "C:\\platform-tools\\adb.exe",
      adbVersion: "35.0.2",
      serverPath: "C:\\Modern DeX\\scrcpy-server",
      serverVersion: "3.3.4",
      endpoint: { port: wsPort, token: "e2e-token" },
      logDir: "C:\\Users\\e2e\\AppData\\Local\\modern-dex\\logs",
      appVersion: "0.1.0",
    },
    settings: {
      width: 1920,
      height: 1080,
      dpi: 240,
      bitRateMbps: 8,
      maxFps: 60,
      audio: false,
      volume: 0.8,
      muted: false,
      flexDisplay: false,
      dexStrategy: "auto",
      freeformWindows: true,
      forceDesktopMode: false,
      // true: "DeX を切断" goes through the confirmation dialog
      destroyContent: true,
      imePolicy: "local",
      keyboardHook: true,
      trackpadGestures: true,
      clipboardSync: true,
      transferDir: "/sdcard/Download",
      statsOverlay: false,
      adbPath: "",
      pendingRestore: null,
      pendingRestores: null,
      activeForward: null,
    },
    devices: [
      { serial, state: "device", model: "SM-S928Q", manufacturer: "samsung", android: "15", sdk: "35", oneui: "7.0", connection: "usb" },
    ],
    session: {
      id: 1,
      serial,
      deviceName: "Galaxy S24 Ultra",
      displayId: 2,
      width: 1920,
      height: 1080,
      dpi: 240,
      connection: "usb",
      // Shows the mute button and volume slider on the toolbar
      audio: true,
      flex: false,
      launcher: null,
    },
    apps: [
      { name: "Chrome", component: "com.android.chrome/com.google.android.apps.chrome.Main" },
      { name: "マイファイル", component: "com.sec.android.app.myfiles/.external.ui.MainActivity" },
      { name: "設定", component: "com.android.settings/.Settings" },
    ],
  };
}

/**
 * Runs in the page before the app (Playwright `addInitScript`): fakes
 * `window.__TAURI_INTERNALS__` and records focus, composition and IPC traffic
 * in `window.__e2e`. Serialized into the page, so it must stay self-contained.
 */
export function pageInitScript(cfg) {
  const now = () => Math.round(performance.now());
  // `fail`: command names whose invoke rejects (to provoke error toasts).
  const e2e = (window.__e2e = { invokes: [], unknownCommands: [], focusLog: [], composition: [], imeBlurs: 0, imeFocuses: 0, fail: new Set() });

  // ---- Tauri IPC ----
  const callbacks = new Map();
  const listeners = new Map();
  let nextId = 1;
  const state = { settings: cfg.settings, session: null, fullscreen: false };
  const emit = (event, payload) => {
    for (const l of listeners.get(event) ?? []) callbacks.get(l.handler)?.({ event, id: l.id, payload });
  };
  const handlers = {
    get_env: () => cfg.env,
    get_settings: () => state.settings,
    set_settings: (a) => (state.settings = a.settings),
    get_devices: () => cfg.devices,
    get_session: () => state.session,
    start_session: (a) => (state.session = { ...cfg.session, serial: a.serial }),
    stop_session: () => (state.session = null),
    list_session_apps: () => cfg.apps,
    launch_session_app: () => null,
    get_session_device_status: (a) => ({ sessionId: a.sessionId, keyguardShowing: false }),
    send_ime_text: () => null,
    reset_video: () => null,
    set_phone_screen: () => null,
    resize_display: () => null,
    transfer_files: () => 0,
    adb_connect: () => "connected",
    adb_pair: () => "paired",
    "plugin:event|listen": (a) => {
      const id = nextId++;
      if (!listeners.has(a.event)) listeners.set(a.event, []);
      listeners.get(a.event).push({ id, handler: a.handler });
      return id;
    },
    "plugin:event|unlisten": () => null,
    "plugin:event|emit": (a) => (emit(a.event, a.payload), null),
    "plugin:log|log": () => null,
    "plugin:window|is_fullscreen": () => state.fullscreen,
    "plugin:window|set_fullscreen": (a) => ((state.fullscreen = !!a.value), null),
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    async invoke(cmd, args = {}) {
      if (!cmd.startsWith("plugin:event|") && cmd !== "plugin:log|log") e2e.invokes.push({ t: now(), cmd, args: JSON.parse(JSON.stringify(args)) });
      if (e2e.fail.has(cmd)) throw `${cmd} failed (e2e)`;
      const handler = handlers[cmd];
      if (!handler) {
        e2e.unknownCommands.push(cmd);
        return null;
      }
      const result = handler(args);
      return result === undefined ? null : structuredClone(result);
    },
    transformCallback(cb, once = false) {
      const id = nextId++;
      callbacks.set(id, (data) => {
        if (once) callbacks.delete(id);
        return cb?.(data);
      });
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback: (id, data) => callbacks.get(id)?.(data),
    callbacks,
    convertFileSrc: (p) => p,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) {
      const list = listeners.get(event);
      if (list) listeners.set(event, list.filter((l) => l.id !== id));
    },
  };
  e2e.emit = emit;

  // ---- focus / composition recorder ----
  const desc = (el) => {
    if (!el) return "null";
    if (el === document.body) return "body";
    if (!(el instanceof Element)) return String(el);
    if (el.classList.contains("ime-sink")) return "textarea.ime-sink";
    let s = el.tagName.toLowerCase();
    const label = el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent || "").trim().slice(0, 24);
    if (label) s += `[${label}]`;
    const dialog = el.closest("dialog");
    if (dialog) s += ` in dialog#${dialog.getAttribute("aria-labelledby")}`;
    return s;
  };
  e2e.desc = desc;
  const isIme = (el) => el instanceof Element && el.classList.contains("ime-sink");
  for (const type of ["focusin", "focusout"]) {
    document.addEventListener(
      type,
      (e) => {
        if (isIme(e.target)) type === "focusout" ? e2e.imeBlurs++ : e2e.imeFocuses++;
        e2e.focusLog.push({ t: now(), type, target: desc(e.target), related: desc(e.relatedTarget) });
      },
      true,
    );
  }
  for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
    document.addEventListener(type, (e) => e2e.composition.push({ t: now(), type, data: e.data, target: desc(e.target) }), true);
  }
  window.addEventListener("blur", () => e2e.focusLog.push({ t: now(), type: "window-blur" }));
  window.addEventListener("focus", () => e2e.focusLog.push({ t: now(), type: "window-focus" }));
  // Focus can also vanish without an event (element removed or made inert).
  let lastActive = "";
  setInterval(() => {
    const active = desc(document.activeElement);
    if (active !== lastActive) e2e.focusLog.push({ t: now(), type: "activeElement", active });
    lastActive = active;
  }, 50);
}
