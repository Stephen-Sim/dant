use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const DESKTOP_TRANSITION_TIMEOUT: Duration = Duration::from_secs(150);
const DESKTOP_RESPONSE_MAX_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExitFailure {
    Unconfirmed,
    WorkPauseUnconfirmed,
    VMSuspensionUnconfirmed,
    VMOperationBusy,
    VMIdentityUnverified,
    VMUnsupported,
    BackupRunning,
    BackupUnconfirmed,
    DesktopBusy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExitOutcome {
    Confirmed { unsupported_notice: bool },
    Rejected(ExitFailure),
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitBody {
    ok: Option<bool>,
    work_paused: Option<bool>,
    vm_suspended: Option<bool>,
    unsupported: Option<bool>,
    not_configured: Option<bool>,
    code: Option<String>,
    phase: Option<String>,
}

impl ExitFailure {
    fn from_code(code: Option<&str>, phase: Option<&str>) -> Self {
        match code {
            Some("vm_pause_unconfirmed" | "executor_stop_unconfirmed") => {
                Self::WorkPauseUnconfirmed
            }
            Some("vm_lifecycle_unconfirmed") => Self::VMSuspensionUnconfirmed,
            Some("vm_lifecycle_busy") => Self::VMOperationBusy,
            Some(
                "vm_lifecycle_invalid_identity"
                | "vm_lifecycle_invalid_receipt"
                | "vm_lifecycle_binding_changed"
                | "vm_lifecycle_intent_changed",
            ) => Self::VMIdentityUnverified,
            Some("vm_lifecycle_unsupported") => Self::VMUnsupported,
            Some("backup_running") => Self::BackupRunning,
            Some("backup_restore_unconfirmed") => Self::BackupUnconfirmed,
            Some("desktop_transition_busy") => Self::DesktopBusy,
            Some("request_timeout" | "request_cancelled") => match phase {
                Some("pausing") => Self::WorkPauseUnconfirmed,
                Some("suspending") => Self::VMSuspensionUnconfirmed,
                _ => Self::Unconfirmed,
            },
            _ => Self::Unconfirmed,
        }
    }
}

fn exit_failure_message(language: &str, failure: ExitFailure) -> String {
    let (english, chinese) = match failure {
        ExitFailure::Unconfirmed => (
            "The exit outcome could not be confirmed.",
            "无法确认退出操作的结果。",
        ),
        ExitFailure::WorkPauseUnconfirmed => (
            "Work pause could not be confirmed.",
            "无法确认任务已暂停。",
        ),
        ExitFailure::VMSuspensionUnconfirmed => (
            "VM suspension could not be confirmed. Verify the VM state and any administrator confirmation.",
            "无法确认虚拟机已挂起，请核对虚拟机状态及管理员确认。",
        ),
        ExitFailure::VMOperationBusy => (
            "Another VM operation is in progress.",
            "另一项虚拟机操作正在进行。",
        ),
        ExitFailure::VMIdentityUnverified => (
            "The VM connection or suspension record changed or could not be verified.",
            "虚拟机连接或挂起记录已变化，或无法验证。",
        ),
        ExitFailure::VMUnsupported => (
            "This VM connection does not support verified suspension.",
            "此虚拟机连接不支持可验证的挂起操作。",
        ),
        ExitFailure::BackupRunning => (
            "A backup or restore is in progress.",
            "备份或恢复正在进行。",
        ),
        ExitFailure::BackupUnconfirmed => (
            "The backup or restore outcome is unconfirmed.",
            "无法确认备份或恢复结果。",
        ),
        ExitFailure::DesktopBusy => (
            "Another update or exit operation is in progress.",
            "另一项更新或退出操作正在进行。",
        ),
    };
    let reason = crate::l10n::text(language, english, chinese);
    let next = crate::l10n::text(
        language,
        "dant remains open. Check the operation status in Settings before exiting.",
        "dant 保持打开，请先到设置核对操作状态，再退出。",
    );
    format!("{reason}\n\n{next}")
}

fn exit_response(status: reqwest::StatusCode, bytes: &[u8]) -> ExitOutcome {
    if bytes.len() > DESKTOP_RESPONSE_MAX_BYTES {
        return ExitOutcome::Rejected(ExitFailure::Unconfirmed);
    }

    let Ok(body) = serde_json::from_slice::<ExitBody>(bytes) else {
        return ExitOutcome::Rejected(ExitFailure::Unconfirmed);
    };

    if status.is_success() && body.code.is_none() {
        if let Ok(value) = serde_json::to_value(&body) {
            if confirmed(&value) {
                return ExitOutcome::Confirmed {
                    unsupported_notice: unsupported_notice(&value),
                };
            }
        }
    }

    ExitOutcome::Rejected(ExitFailure::from_code(
        body.code.as_deref(),
        body.phase.as_deref(),
    ))
}

async fn desktop_response_bytes(response: &mut reqwest::Response) -> Option<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > DESKTOP_RESPONSE_MAX_BYTES as u64)
    {
        return None;
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > DESKTOP_RESPONSE_MAX_BYTES - bytes.len() {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }

    Some(bytes)
}

async fn execute_exit_request(client: &reqwest::Client, request: reqwest::Request) -> ExitOutcome {
    let Ok(mut response) = client.execute(request).await else {
        return ExitOutcome::Rejected(ExitFailure::Unconfirmed);
    };

    let status = response.status();
    let Some(bytes) = desktop_response_bytes(&mut response).await else {
        return ExitOutcome::Rejected(ExitFailure::Unconfirmed);
    };

    exit_response(status, &bytes)
}

enum DesktopAction {
    Open,
    Exit,
}

fn desktop_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(DESKTOP_TRANSITION_TIMEOUT)
        .build()
}

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
    desktop_request(client, session, DesktopAction::Open)
}

fn desktop_request(
    client: &reqwest::Client,
    session: &serde_json::Value,
    action: DesktopAction,
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
    let endpoint = match action {
        DesktopAction::Open => "http://127.0.0.1:4317/api/desktop/open",
        DesktopAction::Exit => "http://127.0.0.1:4317/api/desktop/exit",
    };
    client
        .post(endpoint)
        .header("X-Dant-Token", token)
        .header("Content-Type", "application/json")
        .timeout(DESKTOP_TRANSITION_TIMEOUT)
        .body("{}")
        .build()
        .ok()
}
fn desktop_open_confirmed(bytes: &[u8]) -> bool {
    bytes.len() <= DESKTOP_RESPONSE_MAX_BYTES
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
    let Ok(client) = desktop_client() else {
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
    desktop_response_bytes(&mut response)
        .await
        .is_some_and(|bytes| desktop_open_confirmed(&bytes))
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
        let client = desktop_client();
        let response = match client {
            Ok(client) => match session
                .as_ref()
                .and_then(|session| desktop_request(&client, session, DesktopAction::Exit))
            {
                Some(request) => execute_exit_request(&client, request).await,
                None => ExitOutcome::Rejected(ExitFailure::Unconfirmed),
            },
            Err(_) => ExitOutcome::Rejected(ExitFailure::Unconfirmed),
        };
        let Some(state) = app.try_state::<DesktopExit>() else {
            return;
        };
        state.pending.store(false, Ordering::SeqCst);
        if let ExitOutcome::Confirmed { unsupported_notice } = response {
            if unsupported_notice {
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
            let failure = match response {
                ExitOutcome::Rejected(failure) => failure,
                ExitOutcome::Confirmed { .. } => ExitFailure::Unconfirmed,
            };
            notice(&exit_failure_message(&crate::tray::language(&app), failure));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Read, Write};

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

    #[test]
    fn exit_requests_require_the_controller_identity_and_fixed_authenticated_action() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let session =
            serde_json::json!({"product":"dant","mode":"controller","token":"0123456789abcdef"});
        let request = desktop_request(&client, &session, DesktopAction::Exit).unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.url().as_str(),
            "http://127.0.0.1:4317/api/desktop/exit"
        );
        assert_eq!(request.headers()["X-Dant-Token"], "0123456789abcdef");
        assert_eq!(
            request.body().and_then(|body| body.as_bytes()),
            Some(b"{}".as_slice())
        );
        assert_eq!(request.timeout(), Some(&DESKTOP_TRANSITION_TIMEOUT));
        for session in [
            serde_json::json!({"product":"dant","mode":"worker","token":"ab"}),
            serde_json::json!({"product":"dant","token":"ab"}),
            serde_json::json!({"product":"other","mode":"controller","token":"ab"}),
        ] {
            assert!(desktop_request(&client, &session, DesktopAction::Exit).is_none());
        }
    }

    #[test]
    fn exit_error_codes_are_allowlisted_without_inventing_permission_or_uac_failures() {
        for (code, expected) in [
            ("vm_pause_unconfirmed", ExitFailure::WorkPauseUnconfirmed),
            (
                "executor_stop_unconfirmed",
                ExitFailure::WorkPauseUnconfirmed,
            ),
            (
                "vm_lifecycle_unconfirmed",
                ExitFailure::VMSuspensionUnconfirmed,
            ),
            ("vm_lifecycle_busy", ExitFailure::VMOperationBusy),
            (
                "vm_lifecycle_invalid_identity",
                ExitFailure::VMIdentityUnverified,
            ),
            (
                "vm_lifecycle_invalid_receipt",
                ExitFailure::VMIdentityUnverified,
            ),
            (
                "vm_lifecycle_binding_changed",
                ExitFailure::VMIdentityUnverified,
            ),
            (
                "vm_lifecycle_intent_changed",
                ExitFailure::VMIdentityUnverified,
            ),
            ("vm_lifecycle_unsupported", ExitFailure::VMUnsupported),
            ("backup_running", ExitFailure::BackupRunning),
            ("backup_restore_unconfirmed", ExitFailure::BackupUnconfirmed),
            ("desktop_transition_busy", ExitFailure::DesktopBusy),
        ] {
            let bytes = serde_json::to_vec(&serde_json::json!({
                "code": code,
                "error": "PRIVATE_TOKEN C:\\private\\process-output",
            }))
            .unwrap();
            assert_eq!(
                exit_response(reqwest::StatusCode::CONFLICT, &bytes),
                ExitOutcome::Rejected(expected)
            );
            let message = exit_failure_message("en", expected);
            assert!(!message.contains("PRIVATE_TOKEN") && !message.contains("process-output"));
        }
        for (phase, expected) in [
            ("pausing", ExitFailure::WorkPauseUnconfirmed),
            ("suspending", ExitFailure::VMSuspensionUnconfirmed),
            ("unknown", ExitFailure::Unconfirmed),
        ] {
            assert_eq!(
                ExitFailure::from_code(Some("request_timeout"), Some(phase)),
                expected
            );
            assert_eq!(
                ExitFailure::from_code(Some("request_cancelled"), Some(phase)),
                expected
            );
        }
        for code in [
            "vm_lifecycle_permission_denied",
            "uac_cancelled",
            "private-future-code",
        ] {
            assert_eq!(
                ExitFailure::from_code(Some(code), Some("suspending")),
                ExitFailure::Unconfirmed
            );
        }
    }

    #[test]
    fn exit_responses_require_success_status_and_strong_bounded_confirmation() {
        let confirmed_bytes = br#"{"ok":true,"workPaused":true,"vmSuspended":true}"#;
        assert_eq!(
            exit_response(reqwest::StatusCode::OK, confirmed_bytes),
            ExitOutcome::Confirmed {
                unsupported_notice: false
            }
        );
        assert_eq!(
            exit_response(reqwest::StatusCode::CONFLICT, confirmed_bytes),
            ExitOutcome::Rejected(ExitFailure::Unconfirmed)
        );
        for bytes in [
            br#"{"ok":true}"#.as_slice(),
            br#"{"ok":true,"workPaused":true}"#.as_slice(),
            br#"{"ok":"true","workPaused":true,"vmSuspended":true}"#.as_slice(),
            br#"{"ok":true,"ok":false,"workPaused":true,"vmSuspended":true}"#.as_slice(),
            br#"{"code":"unknown","error":"PRIVATE_TOKEN"}"#.as_slice(),
            br#"{"code":{},"error":"PRIVATE_TOKEN"}"#.as_slice(),
            br#"{"code":"backup_running","code":"vm_pause_unconfirmed"}"#.as_slice(),
            b"PRIVATE_TOKEN not JSON".as_slice(),
            b"\xff".as_slice(),
        ] {
            assert_eq!(
                exit_response(reqwest::StatusCode::OK, bytes),
                ExitOutcome::Rejected(ExitFailure::Unconfirmed)
            );
        }
        let mut bounded = confirmed_bytes.to_vec();
        bounded.resize(DESKTOP_RESPONSE_MAX_BYTES, b' ');
        assert!(matches!(
            exit_response(reqwest::StatusCode::OK, &bounded),
            ExitOutcome::Confirmed { .. }
        ));
        bounded.push(b' ');
        assert_eq!(
            exit_response(reqwest::StatusCode::OK, &bounded),
            ExitOutcome::Rejected(ExitFailure::Unconfirmed)
        );
        let conflicting =
            br#"{"ok":true,"workPaused":true,"vmSuspended":true,"code":"vm_pause_unconfirmed"}"#;
        assert_eq!(
            exit_response(reqwest::StatusCode::OK, conflicting),
            ExitOutcome::Rejected(ExitFailure::WorkPauseUnconfirmed)
        );
    }

    fn isolated_exit_response(response: Vec<u8>) -> ExitOutcome {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/api/desktop/exit", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            connection
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            connection
                .set_write_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut input = std::io::BufReader::new(connection.try_clone().unwrap());
            let mut line = String::new();
            input.read_line(&mut line).unwrap();
            assert_eq!(line, "POST /api/desktop/exit HTTP/1.1\r\n");
            loop {
                line.clear();
                assert!(input.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
            }
            let mut body = [0; 2];
            input.read_exact(&mut body).unwrap();
            assert_eq!(&body, b"{}");
            let _ = connection.write_all(&response);
        });
        let result = tauri::async_runtime::block_on(async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap();
            let request = client.post(endpoint).body("{}").build().unwrap();
            execute_exit_request(&client, request).await
        });
        server.join().unwrap();
        result
    }

    #[test]
    fn non_success_http_responses_are_bounded_and_classified_without_raw_body_leaks() {
        let body =
            br#"{"code":"vm_lifecycle_unconfirmed","phase":"suspending","error":"PRIVATE_TOKEN"}"#;
        let response = format!(
            "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        assert_eq!(
            isolated_exit_response([response.as_bytes(), body].concat()),
            ExitOutcome::Rejected(ExitFailure::VMSuspensionUnconfirmed)
        );

        let large = vec![b' '; DESKTOP_RESPONSE_MAX_BYTES + 1];
        let response = format!(
            "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            large.len()
        );
        assert_eq!(
            isolated_exit_response([response.as_bytes(), large.as_slice()].concat()),
            ExitOutcome::Rejected(ExitFailure::Unconfirmed)
        );
        let response = format!(
            "HTTP/1.1 409 Conflict\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n",
            large.len()
        );
        assert_eq!(
            isolated_exit_response(
                [response.as_bytes(), large.as_slice(), b"\r\n0\r\n\r\n"].concat()
            ),
            ExitOutcome::Rejected(ExitFailure::Unconfirmed)
        );
        let response = b"HTTP/1.1 503 Unavailable\r\nContent-Length: 13\r\nConnection: close\r\n\r\nPRIVATE_TOKEN";
        assert_eq!(
            isolated_exit_response(response.to_vec()),
            ExitOutcome::Rejected(ExitFailure::Unconfirmed)
        );
    }

    #[test]
    fn every_registered_language_has_safe_native_exit_reasons() {
        let registry: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../resources/i18n/language-registry.json"))
                .unwrap();
        for entry in registry {
            let language = entry["code"].as_str().unwrap();
            for failure in [
                ExitFailure::Unconfirmed,
                ExitFailure::WorkPauseUnconfirmed,
                ExitFailure::VMSuspensionUnconfirmed,
                ExitFailure::VMOperationBusy,
                ExitFailure::VMIdentityUnverified,
                ExitFailure::VMUnsupported,
                ExitFailure::BackupRunning,
                ExitFailure::BackupUnconfirmed,
                ExitFailure::DesktopBusy,
            ] {
                let message = exit_failure_message(language, failure);
                assert!(message.contains("\n\n"));
                if language != "en" {
                    let english = exit_failure_message("en", failure);
                    let localized: Vec<_> = message.split("\n\n").collect();
                    let source: Vec<_> = english.split("\n\n").collect();
                    assert_ne!(localized[0], source[0]);
                    assert_ne!(localized[1], source[1]);
                }
            }
        }
    }
}
