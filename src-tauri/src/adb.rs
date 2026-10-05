//! ADB access: the adb.exe CLI for simple commands, and the adb server's
//! smart-socket protocol (127.0.0.1:5037) for device tracking and for file
//! pushes with progress (adb.exe prints no progress when stdout is a pipe).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::proc;

const ADB_SERVER_ADDR: &str = "127.0.0.1:5037";
const SYNC_DATA_MAX: usize = 64 * 1024;
const HOST_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_HOST_RESPONSE: usize = 4 * 1024 * 1024;
const PUSH_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawDevice {
    pub serial: String,
    pub state: String,
    pub props: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub serial: String,
    pub state: String,
    pub model: String,
    pub manufacturer: String,
    pub android: String,
    pub sdk: String,
    pub oneui: String,
    pub connection: Connection,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Connection {
    Usb,
    Wifi,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceProps {
    pub model: String,
    pub manufacturer: String,
    pub android: String,
    pub sdk: String,
    pub oneui: String,
}

/// `ip:port` serials and mDNS TLS serials are Wi-Fi (TCP) connections.
pub fn connection_of(serial: &str) -> Connection {
    if serial.contains("._adb-tls-connect._tcp") || serial.contains("._adb._tcp") {
        return Connection::Wifi;
    }
    match serial.rsplit_once(':') {
        Some((host, port))
            if !host.is_empty() && !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) =>
        {
            Connection::Wifi
        }
        _ => Connection::Usb,
    }
}

/// Parses the payload of a `host:track-devices-l` (or `adb devices -l`) message.
pub fn parse_devices_l(payload: &str) -> Vec<RawDevice> {
    payload
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with("List of devices") || line.starts_with('*') {
                return None;
            }
            let mut tokens = line.split_whitespace();
            let serial = tokens.next()?.to_string();
            let rest: Vec<&str> = tokens.collect();
            let mut state = rest.first().copied().unwrap_or("unknown").to_string();
            if state == "no" && rest.get(1) == Some(&"permissions") {
                state = "no permissions".into();
            }
            // Only `key:value` tokens with a plain lowercase key are properties;
            // this skips free-form text such as the "no permissions" explanation.
            let props = rest
                .iter()
                .skip(1)
                .filter_map(|tok| tok.split_once(':'))
                .filter(|(k, _)| {
                    !k.is_empty() && k.chars().all(|c| c.is_ascii_lowercase() || c == '_')
                })
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            Some(RawDevice {
                serial,
                state,
                props,
            })
        })
        .collect()
}

/// Parses `adb shell getprop` output (`[key]: [value]` lines).
pub fn parse_getprop(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (k, v) = line.split_once("]: [")?;
            let k = k.strip_prefix('[')?;
            let v = v.strip_suffix(']')?;
            Some((k.to_string(), v.to_string()))
        })
        .collect()
}

/// `ro.build.version.oneui` is encoded as MMmmpp (e.g. 80500 → "8.5").
pub fn format_oneui(raw: &str) -> String {
    let Ok(v) = raw.trim().parse::<u32>() else {
        return String::new();
    };
    if v == 0 {
        return String::new();
    }
    let (major, minor, patch) = (v / 10000, (v / 100) % 100, v % 100);
    if patch == 0 {
        format!("{major}.{minor}")
    } else {
        format!("{major}.{minor}.{patch}")
    }
}

pub fn props_from_getprop(map: &HashMap<String, String>) -> DeviceProps {
    let get = |k: &str| map.get(k).cloned().unwrap_or_default();
    DeviceProps {
        model: get("ro.product.model"),
        manufacturer: get("ro.product.manufacturer"),
        android: get("ro.build.version.release"),
        sdk: get("ro.build.version.sdk"),
        oneui: format_oneui(&get("ro.build.version.oneui")),
    }
}

pub fn device_info(raw: &RawDevice, props: Option<&DeviceProps>) -> DeviceInfo {
    let p = props.cloned().unwrap_or_default();
    DeviceInfo {
        serial: raw.serial.clone(),
        state: raw.state.clone(),
        model: if p.model.is_empty() {
            raw.props
                .get("model")
                .cloned()
                .unwrap_or_default()
                .replace('_', " ")
        } else {
            p.model
        },
        manufacturer: p.manufacturer,
        android: p.android,
        sdk: p.sdk,
        oneui: p.oneui,
        connection: connection_of(&raw.serial),
    }
}

/// Encodes an adb smart-socket request: 4 hex digits of length + payload.
pub fn encode_request(req: &str) -> Vec<u8> {
    let mut v = format!("{:04x}", req.len()).into_bytes();
    v.extend_from_slice(req.as_bytes());
    v
}

async fn read_status(stream: &mut TcpStream) -> Result<()> {
    let mut status = [0u8; 4];
    stream
        .read_exact(&mut status)
        .await
        .context("adb server closed the connection")?;
    match &status {
        b"OKAY" => Ok(()),
        b"FAIL" => {
            let msg = read_hex_string(stream).await.unwrap_or_default();
            bail!("adb: {msg}")
        }
        other => bail!(
            "adb: unexpected status {:?}",
            String::from_utf8_lossy(other)
        ),
    }
}

async fn read_hex_string(stream: &mut TcpStream) -> Result<String> {
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).await?;
    let len = usize::from_str_radix(std::str::from_utf8(&len)?, 16)?;
    if len > MAX_HOST_RESPONSE {
        bail!("adb response is too large: {len} bytes");
    }
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

async fn host_request(req: &str) -> Result<TcpStream> {
    let mut stream = timeout(HOST_REQUEST_TIMEOUT, TcpStream::connect(ADB_SERVER_ADDR))
        .await
        .context("timed out reaching the adb server on 127.0.0.1:5037")?
        .context("cannot reach the adb server on 127.0.0.1:5037")?;
    timeout(HOST_REQUEST_TIMEOUT, async {
        stream.write_all(&encode_request(req)).await?;
        read_status(&mut stream).await
    })
    .await
    .context("timed out waiting for the adb server")??;
    Ok(stream)
}

/// Accepts the `host:port` form used by wireless debugging without allowing
/// an address to be interpreted as an adb command-line option.
pub fn valid_tcp_endpoint(address: &str) -> bool {
    let address = address.trim();
    let Some((host, port)) = address.rsplit_once(':') else {
        return false;
    };
    let Ok(port) = port.parse::<u16>() else {
        return false;
    };
    if port == 0 || host.is_empty() {
        return false;
    }
    let bracketed = host.starts_with('[') && host.ends_with(']');
    let host = if bracketed {
        &host[1..host.len() - 1]
    } else {
        host
    };
    if host.is_empty() {
        return false;
    }
    if bracketed {
        host.bytes()
            .all(|c| c.is_ascii_hexdigit() || matches!(c, b':' | b'.' | b'%'))
    } else {
        !host.contains(':')
            && host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
    }
}

#[derive(Clone)]
pub struct Adb {
    pub path: PathBuf,
}

impl Adb {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub async fn start_server(&self) -> Result<()> {
        proc::run_ok(&self.path, ["start-server"]).await.map(|_| ())
    }

    pub async fn version(&self) -> Result<String> {
        let out = proc::run_ok(&self.path, ["version"]).await?;
        Ok(out.lines().next().unwrap_or_default().trim().to_string())
    }

    pub async fn shell(&self, serial: &str, command: &str) -> Result<String> {
        proc::run_ok(&self.path, ["-s", serial, "shell", command]).await
    }

    pub async fn getprops(&self, serial: &str) -> Result<DeviceProps> {
        let out = self.shell(serial, "getprop").await?;
        Ok(props_from_getprop(&parse_getprop(&out)))
    }

    /// `adb forward tcp:0 <remote>`: returns the port allocated by adb.
    pub async fn forward(&self, serial: &str, remote: &str) -> Result<u16> {
        let out = proc::run_ok(&self.path, ["-s", serial, "forward", "tcp:0", remote]).await?;
        out.trim()
            .parse::<u16>()
            .map_err(|_| anyhow!("unexpected `adb forward` output: {out:?}"))
    }

    pub async fn forward_remove(&self, serial: &str, port: u16) -> Result<()> {
        proc::run_ok(
            &self.path,
            ["-s", serial, "forward", "--remove", &format!("tcp:{port}")],
        )
        .await
        .map(|_| ())
    }

    pub async fn forward_present(&self, serial: &str, port: u16) -> Result<bool> {
        let out = proc::run_ok(&self.path, ["forward", "--list"]).await?;
        let local = format!("tcp:{port}");
        Ok(out.lines().any(|line| {
            let mut fields = line.split_whitespace();
            fields.next() == Some(serial) && fields.next() == Some(local.as_str())
        }))
    }

    pub async fn connect(&self, addr: &str) -> Result<String> {
        if !valid_tcp_endpoint(addr) {
            bail!("invalid wireless-debugging address; use host:port");
        }
        let out = proc::run_ok(&self.path, ["connect", addr.trim()]).await?;
        let msg = out.trim().to_string();
        let lower = msg.to_ascii_lowercase();
        if lower.contains("cannot")
            || lower.contains("failed")
            || lower.contains("unable")
            || lower.contains("error")
        {
            bail!("{msg}");
        }
        Ok(msg)
    }

    pub async fn pair(&self, addr: &str, code: &str) -> Result<String> {
        if !valid_tcp_endpoint(addr) {
            bail!("invalid wireless-debugging address; use host:port");
        }
        let code = code.trim();
        if code.len() != 6 || !code.bytes().all(|c| c.is_ascii_digit()) {
            bail!("pairing code must be exactly 6 digits");
        }
        let out = proc::run_ok(&self.path, ["pair", addr.trim(), code]).await?;
        let msg = out.trim().to_string();
        if !msg.to_ascii_lowercase().contains("successfully") {
            bail!("{msg}");
        }
        Ok(msg)
    }

    /// Size in bytes of a device file, `None` if it does not exist.
    pub async fn remote_size(&self, serial: &str, remote: &str) -> Option<u64> {
        let out = self
            .shell(serial, &format!("stat -c %s '{remote}' 2>/dev/null"))
            .await
            .ok()?;
        out.trim().parse().ok()
    }
}

/// Pushes a file with the adb sync protocol, reporting `(sent, total)`.
pub async fn push(
    serial: &str,
    local: &Path,
    remote: &str,
    progress: impl FnMut(u64, u64),
) -> Result<()> {
    timeout(PUSH_TIMEOUT, push_inner(serial, local, remote, progress))
        .await
        .context("adb push timed out")?
}

async fn push_inner(
    serial: &str,
    local: &Path,
    remote: &str,
    mut progress: impl FnMut(u64, u64),
) -> Result<()> {
    let mut file = tokio::fs::File::open(local)
        .await
        .with_context(|| format!("open {}", local.display()))?;
    let meta = file.metadata().await?;
    let total = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
        })
        .as_secs() as u32;

    let mut stream = host_request(&format!("host:transport:{serial}")).await?;
    stream.write_all(&encode_request("sync:")).await?;
    read_status(&mut stream).await?;

    {
        let mut w = BufWriter::with_capacity(4 * SYNC_DATA_MAX, &mut stream);
        let spec = format!("{remote},{}", 0o100644);
        w.write_all(b"SEND").await?;
        w.write_all(&(spec.len() as u32).to_le_bytes()).await?;
        w.write_all(spec.as_bytes()).await?;

        let mut buf = vec![0u8; SYNC_DATA_MAX];
        let mut sent = 0u64;
        let mut last_report = Instant::now();
        progress(0, total);
        loop {
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            w.write_all(b"DATA").await?;
            w.write_all(&(n as u32).to_le_bytes()).await?;
            w.write_all(&buf[..n]).await?;
            sent += n as u64;
            if last_report.elapsed() >= Duration::from_millis(100) {
                progress(sent, total);
                last_report = Instant::now();
            }
        }
        w.write_all(b"DONE").await?;
        w.write_all(&mtime.to_le_bytes()).await?;
        w.flush().await?;
    }

    let mut id = [0u8; 4];
    stream.read_exact(&mut id).await?;
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).await?;
    let len = u32::from_le_bytes(len) as usize;
    match &id {
        b"OKAY" => {}
        b"FAIL" => {
            let mut msg = vec![0u8; len.min(64 * 1024)];
            stream.read_exact(&mut msg).await?;
            bail!("push failed: {}", String::from_utf8_lossy(&msg));
        }
        other => bail!(
            "push: unexpected sync reply {:?}",
            String::from_utf8_lossy(other)
        ),
    }
    let _ = stream.write_all(b"QUIT\0\0\0\0").await;
    progress(total, total);
    Ok(())
}

/// Subscribes to `host:track-devices-l`. `on_list` receives the full device
/// list on every change. Returns when the connection drops.
pub async fn track_devices(mut on_list: impl FnMut(Vec<RawDevice>)) -> Result<()> {
    let mut stream = host_request("host:track-devices-l").await?;
    loop {
        let payload = read_hex_string(&mut stream).await?;
        on_list(parse_devices_l(&payload));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_track_devices_payload() {
        let payload =
            "R5GL34MTPAX            device product:SCG37 model:SCG37 device:m3q transport_id:1\n\
                       192.168.1.20:5555      offline transport_id:3\n\
                       emulator-5554          unauthorized transport_id:2\n";
        let list = parse_devices_l(payload);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].serial, "R5GL34MTPAX");
        assert_eq!(list[0].state, "device");
        assert_eq!(
            list[0].props.get("model").map(String::as_str),
            Some("SCG37")
        );
        assert_eq!(
            list[0].props.get("transport_id").map(String::as_str),
            Some("1")
        );
        assert_eq!(list[1].serial, "192.168.1.20:5555");
        assert_eq!(list[1].state, "offline");
        assert_eq!(list[2].state, "unauthorized");
    }

    #[test]
    fn parse_empty_and_header_lines() {
        assert!(parse_devices_l("").is_empty());
        assert!(parse_devices_l("List of devices attached\n\n").is_empty());
    }

    #[test]
    fn parse_no_permissions() {
        let list = parse_devices_l("0123456789ABCDEF       no permissions (missing udev rules?); see [http://developer.android.com/tools/device.html] usb:1-1 transport_id:4\n");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, "no permissions");
        assert_eq!(
            list[0].props.get("transport_id").map(String::as_str),
            Some("4")
        );
    }

    #[test]
    fn connection_types() {
        assert_eq!(connection_of("R5GL34MTPAX"), Connection::Usb);
        assert_eq!(connection_of("192.168.1.20:5555"), Connection::Wifi);
        assert_eq!(connection_of("[fe80::1]:37000"), Connection::Wifi);
        assert_eq!(
            connection_of("adb-R5GL34MTPAX-abc._adb-tls-connect._tcp"),
            Connection::Wifi
        );
        assert_eq!(connection_of("emulator-5554"), Connection::Usb);
    }

    #[test]
    fn getprop_and_oneui() {
        let out = "[ro.product.model]: [SCG37]\r\n[ro.build.version.release]: [16]\n[ro.build.version.sdk]: [36]\n[ro.build.version.oneui]: [80500]\n[ro.product.manufacturer]: [samsung]\n[weird line\n";
        let props = props_from_getprop(&parse_getprop(out));
        assert_eq!(props.model, "SCG37");
        assert_eq!(props.android, "16");
        assert_eq!(props.sdk, "36");
        assert_eq!(props.oneui, "8.5");
        assert_eq!(props.manufacturer, "samsung");
        assert_eq!(format_oneui("70001"), "7.0.1");
        assert_eq!(format_oneui(""), "");
    }

    #[test]
    fn request_encoding() {
        assert_eq!(
            encode_request("host:track-devices-l"),
            b"0014host:track-devices-l".to_vec()
        );
    }

    #[test]
    fn validates_wireless_debugging_addresses_and_pairing_inputs() {
        assert!(valid_tcp_endpoint("192.168.1.20:5555"));
        assert!(valid_tcp_endpoint("[fe80::1]:37000"));
        assert!(valid_tcp_endpoint("device.local:1"));
        for address in [
            "",
            "192.168.1.20",
            "192.168.1.20:0",
            "192.168.1.20:65536",
            "-Ltcp:1:tcp:2",
            "[fe80::1]",
            "host:5555 extra",
            "host:bad",
        ] {
            assert!(!valid_tcp_endpoint(address), "{address}");
        }
    }
}
