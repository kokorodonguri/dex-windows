//! Persistent user settings (`settings.json` in the app config directory).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DexStrategy {
    /// Rely on the SECONDARY_HOME activity being started automatically.
    Auto,
    /// Resolve the SECONDARY_HOME activity and start it with `am start --display`.
    Explicit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImePolicy {
    /// Do not pass `display_ime_policy` (system default).
    Default,
    /// Show the IME on the virtual display.
    Local,
    /// Show the IME on the phone screen.
    Fallback,
    /// Never show the on-screen IME (a hardware keyboard is used).
    Hide,
}

impl ImePolicy {
    pub fn server_value(self) -> Option<&'static str> {
        match self {
            ImePolicy::Default => None,
            ImePolicy::Local => Some("local"),
            ImePolicy::Fallback => Some("fallback"),
            ImePolicy::Hide => Some("hide"),
        }
    }
}

/// Global settings values changed by "force desktop mode", saved so they can
/// be restored on exit or after a crash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRestore {
    pub serial: String,
    /// setting name → previous value (`None` = was unset)
    pub values: BTreeMap<String, Option<String>>,
}

/// `adb forward` of the running session, persisted so a forward left behind
/// by a crash can be removed on the next launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveForward {
    pub serial: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub width: u32,
    pub height: u32,
    pub dpi: u32,
    pub bit_rate_mbps: u32,
    pub max_fps: u32,
    pub audio: bool,
    pub volume: f32,
    pub muted: bool,
    pub flex_display: bool,
    pub dex_strategy: DexStrategy,
    /// Switch the virtual display to freeform windowing (`cmd window
    /// set-display-windowing-mode`) so apps open as DeX windows.
    pub freeform_windows: bool,
    pub force_desktop_mode: bool,
    pub destroy_content: bool,
    pub ime_policy: ImePolicy,
    pub keyboard_hook: bool,
    /// Translate precision-touchpad scrolling and pinching into Android touch
    /// gestures. A discrete mouse wheel remains a mouse scroll.
    pub trackpad_gestures: bool,
    pub clipboard_sync: bool,
    pub transfer_dir: String,
    pub stats_overlay: bool,
    /// Overrides the adb.exe lookup when non-empty.
    pub adb_path: String,
    /// Legacy single-device record, migrated by `sanitized` on load.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_restore: Option<PendingRestore>,
    pub pending_restores: BTreeMap<String, BTreeMap<String, Option<String>>>,
    /// Per device, the apps that were shown on DeX and still have to be
    /// refreshed for the phone screen. Written while the session runs, so a
    /// session cut short (USB unplugged, crash) is cleaned up on reconnect.
    pub pending_app_refresh: BTreeMap<String, BTreeSet<String>>,
    pub active_forward: Option<ActiveForward>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            dpi: 240,
            bit_rate_mbps: 12,
            max_fps: 60,
            audio: true,
            volume: 1.0,
            muted: false,
            flex_display: false,
            dex_strategy: DexStrategy::Auto,
            freeform_windows: true,
            force_desktop_mode: false,
            destroy_content: false,
            // The PC keyboard (and PC IME) is the input device: Android's
            // on-screen keyboard would only cover the DeX screen.
            ime_policy: ImePolicy::Hide,
            keyboard_hook: true,
            trackpad_gestures: true,
            clipboard_sync: true,
            transfer_dir: "/sdcard/Download/".into(),
            stats_overlay: false,
            adb_path: String::new(),
            pending_restore: None,
            pending_restores: BTreeMap::new(),
            pending_app_refresh: BTreeMap::new(),
            active_forward: None,
        }
    }
}

/// Device directory for dropped files: an absolute Android path with a
/// trailing slash. `None` for anything else (relative paths would land in
/// adbd's working directory, `..` could leave the intended folder).
fn normalize_transfer_dir(raw: &str) -> Option<String> {
    let dir = raw.trim();
    let valid = dir.starts_with('/')
        && !dir
            .chars()
            .any(|c| c.is_control() || c == '\'' || c == '\\')
        && !dir.split('/').any(|segment| segment == "..");
    if !valid {
        return None;
    }
    Some(if dir.ends_with('/') {
        dir.to_string()
    } else {
        format!("{dir}/")
    })
}

impl Settings {
    pub fn remember_restore(&mut self, serial: String, values: BTreeMap<String, Option<String>>) {
        self.pending_restores.entry(serial).or_insert(values);
    }

    /// True when `packages` adds anything to the device's refresh journal.
    pub fn needs_app_refresh_entry(&self, serial: &str, packages: &[String]) -> bool {
        let known = self.pending_app_refresh.get(serial);
        packages
            .iter()
            .any(|p| known.is_none_or(|known| !known.contains(p)))
    }

    /// Clamps values into the ranges supported by the UI and the server.
    pub fn sanitized(mut self) -> Self {
        if let Some(p) = self.pending_restore.take() {
            self.pending_restores.entry(p.serial).or_insert(p.values);
        }
        self.width = self.width.clamp(320, 7680) & !1;
        self.height = self.height.clamp(240, 4320) & !1;
        self.dpi = self.dpi.clamp(80, 640);
        self.bit_rate_mbps = self.bit_rate_mbps.clamp(1, 100);
        self.max_fps = self.max_fps.clamp(1, 240);
        self.volume = if self.volume.is_finite() {
            self.volume.clamp(0.0, 1.0)
        } else {
            1.0
        };
        self.transfer_dir = normalize_transfer_dir(&self.transfer_dir)
            .unwrap_or_else(|| Settings::default().transfer_dir);
        self
    }
}

pub struct SettingsStore {
    path: PathBuf,
}

#[cfg(windows)]
fn replace_file(temp: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING};

    let temp: Vec<u16> = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let target: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(temp.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING,
        )
    }
    .map_err(|e| anyhow::anyhow!("replace settings file: {e}"))?;
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, target: &Path) -> Result<()> {
    std::fs::rename(temp, target).with_context(|| format!("rename to {}", target.display()))?;
    Ok(())
}

impl SettingsStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join("settings.json"),
        }
    }

    fn backup_path(&self) -> PathBuf {
        self.path.with_extension("json.bak")
    }

    pub fn load(&self) -> Settings {
        let parse = |path: &Path| {
            std::fs::read_to_string(path)
                .ok()
                .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        };
        if let Some(settings) = parse(&self.path) {
            return settings.sanitized();
        }
        let backup = self.backup_path();
        if let Some(settings) = parse(&backup) {
            log::warn!(
                "could not load settings {}; restored the previous valid copy from {}",
                self.path.display(),
                backup.display()
            );
            return settings.sanitized();
        }
        if self.path.exists() {
            log::warn!(
                "invalid settings file {}; using defaults",
                self.path.display()
            );
        }
        Settings::default()
    }

    pub fn save(&self, settings: &Settings) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(settings)?)
            .with_context(|| format!("write {}", tmp.display()))?;
        replace_file(&tmp, &self.path)?;
        if let Err(e) = std::fs::copy(&self.path, self.backup_path()) {
            // The primary file is already durable; a missing backup only
            // reduces recovery options for a future corruption.
            log::warn!("could not update settings backup: {e}");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_roundtrip_and_partial_json() {
        let s: Settings = serde_json::from_str(r#"{"width":1600,"height":900}"#).unwrap();
        assert_eq!(s.width, 1600);
        assert_eq!(s.dpi, 240);
        assert_eq!(s.transfer_dir, "/sdcard/Download/");
        assert!(s.trackpad_gestures);
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"bitRateMbps\":12"));
        assert!(json.contains("\"dexStrategy\":\"auto\""));
    }

    #[test]
    fn sanitize() {
        let s = Settings {
            width: 1921,
            dpi: 10,
            transfer_dir: "/sdcard/Movies".into(),
            volume: f32::NAN,
            ..Default::default()
        }
        .sanitized();
        assert_eq!(s.width, 1920);
        assert_eq!(s.dpi, 80);
        assert_eq!(s.transfer_dir, "/sdcard/Movies/");
        assert_eq!(s.volume, 1.0);
    }

    #[test]
    fn transfer_dir_must_be_an_absolute_device_path_without_traversal() {
        let dir = |value: &str| {
            Settings {
                transfer_dir: value.into(),
                ..Default::default()
            }
            .sanitized()
            .transfer_dir
        };
        let default = Settings::default().transfer_dir;
        assert_eq!(dir("/sdcard/Movies"), "/sdcard/Movies/");
        assert_eq!(dir("  /sdcard/Movies/  "), "/sdcard/Movies/");
        assert_eq!(dir("/sdcard/My Files/"), "/sdcard/My Files/");
        for invalid in [
            "",
            "   ",
            "Download",
            "Download/",
            "sdcard/Download",
            "\\sdcard\\Download",
            "/sdcard/../data/local/tmp",
            "/sdcard/Download/..",
            "/sdcard/a\nb",
            "/sdcard/it's",
        ] {
            assert_eq!(dir(invalid), default, "{invalid:?}");
        }
        assert_eq!(dir("/"), "/");
    }

    #[test]
    fn migrate_legacy_restore_and_preserve_original_per_device() {
        let json = r#"{"pendingRestore":{"serial":"A","values":{"enable_freeform_support":"0"}}}"#;
        let mut s = serde_json::from_str::<Settings>(json).unwrap().sanitized();
        let original = s.pending_restores["A"].clone();
        assert!(s.pending_restore.is_none());
        let changed = BTreeMap::from([("enable_freeform_support".into(), Some("1".into()))]);
        s.remember_restore("A".into(), changed.clone());
        s.remember_restore("B".into(), changed.clone());
        let mut loaded = serde_json::from_str::<Settings>(&serde_json::to_string(&s).unwrap())
            .unwrap()
            .sanitized();
        assert_eq!(loaded.pending_restores["A"], original);
        assert_eq!(loaded.pending_restores["B"], changed);
        loaded.pending_restores.remove("B");
        assert_eq!(loaded.pending_restores["A"], original);
    }

    #[test]
    fn saves_over_an_existing_settings_file() {
        let dir = std::env::temp_dir().join(format!("dex-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = SettingsStore::new(&dir);
        let first = Settings::default();
        store.save(&first).unwrap();
        let second = Settings {
            width: 1600,
            ..first
        };
        store.save(&second).unwrap();
        assert_eq!(store.load().width, 1600);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn recovers_settings_and_cleanup_state_from_a_valid_backup() {
        let dir =
            std::env::temp_dir().join(format!("dex-settings-backup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = SettingsStore::new(&dir);
        let settings = Settings {
            width: 1600,
            active_forward: Some(ActiveForward {
                serial: "device".into(),
                port: 37000,
            }),
            ..Default::default()
        };
        store.save(&settings).unwrap();
        std::fs::write(&store.path, b"{not valid json").unwrap();
        let loaded = store.load();
        assert_eq!(loaded.width, 1600);
        assert_eq!(loaded.active_forward, settings.active_forward);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
