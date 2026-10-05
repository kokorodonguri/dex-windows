//! Drag & drop file transfer: dropped paths are queued and pushed one by one
//! to the device (default /sdcard/Download/), then announced to the media
//! scanner with SCAN_FILE so they show up in Gallery / My Files.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::adb;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum TransferEvent {
    Queued {
        id: u64,
        name: String,
        total: u64,
    },
    Progress {
        id: u64,
        name: String,
        sent: u64,
        total: u64,
    },
    Done {
        id: u64,
        name: String,
        remote: String,
    },
    Error {
        id: u64,
        name: String,
        error: String,
    },
}

struct Job {
    id: u64,
    session_id: u64,
    serial: String,
    local: PathBuf,
    remote: String,
    name: String,
}

pub struct FileTransfer {
    tx: mpsc::UnboundedSender<Job>,
}

/// Expands dropped paths (directories recursively) into (local, relative remote path) pairs.
pub fn expand_paths(paths: &[PathBuf]) -> Vec<(PathBuf, String)> {
    fn walk(
        dir: &Path,
        prefix: &str,
        out: &mut Vec<(PathBuf, String)>,
        visited: &mut HashSet<PathBuf>,
    ) {
        // Dropping a directory containing a junction/symlink can otherwise
        // recurse forever when it points back to an ancestor.
        let Ok(canonical) = std::fs::canonicalize(dir) else {
            return;
        };
        if !visited.insert(canonical) {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            let rel = format!("{prefix}/{name}");
            if path.is_dir() {
                walk(&path, &rel, out, visited);
            } else if path.is_file() {
                out.push((path, rel));
            }
        }
    }

    let mut out = Vec::new();
    let mut visited = HashSet::new();
    for p in paths {
        let Some(name) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if p.is_dir() {
            walk(p, &name, &mut out, &mut visited);
        } else if p.is_file() {
            out.push((p.clone(), name));
        }
    }
    out
}

/// Joins the transfer directory and a relative path, rejecting characters
/// that are invalid in Android file names.
pub fn remote_path(dir: &str, rel: &str) -> String {
    let dir = if dir.ends_with('/') {
        dir.to_string()
    } else {
        format!("{dir}/")
    };
    let clean: String = rel
        .chars()
        .map(|c| {
            if matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    format!("{dir}{}", clean.trim_start_matches('/'))
}

/// `name.ext` → `name (2).ext`; the first candidate (`n == 1`) is unchanged.
fn numbered(path: &str, n: u32) -> String {
    if n == 1 {
        return path.to_string();
    }
    let name_start = path.rfind('/').map_or(0, |i| i + 1);
    match path[name_start..].rfind('.') {
        Some(dot) if dot > 0 => {
            let split = name_start + dot;
            format!("{} ({n}){}", &path[..split], &path[split..])
        }
        _ => format!("{path} ({n})"),
    }
}

/// Pairs each dropped file with its device path. Names that only differ in
/// characters replaced by [`remote_path`] (`a?.txt` / `a_.txt`) or that come
/// from different folders must not overwrite each other, so later ones get a
/// ` (2)` suffix; the same local file listed twice is pushed once.
fn plan_remote_paths(files: &[(PathBuf, String)], dir: &str) -> Vec<(PathBuf, String, String)> {
    let mut seen_local = HashSet::new();
    let mut taken = HashSet::new();
    let mut plan = Vec::with_capacity(files.len());
    for (local, rel) in files {
        if !seen_local.insert(local.clone()) {
            continue;
        }
        let base = remote_path(dir, rel);
        let mut n = 1;
        let remote = loop {
            let candidate = numbered(&base, n);
            if !taken.contains(&candidate) {
                break candidate;
            }
            n += 1;
        };
        taken.insert(remote.clone());
        plan.push((local.clone(), rel.clone(), remote));
    }
    plan
}

/// SCAN_FILE carries at most this many bytes of path; a longer one would be
/// truncated into a different (non-existent) path.
fn can_scan(remote: &str) -> bool {
    remote.len() <= crate::control::SCAN_FILE_PATH_MAX_LENGTH
}

impl FileTransfer {
    pub fn start(app: AppHandle) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
        tauri::async_runtime::spawn(async move {
            while let Some(job) = rx.recv().await {
                let total = std::fs::metadata(&job.local).map(|m| m.len()).unwrap_or(0);
                let app2 = app.clone();
                let (id, name) = (job.id, job.name.clone());
                let state = app.state::<crate::AppState>();
                if !state.session_matches(job.session_id, &job.serial).await {
                    let _ = app.emit(
                        "transfer",
                        TransferEvent::Error {
                            id: job.id,
                            name: job.name,
                            error: "セッションが終了しました".into(),
                        },
                    );
                    continue;
                }
                let result = adb::push(&job.serial, &job.local, &job.remote, move |sent, total| {
                    let _ = app2.emit(
                        "transfer",
                        TransferEvent::Progress {
                            id,
                            name: name.clone(),
                            sent,
                            total,
                        },
                    );
                })
                .await;
                match result {
                    Ok(()) => {
                        log::info!(
                            "pushed {} ({total} bytes) → {}",
                            job.local.display(),
                            job.remote
                        );
                        if !can_scan(&job.remote) {
                            log::warn!(
                                "{} is too long to announce to the media scanner",
                                job.remote
                            );
                            let _ = app.emit(
                                "transfer",
                                TransferEvent::Done {
                                    id: job.id,
                                    name: job.name,
                                    remote: job.remote,
                                },
                            );
                            continue;
                        }
                        match state
                            .send_transfer_scan(job.session_id, &job.serial, &job.remote)
                            .await
                        {
                            Ok(()) => {
                                let _ = app.emit(
                                    "transfer",
                                    TransferEvent::Done {
                                        id: job.id,
                                        name: job.name,
                                        remote: job.remote,
                                    },
                                );
                            }
                            Err(e) => {
                                let _ = app.emit(
                                    "transfer",
                                    TransferEvent::Error {
                                        id: job.id,
                                        name: job.name,
                                        error: format!(
                                            "メディアスキャンを開始できませんでした: {e}"
                                        ),
                                    },
                                );
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("push {} failed: {e:#}", job.local.display());
                        let _ = app.emit(
                            "transfer",
                            TransferEvent::Error {
                                id: job.id,
                                name: job.name,
                                error: format!("{e:#}"),
                            },
                        );
                    }
                }
            }
        });
        Self { tx }
    }

    pub fn enqueue(
        &self,
        app: &AppHandle,
        session_id: u64,
        serial: &str,
        paths: &[PathBuf],
        dir: &str,
    ) -> usize {
        let plan = plan_remote_paths(&expand_paths(paths), dir);
        for (local, rel, remote) in &plan {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let name = rel.clone();
            let total = std::fs::metadata(local).map(|m| m.len()).unwrap_or(0);
            let _ = app.emit(
                "transfer",
                TransferEvent::Queued {
                    id,
                    name: name.clone(),
                    total,
                },
            );
            let _ = self.tx.send(Job {
                id,
                session_id,
                serial: serial.to_string(),
                local: local.clone(),
                remote: remote.clone(),
                name,
            });
        }
        plan.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths() {
        assert_eq!(
            remote_path("/sdcard/Download/", "a.txt"),
            "/sdcard/Download/a.txt"
        );
        assert_eq!(
            remote_path("/sdcard/Download", "dir/b c.png"),
            "/sdcard/Download/dir/b c.png"
        );
        assert_eq!(
            remote_path("/sdcard/Download/", "x?.txt"),
            "/sdcard/Download/x_.txt"
        );
    }

    #[test]
    fn colliding_remote_names_are_kept_apart_and_repeats_are_dropped() {
        let files = vec![
            (PathBuf::from("C:/a/x?.txt"), "x?.txt".to_string()),
            (PathBuf::from("C:/b/x_.txt"), "x_.txt".to_string()),
            (PathBuf::from("C:/c/x*.txt"), "x*.txt".to_string()),
            (PathBuf::from("C:/a/x?.txt"), "x?.txt".to_string()), // same file dropped twice
            (PathBuf::from("C:/a/README"), "README".to_string()),
            (PathBuf::from("C:/b/README"), "README".to_string()),
            (PathBuf::from("C:/a/dir.d/f"), "dir.d/f".to_string()),
            (PathBuf::from("C:/b/dir.d/f"), "dir.d/f".to_string()),
        ];
        let plan = plan_remote_paths(&files, "/sdcard/Download/");
        let remotes: Vec<&str> = plan.iter().map(|(_, _, r)| r.as_str()).collect();
        assert_eq!(
            remotes,
            vec![
                "/sdcard/Download/x_.txt",
                "/sdcard/Download/x_ (2).txt",
                "/sdcard/Download/x_ (3).txt",
                "/sdcard/Download/README",
                "/sdcard/Download/README (2)",
                "/sdcard/Download/dir.d/f",
                "/sdcard/Download/dir.d/f (2)",
            ]
        );
        assert!(plan_remote_paths(&[], "/sdcard/Download/").is_empty());
    }

    #[test]
    fn only_short_paths_can_be_announced_to_the_media_scanner() {
        assert!(can_scan("/sdcard/Download/a.txt"));
        let limit = crate::control::SCAN_FILE_PATH_MAX_LENGTH;
        assert!(can_scan(&format!("/{}", "a".repeat(limit - 1))));
        assert!(!can_scan(&format!("/{}", "a".repeat(limit))));
        // The limit is in bytes, not characters.
        assert!(!can_scan(&format!("/{}", "あ".repeat(limit / 3 + 1))));
    }

    #[test]
    fn expand_directory() {
        let base = std::env::temp_dir().join(format!("dex-ft-test-{}", std::process::id()));
        let sub = base.join("folder").join("inner");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(base.join("folder").join("a.txt"), b"a").unwrap();
        std::fs::write(sub.join("b.txt"), b"b").unwrap();
        std::fs::write(base.join("c.txt"), b"c").unwrap();

        let files = expand_paths(&[
            base.join("folder"),
            base.join("c.txt"),
            base.join("missing"),
        ]);
        let rels: Vec<&str> = files.iter().map(|(_, r)| r.as_str()).collect();
        assert_eq!(rels, vec!["folder/a.txt", "folder/inner/b.txt", "c.txt"]);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
