//! Demuxer for the scrcpy v4 video/audio sockets.
//!
//! Stream layout: a 4-byte codec id, then a sequence of 12-byte headers.
//! A header whose MSB is set is a *session packet* (video only, no payload):
//! `[0x80 0 0 R][width u32][height u32]`, R = client-resized flag.
//! Otherwise it is a *media packet*: `[pts+flags u64][size u32]` followed by
//! `size` bytes, where bit 62 = config packet and bit 61 = key frame.
//!
//! Each packet is converted into one WebSocket frame for the frontend:
//! `[kind u8][flags u8][pts u64 BE][payload]`.

use anyhow::{bail, Result};
use tokio::io::{AsyncRead, AsyncReadExt};

pub const WS_HEADER_LEN: usize = 10;

pub const KIND_VIDEO_SESSION: u8 = 0;
pub const KIND_VIDEO: u8 = 1;
pub const KIND_AUDIO_CONFIG: u8 = 2;
pub const KIND_AUDIO: u8 = 3;
pub const KIND_AUDIO_DISABLED: u8 = 4;

pub const FLAG_KEY: u8 = 1;
pub const FLAG_CONFIG: u8 = 2;
pub const FLAG_CLIENT_RESIZED: u8 = 4;

const PACKET_FLAG_CONFIG: u64 = 1 << 62;
const PACKET_FLAG_KEY_FRAME: u64 = 1 << 61;
const PACKET_PTS_MASK: u64 = PACKET_FLAG_KEY_FRAME - 1;

const MAX_PACKET_SIZE: u32 = 64 * 1024 * 1024;
const MAX_VIDEO_WIDTH: u32 = 7680;
const MAX_VIDEO_HEIGHT: u32 = 4320;

pub const CODEC_ID_H264: u32 = 0x6832_3634; // "h264"
pub const CODEC_ID_OPUS: u32 = 0x6f70_7573; // "opus"

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Header {
    Session {
        width: u32,
        height: u32,
        client_resized: bool,
    },
    Media {
        pts: u64,
        config: bool,
        key: bool,
        size: u32,
    },
}

pub fn parse_header(h: &[u8; 12]) -> Header {
    if h[0] & 0x80 != 0 {
        Header::Session {
            width: u32::from_be_bytes([h[4], h[5], h[6], h[7]]),
            height: u32::from_be_bytes([h[8], h[9], h[10], h[11]]),
            client_resized: h[3] & 1 != 0,
        }
    } else {
        let pts_flags = u64::from_be_bytes([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]]);
        let config = pts_flags & PACKET_FLAG_CONFIG != 0;
        Header::Media {
            pts: if config {
                0
            } else {
                pts_flags & PACKET_PTS_MASK
            },
            config,
            key: pts_flags & PACKET_FLAG_KEY_FRAME != 0,
            size: u32::from_be_bytes([h[8], h[9], h[10], h[11]]),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamStart {
    Codec(u32),
    /// Code 0: the device explicitly disabled the stream (e.g. audio capture
    /// is not possible) — continue without it.
    Disabled,
    /// Code 1: configuration error on the device.
    Error,
}

pub fn parse_codec_id(id: u32) -> StreamStart {
    match id {
        0 => StreamStart::Disabled,
        1 => StreamStart::Error,
        other => StreamStart::Codec(other),
    }
}

pub fn ws_frame_header(buf: &mut Vec<u8>, kind: u8, flags: u8, pts: u64) {
    buf.push(kind);
    buf.push(flags);
    buf.extend_from_slice(&pts.to_be_bytes());
}

pub fn session_frame(width: u32, height: u32, client_resized: bool) -> Vec<u8> {
    let mut buf = Vec::with_capacity(WS_HEADER_LEN + 8);
    ws_frame_header(
        &mut buf,
        KIND_VIDEO_SESSION,
        if client_resized {
            FLAG_CLIENT_RESIZED
        } else {
            0
        },
        0,
    );
    buf.extend_from_slice(&width.to_be_bytes());
    buf.extend_from_slice(&height.to_be_bytes());
    buf
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Video,
    Audio,
}

pub struct Demuxer<R> {
    reader: R,
    kind: StreamKind,
    /// H.26x config packets (SPS/PPS) are prepended to the next media packet.
    pending_config: Option<Vec<u8>>,
    session_seen: bool,
}

impl<R: AsyncRead + Unpin> Demuxer<R> {
    pub fn new(reader: R, kind: StreamKind) -> Self {
        Self {
            reader,
            kind,
            pending_config: None,
            session_seen: false,
        }
    }

    pub async fn read_codec(&mut self) -> Result<StreamStart> {
        let mut id = [0u8; 4];
        self.reader.read_exact(&mut id).await?;
        Ok(parse_codec_id(u32::from_be_bytes(id)))
    }

    async fn read_header(&mut self) -> Result<Option<[u8; 12]>> {
        let mut h = [0u8; 12];
        let n = self.reader.read(&mut h[..1]).await?;
        if n == 0 {
            return Ok(None);
        }
        self.reader.read_exact(&mut h[1..]).await?;
        Ok(Some(h))
    }

    /// Returns the next WebSocket frame, or `None` at end of stream.
    pub async fn next_frame(&mut self) -> Result<Option<Vec<u8>>> {
        loop {
            let Some(raw) = self.read_header().await? else {
                return Ok(None);
            };
            match parse_header(&raw) {
                Header::Session {
                    width,
                    height,
                    client_resized,
                } => {
                    if self.kind != StreamKind::Video {
                        bail!("unexpected session packet on the audio stream");
                    }
                    if !(320..=MAX_VIDEO_WIDTH).contains(&width)
                        || !(240..=MAX_VIDEO_HEIGHT).contains(&height)
                    {
                        bail!("invalid session video size {width}x{height}");
                    }
                    self.session_seen = true;
                    // A new session always starts with fresh config packets
                    self.pending_config = None;
                    return Ok(Some(session_frame(width, height, client_resized)));
                }
                Header::Media {
                    pts,
                    config,
                    key,
                    size,
                } => {
                    if self.kind == StreamKind::Video && !self.session_seen {
                        bail!("media packet received before the session packet");
                    }
                    if size == 0 || size > MAX_PACKET_SIZE {
                        bail!("invalid packet size {size}");
                    }
                    let size = size as usize;

                    if config && self.kind == StreamKind::Video {
                        let mut data = vec![0u8; size];
                        self.reader.read_exact(&mut data).await?;
                        let existing = self.pending_config.as_ref().map_or(0, Vec::len);
                        if existing
                            .checked_add(size)
                            .is_none_or(|total| total > MAX_PACKET_SIZE as usize)
                        {
                            bail!("video config data is too large");
                        }
                        match &mut self.pending_config {
                            Some(existing) => existing.extend_from_slice(&data),
                            None => self.pending_config = Some(data),
                        }
                        continue;
                    }

                    let (kind, mut flags) = match (self.kind, config) {
                        (StreamKind::Video, _) => (KIND_VIDEO, 0),
                        (StreamKind::Audio, true) => (KIND_AUDIO_CONFIG, FLAG_CONFIG),
                        (StreamKind::Audio, false) => (KIND_AUDIO, 0),
                    };
                    if key {
                        flags |= FLAG_KEY;
                    }

                    let prefix = self.pending_config.take();
                    let prefix_len = prefix.as_ref().map_or(0, Vec::len);
                    if prefix_len
                        .checked_add(size)
                        .is_none_or(|total| total > MAX_PACKET_SIZE as usize)
                    {
                        bail!("video frame is too large");
                    }
                    if prefix.is_some() {
                        flags |= FLAG_CONFIG;
                    }
                    let mut frame = Vec::with_capacity(WS_HEADER_LEN + prefix_len + size);
                    ws_frame_header(&mut frame, kind, flags, pts);
                    if let Some(p) = prefix {
                        frame.extend_from_slice(&p);
                    }
                    let start = frame.len();
                    frame.resize(start + size, 0);
                    self.reader.read_exact(&mut frame[start..]).await?;
                    return Ok(Some(frame));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::ReadBuf;

    /// Reader that returns at most `chunk` bytes per read, to exercise
    /// reassembly of headers and payloads split across reads.
    struct ChunkedReader {
        data: Vec<u8>,
        pos: usize,
        chunk: usize,
    }

    impl AsyncRead for ChunkedReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let n = self
                .chunk
                .min(buf.remaining())
                .min(self.data.len() - self.pos);
            let pos = self.pos;
            buf.put_slice(&self.data[pos..pos + n]);
            self.pos += n;
            Poll::Ready(Ok(()))
        }
    }

    fn session_hdr(w: u32, h: u32, resized: bool) -> Vec<u8> {
        let mut v = vec![0x80, 0, 0, resized as u8];
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v
    }

    fn media(pts: u64, config: bool, key: bool, payload: &[u8]) -> Vec<u8> {
        let mut flags = if config { PACKET_FLAG_CONFIG } else { pts };
        if key {
            flags |= PACKET_FLAG_KEY_FRAME;
        }
        let mut v = flags.to_be_bytes().to_vec();
        v.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        v.extend_from_slice(payload);
        v
    }

    fn video_stream() -> Vec<u8> {
        let mut s = CODEC_ID_H264.to_be_bytes().to_vec();
        s.extend(session_hdr(1920, 1080, false));
        s.extend(media(0, true, false, &[0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28])); // SPS
        s.extend(media(0, true, false, &[0, 0, 0, 1, 0x68])); // PPS
        s.extend(media(1000, false, true, &[0, 0, 0, 1, 0x65, 0xAA]));
        s.extend(media(17666, false, false, &[0, 0, 0, 1, 0x41, 0xBB]));
        s.extend(session_hdr(1280, 720, true));
        s
    }

    #[test]
    fn header_session_vs_media() {
        let h: [u8; 12] = session_hdr(1920, 1080, true).try_into().unwrap();
        assert_eq!(
            parse_header(&h),
            Header::Session {
                width: 1920,
                height: 1080,
                client_resized: true
            }
        );

        let h: [u8; 12] = media(123456, false, true, &[])[..12].try_into().unwrap();
        assert_eq!(
            parse_header(&h),
            Header::Media {
                pts: 123456,
                config: false,
                key: true,
                size: 0
            }
        );

        let h: [u8; 12] = media(0, true, false, &[1, 2, 3])[..12].try_into().unwrap();
        assert_eq!(
            parse_header(&h),
            Header::Media {
                pts: 0,
                config: true,
                key: false,
                size: 3
            }
        );
    }

    #[test]
    fn codec_id_codes() {
        assert_eq!(parse_codec_id(0), StreamStart::Disabled);
        assert_eq!(parse_codec_id(1), StreamStart::Error);
        assert_eq!(
            parse_codec_id(CODEC_ID_H264),
            StreamStart::Codec(CODEC_ID_H264)
        );
    }

    async fn demux_all(
        chunk: usize,
        data: Vec<u8>,
        kind: StreamKind,
    ) -> (StreamStart, Vec<Vec<u8>>) {
        let mut d = Demuxer::new(
            ChunkedReader {
                data,
                pos: 0,
                chunk,
            },
            kind,
        );
        let start = d.read_codec().await.unwrap();
        let mut frames = Vec::new();
        while let Some(f) = d.next_frame().await.unwrap() {
            frames.push(f);
        }
        (start, frames)
    }

    #[tokio::test]
    async fn video_config_is_merged_into_next_packet() {
        for chunk in [1, 3, 7, 4096] {
            let (start, frames) = demux_all(chunk, video_stream(), StreamKind::Video).await;
            assert_eq!(start, StreamStart::Codec(CODEC_ID_H264));
            assert_eq!(frames.len(), 4, "chunk={chunk}");

            // session
            assert_eq!(frames[0][0], KIND_VIDEO_SESSION);
            assert_eq!(&frames[0][10..], &[0, 0, 0x07, 0x80, 0, 0, 0x04, 0x38]);

            // key frame with SPS+PPS prepended
            let f = &frames[1];
            assert_eq!(f[0], KIND_VIDEO);
            assert_eq!(f[1], FLAG_KEY | FLAG_CONFIG);
            assert_eq!(u64::from_be_bytes(f[2..10].try_into().unwrap()), 1000);
            assert_eq!(
                &f[10..],
                &[0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0, 0, 0, 1, 0x68, 0, 0, 0, 1, 0x65, 0xAA]
            );

            // delta frame, no config
            let f = &frames[2];
            assert_eq!(f[1], 0);
            assert_eq!(u64::from_be_bytes(f[2..10].try_into().unwrap()), 17666);
            assert_eq!(&f[10..], &[0, 0, 0, 1, 0x41, 0xBB]);

            // resized session
            assert_eq!(frames[3][0], KIND_VIDEO_SESSION);
            assert_eq!(frames[3][1], FLAG_CLIENT_RESIZED);
        }
    }

    #[tokio::test]
    async fn audio_config_is_forwarded_separately() {
        let mut s = CODEC_ID_OPUS.to_be_bytes().to_vec();
        s.extend(media(0, true, false, b"OpusHead\x01\x02"));
        s.extend(media(20000, false, false, &[0xFC, 0xFF]));
        let (start, frames) = demux_all(2, s, StreamKind::Audio).await;
        assert_eq!(start, StreamStart::Codec(CODEC_ID_OPUS));
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0][0], KIND_AUDIO_CONFIG);
        assert_eq!(&frames[0][10..], b"OpusHead\x01\x02");
        assert_eq!(frames[1][0], KIND_AUDIO);
        assert_eq!(
            u64::from_be_bytes(frames[1][2..10].try_into().unwrap()),
            20000
        );
    }

    #[tokio::test]
    async fn disabled_audio_stream() {
        let mut d = Demuxer::new(
            ChunkedReader {
                data: vec![0, 0, 0, 0],
                pos: 0,
                chunk: 1,
            },
            StreamKind::Audio,
        );
        assert_eq!(d.read_codec().await.unwrap(), StreamStart::Disabled);
        let mut d = Demuxer::new(
            ChunkedReader {
                data: vec![0, 0, 0, 1],
                pos: 0,
                chunk: 1,
            },
            StreamKind::Audio,
        );
        assert_eq!(d.read_codec().await.unwrap(), StreamStart::Error);
    }

    #[tokio::test]
    async fn media_before_session_is_rejected() {
        let mut s = CODEC_ID_H264.to_be_bytes().to_vec();
        s.extend(media(1, false, true, &[1]));
        let mut d = Demuxer::new(
            ChunkedReader {
                data: s,
                pos: 0,
                chunk: 64,
            },
            StreamKind::Video,
        );
        d.read_codec().await.unwrap();
        assert!(d.next_frame().await.is_err());
    }

    #[tokio::test]
    async fn truncated_payload_is_an_error() {
        let mut s = CODEC_ID_H264.to_be_bytes().to_vec();
        s.extend(session_hdr(320, 240, false));
        let mut m = media(1, false, true, &[1, 2, 3, 4]);
        m.truncate(m.len() - 2);
        s.extend(m);
        let mut d = Demuxer::new(
            ChunkedReader {
                data: s,
                pos: 0,
                chunk: 5,
            },
            StreamKind::Video,
        );
        d.read_codec().await.unwrap();
        assert!(d.next_frame().await.unwrap().is_some());
        assert!(d.next_frame().await.is_err());
    }

    #[tokio::test]
    async fn truncated_header_is_an_error() {
        let mut s = CODEC_ID_H264.to_be_bytes().to_vec();
        s.extend(session_hdr(320, 240, false));
        s.extend([0, 0, 0, 0]);
        let mut d = Demuxer::new(
            ChunkedReader {
                data: s,
                pos: 0,
                chunk: 5,
            },
            StreamKind::Video,
        );
        d.read_codec().await.unwrap();
        assert!(d.next_frame().await.unwrap().is_some());
        assert!(d.next_frame().await.is_err());
    }

    #[tokio::test]
    async fn unreasonable_session_size_is_rejected() {
        let mut s = CODEC_ID_H264.to_be_bytes().to_vec();
        s.extend(session_hdr(1, 1, false));
        let mut d = Demuxer::new(
            ChunkedReader {
                data: s,
                pos: 0,
                chunk: 64,
            },
            StreamKind::Video,
        );
        d.read_codec().await.unwrap();
        assert!(d.next_frame().await.is_err());
    }
}
