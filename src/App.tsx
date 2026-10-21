import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectScreen } from "./components/ConnectScreen";
import { SessionLog } from "./components/LogPanel";
import { SessionScreen } from "./components/SessionScreen";
import { SettingsModal } from "./components/SettingsModal";
import { ToastProvider, useToast } from "./components/Toasts";
import { api, errorMessage, events, type DeviceInfo, type EnvInfo, type SessionInfo, type Settings } from "./lib/tauri";
import { AudioPlayer } from "./media/audio";

function Shell() {
  const toast = useToast();
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  // null until the first list arrives: "no devices" must not flash at startup.
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectInFlight = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [audio] = useState(() => new AudioPlayer());
  const settingsRef = useRef<Settings | null>(null);
  const settingsSaves = useRef<Promise<void>>(Promise.resolve());
  // `starting` only reaches the buttons after a render: two clicks in the same
  // frame would both get through.
  const startInFlight = useRef(false);

  useEffect(() => {
    // Events can overtake the initial snapshot requests below: a snapshot that
    // arrives after an event is older than it and must not overwrite it.
    let devicesFromEvent = false;
    const endedSessions = new Set<number>();
    const unlisteners = [
      events.devices((list) => {
        devicesFromEvent = true;
        setDevices(list);
      }),
      events.sessionEnded((e) => {
        endedSessions.add(e.id);
        setSession((cur) => (cur && cur.id === e.id ? null : cur));
        toast.show("info", "DeX セッションを終了しました", e.reason);
      }),
    ];
    const initFailed = (e: unknown) => toast.show("error", "初期化に失敗しました", errorMessage(e));
    void api.getEnv().then(setEnv, initFailed);
    void api.getSettings().then((value) => {
      // A save made while loading is newer than this snapshot.
      if (settingsRef.current) return;
      settingsRef.current = value;
      setSettings(value);
    }, initFailed);
    void api.getDevices().then(
      (list) => {
        if (!devicesFromEvent) setDevices(list);
      },
      (e) => {
        if (!devicesFromEvent) setDevices([]);
        initFailed(e);
      },
    );
    void api.getSession().then((s) => {
      if (s && !endedSessions.has(s.id)) setSession(s);
    }, initFailed);
    return () => {
      for (const u of unlisteners) void u.then((f) => f());
    };
  }, [toast]);

  const start = useCallback(
    async (serial: string) => {
      if (startInFlight.current) return;
      startInFlight.current = true;
      setStarting(serial);
      try {
        // Created inside the click handler to satisfy the autoplay policy
        if (settings?.audio) await audio.resume().catch((e) => console.warn("audio init failed", e));
        const info = await api.startSession(serial);
        setSession(info);
      } catch (e) {
        toast.show("error", "DeX を開始できませんでした", errorMessage(e));
        setLogOpen(true);
      } finally {
        startInFlight.current = false;
        setStarting(null);
      }
    },
    [settings?.audio, toast, audio],
  );

  const disconnect = useCallback(async () => {
    if (disconnectInFlight.current) return;
    disconnectInFlight.current = true;
    setDisconnecting(true);
    try {
      await api.stopSession();
      setSession(null);
    } catch (e) {
      // The session is still running: keep showing it instead of a
      // disconnected screen that contradicts the device.
      toast.show("error", "切断に失敗しました", errorMessage(e));
    } finally {
      disconnectInFlight.current = false;
      setDisconnecting(false);
    }
  }, [toast]);

  /** Resolves true once `next` is stored by the backend. */
  const persistSettings = useCallback(
    (next: Settings): Promise<boolean> => {
      settingsRef.current = next;
      setSettings(next);
      const task = settingsSaves.current
        .catch(() => undefined)
        .then(async () => {
          const saved = await api.setSettings(next);
          if (settingsRef.current === next) {
            settingsRef.current = saved;
            setSettings(saved);
          }
        });
      settingsSaves.current = task.then(() => undefined, () => undefined);
      return task.then(
        () => true,
        async (e) => {
          toast.show("error", "設定を保存できませんでした", errorMessage(e));
          if (settingsRef.current === next) {
            try {
              const current = await api.getSettings();
              settingsRef.current = current;
              setSettings(current);
            } catch {
              // Keep the optimistic value until the next successful refresh.
            }
          }
          return false;
        },
      );
    },
    [toast],
  );

  const patchSettings = useCallback(
    (patch: Partial<Settings>) => {
      const current = settingsRef.current;
      if (current) void persistSettings({ ...current, ...patch });
    },
    [persistSettings],
  );

  return (
    <div className="h-full">
      {session && env && settings ? (
        <SessionScreen
          session={session}
          endpoint={env.endpoint}
          settings={settings}
          settingsOpen={settingsOpen}
          disconnecting={disconnecting}
          audio={audio}
          onDisconnect={() => void disconnect()}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenLog={() => setLogOpen((v) => !v)}
          onPatchSettings={patchSettings}
        />
      ) : (
        <ConnectScreen
          env={env}
          settings={settings}
          devices={devices}
          starting={starting}
          onStart={(s) => void start(s)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenLog={() => setLogOpen((v) => !v)}
        />
      )}

      {settingsOpen && settings && (
        <SettingsModal
          settings={settings}
          sessionActive={!!session}
          onClose={() => setSettingsOpen(false)}
          onSave={(s) => {
            void persistSettings(s).then((saved) => saved && toast.show("success", "設定を保存しました"));
            setSettingsOpen(false);
          }}
        />
      )}
      <SessionLog open={logOpen} logDir={env?.logDir ?? null} onClose={() => setLogOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
