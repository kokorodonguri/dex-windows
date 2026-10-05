//! Locating adb.exe and the bundled scrcpy-server.

use std::path::{Path, PathBuf};

/// scrcpy-server protocol version. The server refuses to start when the
/// client passes a different version, and the v4 stream format (session
/// packets, RESIZE_DISPLAY, SCAN_FILE) is assumed throughout.
pub const SERVER_VERSION: &str = "4.1";
pub const SERVER_FILE_NAME: &str = "scrcpy-server";
pub const DEVICE_SERVER_PATH: &str = "/data/local/tmp/scrcpy-server.jar";

#[cfg(windows)]
const ADB_EXE: &str = "adb.exe";
#[cfg(not(windows))]
const ADB_EXE: &str = "adb";

fn existing(p: PathBuf) -> Option<PathBuf> {
    p.is_file().then_some(p)
}

fn bin_dirs(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(r) = resource_dir {
        dirs.push(r.join("bin"));
        dirs.push(r.join("resources").join("bin"));
    }
    // During `tauri dev` the resources may not have been copied yet
    if cfg!(debug_assertions) {
        dirs.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("bin"),
        );
    }
    dirs
}

/// ADB lookup order: settings override → resource_dir/bin →
/// %LOCALAPPDATA%\Android\Sdk\platform-tools → %ANDROID_HOME% (and
/// %ANDROID_SDK_ROOT%) → PATH.
pub fn find_adb(override_path: &str, resource_dir: Option<&Path>) -> Option<PathBuf> {
    let o = override_path.trim().trim_matches('"');
    if !o.is_empty() {
        let p = PathBuf::from(o);
        let p = if p.is_dir() { p.join(ADB_EXE) } else { p };
        if let Some(p) = existing(p) {
            return Some(p);
        }
        log::warn!("adb override {o} does not exist, falling back to the default lookup");
    }

    for dir in bin_dirs(resource_dir) {
        if let Some(p) = existing(dir.join(ADB_EXE)) {
            return Some(p);
        }
    }

    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(local)
            .join("Android")
            .join("Sdk")
            .join("platform-tools")
            .join(ADB_EXE);
        if let Some(p) = existing(p) {
            return Some(p);
        }
    }

    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(home) = std::env::var_os(var) {
            if let Some(p) = existing(PathBuf::from(home).join("platform-tools").join(ADB_EXE)) {
                return Some(p);
            }
        }
    }

    std::env::var_os("PATH")
        .and_then(|paths| std::env::split_paths(&paths).find_map(|dir| existing(dir.join(ADB_EXE))))
}

pub fn find_server(resource_dir: Option<&Path>) -> Option<PathBuf> {
    bin_dirs(resource_dir)
        .into_iter()
        .find_map(|dir| existing(dir.join(SERVER_FILE_NAME)))
}
