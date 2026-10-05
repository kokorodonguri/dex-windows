//! scrcpy control-message encoding (the Rust half).
//!
//! The frontend encodes input messages (INJECT_KEYCODE, INJECT_TEXT,
//! INJECT_TOUCH_EVENT, INJECT_SCROLL_EVENT, BACK_OR_SCREEN_ON) itself and sends
//! them over the WebSocket, so they stay ordered with each other; Rust only
//! validates them. Everything else is encoded here, so the two sides never
//! produce the same message type.

pub const TYPE_INJECT_KEYCODE: u8 = 0;
pub const TYPE_INJECT_TEXT: u8 = 1;
pub const TYPE_INJECT_TOUCH_EVENT: u8 = 2;
pub const TYPE_INJECT_SCROLL_EVENT: u8 = 3;
pub const TYPE_BACK_OR_SCREEN_ON: u8 = 4;
pub const TYPE_SET_CLIPBOARD: u8 = 9;
pub const TYPE_SET_DISPLAY_POWER: u8 = 10;
pub const TYPE_RESET_VIDEO: u8 = 17;
pub const TYPE_RESIZE_DISPLAY: u8 = 21;
pub const TYPE_SCAN_FILE: u8 = 22;

const CONTROL_MSG_MAX_SIZE: usize = 1 << 18;
pub const INJECT_TEXT_MAX_LENGTH: usize = 300;
pub const CLIPBOARD_TEXT_MAX_LENGTH: usize = CONTROL_MSG_MAX_SIZE - 14;
pub const SCAN_FILE_PATH_MAX_LENGTH: usize = 256;

/// Device → client message types.
pub const DEVICE_MSG_TYPE_CLIPBOARD: u8 = 0;
pub const DEVICE_MSG_TYPE_ACK_CLIPBOARD: u8 = 1;
pub const DEVICE_MSG_TYPE_UHID_OUTPUT: u8 = 2;

/// Returns the largest prefix length of `s` that is <= `max_len` bytes and
/// ends on a UTF-8 character boundary (like `sc_str_utf8_truncation_index`).
fn utf8_truncation_index(s: &str, max_len: usize) -> usize {
    if s.len() <= max_len {
        return s.len();
    }
    let mut i = max_len;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn put_string(buf: &mut Vec<u8>, s: &str, max_len: usize) {
    let len = utf8_truncation_index(s, max_len);
    buf.extend_from_slice(&(len as u32).to_be_bytes());
    buf.extend_from_slice(&s.as_bytes()[..len]);
}

pub fn set_clipboard(sequence: u64, text: &str, paste: bool) -> Vec<u8> {
    let mut buf = Vec::with_capacity(14 + text.len().min(CLIPBOARD_TEXT_MAX_LENGTH));
    buf.push(TYPE_SET_CLIPBOARD);
    buf.extend_from_slice(&sequence.to_be_bytes());
    buf.push(paste as u8);
    put_string(&mut buf, text, CLIPBOARD_TEXT_MAX_LENGTH);
    buf
}

/// With `new_display`, the server applies this to the phone's physical screen:
/// off = screen dark but the device stays awake, so DeX keeps rendering.
pub fn set_display_power(on: bool) -> Vec<u8> {
    vec![TYPE_SET_DISPLAY_POWER, on as u8]
}

pub fn reset_video() -> Vec<u8> {
    vec![TYPE_RESET_VIDEO]
}

pub fn resize_display(width: u16, height: u16) -> Vec<u8> {
    let mut buf = Vec::with_capacity(5);
    buf.push(TYPE_RESIZE_DISPLAY);
    buf.extend_from_slice(&width.to_be_bytes());
    buf.extend_from_slice(&height.to_be_bytes());
    buf
}

pub fn scan_file(path: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(5 + path.len().min(SCAN_FILE_PATH_MAX_LENGTH));
    buf.push(TYPE_SCAN_FILE);
    put_string(&mut buf, path, SCAN_FILE_PATH_MAX_LENGTH);
    buf
}

/// Validates a message produced by the frontend: only the input types are
/// accepted, each with its exact size.
pub fn validate_frontend_message(msg: &[u8]) -> Result<(), String> {
    let Some(&ty) = msg.first() else {
        return Err("empty control message".into());
    };
    let expected = match ty {
        TYPE_INJECT_TEXT => {
            if msg.len() < 5 {
                return Err("truncated INJECT_TEXT".into());
            }
            let len = u32::from_be_bytes([msg[1], msg[2], msg[3], msg[4]]) as usize;
            if len > INJECT_TEXT_MAX_LENGTH || std::str::from_utf8(&msg[5..]).is_err() {
                return Err("invalid INJECT_TEXT payload".into());
            }
            5 + len
        }
        TYPE_INJECT_KEYCODE => 14,
        TYPE_INJECT_TOUCH_EVENT => 32,
        TYPE_INJECT_SCROLL_EVENT => 21,
        TYPE_BACK_OR_SCREEN_ON => 2,
        other => {
            return Err(format!(
                "control message type {other} is not allowed from the frontend"
            ))
        }
    };
    if msg.len() != expected {
        return Err(format!(
            "control message type {ty}: expected {expected} bytes, got {}",
            msg.len()
        ));
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub enum DeviceMessage {
    Clipboard(String),
    AckClipboard(u64),
    UhidOutput { id: u16, data: Vec<u8> },
}

/// Incremental parser for the device-message stream. Returns the parsed
/// message and the number of consumed bytes, `Ok(None)` if more data is
/// needed.
pub fn parse_device_message(buf: &[u8]) -> Result<Option<(DeviceMessage, usize)>, String> {
    let Some(&ty) = buf.first() else {
        return Ok(None);
    };
    match ty {
        DEVICE_MSG_TYPE_CLIPBOARD => {
            if buf.len() < 5 {
                return Ok(None);
            }
            let len = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;
            if len > CONTROL_MSG_MAX_SIZE {
                return Err(format!("clipboard message too large: {len}"));
            }
            if buf.len() < 5 + len {
                return Ok(None);
            }
            let text = String::from_utf8_lossy(&buf[5..5 + len]).into_owned();
            Ok(Some((DeviceMessage::Clipboard(text), 5 + len)))
        }
        DEVICE_MSG_TYPE_ACK_CLIPBOARD => {
            if buf.len() < 9 {
                return Ok(None);
            }
            let mut seq = [0u8; 8];
            seq.copy_from_slice(&buf[1..9]);
            Ok(Some((
                DeviceMessage::AckClipboard(u64::from_be_bytes(seq)),
                9,
            )))
        }
        DEVICE_MSG_TYPE_UHID_OUTPUT => {
            if buf.len() < 5 {
                return Ok(None);
            }
            let id = u16::from_be_bytes([buf[1], buf[2]]);
            let size = u16::from_be_bytes([buf[3], buf[4]]) as usize;
            if buf.len() < 5 + size {
                return Ok(None);
            }
            Ok(Some((
                DeviceMessage::UhidOutput {
                    id,
                    data: buf[5..5 + size].to_vec(),
                },
                5 + size,
            )))
        }
        other => Err(format!("unknown device message type {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vectors ported from scrcpy app/tests/test_control_msg_serialize.c (v4.1)

    #[test]
    fn serialize_set_clipboard() {
        let buf = set_clipboard(0x0102030405060708, "hello, world!", true);
        assert_eq!(buf.len(), 27);
        let mut expected = vec![
            TYPE_SET_CLIPBOARD,
            0x01,
            0x02,
            0x03,
            0x04,
            0x05,
            0x06,
            0x07,
            0x08, // sequence
            1,    // paste
            0x00,
            0x00,
            0x00,
            0x0d, // text length
        ];
        expected.extend_from_slice(b"hello, world!");
        assert_eq!(buf, expected);
    }

    #[test]
    fn serialize_set_clipboard_long() {
        let text = "a".repeat(CLIPBOARD_TEXT_MAX_LENGTH + 1);
        let buf = set_clipboard(0x0102030405060708, &text, true);
        assert_eq!(buf.len(), CONTROL_MSG_MAX_SIZE);
        let len = CLIPBOARD_TEXT_MAX_LENGTH as u32;
        assert_eq!(&buf[10..14], &len.to_be_bytes());
        assert!(buf[14..].iter().all(|&b| b == b'a'));
    }

    #[test]
    fn serialize_set_clipboard_truncates_on_char_boundary() {
        // 3-byte characters: the truncation must not split one
        let text = "あ".repeat(CLIPBOARD_TEXT_MAX_LENGTH / 3 + 1);
        let buf = set_clipboard(1, &text, false);
        let len = u32::from_be_bytes([buf[10], buf[11], buf[12], buf[13]]) as usize;
        assert!(len <= CLIPBOARD_TEXT_MAX_LENGTH);
        assert_eq!(len % 3, 0);
        assert!(std::str::from_utf8(&buf[14..]).is_ok());
    }

    #[test]
    fn serialize_resize_display() {
        let buf = resize_display(1920, 1080);
        assert_eq!(
            buf,
            vec![
                TYPE_RESIZE_DISPLAY,
                (1920 >> 8) as u8,
                (1920 & 0xff) as u8,
                (1080 >> 8) as u8,
                (1080 & 0xff) as u8
            ]
        );
    }

    #[test]
    fn serialize_scan_file() {
        let buf = scan_file("/sdcard/Download");
        assert_eq!(buf.len(), 21);
        let mut expected = vec![TYPE_SCAN_FILE, 0x00, 0x00, 0x00, 0x10];
        expected.extend_from_slice(b"/sdcard/Download");
        assert_eq!(buf, expected);
    }

    #[test]
    fn serialize_set_display_power() {
        assert_eq!(set_display_power(true), vec![TYPE_SET_DISPLAY_POWER, 0x01]);
        assert_eq!(set_display_power(false), vec![TYPE_SET_DISPLAY_POWER, 0x00]);
    }

    #[test]
    fn serialize_reset_video() {
        assert_eq!(reset_video(), vec![17]);
    }

    #[test]
    fn validate_frontend_messages() {
        assert!(validate_frontend_message(&[0; 14]).is_ok());
        let mut touch = [0u8; 32];
        touch[0] = TYPE_INJECT_TOUCH_EVENT;
        assert!(validate_frontend_message(&touch).is_ok());
        let mut scroll = [0u8; 21];
        scroll[0] = TYPE_INJECT_SCROLL_EVENT;
        assert!(validate_frontend_message(&scroll).is_ok());
        assert!(validate_frontend_message(&[TYPE_BACK_OR_SCREEN_ON, 1]).is_ok());
        let mut text = vec![TYPE_INJECT_TEXT, 0x00, 0x00, 0x00, 0x0d];
        text.extend_from_slice(b"hello, world!");
        assert!(validate_frontend_message(&text).is_ok());
        text.push(b'!'); // length mismatch
        assert!(validate_frontend_message(&text).is_err());
        let mut long = vec![TYPE_INJECT_TEXT, 0x00, 0x00, 0x01, 0x2d];
        long.extend(std::iter::repeat_n(b'a', 301));
        assert!(validate_frontend_message(&long).is_err());

        assert!(validate_frontend_message(&[]).is_err());
        assert!(validate_frontend_message(&[0; 13]).is_err()); // wrong size
        assert!(validate_frontend_message(&set_clipboard(1, "x", true)).is_err()); // Rust-only type
        assert!(validate_frontend_message(&[TYPE_RESIZE_DISPLAY, 0, 0, 0, 0]).is_err());
    }

    // Vectors ported from scrcpy app/tests/test_device_msg_deserialize.c

    #[test]
    fn deserialize_clipboard() {
        let input = [
            DEVICE_MSG_TYPE_CLIPBOARD,
            0x00,
            0x00,
            0x00,
            0x03,
            b'A',
            b'B',
            b'C',
        ];
        let (msg, n) = parse_device_message(&input).unwrap().unwrap();
        assert_eq!(n, 8);
        assert_eq!(msg, DeviceMessage::Clipboard("ABC".into()));
    }

    #[test]
    fn deserialize_clipboard_partial() {
        let input = [
            DEVICE_MSG_TYPE_CLIPBOARD,
            0x00,
            0x00,
            0x00,
            0x03,
            b'A',
            b'B',
        ];
        assert_eq!(parse_device_message(&input).unwrap(), None);
        assert_eq!(parse_device_message(&input[..3]).unwrap(), None);
    }

    #[test]
    fn deserialize_ack_clipboard() {
        let input = [
            DEVICE_MSG_TYPE_ACK_CLIPBOARD,
            0x01,
            0x02,
            0x03,
            0x04,
            0x05,
            0x06,
            0x07,
            0x08,
        ];
        let (msg, n) = parse_device_message(&input).unwrap().unwrap();
        assert_eq!(n, 9);
        assert_eq!(msg, DeviceMessage::AckClipboard(0x0102030405060708));
    }

    #[test]
    fn deserialize_uhid_output() {
        let input = [DEVICE_MSG_TYPE_UHID_OUTPUT, 0, 42, 0, 5, 1, 2, 3, 4, 5];
        let (msg, n) = parse_device_message(&input).unwrap().unwrap();
        assert_eq!(n, 10);
        assert_eq!(
            msg,
            DeviceMessage::UhidOutput {
                id: 42,
                data: vec![1, 2, 3, 4, 5]
            }
        );
    }

    #[test]
    fn deserialize_unknown_type() {
        assert!(parse_device_message(&[42, 0, 0]).is_err());
    }
}
