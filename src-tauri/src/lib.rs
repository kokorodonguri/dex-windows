mod adb;
mod apps;
mod binaries;
mod clipboard;
mod control;
mod demuxer;
mod device_status;
mod dex;
mod file_transfer;
mod keyboard_hook;
mod layout;
mod proc;
mod session;
mod settings;
mod ws;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tokio::sync::mpsc;

use crate::adb::{Adb, DeviceInfo, DeviceProps, RawDevice};
use crate::clipboard::ClipboardSync;
use crate::control::DeviceMessage;
use crate::file_transfer::FileTransfer;
use crate::session::{Session, SessionInfo, StartParams};
use crate::settings::{ActiveForward, Settings, SettingsStore};
use crate::ws::{Endpoint, StreamHub};

pub struct AppState {
    settings: Mutex<Settings>,
    store: SettingsStore,
    resource_dir: Option<PathBuf>,
    log_dir: Option<PathBuf>,
    endpoint: Endpoint,
    hub: Arc<StreamHub>,
    clipboard: Arc<ClipboardSync>,
    transfer: FileTransfer,
    session: tokio::sync::Mutex<Option<Session>>,
    devices: Mutex<Vec<DeviceInfo>>,
    focused: AtomicBool,
    streaming: AtomicBool,
    closing: AtomicBool,
    end_tx: session::EndSender,
}

impl AppState {
    fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    fn adb(&self) -> Option<Adb> {
        let override_path = self.settings.lock().unwrap().adb_path.clone();
        binaries::find_adb(&override_path, self.resource_dir.as_deref()).map(Adb::new)
    }

    fn update_settings(&self, f: impl FnOnce(&mut Settings)) {
        if let Err(e) = self.try_update_settings(f) {
            log::error!("could not save settings: {e:#}");
        }
    }

    fn try_update_settings(&self, f: impl FnOnce(&mut Settings)) -> anyhow::Result<()> {
        // Serialize all saves (including the shared .tmp file). Publish only
        // after persistence succeeds, so device writes can rely on the journal.
        let mut s = self.settings.lock().unwrap();
        let mut next = s.clone();
        f(&mut next);
        self.store.save(&next)?;
        *s = next;
        Ok(())
    }

    fn update_hook(&self) {
        let enabled = self.settings.lock().unwrap().keyboard_hook;
        keyboard_hook::set_active(
            enabled && self.focused.load(Ordering::SeqCst) && self.streaming.load(Ordering::SeqCst),
        );
    }

    pub(crate) async fn session_matches(&self, session_id: u64, serial: &str) -> bool {
        self.session
            .lock()
            .await
            .as_ref()
            .is_some_and(|s| s.info.id == session_id && s.serial() == serial)
    }

    /// Queues a media scan while holding the session mutex, so disconnect
    /// cannot route an old transfer's scan request to a new device session.
    pub(crate) async fn send_transfer_scan(
        &self,
        session_id: u64,
        serial: &str,
        remote: &str,
    ) -> Result<(), String> {
        let guard = self.session.lock().await;
        if !guard
            .as_ref()
            .is_some_and(|s| s.info.id == session_id && s.serial() == serial)
        {
            return Err("セッションが終了しました".into());
        }
        let tx = self
            .hub
            .control_sender()
            .ok_or("control channel closed".to_string())?;
        tx.try_send(control::scan_file(remote))
            .map_err(|e| format!("control channel unavailable: {e}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvInfo {
    adb_path: Option<String>,
    adb_version: Option<String>,
    server_path: Option<String>,
    server_version: &'static str,
    endpoint: Endpoint,
    log_dir: Option<String>,
    app_version: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionEnded {
    id: u64,
    reason: String,
}

type CmdResult<T> = Result<T, String>;

fn err_string(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[tauri::command]
async fn get_env(app: AppHandle, state: State<'_, AppState>) -> CmdResult<EnvInfo> {
    let adb = state.adb();
    let adb_version = match &adb {
        Some(a) => a.version().await.ok(),
        None => None,
    };
    Ok(EnvInfo {
        adb_path: adb.map(|a| a.path.display().to_string()),
        adb_version,
        server_path: binaries::find_server(state.resource_dir.as_deref())
            .map(|p| p.display().to_string()),
        server_version: binaries::SERVER_VERSION,
        endpoint: state.endpoint.clone(),
        log_dir: state.log_dir.as_ref().map(|p| p.display().to_string()),
        app_version: app.package_info().version.to_string(),
    })
}

#[tauri::command]
fn get_devices(state: State<'_, AppState>) -> Vec<DeviceInfo> {
    state.devices.lock().unwrap().clone()
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
fn set_settings(state: State<'_, AppState>, settings: Settings) -> CmdResult<Settings> {
    let mut next = settings.sanitized();
    let clipboard_sync = next.clipboard_sync;
    state
        .try_update_settings(|s| {
            // Internal state is owned by the backend, never by the settings UI
            let pending = std::mem::take(&mut s.pending_restores);
            let app_refresh = std::mem::take(&mut s.pending_app_refresh);
            let forward = s.active_forward.take();
            next.pending_restore = None;
            next.pending_restores = pending;
            next.pending_app_refresh = app_refresh;
            next.active_forward = forward;
            *s = next;
        })
        .map_err(err_string)?;
    if state.streaming.load(Ordering::SeqCst) {
        state.clipboard.set_enabled(clipboard_sync);
    }
    state.update_hook();
    Ok(state.settings())
}

#[tauri::command]
async fn adb_connect(state: State<'_, AppState>, address: String) -> CmdResult<String> {
    let adb = state.adb().ok_or("adb.exe が見つかりません")?;
    adb.connect(address.trim()).await.map_err(err_string)
}

#[tauri::command]
async fn adb_pair(state: State<'_, AppState>, address: String, code: String) -> CmdResult<String> {
    let adb = state.adb().ok_or("adb.exe が見つかりません")?;
    adb.pair(address.trim(), code.trim())
        .await
        .map_err(err_string)
}

#[tauri::command]
async fn get_session(state: State<'_, AppState>) -> CmdResult<Option<SessionInfo>> {
    Ok(state.session.lock().await.as_ref().map(|s| s.info.clone()))
}

#[tauri::command]
async fn list_session_apps(
    state: State<'_, AppState>,
    session_id: u64,
) -> CmdResult<Vec<apps::LaunchableApp>> {
    static SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let _permit = SLOT.try_acquire().map_err(|_| "アプリ一覧を取得中です")?;
    let (adb, serial) = {
        let guard = state.session.lock().await;
        let s = guard
            .as_ref()
            .filter(|s| s.info.id == session_id)
            .ok_or("接続が変更されました")?;
        (s.adb_client(), s.info.serial.clone())
    };
    let server = binaries::find_server(state.resource_dir.as_deref())
        .ok_or("scrcpy-server が見つかりません")?;
    let apps = tokio::time::timeout(Duration::from_secs(8), apps::list(&adb, &serial, &server))
        .await
        .map_err(|_| "アプリ一覧の取得がタイムアウトしました")?
        .map_err(|e| format!("{e:#}"))?;
    let guard = state.session.lock().await;
    if guard.as_ref().is_none_or(|s| s.info.id != session_id) {
        return Err("接続が変更されました".into());
    }
    Ok(apps)
}

#[tauri::command]
async fn launch_session_app(
    state: State<'_, AppState>,
    session_id: u64,
    component: String,
) -> CmdResult<()> {
    static SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let _permit = SLOT.try_acquire().map_err(|_| "アプリを起動中です")?;
    // Serialize the bounded device write with disconnect so the target display
    // cannot be removed/reused between validation and am start.
    let guard = state.session.lock().await;
    let s = guard
        .as_ref()
        .filter(|s| s.info.id == session_id)
        .ok_or("接続が変更されました")?;
    if state.closing.load(Ordering::SeqCst) {
        return Err("終了処理中です".into());
    }
    tokio::time::timeout(
        Duration::from_secs(3),
        apps::launch(
            &s.adb_client(),
            &s.info.serial,
            s.info.display_id,
            &component,
        ),
    )
    .await
    .map_err(|_| "起動確認がタイムアウトしました。画面を確認してください")?
    .map_err(|e| format!("{e:#}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDeviceStatus {
    session_id: u64,
    keyguard_showing: Option<bool>,
}

#[tauri::command]
async fn get_session_device_status(
    state: State<'_, AppState>,
    session_id: u64,
) -> CmdResult<SessionDeviceStatus> {
    static DIAGNOSTIC_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let _permit = DIAGNOSTIC_SLOT
        .try_acquire()
        .map_err(|_| "device status check already running")?;
    let (adb, serial) = {
        let guard = state.session.lock().await;
        let session = guard
            .as_ref()
            .filter(|s| s.info.id == session_id)
            .ok_or("session changed")?;
        (session.adb_client(), session.info.serial.clone())
    };
    // Do not hold the session mutex during an external process: disconnect must
    // remain responsive even when ADB is unresponsive. run() kills on drop.
    let keyguard_showing = match tokio::time::timeout(
        Duration::from_secs(2),
        adb.shell(&serial, "dumpsys window policy"),
    )
    .await
    {
        Ok(Ok(output)) => device_status::parse_keyguard_showing(&output),
        _ => None,
    };
    let guard = state.session.lock().await;
    if guard.as_ref().is_none_or(|s| s.info.id != session_id) {
        return Err("session changed".into());
    }
    Ok(SessionDeviceStatus {
        session_id,
        keyguard_showing,
    })
}

#[tauri::command]
async fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    serial: String,
) -> CmdResult<SessionInfo> {
    let mut guard = state.session.lock().await;
    if state.closing.load(Ordering::SeqCst) {
        return Err("アプリを終了しています".into());
    }
    if guard.is_some() {
        return Err("セッションは既に実行中です".into());
    }
    let adb = state
        .adb()
        .ok_or("adb.exe が見つかりません。設定で adb のパスを指定してください")?;
    let server_path = binaries::find_server(state.resource_dir.as_deref())
        .ok_or("scrcpy-server が見つかりません。`npm run fetch:bin` を実行してください")?;
    let settings = state.settings();

    // Do not overwrite a forward journal from a previous crashed session.
    clear_stale_forward(&state, &adb).await?;

    // A previous crash may have left the device-wide DeX settings modified.
    // Restore them before starting a normal session; otherwise the new
    // session would inherit a stale global configuration.
    if !settings.force_desktop_mode {
        restore_pending(&state, &adb, &serial)
            .await
            .map_err(|e| format!("端末設定を復元できませんでした: {e}"))?;
    }
    // Apps left with DeX's configuration by a session that was cut short.
    refresh_pending_apps(&state, &adb, &serial).await;

    if settings.force_desktop_mode {
        let result = dex::force_desktop_mode(&adb, &serial, |previous| {
            state.try_update_settings(|s| {
                // Keep the original baseline if an earlier restore failed.
                s.remember_restore(serial.clone(), previous);
            })
        })
        .await;
        if let Err(e) = result {
            if let Err(restore_error) = restore_pending(&state, &adb, &serial).await {
                log::warn!("could not restore settings after failed start: {restore_error}");
            }
            return Err(err_string(e));
        }
    }

    let clipboard = state.clipboard.clone();
    let on_device_msg: session::DeviceMessageHandler = Arc::new(move |msg| match msg {
        DeviceMessage::Clipboard(text) => clipboard.on_device_clipboard(text),
        DeviceMessage::AckClipboard(seq) => log::debug!("clipboard ack {seq}"),
        DeviceMessage::UhidOutput { .. } => {}
    });

    // Journal every app that reaches the DeX display as soon as it is seen, so
    // it is refreshed for the phone even if the session ends abruptly.
    let journal_app = app.clone();
    let journal_serial = serial.clone();
    let on_apps_on_dex: session::AppsOnDexHandler = Arc::new(move |packages| {
        let state = journal_app.state::<AppState>();
        let known = !state
            .settings
            .lock()
            .unwrap()
            .needs_app_refresh_entry(&journal_serial, packages);
        if !known {
            state.update_settings(|s| {
                s.pending_app_refresh
                    .entry(journal_serial.clone())
                    .or_default()
                    .extend(packages.iter().cloned())
            });
        }
    });

    let params = StartParams {
        adb: adb.clone(),
        serial: serial.clone(),
        server_path,
        settings: settings.clone(),
        on_apps_on_dex,
    };
    match session::start(
        params,
        state.hub.clone(),
        state.end_tx.clone(),
        on_device_msg,
    )
    .await
    {
        Ok(session) => {
            let info = session.info.clone();
            let forward = ActiveForward {
                serial: serial.clone(),
                port: session.forward_port(),
            };
            let mut session = session;
            if let Err(e) = state.try_update_settings(|s| s.active_forward = Some(forward)) {
                log::error!(
                    "could not persist the active ADB forward: {e:#}; stopping the session"
                );
                session.stop(false).await;
                state.hub.end_session();
                if let Err(restore_error) = restore_pending(&state, &adb, &serial).await {
                    log::warn!("could not restore settings after failed start: {restore_error}");
                }
                return Err(format!(
                    "セッションの後処理情報を保存できませんでした: {e:#}"
                ));
            }
            *guard = Some(session);
            state.streaming.store(true, Ordering::SeqCst);
            state.update_hook();
            state.clipboard.set_enabled(settings.clipboard_sync);
            state.clipboard.sync_initial();
            let _ = app.emit("session-started", info.clone());
            drop(guard);
            Ok(info)
        }
        Err(e) => {
            log::error!("failed to start session: {e:#}");
            if let Err(restore_error) = restore_pending(&state, &adb, &serial).await {
                log::warn!("could not restore settings after failed start: {restore_error}");
            }
            Err(err_string(e))
        }
    }
}

// Caller holds the session mutex through restoration, excluding new starts.
async fn restore_pending(state: &AppState, adb: &Adb, serial: &str) -> Result<(), String> {
    let pending = state
        .settings
        .lock()
        .unwrap()
        .pending_restores
        .get(serial)
        .cloned();
    if let Some(values) = pending {
        dex::restore_settings(adb, serial, &values)
            .await
            .map_err(err_string)?;
        state
            .try_update_settings(|s| {
                s.pending_restores.remove(serial);
            })
            .map_err(err_string)?;
        log::info!("restored global settings on {serial}");
    }
    Ok(())
}

/// Refreshes the apps journaled for `serial` (see
/// [`session::refresh_returned_apps`]) and forgets them once the device
/// answered. Callers make sure no session is running on that device.
async fn refresh_pending_apps(state: &AppState, adb: &Adb, serial: &str) {
    let packages: Vec<String> = match state
        .settings
        .lock()
        .unwrap()
        .pending_app_refresh
        .get(serial)
    {
        Some(p) if !p.is_empty() => p.iter().cloned().collect(),
        _ => return,
    };
    if session::refresh_returned_apps(adb, serial, &packages).await {
        state.update_settings(|s| {
            s.pending_app_refresh.remove(serial);
        });
    } else {
        log::warn!("{serial} unreachable; apps from DeX will be refreshed on reconnect");
    }
}

async fn clear_stale_forward(state: &AppState, adb: &Adb) -> CmdResult<()> {
    let Some(forward) = state.settings().active_forward else {
        return Ok(());
    };
    let removal = tokio::time::timeout(
        Duration::from_secs(3),
        adb.forward_remove(&forward.serial, forward.port),
    )
    .await;
    match removal {
        Ok(Ok(())) => {}
        Ok(Err(remove_error)) => {
            let present = tokio::time::timeout(
                Duration::from_secs(3),
                adb.forward_present(&forward.serial, forward.port),
            )
            .await
            .map_err(|_| "既存のADB転送の確認がタイムアウトしました".to_string())?
            .map_err(err_string)?;
            if present {
                return Err(format!(
                    "既存のADB転送を削除できませんでした: {remove_error:#}"
                ));
            }
            log::debug!(
                "stale forward tcp:{} was already gone: {remove_error:#}",
                forward.port
            );
        }
        Err(_) => return Err("既存のADB転送の削除がタイムアウトしました".into()),
    }
    state
        .try_update_settings(|s| {
            if s.active_forward.as_ref() == Some(&forward) {
                s.active_forward = None;
            }
        })
        .map_err(err_string)?;
    Ok(())
}

async fn stop_session_inner(app: &AppHandle, id: Option<u64>, reason: &str, device_gone: bool) {
    let state = app.state::<AppState>();
    let mut guard = state.session.lock().await;
    let Some(mut session) = guard.take_if(|s| id.is_none_or(|id| s.info.id == id)) else {
        return;
    };
    state.streaming.store(false, Ordering::SeqCst);
    state.update_hook();
    state.clipboard.set_enabled(false);
    let forward_removed = session.stop(device_gone).await;
    state.hub.end_session();
    if !device_gone && forward_removed {
        state.update_settings(|s| s.active_forward = None);
    }
    if !device_gone {
        if let Some(adb) = state.adb() {
            if let Err(e) = restore_pending(&state, &adb, session.serial()).await {
                log::warn!("could not restore global settings after session stop: {e}");
            }
            refresh_pending_apps(&state, &adb, session.serial()).await;
        }
    }
    drop(guard);
    log::info!("session {} ended: {reason}", session.info.id);
    let _ = app.emit(
        "session-ended",
        SessionEnded {
            id: session.info.id,
            reason: reason.to_string(),
        },
    );
}

#[tauri::command]
async fn stop_session(app: AppHandle) -> CmdResult<()> {
    stop_session_inner(&app, None, "ユーザーが切断しました", false).await;
    Ok(())
}

#[tauri::command]
async fn send_ime_text(state: State<'_, AppState>, session_id: u64, text: String) -> CmdResult<()> {
    let Some(msg) = clipboard::ime_clipboard_message(&text) else {
        return Ok(());
    };
    // Keep the identity check and enqueue atomic with respect to disconnect:
    // an IME request from a closing session must never enter a new session.
    let guard = state.session.lock().await;
    if guard.as_ref().is_none_or(|s| s.info.id != session_id) {
        return Err("接続が変更されました".into());
    }
    let tx = state
        .hub
        .control_sender()
        .ok_or("control channel closed".to_string())?;
    tx.try_send(msg)
        .map_err(|e| format!("control channel unavailable: {e}"))
}

/// Asks the device to restart the encoder (new config + key frame), used by
/// the frontend after a decoder error.
#[tauri::command]
async fn reset_video(state: State<'_, AppState>, session_id: u64) -> CmdResult<()> {
    let guard = state.session.lock().await;
    if guard.as_ref().is_none_or(|s| s.info.id != session_id) {
        return Err("接続が変更されました".into());
    }
    let tx = state
        .hub
        .control_sender()
        .ok_or("control channel closed".to_string())?;
    tx.try_send(control::reset_video())
        .map_err(|e| format!("control channel unavailable: {e}"))
}

/// Turns the phone's own screen off/on while DeX keeps running (the server
/// turns it back on when the session ends).
#[tauri::command]
async fn set_phone_screen(state: State<'_, AppState>, session_id: u64, on: bool) -> CmdResult<()> {
    let guard = state.session.lock().await;
    if guard.as_ref().is_none_or(|s| s.info.id != session_id) {
        return Err("接続が変更されました".into());
    }
    let tx = state
        .hub
        .control_sender()
        .ok_or("control channel closed".to_string())?;
    tx.try_send(control::set_display_power(on))
        .map_err(|e| format!("control channel unavailable: {e}"))
}

#[tauri::command]
async fn resize_display(
    state: State<'_, AppState>,
    session_id: u64,
    width: u32,
    height: u32,
) -> CmdResult<()> {
    let w = width.clamp(320, 4096) as u16;
    let h = height.clamp(240, 4096) as u16;
    let guard = state.session.lock().await;
    if guard.as_ref().is_none_or(|s| s.info.id != session_id) {
        return Err("接続が変更されました".into());
    }
    let tx = state
        .hub
        .control_sender()
        .ok_or("control channel closed".to_string())?;
    tx.try_send(control::resize_display(w, h))
        .map_err(|e| format!("control channel unavailable: {e}"))?;
    guard
        .as_ref()
        .unwrap()
        .update_display_size(w as u32, h as u32);
    Ok(())
}

#[tauri::command]
async fn transfer_files(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> CmdResult<usize> {
    let (session_id, serial) = state
        .session
        .lock()
        .await
        .as_ref()
        .map(|s| (s.info.id, s.serial().to_string()))
        .ok_or("セッションが開始されていません")?;
    let dir = state.settings.lock().unwrap().transfer_dir.clone();
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    Ok(state
        .transfer
        .enqueue(&app, session_id, &serial, &paths, &dir))
}

/// Keeps the device list up to date from `host:track-devices-l`, reconnecting
/// when the adb server goes away.
fn spawn_device_tracker(app: AppHandle) {
    let (list_tx, mut list_rx) = mpsc::unbounded_channel::<Vec<RawDevice>>();

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let adb = app2.state::<AppState>().adb();
            match adb {
                Some(adb) => {
                    if let Err(e) = adb.start_server().await {
                        log::warn!("adb start-server failed: {e:#}");
                    }
                    let tx = list_tx.clone();
                    if let Err(e) = adb::track_devices(move |list| {
                        let _ = tx.send(list);
                    })
                    .await
                    {
                        log::warn!("device tracking interrupted: {e:#}");
                    }
                    let _ = list_tx.send(Vec::new());
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                None => {
                    let _ = list_tx.send(Vec::new());
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        let mut props_cache: HashMap<String, DeviceProps> = HashMap::new();
        while let Some(mut raw) = list_rx.recv().await {
            // Only the latest list matters
            while let Ok(newer) = list_rx.try_recv() {
                raw = newer;
            }
            let state = app.state::<AppState>();
            let adb = state.adb();
            for d in raw.iter().filter(|d| d.state == "device") {
                if !props_cache.contains_key(&d.serial) {
                    if let Some(adb) = &adb {
                        match adb.getprops(&d.serial).await {
                            Ok(p) => {
                                props_cache.insert(d.serial.clone(), p);
                            }
                            Err(e) => log::warn!("getprop on {} failed: {e:#}", d.serial),
                        }
                    }
                }
            }
            props_cache.retain(|serial, _| raw.iter().any(|d| &d.serial == serial));
            let list: Vec<DeviceInfo> = raw
                .iter()
                .map(|d| adb::device_info(d, props_cache.get(&d.serial)))
                .collect();
            *state.devices.lock().unwrap() = list.clone();
            let _ = app.emit("devices", list.clone());

            // End the session if its device disappeared
            let session_serial = state
                .session
                .lock()
                .await
                .as_ref()
                .map(|s| s.serial().to_string());
            if let Some(serial) = session_serial {
                if !list
                    .iter()
                    .any(|d| d.serial == serial && d.state == "device")
                {
                    stop_session_inner(&app, None, "デバイスが切断されました", true).await;
                }
            }

            // Remove a port forward left behind by a crash (or by a device that
            // disconnected mid-session and came back)
            let guard = state.session.lock().await;
            let stale = state.settings.lock().unwrap().active_forward.clone();
            if let (Some(f), Some(adb)) = (stale, adb.as_ref()) {
                let online = list
                    .iter()
                    .any(|d| d.serial == f.serial && d.state == "device");
                if online && guard.is_none() {
                    match clear_stale_forward(&state, adb).await {
                        Ok(()) => {
                            log::info!("removed stale forward tcp:{} on {}", f.port, f.serial)
                        }
                        Err(e) => log::warn!(
                            "could not remove stale forward tcp:{} on {}: {e}",
                            f.port,
                            f.serial
                        ),
                    }
                }
            }

            // Restore settings left modified by a crash
            let pending = state.settings.lock().unwrap().pending_restores.clone();
            if let Some(adb) = adb.as_ref() {
                for serial in pending.keys() {
                    let online = list
                        .iter()
                        .any(|d| &d.serial == serial && d.state == "device");
                    let active = guard.as_ref().is_some_and(|s| s.serial() == serial);
                    if online && !active {
                        if let Err(e) = restore_pending(&state, adb, serial).await {
                            log::warn!("could not restore global settings on {serial}: {e}");
                        }
                    }
                }
                // Refresh apps a cut-short session left in DeX's configuration
                let journaled: Vec<String> = state
                    .settings
                    .lock()
                    .unwrap()
                    .pending_app_refresh
                    .keys()
                    .cloned()
                    .collect();
                for serial in &journaled {
                    let online = list
                        .iter()
                        .any(|d| &d.serial == serial && d.state == "device");
                    let active = guard.as_ref().is_some_and(|s| s.serial() == serial);
                    if online && !active {
                        refresh_pending_apps(&state, adb, serial).await;
                    }
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_plugin = tauri_plugin_log::Builder::new()
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("modern-dex".into()),
            }),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
        ])
        .level(log::LevelFilter::Info)
        .level_for("tungstenite", log::LevelFilter::Warn)
        .level_for("tokio_tungstenite", log::LevelFilter::Warn)
        .max_file_size(5 * 1024 * 1024)
        .build();

    tauri::Builder::default()
        // Two copies would fight over the same phone: the second one removes
        // the first one's port forward and creates a second DeX display that
        // apps jump between. Launching again just brings the window back.
        // Registered first, so a second copy exits before doing anything.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(log_plugin)
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir()?;
            let store = SettingsStore::new(&config_dir);
            let settings = store.load();
            let resource_dir = app.path().resource_dir().ok();
            let log_dir = app.path().app_log_dir().ok();

            let hub = Arc::new(StreamHub::default());
            let endpoint = tauri::async_runtime::block_on(ws::start(hub.clone()))?;
            let clipboard = ClipboardSync::new(hub.clone());
            clipboard.start_listener();
            let transfer = FileTransfer::start(handle.clone());
            let (end_tx, mut end_rx) = mpsc::unbounded_channel::<(u64, String)>();

            log::info!(
                "Modern DeX for PC {} — scrcpy-server v{}",
                app.package_info().version,
                binaries::SERVER_VERSION
            );
            log::info!("settings: {}", config_dir.join("settings.json").display());

            app.manage(AppState {
                settings: Mutex::new(settings),
                store,
                resource_dir,
                log_dir,
                endpoint,
                hub: hub.clone(),
                clipboard,
                transfer,
                session: tokio::sync::Mutex::new(None),
                devices: Mutex::new(Vec::new()),
                focused: AtomicBool::new(true),
                streaming: AtomicBool::new(false),
                closing: AtomicBool::new(false),
                end_tx,
            });

            // Sessions ending by themselves (stream EOF, server exit)
            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Some((id, reason)) = end_rx.recv().await {
                    stop_session_inner(&h, Some(id), &reason, false).await;
                }
            });

            keyboard_hook::start(move |event| hub.send_event(&event));
            spawn_device_tracker(handle);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(focused) => {
                let state = window.state::<AppState>();
                state.focused.store(*focused, Ordering::SeqCst);
                state.update_hook();
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let state = window.state::<AppState>();
                if !state.closing.swap(true, Ordering::SeqCst) {
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        stop_session_inner(&app, None, "ウィンドウを閉じました", false).await;
                        app.exit(0);
                    });
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_env,
            get_devices,
            get_settings,
            set_settings,
            adb_connect,
            adb_pair,
            get_session,
            get_session_device_status,
            list_session_apps,
            launch_session_app,
            start_session,
            stop_session,
            send_ime_text,
            reset_video,
            set_phone_screen,
            resize_display,
            transfer_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
