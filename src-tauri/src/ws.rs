//! Local WebSocket server (127.0.0.1, random port, per-launch random token).
//!
//! * `/stream` — binary: demuxed video/audio frames to the frontend, and
//!   input control messages from the frontend (validated, then forwarded to
//!   the device control socket).
//! * `/events` — text (JSON): low-latency events such as keys captured by the
//!   low-level keyboard hook.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use crate::control;
use crate::demuxer::{KIND_AUDIO_CONFIG, KIND_VIDEO, KIND_VIDEO_SESSION};

const MEDIA_QUEUE: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

/// Routes frames between the active session and the connected frontend.
#[derive(Default)]
pub struct StreamHub {
    media_tx: Mutex<Option<mpsc::Sender<Message>>>,
    events_tx: Mutex<Option<(u64, mpsc::UnboundedSender<Message>)>>,
    next_events_id: AtomicU64,
    control_tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    /// Latest session frame and audio config, replayed to a (re)connecting client.
    last_session: Mutex<Option<Vec<u8>>>,
    last_audio_config: Mutex<Option<Vec<u8>>>,
    /// Set when video frames were dropped because no client was connected: the
    /// next client needs a new key frame (RESET_VIDEO).
    need_reset: AtomicBool,
    pub rx_bytes: AtomicU64,
}

impl StreamHub {
    pub fn begin_session(&self, control_tx: mpsc::Sender<Vec<u8>>) {
        *self.control_tx.lock().unwrap() = Some(control_tx);
        *self.last_session.lock().unwrap() = None;
        *self.last_audio_config.lock().unwrap() = None;
        self.need_reset.store(false, Ordering::SeqCst);
    }

    pub fn end_session(&self) {
        *self.control_tx.lock().unwrap() = None;
        *self.last_session.lock().unwrap() = None;
        *self.last_audio_config.lock().unwrap() = None;
    }

    pub fn control_sender(&self) -> Option<mpsc::Sender<Vec<u8>>> {
        self.control_tx.lock().unwrap().clone()
    }

    /// Sends a control message (encoded by Rust) to the device.
    pub async fn send_control(&self, msg: Vec<u8>) -> Result<(), String> {
        let tx = self.control_sender().ok_or("no active session")?;
        tx.send(msg)
            .await
            .map_err(|_| "control channel closed".to_string())
    }

    /// Delivers a demuxed frame to the connected client (awaiting when its
    /// queue is full, which back-pressures the device socket).
    pub async fn send_media(&self, frame: Vec<u8>) {
        self.rx_bytes
            .fetch_add(frame.len() as u64, Ordering::Relaxed);
        let kind = frame.first().copied().unwrap_or(u8::MAX);
        match kind {
            KIND_VIDEO_SESSION => *self.last_session.lock().unwrap() = Some(frame.clone()),
            KIND_AUDIO_CONFIG => *self.last_audio_config.lock().unwrap() = Some(frame.clone()),
            _ => {}
        }
        let tx = self.media_tx.lock().unwrap().clone();
        let delivered = match tx {
            Some(tx) => tx.send(Message::binary(frame)).await.is_ok(),
            None => false,
        };
        if !delivered && (kind == KIND_VIDEO || kind == KIND_VIDEO_SESSION) {
            self.need_reset.store(true, Ordering::SeqCst);
        }
    }

    pub fn send_event<T: Serialize>(&self, event: &T) {
        if let Some((_, tx)) = self.events_tx.lock().unwrap().as_ref() {
            if let Ok(text) = serde_json::to_string(event) {
                let _ = tx.send(Message::text(text));
            }
        }
    }

    fn end_events_client(&self, id: u64) {
        let mut events = self.events_tx.lock().unwrap();
        if events.as_ref().is_some_and(|(current, _)| *current == id) {
            *events = None;
        }
    }

    async fn attach_media_client(&self) -> mpsc::Receiver<Message> {
        let (tx, rx) = mpsc::channel(MEDIA_QUEUE);
        let session = self.last_session.lock().unwrap().clone();
        let audio_config = self.last_audio_config.lock().unwrap().clone();
        for frame in [session, audio_config].into_iter().flatten() {
            let _ = tx.try_send(Message::binary(frame));
        }
        *self.media_tx.lock().unwrap() = Some(tx);
        if self.need_reset.swap(false, Ordering::SeqCst) {
            // Frames were lost before this client connected: ask the device to
            // restart the encoder so the stream resumes with config + key frame.
            let _ = self.send_control(control::reset_video()).await;
        }
        rx
    }
}

pub async fn start(hub: Arc<StreamHub>) -> Result<Endpoint> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let token = format!("{:032x}", rand::random::<u128>());
    let endpoint = Endpoint {
        port,
        token: token.clone(),
    };
    log::info!("websocket server listening on 127.0.0.1:{port}");

    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let hub = hub.clone();
                    let token = token.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = handle_client(stream, hub, token).await {
                            log::debug!("websocket client ended: {e}");
                        }
                    });
                }
                Err(e) => log::warn!("websocket accept failed: {e}"),
            }
        }
    });

    Ok(endpoint)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Route {
    Stream,
    Events,
}

fn check_request(req: &Request, token: &str) -> Result<Route, &'static str> {
    let uri = req.uri();
    let query_token = uri
        .query()
        .unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("token="))
        .unwrap_or("");
    if query_token.len() != token.len() || query_token != token {
        return Err("invalid token");
    }
    match uri.path() {
        "/stream" => Ok(Route::Stream),
        "/events" => Ok(Route::Events),
        _ => Err("unknown path"),
    }
}

#[allow(clippy::result_large_err)]
async fn handle_client(stream: TcpStream, hub: Arc<StreamHub>, token: String) -> Result<()> {
    stream.set_nodelay(true)?;
    let mut route = Route::Events;
    let ws = tokio_tungstenite::accept_hdr_async(
        stream,
        |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            match check_request(req, &token) {
                Ok(r) => {
                    route = r;
                    Ok(resp)
                }
                Err(reason) => {
                    let mut err = ErrorResponse::new(Some(reason.to_string()));
                    *err.status_mut() = StatusCode::FORBIDDEN;
                    Err(err)
                }
            }
        },
    )
    .await?;

    let (mut sink, mut source) = ws.split();

    match route {
        Route::Stream => {
            let mut rx = hub.attach_media_client().await;
            let writer = async {
                while let Some(msg) = rx.recv().await {
                    if sink.send(msg).await.is_err() {
                        break;
                    }
                }
            };
            let reader = async {
                while let Some(Ok(msg)) = source.next().await {
                    match msg {
                        Message::Binary(data) => match control::validate_frontend_message(&data) {
                            Ok(()) => {
                                if let Some(tx) = hub.control_sender() {
                                    let _ = tx.send(data.to_vec()).await;
                                }
                            }
                            Err(e) => log::warn!("rejected control message: {e}"),
                        },
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
            };
            tokio::select! {
                _ = writer => {}
                _ = reader => {}
            }
        }
        Route::Events => {
            let (tx, mut rx) = mpsc::unbounded_channel();
            let id = hub.next_events_id.fetch_add(1, Ordering::Relaxed);
            *hub.events_tx.lock().unwrap() = Some((id, tx));
            let writer = async {
                while let Some(msg) = rx.recv().await {
                    if sink.send(msg).await.is_err() {
                        break;
                    }
                }
            };
            let reader = async { while let Some(Ok(_)) = source.next().await {} };
            tokio::select! {
                _ = writer => {}
                _ = reader => {}
            }
            hub.end_events_client(id);
        }
    }
    Ok(())
}
