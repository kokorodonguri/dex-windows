//! Best-effort diagnostics only: never dismiss or change the device keyguard.

/// Read the keyguard service section, not similarly named display/policy flags.
/// OEMs may omit or change dumpsys fields; missing/conflicting values are unknown.
pub fn parse_keyguard_showing(output: &str) -> Option<bool> {
    let mut in_delegate = false;
    let mut indent = 0;
    let mut value = None;
    for line in output.lines() {
        let text = line.trim();
        if text == "KeyguardServiceDelegate" {
            in_delegate = true;
            indent = line.len() - line.trim_start().len();
            continue;
        }
        if !in_delegate || text.is_empty() {
            continue;
        }
        if line.len() - line.trim_start().len() <= indent {
            break;
        }
        let field = text
            .strip_prefix("showing=")
            .or_else(|| text.strip_prefix("mIsShowing="));
        if let Some(field) = field {
            let next = match field {
                "true" => true,
                "false" => false,
                _ => return None,
            };
            if value.is_some_and(|old| old != next) {
                return None;
            }
            value = Some(next);
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixel_locked_and_unlocked() {
        for state in ["true", "false"] {
            let dump = format!("  KeyguardServiceDelegate\r\n    showing={state}\r\n    inputRestricted=false\r\n    KeyguardStateMonitor\r\n      mIsShowing={state}\r\n      mInputRestricted=true\r\n");
            assert_eq!(parse_keyguard_showing(&dump), Some(state == "true"));
        }
    }

    #[test]
    fn unknown_or_conflicting_output_never_means_unlocked() {
        for dump in ["", "Permission Denial", "showing=false", "  KeyguardServiceDelegate\n    showing=true\n    KeyguardStateMonitor\n      mIsShowing=false", "  KeyguardServiceDelegate\n    showing=unknown", "  KeyguardServiceDelegate\n  OtherSection\n    showing=false"] {
            assert_eq!(parse_keyguard_showing(dump), None, "{dump}");
        }
    }
}
