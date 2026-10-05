//! DeX-specific device tweaks: starting the DeX launcher on the virtual
//! display, freeform windowing, and the optional "force desktop mode"
//! global settings (saved so they can be restored).

use std::collections::BTreeMap;

use anyhow::{bail, Result};

use crate::adb::Adb;
use crate::layout::{Fit, Rect};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DisplaySize {
    pub width: u32,
    pub height: u32,
}

/// Global settings changed by "force desktop mode" and their forced values.
pub const DESKTOP_MODE_SETTINGS: [(&str, &str); 2] = [
    ("force_desktop_mode_on_external_displays", "1"),
    ("enable_freeform_support", "1"),
];

const WINDOWING_MODE_UNDEFINED: u32 = 0;
const WINDOWING_MODE_FREEFORM: u32 = 5;

/// Picks the DeX launcher among the SECONDARY_HOME candidates: the legacy
/// standalone DeX launcher (One UI ≤ 6) first, then the DeX service built into
/// One UI Home (One UI 7+), never the cover-screen SubHomeActivity.
pub fn pick_dex_launcher(components: &str) -> Option<String> {
    let list: Vec<&str> = components
        .lines()
        .map(str::trim)
        .filter(|l| crate::apps::valid_component(l))
        .collect();
    list.iter()
        .find(|c| c.contains("desktoplauncher"))
        .or_else(|| list.iter().find(|c| c.contains("honeyspace.dexservice")))
        .or_else(|| {
            list.iter()
                .find(|c| !c.contains("subscreen") && !c.starts_with("com.android.systemui/"))
        })
        .map(|c| c.to_string())
}

pub async fn resolve_dex_launcher(adb: &Adb, serial: &str) -> Result<Option<String>> {
    let out = adb
        .shell(
            serial,
            "cmd package query-activities --components --user 0 -a android.intent.action.MAIN -c android.intent.category.SECONDARY_HOME",
        )
        .await?;
    Ok(pick_dex_launcher(&out))
}

pub async fn start_dex_launcher(adb: &Adb, serial: &str, display_id: u32) -> Result<String> {
    let Some(component) = resolve_dex_launcher(adb, serial).await? else {
        bail!("no SECONDARY_HOME (DeX) activity found");
    };
    if !crate::apps::valid_component(&component) {
        bail!("invalid SECONDARY_HOME component");
    }
    let out = adb
        .shell(
            serial,
            &format!("am start --user 0 --display {display_id} -a android.intent.action.MAIN -c android.intent.category.SECONDARY_HOME -n '{component}'"),
        )
        .await?;
    if crate::apps::shell_reported_error(&out) {
        bail!("am start failed: {}", out.trim());
    }
    Ok(component)
}

async fn set_windowing_mode(adb: &Adb, serial: &str, display_id: u32, mode: u32) -> Result<()> {
    let out = adb
        .shell(
            serial,
            &format!("cmd window set-display-windowing-mode -d {display_id} {mode}"),
        )
        .await?;
    let lower = out.to_ascii_lowercase();
    if lower.contains("error") || lower.contains("unknown") {
        bail!("set-display-windowing-mode: {}", out.trim());
    }
    Ok(())
}

/// Without this, One UI 8.5 shows the DeX taskbar on the virtual display but
/// opens every app fullscreen; freeform gives real DeX windows.
pub async fn enable_freeform(adb: &Adb, serial: &str, display_id: u32) -> Result<()> {
    set_windowing_mode(adb, serial, display_id, WINDOWING_MODE_FREEFORM).await
}

/// Clears the per-display override (display settings may be persisted by the
/// display's unique id).
pub async fn reset_windowing_mode(adb: &Adb, serial: &str, display_id: u32) -> Result<()> {
    set_windowing_mode(adb, serial, display_id, WINDOWING_MODE_UNDEFINED).await
}

/// One root task of a display, as listed by `dumpsys activity activities`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskInfo {
    pub id: u32,
    /// Package of the task's root activity, when the dump names it.
    pub package: Option<String>,
    /// `fullscreen`, `freeform`, `pinned`, …
    pub mode: String,
    /// Current bounds; `None` when this build of Android does not print them.
    pub bounds: Option<Rect>,
    /// Orientation of the top activity, e.g. `SCREEN_ORIENTATION_PORTRAIT`.
    pub orientation: Option<String>,
    /// On screen (not minimised or behind another full window).
    pub visible: bool,
}

/// Windows that must keep the layout the system gives them: the DeX taskbar
/// and launcher, system dialogs and overlays, the on-screen keyboard, and
/// picture-in-picture (which the user places by hand).
const UNMANAGED_PACKAGES: [&str; 4] = [
    "com.sec.android.app.launcher",
    "com.sec.android.app.desktoplauncher",
    "com.android.systemui",
    "com.samsung.android.app.aodservice",
];

impl TaskInfo {
    /// True for ordinary app windows, the only ones this client lays out.
    pub fn is_app_window(&self) -> bool {
        if self.mode == "pinned" {
            return false;
        }
        match self.package.as_deref() {
            Some(p) => {
                !UNMANAGED_PACKAGES.contains(&p)
                    && !p.contains("inputmethod")
                    && !p.contains("honeyboard")
            }
            None => true,
        }
    }

    /// How the window should be shaped. Android 16 ignores an app's portrait
    /// lock on large displays and stretches it across the screen, so a
    /// phone-only app (TikTok, LINE, …) has to be given a portrait window, the
    /// way real DeX opens it.
    pub fn fit(&self) -> Fit {
        match self
            .orientation
            .as_deref()
            .and_then(|o| o.strip_prefix("SCREEN_ORIENTATION_"))
        {
            Some("PORTRAIT" | "REVERSE_PORTRAIT" | "SENSOR_PORTRAIT" | "USER_PORTRAIT") => {
                Fit::Portrait
            }
            _ => Fit::Fill,
        }
    }
}

/// `[0,0][1920,1224]` (Rect::toShortString) or `Rect(0, 0 - 1920, 1224)`.
pub fn parse_rect(text: &str) -> Option<Rect> {
    let text = text.trim();
    let numbers: Vec<i32> =
        if let Some(inner) = text.strip_prefix("Rect(").and_then(|t| t.split(')').next()) {
            inner
                .replace(" - ", ",")
                .split(',')
                .map(|n| n.trim().parse().ok())
                .collect::<Option<_>>()?
        } else {
            let (first, rest) = text.strip_prefix('[')?.split_once("][")?;
            let second = rest.split(']').next()?;
            first
                .split(',')
                .chain(second.split(','))
                .map(|n| n.trim().parse().ok())
                .collect::<Option<_>>()?
        };
    let [left, top, right, bottom] = numbers[..] else {
        return None;
    };
    Some(Rect::new(left, top, right, bottom))
}

fn parse_task_header(line: &str) -> Option<TaskInfo> {
    let line = line.trim_start().strip_prefix("* Task{")?;
    if !line.contains("type=standard") {
        return None;
    }
    let field = |key: &str| {
        line.split(key)
            .nth(1)
            .and_then(|v| v.split_whitespace().next())
    };
    let id = field("#")?.trim_end_matches('}').parse().ok()?;
    // `I=com.sec.android.app.launcher/…` names the root activity. Otherwise
    // `A=10143:com.instagram.android` is only the task affinity, which is not
    // always a package (`com.android.settings.root`): the activity records
    // below the header replace it.
    let package = field("I=")
        .and_then(component_package)
        .or_else(|| field("A=").map(|a| a.split_once(':').map_or(a, |(_, p)| p).to_string()));
    Some(TaskInfo {
        id,
        package,
        mode: field("mode=").unwrap_or("undefined").to_string(),
        bounds: None,
        orientation: None,
        visible: field("visible=") == Some("true"),
    })
}

/// `com.android.settings/.Settings` → `com.android.settings`.
fn component_package(component: &str) -> Option<String> {
    let (package, _) = component.split_once('/')?;
    (!package.is_empty()).then(|| package.to_string())
}

/// Package of an `ActivityRecord{4987 u0 com.instagram.android/.Main t11773}`.
fn activity_record_package(line: &str) -> Option<String> {
    let record = line.split("ActivityRecord{").nth(1)?;
    record.split_whitespace().find_map(|word| {
        word.contains('/')
            .then(|| component_package(word))
            .flatten()
    })
}

/// One UI 8.5 prints `mBounds=Rect(0, 0 - 1920, 1224)` for a task that has
/// explicit bounds (and nothing at all for one that inherits the display);
/// other builds print `bounds=[0,0][1920,1224]`. Neighbouring lines such as
/// `mLastNonFullscreenBounds=` hold stale phone-screen values and are skipped.
fn parse_bounds_line(line: &str) -> Option<Rect> {
    let line = line.trim_start();
    let value = line
        .strip_prefix("mBounds=")
        .or_else(|| line.strip_prefix("bounds="))?;
    parse_rect(value)
}

/// Lists the root tasks of one display, top to bottom. Tasks nested inside a
/// split-screen or app-pair root are covered by their parent's bounds and are
/// left out.
pub fn parse_display_tasks(output: &str, display_id: u32) -> Vec<TaskInfo> {
    let heading = format!("Display #{display_id} ");
    let Some(section) = output
        .split(&heading)
        .nth(1)
        .and_then(|s| s.split("Display #").next())
    else {
        return Vec::new();
    };
    let lines: Vec<&str> = section.lines().collect();
    let indent = |line: &str| line.len() - line.trim_start().len();
    let starts: Vec<usize> = (0..lines.len())
        .filter(|&i| lines[i].trim_start().starts_with("* Task{"))
        .collect();
    let Some(root) = starts.iter().map(|&i| indent(lines[i])).min() else {
        return Vec::new();
    };
    let mut tasks = Vec::new();
    for (n, &start) in starts.iter().enumerate() {
        if indent(lines[start]) != root {
            continue;
        }
        let Some(mut task) = parse_task_header(lines[start]) else {
            continue;
        };
        let end = starts.get(n + 1).copied().unwrap_or(lines.len());
        let block = &lines[start + 1..end];
        // The task's own fields come before its first activity record.
        task.bounds = block
            .iter()
            .take_while(|l| !l.trim_start().starts_with("* "))
            .find_map(|l| parse_bounds_line(l));
        if let Some(package) = block.iter().find_map(|l| activity_record_package(l)) {
            task.package = Some(package);
        }
        // Activity records are listed top first: the first one is on screen.
        // `overrideOrientation` (printed just before `requestedOrientation`)
        // already includes the user's per-app aspect-ratio override.
        task.orientation = block
            .iter()
            .find_map(|l| {
                let l = l.trim_start();
                l.strip_prefix("overrideOrientation=")
                    .or_else(|| l.strip_prefix("requestedOrientation="))
            })
            .map(|o| o.split_whitespace().next().unwrap_or(o).to_string());
        tasks.push(task);
    }
    tasks
}

/// Extracts the current logical size for a display from `dumpsys window`.
pub fn parse_display_size(output: &str, display_id: u32) -> Option<DisplaySize> {
    let heading = format!("Display: mDisplayId={display_id} ");
    let section = output
        .split(&heading)
        .nth(1)?
        .split("Display: mDisplayId=")
        .next()?;
    let cur = section.split("cur=").nth(1)?.split_whitespace().next()?;
    let (width, height) = cur.split_once('x')?;
    Some(DisplaySize {
        width: width.parse().ok()?,
        height: height.parse().ok()?,
    })
}

/// Reads the navigation-bar inset supplied by Samsung's DeX taskbar window.
pub fn parse_dex_taskbar_bottom_inset(output: &str, display_id: u32) -> Option<u32> {
    for block in output
        .split("Window #")
        .filter(|b| b.contains("DexTaskbarWindow"))
    {
        if !block.contains(&format!("mDisplayId={display_id}")) {
            continue;
        }
        for line in block.lines() {
            if !line.contains("type=navigationBars") || !line.contains("insetsSize=Insets{") {
                continue;
            }
            let bottom = line
                .split("bottom=")
                .nth(1)?
                .split(|c: char| !c.is_ascii_digit())
                .next()?;
            if let Ok(value) = bottom.parse::<u32>() {
                return Some(value);
            }
        }
    }
    None
}

/// Packages of the app windows on a display, visible or minimised, without
/// duplicates.
pub fn app_packages(tasks: &[TaskInfo]) -> Vec<String> {
    let mut packages: Vec<String> = tasks
        .iter()
        .filter(|t| t.is_app_window())
        .filter_map(|t| t.package.clone())
        .collect();
    packages.sort();
    packages.dedup();
    packages
}

/// Ends an app's process if (and only if) it sits in the background, the same
/// way Android reclaims memory: its activities keep their saved state and are
/// recreated on next use. Unlike `force-stop`, notifications and alarms keep
/// working, and a foreground service (music playback) is left alone.
pub async fn kill_background_app(adb: &Adb, serial: &str, package: &str) -> Result<()> {
    if package.is_empty()
        || !package
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
    {
        bail!("refusing to kill unexpected package name {package:?}");
    }
    let out = adb
        .shell(serial, &format!("am kill --user 0 {package}"))
        .await?;
    if crate::apps::shell_reported_error(&out) {
        bail!("am kill {package}: {}", out.trim());
    }
    Ok(())
}

pub async fn resize_task(adb: &Adb, serial: &str, task_id: u32, bounds: Rect) -> Result<()> {
    if bounds.is_empty() {
        bail!("refusing to resize task {task_id} to an empty rect");
    }
    let Rect {
        left,
        top,
        right,
        bottom,
    } = bounds;
    let out = adb
        .shell(
            serial,
            &format!("am task resize {task_id} {left} {top} {right} {bottom}"),
        )
        .await?;
    if crate::apps::shell_reported_error(&out) {
        bail!("task resize failed: {}", out.trim());
    }
    Ok(())
}

pub fn parse_setting_value(raw: &str) -> Option<String> {
    let v = raw.trim();
    (!v.is_empty() && v != "null").then(|| v.to_string())
}

/// Persist the original values before issuing any device writes.
pub async fn force_desktop_mode(
    adb: &Adb,
    serial: &str,
    persist: impl FnOnce(BTreeMap<String, Option<String>>) -> Result<()>,
) -> Result<()> {
    force_desktop_mode_with(|cmd| async move { adb.shell(serial, &cmd).await }, persist).await
}

async fn force_desktop_mode_with<F, Fut>(
    mut shell: F,
    persist: impl FnOnce(BTreeMap<String, Option<String>>) -> Result<()>,
) -> Result<()>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<String>>,
{
    let mut previous = BTreeMap::new();
    for (name, _) in DESKTOP_MODE_SETTINGS {
        let raw = shell(format!("settings get global {name}")).await?;
        previous.insert(name.to_string(), parse_setting_value(&raw));
    }
    persist(previous)?;
    for (name, value) in DESKTOP_MODE_SETTINGS {
        shell(format!("settings put global {name} {value}")).await?;
    }
    Ok(())
}

pub async fn restore_settings(
    adb: &Adb,
    serial: &str,
    values: &BTreeMap<String, Option<String>>,
) -> Result<()> {
    restore_settings_with(|cmd| async move { adb.shell(serial, &cmd).await }, values).await
}

async fn restore_settings_with<F, Fut>(
    mut shell: F,
    values: &BTreeMap<String, Option<String>>,
) -> Result<()>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<String>>,
{
    for (name, value) in values {
        // Names come from DESKTOP_MODE_SETTINGS; values were read from the device.
        if !DESKTOP_MODE_SETTINGS.iter().any(|(n, _)| n == name) {
            continue;
        }
        let cmd = match value {
            Some(v)
                if v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) =>
            {
                format!("settings put global {name} {v}")
            }
            Some(_) => bail!("refusing to restore invalid value for global setting {name}"),
            None => format!("settings delete global {name}"),
        };
        shell(cmd).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn partial_write_failure_keeps_persisted_original_values() {
        use std::sync::{Arc, Mutex};
        let journal = Arc::new(Mutex::new(None));
        let writes = Arc::new(Mutex::new(Vec::new()));
        let saved = journal.clone();
        let observed = journal.clone();
        let written = writes.clone();
        let result = force_desktop_mode_with(
            move |cmd| {
                let observed = observed.clone();
                let written = written.clone();
                async move {
                    if cmd.starts_with("settings get") {
                        return Ok("0\n".into());
                    }
                    assert!(
                        observed.lock().unwrap().is_some(),
                        "journal must precede device writes"
                    );
                    let mut writes = written.lock().unwrap();
                    writes.push(cmd);
                    if writes.len() == 2 {
                        bail!("device disconnected");
                    }
                    Ok(String::new())
                }
            },
            move |values| {
                *saved.lock().unwrap() = Some(values);
                Ok(())
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(writes.lock().unwrap().len(), 2);
        let values = journal.lock().unwrap().clone().unwrap();
        for (name, _) in DESKTOP_MODE_SETTINGS {
            assert_eq!(values[name].as_deref(), Some("0"));
        }
    }

    #[tokio::test]
    async fn persistence_failure_prevents_all_device_writes() {
        let result = force_desktop_mode_with(
            |cmd| async move {
                assert!(
                    cmd.starts_with("settings get"),
                    "must not modify the device without a journal"
                );
                Ok("null\n".into())
            },
            |_| bail!("disk full"),
        )
        .await;
        assert_eq!(result.unwrap_err().to_string(), "disk full");
    }

    #[test]
    fn picks_honeyspace_on_one_ui_8() {
        let out = "com.android.systemui/.subscreen.SubHomeActivity\r\ncom.sec.android.app.launcher/com.honeyspace.dexservice.SecondaryLauncher\r\n";
        assert_eq!(
            pick_dex_launcher(out).as_deref(),
            Some("com.sec.android.app.launcher/com.honeyspace.dexservice.SecondaryLauncher")
        );
    }

    #[test]
    fn prefers_legacy_desktop_launcher() {
        let out = "com.sec.android.app.launcher/com.honeyspace.dexservice.SecondaryLauncher\ncom.sec.android.app.desktoplauncher/.LauncherActivity\n";
        assert_eq!(
            pick_dex_launcher(out).as_deref(),
            Some("com.sec.android.app.desktoplauncher/.LauncherActivity")
        );
    }

    #[test]
    fn no_candidate() {
        assert_eq!(pick_dex_launcher("No activities found\n"), None);
        assert_eq!(
            pick_dex_launcher("com.android.systemui/.subscreen.SubHomeActivity\n"),
            None
        );
        assert_eq!(
            pick_dex_launcher(
                "com.sec.android.app.launcher/com.honeyspace.dexservice.Secondary$Launcher\n"
            )
            .as_deref(),
            Some("com.sec.android.app.launcher/com.honeyspace.dexservice.Secondary$Launcher")
        );
        assert_eq!(
            pick_dex_launcher("com.sec.android.app.launcher/.Bad;reboot\n"),
            None
        );
    }

    #[test]
    fn setting_values() {
        assert_eq!(parse_setting_value("null\n"), None);
        assert_eq!(parse_setting_value("0\r\n"), Some("0".into()));
    }

    #[tokio::test]
    async fn invalid_restore_values_are_not_silently_dropped() {
        let values = BTreeMap::from([(
            "force_desktop_mode_on_external_displays".into(),
            Some("0;reboot".into()),
        )]);
        let result = restore_settings_with(|_| async { Ok(String::new()) }, &values).await;
        assert!(result.is_err());
    }

    /// Abridged `dumpsys activity activities` of One UI 8.5 (SCG37).
    const ACTIVITIES: &str = r#"ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #8 (activities from top to bottom):
  * Task{28bb49d #11773 type=standard A=10428:com.instagram.android U=0 visible=true visibleRequested=true mode=freeform translucent=true sz=1}
    mBounds=Rect(0, 0 - 1080, 2238)
    mLastPausedActivity: ActivityRecord{4987 u0 com.instagram.android/.activity.MainTabActivity t11773}
    mLastNonFullscreenBounds=Rect(81, 618 - 999, 1788)
    isSleeping=false
    * Hist  #0: ActivityRecord{4987 u0 com.instagram.android/.activity.MainTabActivity t11773}
      overrideOrientation=SCREEN_ORIENTATION_FULL_USER
      requestedOrientation=SCREEN_ORIENTATION_FULL_USER
      mLastReportedConfigurations:
        mGlobalConfig={1.0 ... winConfig={ mBounds=Rect(0, 0 - 1080, 2340) mAppBounds=Rect(0, 0 - 1080, 2340)} s.2}
    * Task{3ca4742 #11774 type=standard A=10428:com.instagram.android U=0 rootTaskId=11773 visible=true mode=freeform sz=1}
      mBounds=Rect(0, 0 - 540, 2238)
  * Task{a1 #9 type=standard A=10157:com.sec.android.app.launcher U=0 visible=true mode=fullscreen translucent=false sz=1}
    mBounds=Rect(0, 1224 - 1920, 1280)
  * Task{a2 #12 type=home U=0 visible=true visibleRequested=true mode=fullscreen translucent=true sz=1}
  * Task{a6 #15 type=standard A=10388:com.discord U=0 visible=false visibleRequested=false mode=freeform translucent=true sz=1}
  * Task{a3 #13 type=standard A=10200:com.samsung.android.video U=0 visible=true mode=pinned sz=1}
    mBounds=Rect(1500, 900 - 1900, 1130)
  * Task{a4 #14 type=standard A=10561:com.ss.android.ugc.trill U=0 visible=true visibleRequested=true mode=freeform translucent=false sz=2}
    * Hist  #1: ActivityRecord{77 u0 com.ss.android.ugc.trill/com.ss.android.ugc.aweme.main.MainActivity t14}
      overrideOrientation=SCREEN_ORIENTATION_PORTRAIT
      requestedOrientation=SCREEN_ORIENTATION_PORTRAIT
    * Hist  #0: ActivityRecord{78 u0 com.ss.android.ugc.trill/com.ss.android.ugc.aweme.splash.SplashActivity t14}
      overrideOrientation=SCREEN_ORIENTATION_BEHIND
      requestedOrientation=SCREEN_ORIENTATION_BEHIND
Display #0 (activities from top to bottom):
  * Task{a5 #3 type=standard A=10428:com.instagram.android U=0 visible=true mode=fullscreen sz=1}
    bounds=[0,0][1080,2340]"#;

    #[test]
    fn lists_root_app_tasks_with_their_bounds() {
        let tasks = parse_display_tasks(ACTIVITIES, 8);
        let ids: Vec<u32> = tasks.iter().map(|t| t.id).collect();
        assert_eq!(
            ids,
            vec![11773, 9, 15, 13, 14],
            "nested and non-standard tasks are skipped"
        );
        assert!(
            !tasks[2].visible,
            "a minimised window is listed but not visible"
        );
        assert!(tasks[0].visible);
        assert_eq!(
            tasks[0].bounds,
            Some(Rect::new(0, 0, 1080, 2238)),
            "neither the activity config nor the stale bounds win"
        );
        assert_eq!(tasks[0].package.as_deref(), Some("com.instagram.android"));
        assert_eq!(tasks[0].mode, "freeform");
        assert_eq!(
            tasks[4].bounds, None,
            "a task that inherits the display prints no bounds"
        );
        assert_eq!(tasks[0].fit(), Fit::Fill, "Instagram rotates");
        assert_eq!(
            tasks[4].orientation.as_deref(),
            Some("SCREEN_ORIENTATION_PORTRAIT"),
            "the top activity decides"
        );
        assert_eq!(tasks[4].fit(), Fit::Portrait, "TikTok is phone-only");
        assert_eq!(tasks[1].fit(), Fit::Fill, "no orientation printed: fill");

        let managed: Vec<u32> = tasks
            .iter()
            .filter(|t| t.visible && t.is_app_window())
            .map(|t| t.id)
            .collect();
        assert_eq!(
            managed,
            vec![11773, 14],
            "the DeX taskbar and picture-in-picture are left alone"
        );
        assert_eq!(
            app_packages(&tasks),
            vec!["com.discord", "com.instagram.android", "com.ss.android.ugc.trill"],
            "apps that will move to the phone, minimised ones included; not the launcher, not picture-in-picture"
        );
        assert!(parse_display_tasks(ACTIVITIES, 4).is_empty());
        assert_eq!(parse_display_tasks(ACTIVITIES, 0).len(), 1);
    }

    #[test]
    fn packages_come_from_the_activities_not_the_task_affinity() {
        let dump = r#"Display #10 (activities from top to bottom):
  * Task{221bfbb #11988 type=standard A=1000:com.android.settings.root U=0 visible=true visibleRequested=true mode=freeform translucent=false sz=2}
    mBounds=Rect(0, 0 - 1600, 944)
    * Hist  #0: ActivityRecord{1 u0 com.android.settings/.Settings t11988}
  * Task{cd70eb0 #11986 type=standard A=10273:com.google.android.googlequicksearchbox.googleapp U=0 visible=false mode=freeform sz=1}
    mLastPausedActivity: ActivityRecord{2 u0 com.google.android.googlequicksearchbox/com.google.android.apps.search.googleapp.activity.GoogleAppActivity t11986}
  * Task{4564e9 #12000 type=standard I=com.sec.android.app.launcher/com.honeyspace.dexservice.SecondaryLauncher U=0 visible=true mode=fullscreen sz=1}
  * Task{d1 #12001 type=standard A=10388:com.discord U=0 visible=false mode=freeform sz=1}
Display #0 (activities from top to bottom):"#;
        let tasks = parse_display_tasks(dump, 10);
        let packages: Vec<Option<&str>> = tasks.iter().map(|t| t.package.as_deref()).collect();
        assert_eq!(
            packages,
            vec![
                Some("com.android.settings"),
                Some("com.google.android.googlequicksearchbox"),
                Some("com.sec.android.app.launcher"),
                Some("com.discord"),
            ],
            "`am kill` needs real package names; the affinity is only a fallback"
        );
        assert_eq!(
            app_packages(&tasks),
            vec![
                "com.android.settings",
                "com.discord",
                "com.google.android.googlequicksearchbox"
            ]
        );
    }

    #[test]
    fn rect_formats_and_unmanaged_packages() {
        assert_eq!(
            parse_rect("[0,0][1920,1224]"),
            Some(Rect::new(0, 0, 1920, 1224))
        );
        assert_eq!(
            parse_rect("Rect(-8, -40 - 1920, 1224)"),
            Some(Rect::new(-8, -40, 1920, 1224))
        );
        assert_eq!(parse_rect("[0,0]"), None);
        assert_eq!(
            parse_bounds_line("    mLastNonFullscreenBounds=Rect(81, 618 - 999, 1788)"),
            None
        );
        assert_eq!(
            parse_bounds_line(
                "        mOverrideConfig={1.0 winConfig={ mBounds=Rect(0, 0 - 1080, 2340)}}"
            ),
            None
        );
        assert_eq!(
            parse_bounds_line("    mBounds=Rect(0, 0 - 1920, 1224)"),
            Some(Rect::new(0, 0, 1920, 1224))
        );
        assert_eq!(
            parse_bounds_line("    bounds=[0,0][10,10]"),
            Some(Rect::new(0, 0, 10, 10))
        );
        let ime = TaskInfo {
            id: 1,
            package: Some("com.samsung.android.honeyboard".into()),
            mode: "freeform".into(),
            bounds: None,
            orientation: None,
            visible: true,
        };
        assert!(!ime.is_app_window());
    }

    #[test]
    fn parses_display_size_and_taskbar_inset() {
        let windows = r#"Window #0 Window{abc u0 DexTaskbarWindow}:
  mDisplayId=8 package=com.sec.android.app.launcher
  InsetsFrameProvider: {type=navigationBars, source=FRAME, insetsSize=Insets{left=0, top=0, right=0, bottom=56}}
Display: mDisplayId=8 (organized)
  init=1920x1080 240dpi base=1920x1080 cur=1920x1280 app=1920x1280
Display: mDisplayId=0 (organized)"#;
        assert_eq!(parse_dex_taskbar_bottom_inset(windows, 8), Some(56));
        assert_eq!(
            parse_display_size(windows, 8),
            Some(DisplaySize {
                width: 1920,
                height: 1280
            })
        );
    }
}
