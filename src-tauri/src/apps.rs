//! Launchable applications for devices whose secondary launcher cannot start apps.
use crate::{
    adb::{self, Adb},
    binaries::SERVER_VERSION,
};
use anyhow::{bail, Result};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchableApp {
    pub name: String,
    pub component: String,
}

pub fn valid_component(value: &str) -> bool {
    let Some((package, activity)) = value.split_once('/') else {
        return false;
    };
    !package.is_empty()
        && !activity.is_empty()
        && value.len() <= 512
        && package
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'.')
        && activity
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.$".contains(&c))
}

/// True when `am` / `cmd` output reports a failure. Only lines that *start*
/// with a failure marker count: a successful `am start` echoes the component
/// (`Starting: Intent { cmp=p/.ErrorActivity }`), so a substring search would
/// reject apps whose class name merely contains "Error" or "Exception".
pub fn shell_reported_error(output: &str) -> bool {
    output.lines().map(str::trim_start).any(|line| {
        ["Error", "Exception", "Security", "java."]
            .iter()
            .any(|marker| line.starts_with(marker))
    })
}

pub fn parse_apps(components: &str, labels: &str) -> Vec<LaunchableApp> {
    let mut names = BTreeMap::new();
    for line in labels.lines() {
        let line = line.trim();
        let Some(row) = line.strip_prefix('*').or_else(|| line.strip_prefix('-')) else {
            continue;
        };
        let row = row.trim();
        let Some(index) = row.rfind(char::is_whitespace) else {
            continue;
        };
        let (name, package) = row.split_at(index);
        names.insert(package.trim(), name.trim());
    }
    let mut apps = BTreeMap::new();
    for component in components
        .lines()
        .map(str::trim)
        .filter(|c| valid_component(c))
    {
        let package = component.split_once('/').unwrap().0;
        apps.insert(
            component.to_owned(),
            LaunchableApp {
                name: names
                    .get(package)
                    .copied()
                    .filter(|n| !n.is_empty())
                    .unwrap_or(package)
                    .to_owned(),
                component: component.to_owned(),
            },
        );
    }
    apps.into_values().collect()
}

pub async fn list(adb: &Adb, serial: &str, server: &Path) -> Result<Vec<LaunchableApp>> {
    let components = adb.shell(serial, "cmd package query-activities --components --user current -a android.intent.action.MAIN -c android.intent.category.LAUNCHER").await?;
    if shell_reported_error(&components) {
        bail!("アプリ一覧を取得できません: {}", components.trim());
    }
    // Use a separate file: list mode unlinks its jar and must not touch the
    // running session's server. Failure to obtain labels still leaves usable apps.
    let remote = "/data/local/tmp/modern-dex-app-list.jar";
    let labels = async {
        adb::push(serial, server, remote, |_, _| {}).await?;
        adb.shell(serial, &format!("CLASSPATH={remote} app_process / com.genymobile.scrcpy.Server {SERVER_VERSION} list_apps=true")).await
    };
    let labels = match tokio::time::timeout(std::time::Duration::from_secs(5), labels).await {
        Ok(Ok(labels)) => labels,
        _ => String::new(),
    };
    Ok(parse_apps(&components, &labels))
}

pub async fn launch(adb: &Adb, serial: &str, display: u32, component: &str) -> Result<()> {
    if !valid_component(component) {
        bail!("無効なアプリです");
    }
    // The strict grammar excludes shell syntax. Quote to preserve '$' in inner
    // activity class names. Do not force-stop an already running application.
    let out = adb.shell(serial, &format!("am start --user current --display {display} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n '{component}'")).await?;
    if !out.contains("Starting: Intent") || shell_reported_error(&out) {
        bail!("アプリを起動できません: {}", out.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_labels_filters_and_deduplicates() {
        let apps = parse_apps("p.calc/.Main\np.calc/.Main\np.other/.Main\nNo activities found\n", "[server] INFO: List of apps:\n * 電卓 アプリ         p.calc\n - Unlaunchable         p.hidden\n");
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].name, "電卓 アプリ");
        assert_eq!(apps[1].name, "p.other");
    }
    #[test]
    fn error_detection_ignores_component_names_that_contain_error() {
        assert!(!shell_reported_error(
            "Starting: Intent { act=android.intent.action.MAIN cmp=p.app/.ErrorReportActivity }\r\n"
        ));
        assert!(!shell_reported_error(
            "p.app/.ExceptionListActivity\np.b/.Main\n"
        ));
        assert!(!shell_reported_error(""));
        assert!(shell_reported_error(
            "Error: Activity class {p/.X} does not exist.\n"
        ));
        assert!(shell_reported_error(
            "Starting: Intent { cmp=p/.X }\nError type 3\n"
        ));
        assert!(shell_reported_error(
            "  Exception occurred while executing 'start':\n"
        ));
        assert!(shell_reported_error(
            "java.lang.SecurityException: Permission Denial\n"
        ));
        assert!(shell_reported_error(
            "Security exception: Permission Denial\n"
        ));
    }

    #[test]
    fn rejects_shell_injection_and_accepts_activity_aliases() {
        for value in [
            "",
            "p/",
            "/A",
            "p/A;reboot",
            "p/A'",
            "p/A\n",
            "p/A/B",
            "p/$(id)",
        ] {
            assert!(!valid_component(value), "{value}");
        }
        for value in ["com.android.settings/.Settings", "p.app/p.app.Main$Inner"] {
            assert!(valid_component(value));
        }
    }

    // Explicitly opt in: creates a temporary session, opens Calculator, cleans up.
    #[tokio::test]
    #[ignore = "requires an unlocked Pixel; DEX_TEST_DISPLAY reuses an existing display"]
    async fn live_pixel_launcher() {
        let adb = Adb::new(
            std::env::var_os("DEX_TEST_ADB")
                .expect("DEX_TEST_ADB")
                .into(),
        );
        let serial = std::env::var("DEX_TEST_SERIAL").expect("DEX_TEST_SERIAL");
        let server = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/bin/scrcpy-server");
        let existing = std::env::var("DEX_TEST_DISPLAY")
            .ok()
            .map(|v| v.parse::<u32>().expect("numeric display ID"));
        if existing.is_none() {
            let displays = adb.shell(&serial, "dumpsys display").await.unwrap();
            assert!(
                !displays.contains("DisplayDeviceInfo{\"scrcpy\""),
                "set DEX_TEST_DISPLAY to reuse the existing DeX session"
            );
        }
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let settings = crate::settings::Settings {
            audio: false,
            destroy_content: false,
            force_desktop_mode: false,
            ..Default::default()
        };
        let mut session = if existing.is_none() {
            Some(
                crate::session::start(
                    crate::session::StartParams {
                        adb: adb.clone(),
                        serial: serial.clone(),
                        server_path: server.clone(),
                        settings,
                        on_apps_on_dex: std::sync::Arc::new(|_| {}),
                    },
                    std::sync::Arc::new(crate::ws::StreamHub::default()),
                    tx,
                    std::sync::Arc::new(|_| {}),
                )
                .await
                .unwrap(),
            )
        } else {
            None
        };
        let display = existing.unwrap_or_else(|| session.as_ref().unwrap().info.display_id);
        assert!(display > 0, "must use a virtual display");
        let outcome: Result<()> = async {
            let apps = list(&adb, &serial, &server).await?;
            let calculator = apps
                .iter()
                .find(|a| a.component.starts_with("com.google.android.calculator/"))
                .ok_or_else(|| anyhow::anyhow!("Calculator missing"))?;
            if calculator.name == "com.google.android.calculator" {
                bail!("localized label missing");
            }
            if std::env::var_os("DEX_TEST_NATIVE_ICONS").is_some() {
                // Operator clicks the Android launcher icon during this window.
                // This deliberately does not use our app-launch command.
                eprintln!("Native icon test: display {display}, waiting 60 seconds for Calculator");
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            } else {
                launch(&adb, &serial, display, &calculator.component).await?;
            }
            let dump = adb.shell(&serial, "dumpsys activity activities").await?;
            let heading = format!("Display #{display} ");
            let section = dump
                .split(&heading)
                .nth(1)
                .unwrap_or("")
                .split("Display #")
                .next()
                .unwrap_or("");
            if !section.lines().any(|line| {
                line.contains("topResumedActivity=")
                    && line.contains("com.google.android.calculator/")
            }) {
                bail!("Calculator did not resume on the virtual display");
            }
            Ok(())
        }
        .await;
        if let Some(session) = session.as_mut() {
            session.stop(false).await;
        }
        outcome.unwrap();
    }
}
