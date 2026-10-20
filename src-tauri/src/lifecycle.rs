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
    !value.is_empty()
        && value.len() <= crate::protocol::SESSION_TOKEN_MAX_BYTES
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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
        DesktopAction::Open => crate::protocol::api_url("desktop/open"),
        DesktopAction::Exit => crate::protocol::api_url("desktop/exit"),
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
        crate::transport::local_json(crate::protocol::session_path(), None, None)
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
            crate::transport::local_json(crate::protocol::session_path(), None, None)
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
#[path = "../../tests/native/rust/lifecycle.rs"]
mod tests;
