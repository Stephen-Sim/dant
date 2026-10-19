use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const DESKTOP_TRANSITION_TIMEOUT: Duration = Duration::from_secs(150);

#[derive(Default)]
pub struct DesktopExit {
    pending: AtomicBool,
    approved: AtomicBool,
}

fn valid_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
pub(crate) fn confirmed(value: &serde_json::Value) -> bool {
    value.get("ok").and_then(|value| value.as_bool()) == Some(true)
        && value.get("workPaused").and_then(|value| value.as_bool()) == Some(true)
        && (value.get("vmSuspended").and_then(|value| value.as_bool()) == Some(true)
            || value.get("unsupported").and_then(|value| value.as_bool()) == Some(true))
}
fn unsupported_notice(value: &serde_json::Value) -> bool {
    value.get("unsupported").and_then(|value| value.as_bool()) == Some(true)
        && value.get("notConfigured").and_then(|value| value.as_bool()) != Some(true)
}
fn desktop_open_request(
    client: &reqwest::Client,
    session: &serde_json::Value,
) -> Option<reqwest::Request> {
    if session.get("product").and_then(|value| value.as_str()) != Some("dant")
        || session.get("mode").and_then(|value| value.as_str()) != Some("controller")
    {
        return None;
    }
    let token = session
        .get("token")
        .and_then(|value| value.as_str())
        .filter(|value| valid_token(value))?;
    client
        .post("http://127.0.0.1:4317/api/desktop/open")
        .header("X-Dant-Token", token)
        .header("Content-Type", "application/json")
        .timeout(DESKTOP_TRANSITION_TIMEOUT)
        .body("{}")
        .build()
        .ok()
}
fn desktop_open_confirmed(bytes: &[u8]) -> bool {
    bytes.len() <= 4096
        && serde_json::from_slice::<serde_json::Value>(bytes)
            .ok()
            .is_some_and(|value| value.get("ok").and_then(|value| value.as_bool()) == Some(true))
}
async fn open_controller_request() -> bool {
    let session = tauri::async_runtime::spawn_blocking(|| {
        crate::transport::local_json("/api/session", None, None)
    })
    .await
    .ok()
    .flatten();
    let Ok(client) = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return false;
    };
    let Some(request) = session
        .as_ref()
        .and_then(|session| desktop_open_request(&client, session))
    else {
        return false;
    };
    let Ok(mut response) = client.execute(request).await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 4096 => bytes.extend_from_slice(&chunk),
            Ok(None) => return desktop_open_confirmed(&bytes),
            _ => return false,
        }
    }
}
fn notice(message: &str) {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(
                hwnd: *mut std::ffi::c_void,
                text: *const u16,
                title: *const u16,
                kind: u32,
            ) -> i32;
        }
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "dant".encode_utf16().chain(Some(0)).collect();
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x30);
        }
    }
    #[cfg(not(windows))]
    eprintln!("{message}");
}
pub fn approved(app: &AppHandle) -> bool {
    app.try_state::<DesktopExit>()
        .is_some_and(|state| state.approved.load(Ordering::SeqCst))
}

/// An external controller outlives the native process. Reopening the app must ask
/// that same controller to restore the VM, without resuming paused task records.
pub fn open_existing_controller(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if open_controller_request().await {
            return;
        }
        crate::tray::restore(&app);
        let _ = app.emit_to("main", "dant-open-failed", ());
        let message = crate::l10n::text(&crate::tray::language(&app),
            "The work computer could not be restored. dant remains open. Check Work computer before trying again.",
            "未能恢复工作电脑。dant 保持打开，请检查工作电脑后重试。");
        notice(&message);
    });
}

/// Called only after the controller's installation lease has confirmed paused
/// work and suspended the VM. The helper's process handoff must not send it twice.
pub fn prepared_update_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<DesktopExit>() else {
        return;
    };
    state.approved.store(true, Ordering::SeqCst);
    crate::tray::mark_exiting(app);
    app.exit(0);
}
pub fn request_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<DesktopExit>() else {
        return;
    };
    if state.approved.load(Ordering::SeqCst) {
        app.exit(0);
        return;
    }
    if state.pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let session = tauri::async_runtime::spawn_blocking(|| {
            crate::transport::local_json("/api/session", None, None)
        })
        .await
        .ok()
        .flatten();
        let token = session
            .as_ref()
            .filter(|value| value.get("product").and_then(|value| value.as_str()) == Some("dant"))
            .and_then(|value| value.get("token"))
            .and_then(|value| value.as_str())
            .filter(|value| valid_token(value));
        let response = if let Some(token) = token {
            match reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(DESKTOP_TRANSITION_TIMEOUT)
                .build()
            {
                Ok(client) => match client
                    .post("http://127.0.0.1:4317/api/desktop/exit")
                    .header("X-Dant-Token", token)
                    .header("Content-Type", "application/json")
                    .body("{}")
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => response
                        .text()
                        .await
                        .ok()
                        .filter(|value| value.len() <= 4096)
                        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok()),
                    _ => None,
                },
                Err(_) => None,
            }
        } else {
            None
        };
        let Some(state) = app.try_state::<DesktopExit>() else {
            return;
        };
        state.pending.store(false, Ordering::SeqCst);
        if response.as_ref().is_some_and(confirmed) {
            if response.as_ref().is_some_and(unsupported_notice) {
                let chinese = crate::tray::language(&app).starts_with("zh");
                notice(if chinese {
                    "任务已暂停。此电脑连接缺少可验证的虚拟机管理信息，dant 无法挂起整台虚拟机。"
                } else {
                    "Work is paused. This computer connection does not provide a verified identity for suspending the whole virtual machine."
                });
            }
            state.approved.store(true, Ordering::SeqCst);
            crate::tray::mark_exiting(&app);
            app.exit(0);
        } else {
            crate::tray::restore(&app);
            let _ = app.emit_to("main", "dant-exit-failed", ());
            let chinese = crate::tray::language(&app).starts_with("zh");
            notice(if chinese {
                "未能确认工作已暂停或虚拟机已挂起。dant 保持打开，请检查工作电脑后重试退出。"
            } else {
                "Work pause or VM suspension could not be confirmed. dant remains open. Check Work computer, then try Exit again."
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exit_requires_explicit_quiescence_not_a_generic_success_or_cached_state() {
        assert!(confirmed(
            &serde_json::json!({"ok":true,"workPaused":true,"vmSuspended":true})
        ));
        assert!(confirmed(
            &serde_json::json!({"ok":true,"workPaused":true,"unsupported":true})
        ));
        for value in [
            serde_json::json!({"ok":true}),
            serde_json::json!({"ok":true,"workPaused":true}),
            serde_json::json!({"ok":false,"workPaused":true,"vmSuspended":true}),
            serde_json::json!({"ok":true,"workPaused":false,"unsupported":true}),
        ] {
            assert!(!confirmed(&value));
        }
    }
    #[test]
    fn exit_session_is_bounded_and_not_an_arbitrary_header() {
        assert!(valid_token("0123456789abcdef"));
        for value in ["", "token\r\nOther: value", "private token"] {
            assert!(!valid_token(value));
        }
        assert!(!valid_token(&"a".repeat(257)));
    }
    #[test]
    fn no_vm_configuration_does_not_claim_an_unsupported_ssh_connection() {
        assert!(!unsupported_notice(
            &serde_json::json!({"unsupported":true,"notConfigured":true})
        ));
        assert!(unsupported_notice(&serde_json::json!({"unsupported":true})));
        assert!(unsupported_notice(
            &serde_json::json!({"unsupported":true,"notConfigured":false})
        ));
        assert!(!unsupported_notice(
            &serde_json::json!({"unsupported":false,"notConfigured":false})
        ));
    }
    #[test]
    fn reopening_uses_only_an_authenticated_controller_and_the_fixed_local_endpoint() {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let session =
            serde_json::json!({"product":"dant","mode":"controller","token":"0123456789abcdef"});
        let request = desktop_open_request(&client, &session).unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.url().as_str(),
            "http://127.0.0.1:4317/api/desktop/open"
        );
        assert_eq!(request.headers()["X-Dant-Token"], "0123456789abcdef");
        assert_eq!(request.headers()["Content-Type"], "application/json");
        assert_eq!(
            request.body().and_then(|body| body.as_bytes()),
            Some(b"{}".as_slice())
        );
        assert_eq!(request.timeout(), Some(&Duration::from_secs(150)));
        for value in [
            serde_json::json!({"product":"other","mode":"controller","token":"ab"}),
            serde_json::json!({"product":"dant","mode":"worker","token":"ab"}),
            serde_json::json!({"product":"dant","token":"ab"}),
            serde_json::json!({"product":"dant","mode":"controller","token":""}),
            serde_json::json!({"product":"dant","mode":"controller","token":"ab\r\nOther: value"}),
            serde_json::json!({"product":"dant","mode":"controller","token":"a".repeat(257)}),
        ] {
            assert!(desktop_open_request(&client, &value).is_none());
        }
    }
    #[test]
    fn reopening_requires_a_bounded_explicit_confirmation() {
        assert!(desktop_open_confirmed(br#"{"ok":true}"#));
        for value in [
            br#"{}"#.as_slice(),
            br#"{"ok":false}"#.as_slice(),
            br#"{"ok":"true"}"#.as_slice(),
            br#"{"error":"installing"}"#.as_slice(),
            b"not JSON".as_slice(),
        ] {
            assert!(!desktop_open_confirmed(value));
        }
        let oversized = format!("{{\"ok\":true,\"padding\":\"{}\"}}", "a".repeat(4096));
        assert!(!desktop_open_confirmed(oversized.as_bytes()));
    }
}
