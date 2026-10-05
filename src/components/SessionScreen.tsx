import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { KeyAction, encodeBackOrScreenOn, encodeInjectKeycode, type Bytes } from "../lib/control-codec";
import { flexDisplaySize, imeAnchor, type Point, type Size } from "../lib/coords";
import { AKEYCODE } from "../lib/keymap";
import { Kind, parseFrame, parseSession } from "../lib/stream-protocol";
import { api, errorMessage, type Endpoint, type SessionInfo, type Settings } from "../lib/tauri";
import type { AudioPlayer } from "../media/audio";
import { InputController } from "../media/input";
import { VideoPipeline } from "../media/video";
import { LiveStatsOverlay, type SessionStats } from "./StatsOverlay";
import { DisconnectConfirm, hasSeenSessionGuide, markSessionGuideSeen, SessionGuide } from "./SessionGuide";
import { Toolbar } from "./Toolbar";
import { DeviceLockNotice } from "./DeviceLockNotice";
import { AppLauncher } from "./AppLauncher";
import { useToast } from "./Toasts";
import { Icon } from "./ui";

interface Props {
  session: SessionInfo;
  endpoint: Endpoint;
  settings: Settings;
  settingsOpen: boolean;
  audio: AudioPlayer;
  onDisconnect: () => void;
  onOpenSettings: () => void;
  onOpenLog: () => void;
  onPatchSettings: (patch: Partial<Settings>) => void;
}

interface HookEvent {
  t: "key";
  code: string;
  down: boolean;
  repeat: boolean;
}

/** Size reserved for the composition box; the anchor keeps it inside the window. */
const IME_BOX: Size = { width: 320, height: 32 };

/** Distance from the top edge, in CSS px, that counts as touching it. */
const TOOLBAR_EDGE_PX = 4;
/** How long the pointer rests against the top edge before the toolbar opens. */
const TOOLBAR_REVEAL_DELAY_MS = 400;

const wsUrl = (ep: Endpoint, path: string) => `ws://127.0.0.1:${ep.port}${path}?token=${ep.token}`;

export function SessionScreen({ session, endpoint, settings, settingsOpen, audio, onDisconnect, onOpenSettings, onOpenLog, onPatchSettings }: Props) {
  const toast = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imeRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<(msg: Bytes) => void>(() => undefined);
  const inputRef = useRef<InputController | null>(null);
  const lastPointerRef = useRef<Point | null>(null);
  const [imeBox, setImeBox] = useState<Point | null>(null);
  const videoSizeRef = useRef<Size>({ width: session.width, height: session.height });

  const [videoSize, setVideoSize] = useState<Size>(videoSizeRef.current);
  const [connectionPhase, setConnectionPhase] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [statsVisible, setStatsVisible] = useState(settings.statsOverlay);
  const statsRef = useRef<SessionStats | null>(null);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [phoneScreenOff, setPhoneScreenOff] = useState(false);
  const phoneScreenBusy = useRef(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const appsOpenRef = useRef(false);
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);
  const toolbarInteracting = useRef(false);
  const toolbarLocked = useRef(false);
  const guidePrompted = useRef(false);
  const hideTimer = useRef(0);
  const revealTimer = useRef(0);

  const scheduleToolbarHide = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!toolbarInteracting.current && !toolbarLocked.current) setToolbarVisible(false);
    }, 3000);
  }, []);

  const showToolbar = useCallback(() => {
    setToolbarVisible(true);
    window.clearTimeout(hideTimer.current);
    if (!toolbarInteracting.current && !toolbarLocked.current) scheduleToolbarHide();
  }, [scheduleToolbarHide]);

  const setMenuOpen = useCallback((open: boolean) => {
    toolbarLocked.current = open;
    setToolbarMenuOpen(open);
    setToolbarVisible(true);
    window.clearTimeout(hideTimer.current);
    if (!open && !toolbarInteracting.current) scheduleToolbarHide();
  }, [scheduleToolbarHide]);

  const setToolbarInteraction = useCallback((active: boolean) => {
    toolbarInteracting.current = active;
    if (active) {
      setToolbarVisible(true);
      window.clearTimeout(hideTimer.current);
    } else if (!toolbarLocked.current) {
      scheduleToolbarHide();
    }
  }, [scheduleToolbarHide]);

  const toggleFullscreen = useCallback(async () => {
    const win = getCurrentWindow();
    const next = !(await win.isFullscreen());
    await win.setFullscreen(next);
    setFullscreen(next);
    inputRef.current?.focus();
  }, []);

  // Local shortcuts must see the latest callbacks
  const shortcutRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  shortcutRef.current = (e) => {
    if ((e.code === "AltLeft" || e.code === "AltRight") && e.type === "keydown") showToolbar();
    if (e.code === "F11" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (!e.repeat) void toggleFullscreen();
      return true;
    }
    if (e.code === "KeyS" && e.ctrlKey && e.shiftKey && !e.altKey) {
      if (!e.repeat) setStatsVisible((v) => !v);
      return true;
    }
    return false;
  };

  // Stream: video/audio in, input out
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ime = imeRef.current!;
    let disposed = false;
    let ws: WebSocket | null = null;
    let events: WebSocket | null = null;
    let bytes = 0;
    let audioDisabledShown = false;
    let reconnectTimer = 0;

    const video = new VideoPipeline(canvas, {
      onSession: (s) => {
        videoSizeRef.current = { width: s.width, height: s.height };
        setVideoSize(videoSizeRef.current);
      },
      onFatal: (msg) => toast.show("error", "映像エラー", msg),
      requestReset: () => void api.resetVideo(session.id).catch(() => undefined),
    });

    sendRef.current = (msg) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(msg);
    };

    const input = new InputController({
      surface: canvas,
      ime,
      send: (m) => sendRef.current(m),
      videoSize: () => videoSizeRef.current,
      setDeviceClipboard: (text) => api.sendImeText(session.id, text),
      onLocalShortcut: (e) => shortcutRef.current(e),
      trackpadGestures: settings.trackpadGestures,
    });
    inputRef.current = input;

    const connect = () => {
      ws = new WebSocket(wsUrl(endpoint, "/stream"));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => setConnectionPhase("connected");
      ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        bytes += e.data.byteLength;
        const frame = parseFrame(e.data);
        if (!frame) return;
        switch (frame.kind) {
          case Kind.VIDEO_SESSION: {
            const s = parseSession(frame);
            if (s) video.handleSession(s);
            break;
          }
          case Kind.VIDEO:
            video.handleVideo(frame);
            break;
          case Kind.AUDIO_CONFIG:
            void audio.configure(frame.payload).catch((err) => console.warn("audio configure failed", err));
            break;
          case Kind.AUDIO:
            audio.decode(frame.pts, frame.payload);
            break;
          case Kind.AUDIO_DISABLED:
            if (!audioDisabledShown) {
              audioDisabledShown = true;
              toast.show("info", "音声は利用できません", "映像のみで続行します");
            }
            break;
        }
      };
      ws.onclose = () => {
        setConnectionPhase("reconnecting");
        if (!disposed) reconnectTimer = window.setTimeout(connect, 500);
      };
    };
    connect();

    // Keys captured by the low-level keyboard hook (Win, Alt+Tab, …)
    events = new WebSocket(wsUrl(endpoint, "/events"));
    events.onmessage = (e: MessageEvent<string>) => {
      try {
        const ev = JSON.parse(e.data) as HookEvent;
        if (ev.t === "key") {
          if (appsOpenRef.current) return;
          if (ev.down && (ev.code === "AltLeft" || ev.code === "AltRight")) showToolbar();
          input.handleKey(ev.code, "", ev.down, ev.repeat);
        }
      } catch {
        /* ignore */
      }
    };

    // Stats (1 s)
    let last = performance.now();
    const statsTimer = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const v = video.takeStats();
      const a = audio.getStats();
      statsRef.current = {
        fps: v.drawnFrames / dt,
        decodeLatencyMs: v.decodeLatencyMs,
        bitrateMbps: (bytes * 8) / dt / 1e6,
        width: videoSizeRef.current.width,
        height: videoSizeRef.current.height,
        connection: session.connection,
        queue: v.queueSize,
        dropped: v.droppedFrames,
        codec: v.codec,
        hardware: v.hardware,
        audioBufferedMs: a.active ? a.bufferedMs : null,
        audioUnderruns: a.underruns,
      };
      bytes = 0;
    }, 1000);

    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(statsTimer);
      input.dispose();
      inputRef.current = null;
      ws?.close();
      events?.close();
      video.close();
      audio.stopStream();
    };
  }, [session.id, endpoint, audio, toast, session.connection, showToolbar]);

  useEffect(() => {
    if (!settingsOpen) inputRef.current?.focus();
  }, [settingsOpen]);

  useEffect(() => {
    inputRef.current?.setTrackpadGestures(settings.trackpadGestures);
  }, [settings.trackpadGestures]);

  useEffect(() => audio.setVolume(settings.volume, settings.muted), [audio, settings.volume, settings.muted]);

  // Flex mode: follow the window size (debounced)
  useEffect(() => {
    if (!session.flex) return;
    const el = containerRef.current!;
    let timer = 0;
    let lastReq = "";
    const request = () => {
      const r = el.getBoundingClientRect();
      const size = flexDisplaySize({ width: r.width, height: r.height }, window.devicePixelRatio);
      const key = `${size.width}x${size.height}`;
      if (key === lastReq) return;
      lastReq = key;
      void api.resizeDisplay(session.id, size.width, size.height).catch((e) => console.warn("resize failed", e));
    };
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(request, 300);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [session.flex, session.id]);

  // Drag & drop file transfer
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDragging(true);
      else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") {
        setDragging(false);
        if (p.paths.length) {
          api.transferFiles(p.paths).then(
            (n) => n === 0 && toast.show("info", "転送できるファイルがありません"),
            (err) => toast.show("error", "ファイル転送に失敗しました", errorMessage(err)),
          );
        }
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [toast]);

  // Keep track of fullscreen changes made outside the toolbar
  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onResized(() => void win.isFullscreen().then(setFullscreen));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    showToolbar();
    return () => {
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(revealTimer.current);
    };
  }, [showToolbar]);

  // The toolbar covers the caption buttons of DeX windows at the top of the
  // screen, so passing over the top edge on the way to them must not open it:
  // only resting against the edge does (like an auto-hide taskbar).
  const cancelReveal = () => {
    window.clearTimeout(revealTimer.current);
    revealTimer.current = 0;
  };
  const trackTopEdge = (clientY: number) => {
    if (clientY > TOOLBAR_EDGE_PX) {
      cancelReveal();
    } else if (!revealTimer.current) {
      revealTimer.current = window.setTimeout(() => {
        revealTimer.current = 0;
        showToolbar();
      }, TOOLBAR_REVEAL_DELAY_MS);
    }
  };

  useEffect(() => {
    if (connectionPhase !== "connected" || guidePrompted.current) return;
    guidePrompted.current = true;
    try {
      if (!hasSeenSessionGuide(window.localStorage)) setGuideOpen(true);
    } catch {
      setGuideOpen(true);
    }
  }, [connectionPhase]);

  const closeGuide = () => {
    try { markSessionGuideSeen(window.localStorage); } catch { /* storage unavailable */ }
    setGuideOpen(false);
    inputRef.current?.focus();
  };

  const requestDisconnect = () => {
    if (settings.destroyContent) setDisconnectConfirmOpen(true);
    else onDisconnect();
  };

  const pressKey = (keycode: number) => {
    sendRef.current(encodeInjectKeycode(KeyAction.DOWN, keycode, 0, 0));
    sendRef.current(encodeInjectKeycode(KeyAction.UP, keycode, 0, 0));
    inputRef.current?.focus();
  };

  // BACK_OR_SCREEN_ON: Back, or wakes the phone if its screen is off
  const pressBack = () => {
    sendRef.current(encodeBackOrScreenOn(KeyAction.DOWN));
    sendRef.current(encodeBackOrScreenOn(KeyAction.UP));
    inputRef.current?.focus();
  };

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-black"
      onMouseMove={(e) => trackTopEdge(e.clientY)}
      onMouseLeave={cancelReveal}
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        lastPointerRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      }}
    >
      <canvas
        ref={canvasRef}
        width={videoSize.width}
        height={videoSize.height}
        className="block h-full w-full touch-none object-contain outline-none"
      />
      {/* While composing, the IME text box is shown next to the last click so the preedit text and the candidate list are visible there. */}
      <textarea
        ref={imeRef}
        className={imeBox ? "ime-sink ime-sink--composing" : "ime-sink"}
        style={imeBox ? { left: imeBox.x, top: imeBox.y } : undefined}
        onCompositionStart={() => {
          const r = containerRef.current?.getBoundingClientRect();
          setImeBox(imeAnchor(lastPointerRef.current, { width: r?.width ?? 0, height: r?.height ?? 0 }, IME_BOX));
        }}
        onCompositionEnd={() => setImeBox(null)}
        onBlur={() => setImeBox(null)}
        rows={1}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        tabIndex={-1}
        aria-hidden
      />

      <Toolbar
        visible={toolbarVisible}
        menuOpen={toolbarMenuOpen}
        connected={connectionPhase === "connected"}
        deviceName={session.deviceName || session.serial}
        fullscreen={fullscreen}
        volume={settings.volume}
        muted={settings.muted}
        audio={session.audio}
        statsVisible={statsVisible}
        phoneScreenOff={phoneScreenOff}
        onTogglePhoneScreen={() => {
          inputRef.current?.focus();
          // A second click before the first answer would send the same
          // request again from stale state.
          if (phoneScreenBusy.current) return;
          phoneScreenBusy.current = true;
          const off = !phoneScreenOff;
          api
            .setPhoneScreen(session.id, !off)
            .then(
              () => setPhoneScreenOff(off),
              (e) => toast.show("error", "スマホの画面を切り替えられませんでした", errorMessage(e)),
            )
            .finally(() => {
              phoneScreenBusy.current = false;
            });
        }}
        onBack={pressBack}
        onHome={() => pressKey(AKEYCODE.HOME)}
        onRecents={() => pressKey(AKEYCODE.APP_SWITCH)}
        onVolume={(volume) => onPatchSettings({ volume, muted: false })}
        onToggleMute={() => onPatchSettings({ muted: !settings.muted })}
        onToggleStats={() => setStatsVisible((v) => !v)}
        onToggleFullscreen={() => void toggleFullscreen()}
        onOpenSettings={onOpenSettings}
        onOpenLog={onOpenLog}
        onShow={showToolbar}
        onInteractionChange={setToolbarInteraction}
        onMenuOpenChange={setMenuOpen}
          onOpenGuide={() => setGuideOpen(true)}
          onOpenApps={() => { inputRef.current?.releaseAll(); appsOpenRef.current = true; setAppsOpen(true); }}
        onDisconnect={requestDisconnect}
      />

      {statsVisible && <LiveStatsOverlay source={statsRef} />}
      <DeviceLockNotice key={session.id} sessionId={session.id} />

      {connectionPhase !== "connected" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/35 text-white/75">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/25 border-t-white/80" />
          <span className="text-sm">{connectionPhase === "reconnecting" ? "接続が途切れました。再接続しています…" : "DeX の映像に接続しています…"}</span>
        </div>
      )}

      {guideOpen && <SessionGuide onClose={closeGuide} />}
      {appsOpen && <AppLauncher key={session.id} sessionId={session.id} onClose={() => { appsOpenRef.current = false; setAppsOpen(false); inputRef.current?.focus(); }} />}
      {disconnectConfirmOpen && <DisconnectConfirm onCancel={() => { setDisconnectConfirmOpen(false); inputRef.current?.focus(); }} onConfirm={() => { setDisconnectConfirmOpen(false); onDisconnect(); }} />}

      {dragging && (
        <div className="pointer-events-none absolute inset-4 z-40 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-white/70 bg-accent/30 text-white">
          <Icon name="upload" className="mb-2 h-10 w-10" />
          <div className="text-lg font-semibold">ドロップして端末に転送</div>
          <div className="text-sm text-white/80">{settings.transferDir}</div>
        </div>
      )}
    </div>
  );
}
