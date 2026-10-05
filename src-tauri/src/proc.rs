//! Child-process helpers. Every external process (mostly adb.exe) is spawned
//! with CREATE_NO_WINDOW so no console window flashes on screen.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::process::Command;
use tokio::time::timeout;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PROCESS_TIMEOUT: Duration = Duration::from_secs(30);

pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null());
    cmd.kill_on_drop(true);
    cmd
}

pub struct Output {
    pub status_ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a program to completion and captures its (lossy UTF-8) output.
pub async fn run<I, S>(program: &Path, args: I) -> Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let out = timeout(
        PROCESS_TIMEOUT,
        command(program)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "{} timed out after {} seconds",
            program.display(),
            PROCESS_TIMEOUT.as_secs()
        )
    })?
    .with_context(|| format!("failed to run {}", program.display()))?;
    Ok(Output {
        status_ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Like [`run`], but fails when the process exits with a non-zero status.
pub async fn run_ok<I, S>(program: &Path, args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let out = run(program, args).await?;
    if !out.status_ok {
        let msg = if out.stderr.trim().is_empty() {
            out.stdout.trim()
        } else {
            out.stderr.trim()
        };
        bail!("{} failed: {}", program.display(), msg);
    }
    Ok(out.stdout)
}
