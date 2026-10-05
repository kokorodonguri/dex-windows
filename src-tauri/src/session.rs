//! One DeX session: pushes and starts scrcpy-server on a new virtual display,
//! connects the video/audio/control sockets through `adb forward`, and runs
//! the demux/control tasks until stopped.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout, Instant};
use tokio_util::sync::CancellationToken;

use crate::adb::{self, Adb, Connection};
use crate::binaries::{DEVICE_SERVER_PATH, SERVER_VERSION};
use crate::control::{parse_device_message, DeviceMessage};
use crate::demuxer::{
    self, Demuxer, StreamKind, StreamStart, CODEC_ID_H264, CODEC_ID_OPUS, KIND_AUDIO_DISABLED,
};
use crate::dex;
use crate::layout;
use crate::proc;
use crate::settings::{DexStrategy, Settings};
use crate::ws::StreamHub;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_RETRY: Duration = Duration::from_millis(100);
/// How often the window layout of the virtual display is checked.
const LAYOUT_POLL: Duration = Duration::from_millis(1000);
const DUMP_TIMEOUT: Duration = Duration::from_secs(2);
const DEVICE_NAME_FIELD_LENGTH: usize = 64;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: u64,
    pub serial: String,
    pub device_name: String,
    pub display_id: u32,
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub connection: Connection,
    pub audio: bool,
    pub flex: bool,
    pub launcher: Option<String>,
}

pub struct StartParams {
    pub adb: Adb,
    pub serial: String,
    pub server_path: PathBuf,
    pub settings: Settings,
    pub on_apps_on_dex: AppsOnDexHandler,
}

pub type DeviceMessageHandler = Arc<dyn Fn(DeviceMessage) + Send + Sync>;

/// Receives the packages currently on the DeX display (visible or minimised),
/// so they can be journaled before they return to the phone.
pub type AppsOnDexHandler = Arc<dyn Fn(&[String]) + Send + Sync>;

/// Sends `(session id, reason)` when a session ends by itself.
pub type EndSender = mpsc::UnboundedSender<(u64, String)>;

pub struct Session {
    pub info: SessionInfo,
    adb: Adb,
    cancel: CancellationToken,
    tasks: Vec<JoinHandle<()>>,
    child_task: Option<JoinHandle<()>>,
    port: u16,
    freeform: bool,
    display_size: Arc<AtomicU64>,
    /// Apps on the DeX display move to the phone when the display goes away
    /// (`vd_destroy_content=false`).
    returns_apps: bool,
    on_apps_on_dex: AppsOnDexHandler,
}

fn pack_size(width: u32, height: u32) -> u64 {
    ((width as u64) << 32) | height as u64
}

/// Builds the `key=value` arguments for `com.genymobile.scrcpy.Server`.
pub fn server_args(scid: u32, s: &Settings) -> Vec<String> {
    let mut args = vec![
        SERVER_VERSION.to_string(),
        format!("scid={scid:08x}"),
        "log_level=info".into(),
        "tunnel_forward=true".into(),
        "video_codec=h264".into(),
        format!("video_bit_rate={}", s.bit_rate_mbps as u64 * 1_000_000),
        format!("max_fps={}", s.max_fps),
        format!("new_display={}x{}/{}", s.width, s.height, s.dpi),
        "vd_system_decorations=true".into(),
        format!("vd_destroy_content={}", s.destroy_content),
    ];
    if let Some(policy) = s.ime_policy.server_value() {
        args.push(format!("display_ime_policy={policy}"));
    }
    args.push(format!("audio={}", s.audio));
    if s.audio {
        args.push("audio_codec=opus".into());
    }
    args.push("control=true".into());
    args.push(format!("clipboard_autosync={}", s.clipboard_sync));
    args.push("stay_awake=true".into());
    if s.flex_display {
        args.push("flex_display=true".into());
    }
    args
}

/// Parses `New display: 1920x1080/240 (id=18)` from a server log line.
pub fn parse_new_display(line: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = &line[line.find("New display: ")? + "New display: ".len()..];
    let (size, rest) = rest.split_once('/')?;
    let (w, h) = size.split_once('x')?;
    let (dpi, rest) = rest.split_once(" (id=")?;
    let id = rest.split_once(')')?.0;
    Some((
        w.trim().parse().ok()?,
        h.trim().parse().ok()?,
        dpi.trim().parse().ok()?,
        id.trim().parse().ok()?,
    ))
}

fn parse_device_name(meta: &[u8; DEVICE_NAME_FIELD_LENGTH]) -> String {
    let end = meta.iter().position(|&b| b == 0).unwrap_or(meta.len());
    String::from_utf8_lossy(&meta[..end]).into_owned()
}

/// Server log line → (level, message without the "[server] LEVEL: " prefix).
fn classify_server_line(line: &str) -> (log::Level, &str) {
    let msg = line.strip_prefix("[server] ").unwrap_or(line);
    for (prefix, level) in [
        ("ERROR: ", log::Level::Error),
        ("WARN: ", log::Level::Warn),
        ("INFO: ", log::Level::Info),
        ("DEBUG: ", log::Level::Debug),
        ("VERBOSE: ", log::Level::Trace),
    ] {
        if let Some(m) = msg.strip_prefix(prefix) {
            return (level, m);
        }
    }
    (log::Level::Info, msg)
}

async fn ensure_server_pushed(adb: &Adb, serial: &str, local: &PathBuf) -> Result<()> {
    let local_size = std::fs::metadata(local)
        .with_context(|| format!("scrcpy-server not found at {}", local.display()))?
        .len();
    if adb.remote_size(serial, DEVICE_SERVER_PATH).await == Some(local_size) {
        log::info!("scrcpy-server already on the device ({local_size} bytes), skipping push");
        return Ok(());
    }
    log::info!("pushing scrcpy-server v{SERVER_VERSION} to {DEVICE_SERVER_PATH}");
    adb::push(serial, local, DEVICE_SERVER_PATH, |_, _| {}).await
}

/// Connects to the first (video) socket. Until the server listens, adb
/// accepts the TCP connection and closes it immediately, so a successful
/// connection is only confirmed by the server's dummy byte.
async fn connect_first(
    port: u16,
    server_alive: &watch::Receiver<bool>,
    errors: &Mutex<Vec<String>>,
) -> Result<TcpStream> {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        if !*server_alive.borrow() {
            let errs = errors.lock().unwrap().join("; ");
            bail!(
                "scrcpy-server exited during startup{}",
                if errs.is_empty() {
                    String::new()
                } else {
                    format!(": {errs}")
                }
            );
        }
        if let Ok(Ok(mut stream)) = timeout(
            Duration::from_secs(2),
            TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        {
            let mut dummy = [0u8; 1];
            if let Ok(Ok(1)) = timeout(Duration::from_secs(2), stream.read(&mut dummy)).await {
                stream.set_nodelay(true)?;
                return Ok(stream);
            }
        }
        if Instant::now() >= deadline {
            bail!("timed out connecting to scrcpy-server");
        }
        sleep(CONNECT_RETRY).await;
    }
}

async fn connect_next(port: u16) -> Result<TcpStream> {
    let stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(("127.0.0.1", port)))
        .await
        .map_err(|_| anyhow!("timed out connecting to scrcpy-server"))?
        .context("connect to scrcpy-server")?;
    stream.set_nodelay(true)?;
    Ok(stream)
}

struct ServerProcess {
    display_rx: oneshot::Receiver<(u32, u32, u32, u32)>,
    alive_rx: watch::Receiver<bool>,
    errors: Arc<Mutex<Vec<String>>>,
    child_task: JoinHandle<()>,
}

type DisplaySender = Arc<Mutex<Option<oneshot::Sender<(u32, u32, u32, u32)>>>>;

fn spawn_server(
    p: &StartParams,
    scid: u32,
    id: u64,
    cancel: CancellationToken,
    end_tx: EndSender,
) -> Result<ServerProcess> {
    let mut cmd = proc::command(&p.adb.path);
    cmd.args([
        "-s",
        &p.serial,
        "shell",
        &format!("CLASSPATH={DEVICE_SERVER_PATH}"),
        "app_process",
        "/",
        "com.genymobile.scrcpy.Server",
    ]);
    cmd.args(server_args(scid, &p.settings));
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child: Child = cmd
        .spawn()
        .context("failed to start adb shell for scrcpy-server")?;

    let (display_tx, display_rx) = oneshot::channel();
    let display_tx = Arc::new(Mutex::new(Some(display_tx)));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let (alive_tx, alive_rx) = watch::channel(true);

    fn pump<R: AsyncRead + Unpin + Send + 'static>(
        reader: R,
        display_tx: DisplaySender,
        errors: Arc<Mutex<Vec<String>>>,
    ) {
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim_end();
                if line.is_empty() {
                    continue;
                }
                let (level, msg) = classify_server_line(line);
                log::log!(target: "scrcpy-server", level, "{msg}");
                if level == log::Level::Error {
                    let mut e = errors.lock().unwrap();
                    if e.len() < 8 {
                        e.push(msg.to_string());
                    }
                }
                if let Some(d) = parse_new_display(msg) {
                    if let Some(tx) = display_tx.lock().unwrap().take() {
                        let _ = tx.send(d);
                    }
                }
            }
        });
    }
    pump(
        child.stdout.take().expect("piped stdout"),
        display_tx.clone(),
        errors.clone(),
    );
    pump(
        child.stderr.take().expect("piped stderr"),
        display_tx,
        errors.clone(),
    );

    let child_task = tokio::spawn(async move {
        tokio::select! {
            status = child.wait() => {
                let _ = alive_tx.send(false);
                log::info!("scrcpy-server process exited ({})", status.map(|s| s.to_string()).unwrap_or_else(|e| e.to_string()));
                let _ = end_tx.send((id, "scrcpy-server が終了しました".into()));
            }
            _ = cancel.cancelled() => {
                // The sockets are closed by now: give the server a moment to
                // release the virtual display by itself, then kill adb shell.
                if timeout(Duration::from_secs(1), child.wait()).await.is_err() {
                    let _ = child.kill().await;
                }
                let _ = alive_tx.send(false);
            }
        }
    });

    Ok(ServerProcess {
        display_rx,
        alive_rx,
        errors,
        child_task,
    })
}

async fn dump(adb: &Adb, serial: &str, command: &str) -> Option<String> {
    match timeout(DUMP_TIMEOUT, adb.shell(serial, command)).await {
        Ok(Ok(output)) => Some(output),
        Ok(Err(e)) => {
            log::debug!("layout monitor: `{command}` failed: {e:#}");
            None
        }
        Err(_) => {
            log::debug!("layout monitor: `{command}` timed out");
            None
        }
    }
}

/// Watches the apps on the virtual display. Every app seen is reported to
/// `on_apps` (they return to the phone with DeX's configuration). With
/// `layout`, it also keeps every app window inside the area DeX leaves free:
/// apps opened on a secondary display keep the bounds they had on the phone,
/// so without this they show up cropped or hidden behind the taskbar. A
/// device that does not report tasks or insets only produces a warning: the
/// session itself keeps running.
async fn display_monitor(
    adb: Adb,
    serial: String,
    display_id: u32,
    display_size: Arc<AtomicU64>,
    layout: bool,
    on_apps: Option<AppsOnDexHandler>,
    cancel: CancellationToken,
) {
    let mut tracker: Option<layout::LayoutTracker> = None;
    let mut safe_area_of = 0u64;
    let mut warned = false;
    let mut reported: Vec<String> = Vec::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = sleep(LAYOUT_POLL) => {}
        }
        let Some(activities) = dump(&adb, &serial, "dumpsys activity activities").await else {
            continue;
        };
        let all_tasks = dex::parse_display_tasks(&activities, display_id);
        if let Some(on_apps) = &on_apps {
            let packages = dex::app_packages(&all_tasks);
            let new: Vec<String> = packages
                .into_iter()
                .filter(|p| !reported.contains(p))
                .collect();
            if !new.is_empty() {
                reported.extend(new);
                on_apps(&reported);
            }
        }
        if !layout {
            continue;
        }
        let tasks: Vec<dex::TaskInfo> = all_tasks
            .into_iter()
            .filter(|t| t.visible && t.is_app_window())
            .collect();

        // `dumpsys window` is a large dump: read it only when the display size
        // changed (Flex), since the taskbar keeps its height for a session.
        let requested = display_size.load(Ordering::Relaxed);
        if tracker.is_none() || safe_area_of != requested {
            if tasks.is_empty() && tracker.is_none() {
                continue; // nothing to lay out yet; skip the expensive dump
            }
            let Some(windows) = dump(&adb, &serial, "dumpsys window").await else {
                continue;
            };
            let size = dex::parse_display_size(&windows, display_id);
            // RESIZE_DISPLAY is asynchronous: until WindowManager reports the
            // Flex size we asked for, any safe area we computed is stale.
            if size.map(|s| pack_size(s.width, s.height)) != Some(requested) {
                continue;
            }
            let safe = size
                .zip(dex::parse_dex_taskbar_bottom_inset(&windows, display_id))
                .and_then(|(size, bottom)| layout::safe_area(size, bottom));
            let Some(safe) = safe else {
                if !warned {
                    warned = true;
                    log::warn!("display {display_id}: no DeX taskbar inset reported; leaving window layout to the device");
                }
                continue;
            };
            safe_area_of = requested;
            match tracker.as_mut() {
                None => {
                    log::info!(
                        "display {display_id}: laying out app windows in {}x{}",
                        safe.width(),
                        safe.height()
                    );
                    tracker = Some(layout::LayoutTracker::new(safe));
                }
                Some(tracker) => {
                    let moved = tracker.set_safe_area(safe);
                    log::info!(
                        "display {display_id}: safe area is now {}x{}, repositioning {} window(s)",
                        safe.width(),
                        safe.height(),
                        moved.len()
                    );
                }
            }
        }
        let Some(tracker) = tracker.as_mut() else {
            continue;
        };

        let live: Vec<u32> = tasks.iter().map(|t| t.id).collect();
        tracker.retain_live(&live);
        for task in &tasks {
            let Some(bounds) = tracker.observe(task.id, task.bounds, task.fit()) else {
                continue;
            };
            match timeout(
                DUMP_TIMEOUT,
                dex::resize_task(&adb, &serial, task.id, bounds),
            )
            .await
            {
                Ok(Ok(())) => log::info!(
                    "display {display_id}: task {} ({}) placed at {},{} {}x{}",
                    task.id,
                    task.package.as_deref().unwrap_or("?"),
                    bounds.left,
                    bounds.top,
                    bounds.width(),
                    bounds.height()
                ),
                Ok(Err(e)) => log::warn!(
                    "could not place task {} in the DeX safe area: {e:#}",
                    task.id
                ),
                Err(_) => log::warn!("timed out placing task {} in the DeX safe area", task.id),
            }
        }
    }
}

pub async fn start(
    p: StartParams,
    hub: Arc<StreamHub>,
    end_tx: EndSender,
    on_device_msg: DeviceMessageHandler,
) -> Result<Session> {
    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let adb = p.adb.clone();
    let serial = p.serial.clone();

    ensure_server_pushed(&adb, &serial, &p.server_path).await?;

    let scid = rand::random::<u32>() & 0x7FFF_FFFF;
    let port = adb
        .forward(&serial, &format!("localabstract:scrcpy_{scid:08x}"))
        .await?;
    log::info!("forwarded tcp:{port} → localabstract:scrcpy_{scid:08x}");

    let cancel = CancellationToken::new();
    let server = match spawn_server(&p, scid, id, cancel.clone(), end_tx.clone()) {
        Ok(s) => s,
        Err(e) => {
            let _ = adb.forward_remove(&serial, port).await;
            return Err(e);
        }
    };

    let mut session = Session {
        info: SessionInfo {
            id,
            serial: serial.clone(),
            device_name: String::new(),
            display_id: 0,
            width: p.settings.width,
            height: p.settings.height,
            dpi: p.settings.dpi,
            connection: adb::connection_of(&serial),
            audio: p.settings.audio,
            flex: p.settings.flex_display,
            launcher: None,
        },
        adb: adb.clone(),
        cancel: cancel.clone(),
        tasks: Vec::new(),
        child_task: Some(server.child_task),
        port,
        freeform: false,
        display_size: Arc::new(AtomicU64::new(pack_size(
            p.settings.width,
            p.settings.height,
        ))),
        returns_apps: !p.settings.destroy_content,
        on_apps_on_dex: p.on_apps_on_dex.clone(),
    };

    match connect_and_run(
        &mut session,
        &p,
        server.display_rx,
        server.alive_rx,
        &server.errors,
        hub,
        end_tx,
        on_device_msg,
    )
    .await
    {
        Ok(()) => Ok(session),
        Err(e) => {
            session.stop(false).await;
            Err(e)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn connect_and_run(
    session: &mut Session,
    p: &StartParams,
    display_rx: oneshot::Receiver<(u32, u32, u32, u32)>,
    alive_rx: watch::Receiver<bool>,
    errors: &Mutex<Vec<String>>,
    hub: Arc<StreamHub>,
    end_tx: EndSender,
    on_device_msg: DeviceMessageHandler,
) -> Result<()> {
    let port = session.port;
    let id = session.info.id;

    let mut video = connect_first(port, &alive_rx, errors).await?;
    let audio = if p.settings.audio {
        Some(connect_next(port).await?)
    } else {
        None
    };
    let control = connect_next(port).await?;

    let mut meta = [0u8; DEVICE_NAME_FIELD_LENGTH];
    timeout(Duration::from_secs(5), video.read_exact(&mut meta))
        .await
        .map_err(|_| anyhow!("timed out reading device meta"))??;
    session.info.device_name = parse_device_name(&meta);

    let (w, h, dpi, display_id) = timeout(Duration::from_secs(10), display_rx)
        .await
        .map_err(|_| anyhow!("the server did not report the new display id"))?
        .map_err(|_| anyhow!("scrcpy-server exited before creating the display"))?;
    session.info.display_id = display_id;
    session.info.width = w;
    session.info.height = h;
    session.info.dpi = dpi;
    session
        .display_size
        .store(pack_size(w, h), Ordering::Relaxed);
    log::info!(
        "DeX display {w}x{h}/{dpi} id={display_id} on {} ({})",
        session.info.device_name,
        p.serial
    );

    if p.settings.freeform_windows {
        match dex::enable_freeform(&p.adb, &p.serial, display_id).await {
            Ok(()) => {
                session.freeform = true;
                log::info!("display {display_id}: freeform windowing enabled");
            }
            Err(e) => log::warn!("could not enable freeform windowing: {e:#}"),
        }
    }

    if p.settings.dex_strategy == DexStrategy::Explicit {
        match dex::start_dex_launcher(&p.adb, &p.serial, display_id).await {
            Ok(component) => {
                log::info!("started DeX launcher {component} on display {display_id}");
                session.info.launcher = Some(component);
            }
            Err(e) => log::warn!("could not start the DeX launcher explicitly: {e:#}"),
        }
    }

    if session.freeform || session.returns_apps {
        let adb = p.adb.clone();
        let serial = p.serial.clone();
        let cancel = session.cancel.clone();
        let display_size = session.display_size.clone();
        let layout = session.freeform;
        let on_apps = session.returns_apps.then(|| session.on_apps_on_dex.clone());
        session.tasks.push(tokio::spawn(async move {
            display_monitor(
                adb,
                serial,
                display_id,
                display_size,
                layout,
                on_apps,
                cancel,
            )
            .await;
        }));
    }

    let cancel = session.cancel.clone();
    let (control_tx, mut control_rx) = mpsc::channel::<Vec<u8>>(512);
    hub.begin_session(control_tx);

    // Video
    {
        let hub = hub.clone();
        let end_tx = end_tx.clone();
        let cancel = cancel.clone();
        session.tasks.push(tokio::spawn(async move {
            let run = async {
                let mut demux = Demuxer::new(video, StreamKind::Video);
                match demux.read_codec().await? {
                    StreamStart::Codec(CODEC_ID_H264) => {}
                    StreamStart::Codec(other) => bail!("unexpected video codec 0x{other:08x}"),
                    StreamStart::Disabled | StreamStart::Error => {
                        bail!("the device could not start the video stream")
                    }
                }
                while let Some(frame) = demux.next_frame().await? {
                    hub.send_media(frame).await;
                }
                Ok::<_, anyhow::Error>("映像ストリームが終了しました".to_string())
            };
            if let Some(result) = cancel.run_until_cancelled(run).await {
                let reason = result.unwrap_or_else(|e| format!("映像ストリームエラー: {e:#}"));
                log::info!("video: {reason}");
                let _ = end_tx.send((id, reason));
            }
        }));
    }

    // Audio (optional; failure only disables audio)
    if let Some(audio) = audio {
        let hub = hub.clone();
        let cancel = cancel.clone();
        session.tasks.push(tokio::spawn(async move {
            let run = async {
                let mut demux = Demuxer::new(audio, StreamKind::Audio);
                let start = demux.read_codec().await?;
                let disabled_reason = match start {
                    StreamStart::Codec(CODEC_ID_OPUS) => None,
                    StreamStart::Codec(other) => {
                        Some((2u8, format!("unsupported audio codec 0x{other:08x}")))
                    }
                    StreamStart::Disabled => Some((0, "audio disabled by the device".to_string())),
                    StreamStart::Error => {
                        Some((1, "audio configuration error on the device".to_string()))
                    }
                };
                if let Some((code, reason)) = disabled_reason {
                    log::warn!("{reason}; continuing with video only");
                    let mut frame = Vec::with_capacity(demuxer::WS_HEADER_LEN + 1);
                    demuxer::ws_frame_header(&mut frame, KIND_AUDIO_DISABLED, 0, 0);
                    frame.push(code);
                    hub.send_media(frame).await;
                    return Ok(());
                }
                while let Some(frame) = demux.next_frame().await? {
                    hub.send_media(frame).await;
                }
                Ok::<_, anyhow::Error>(())
            };
            if let Some(Err(e)) = cancel.run_until_cancelled(run).await {
                log::warn!("audio stream error: {e:#}");
            }
        }));
    }

    // Control
    let (mut control_read, mut control_write) = control.into_split();
    {
        let cancel = cancel.clone();
        session.tasks.push(tokio::spawn(async move {
            let run = async {
                while let Some(msg) = control_rx.recv().await {
                    if let Err(e) = control_write.write_all(&msg).await {
                        log::warn!("control socket write failed: {e}");
                        break;
                    }
                }
            };
            cancel.run_until_cancelled(run).await;
        }));
    }
    {
        let cancel = cancel.clone();
        session.tasks.push(tokio::spawn(async move {
            let run = async {
                let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
                let mut chunk = vec![0u8; 64 * 1024];
                loop {
                    let n = control_read.read(&mut chunk).await?;
                    if n == 0 {
                        return Ok::<_, anyhow::Error>(());
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    while let Some((msg, used)) =
                        parse_device_message(&buf).map_err(|e| anyhow!(e))?
                    {
                        buf.drain(..used);
                        on_device_msg(msg);
                    }
                }
            };
            if let Some(Err(e)) = cancel.run_until_cancelled(run).await {
                log::warn!("device message stream error: {e:#}");
            }
        }));
    }

    Ok(())
}

impl Session {
    pub fn adb_client(&self) -> Adb {
        self.adb.clone()
    }

    pub fn serial(&self) -> &str {
        &self.info.serial
    }

    pub fn forward_port(&self) -> u16 {
        self.port
    }

    pub fn update_display_size(&self, width: u32, height: u32) {
        self.display_size
            .store(pack_size(width, height), Ordering::Relaxed);
    }

    /// Tears the session down: closes the sockets, stops the server process
    /// and removes the port forward. `device_gone` skips device commands.
    /// Apps returning to the phone are only journaled here; the caller
    /// refreshes them with [`refresh_returned_apps`] once the display is gone.
    pub async fn stop(&mut self, device_gone: bool) -> bool {
        let serial = self.info.serial.clone();
        // Taken while the DeX display still exists: once it is gone these apps
        // are listed on the phone display among everything else.
        if self.returns_apps && !device_gone && self.info.display_id != 0 {
            if let Some(output) = dump(&self.adb, &serial, "dumpsys activity activities").await {
                let returning =
                    dex::app_packages(&dex::parse_display_tasks(&output, self.info.display_id));
                if !returning.is_empty() {
                    (self.on_apps_on_dex)(&returning);
                }
            }
        }
        if self.freeform && !device_gone {
            let _ = timeout(
                Duration::from_secs(2),
                dex::reset_windowing_mode(&self.adb, &serial, self.info.display_id),
            )
            .await;
            self.freeform = false;
        }

        self.cancel.cancel();
        for task in self.tasks.drain(..) {
            let abort = task.abort_handle();
            if timeout(Duration::from_secs(2), task).await.is_err() {
                abort.abort();
            }
        }
        if let Some(task) = self.child_task.take() {
            let abort = task.abort_handle();
            if timeout(Duration::from_secs(3), task).await.is_err() {
                abort.abort();
            }
        }
        let forward_removed = if device_gone {
            false
        } else {
            match timeout(
                Duration::from_secs(3),
                self.adb.forward_remove(&serial, self.port),
            )
            .await
            {
                Ok(Ok(())) => true,
                Ok(Err(e)) => match timeout(
                    Duration::from_secs(3),
                    self.adb.forward_present(&serial, self.port),
                )
                .await
                {
                    Ok(Ok(false)) => true,
                    Ok(Ok(true)) => {
                        log::warn!("could not remove forward tcp:{}: {e:#}", self.port);
                        false
                    }
                    Ok(Err(present_error)) => {
                        log::warn!(
                            "could not remove forward tcp:{}: {e:#}; could not verify it: {present_error:#}",
                            self.port
                        );
                        false
                    }
                    Err(_) => {
                        log::warn!(
                            "could not remove forward tcp:{}: {e:#}; verification timed out",
                            self.port
                        );
                        false
                    }
                },
                Err(_) => {
                    log::warn!(
                        "timed out removing forward tcp:{}; keeping cleanup journal",
                        self.port
                    );
                    false
                }
            }
        };
        log::info!("session {} stopped", self.info.id);
        forward_removed
    }
}

/// Apps that come back from DeX keep drawing at the DeX density (210dpi
/// against the phone's 420dpi) until their process restarts, and some —
/// Discord, for one — then show tiny text on the phone. Reclaiming them in
/// the background brings them back with the phone's own configuration the
/// next time they are opened, with their screens restored as after any
/// low-memory kill. Apps in the foreground are left alone by `am kill`.
///
/// Returns false when the device could not be reached, so the journal is
/// kept for the next attempt.
pub async fn refresh_returned_apps(adb: &Adb, serial: &str, packages: &[String]) -> bool {
    if packages.is_empty() {
        return true;
    }
    if !matches!(
        timeout(DUMP_TIMEOUT, adb.shell(serial, "echo ok")).await,
        Ok(Ok(_))
    ) {
        return false;
    }
    // Let the moved activities stop, so the processes count as background.
    sleep(Duration::from_millis(800)).await;
    for package in packages {
        match timeout(DUMP_TIMEOUT, dex::kill_background_app(adb, serial, package)).await {
            Ok(Ok(())) => log::info!("restored phone configuration for {package}"),
            Ok(Err(e)) => log::warn!("could not refresh {package} after DeX: {e:#}"),
            Err(_) => log::warn!("timed out refreshing {package} after DeX"),
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_display_line() {
        assert_eq!(
            parse_new_display("New display: 1920x1080/240 (id=18)"),
            Some((1920, 1080, 240, 18))
        );
        assert_eq!(
            parse_new_display("[server] INFO: New display: 2560x1440/320 (id=7)"),
            Some((2560, 1440, 320, 7))
        );
        assert_eq!(
            parse_new_display("Device: [samsung] samsung SCG37 (Android 16)"),
            None
        );
    }

    #[test]
    fn server_line_levels() {
        assert_eq!(
            classify_server_line("[server] ERROR: boom"),
            (log::Level::Error, "boom")
        );
        assert_eq!(
            classify_server_line("[server] INFO: hi"),
            (log::Level::Info, "hi")
        );
        assert_eq!(
            classify_server_line("Aborted"),
            (log::Level::Info, "Aborted")
        );
    }

    #[test]
    fn device_name_meta() {
        let mut meta = [0u8; DEVICE_NAME_FIELD_LENGTH];
        meta[..5].copy_from_slice(b"SCG37");
        assert_eq!(parse_device_name(&meta), "SCG37");
    }

    #[test]
    fn args_default() {
        let args = server_args(0x1234abcd, &Settings::default());
        assert_eq!(args[0], "4.1");
        assert!(args.contains(&"scid=1234abcd".to_string()));
        assert!(args.contains(&"new_display=1920x1080/240".to_string()));
        assert!(args.contains(&"video_bit_rate=12000000".to_string()));
        assert!(args.contains(&"vd_system_decorations=true".to_string()));
        assert!(args.contains(&"audio_codec=opus".to_string()));
        assert!(args.contains(&"display_ime_policy=hide".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("flex_display")));
        assert!(args.iter().all(|a| !a.contains(' ')));
    }

    #[test]
    fn args_flex_no_audio() {
        let s = Settings {
            flex_display: true,
            audio: false,
            ..Default::default()
        };
        let args = server_args(1, &s);
        assert!(args.contains(&"flex_display=true".to_string()));
        assert!(args.contains(&"audio=false".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("audio_codec")));
        assert!(args.contains(&"scid=00000001".to_string()));
    }
}
