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

#[derive(serde::Deserialize)]
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

struct ExitEvidence {
    ok: bool,
    work_paused: bool,
    vm_suspended: bool,
    unsupported: bool,
    not_configured: bool,
}

impl ExitEvidence {
    fn from_body(body: &ExitBody) -> Self {
        Self {
            ok: body.ok == Some(true),
            work_paused: body.work_paused == Some(true),
            vm_suspended: body.vm_suspended == Some(true),
            unsupported: body.unsupported == Some(true),
            not_configured: body.not_configured == Some(true),
        }
    }

    fn from_value(value: &serde_json::Value) -> Self {
        let explicit = |field| value.get(field).and_then(serde_json::Value::as_bool) == Some(true);
        Self {
            ok: explicit("ok"),
            work_paused: explicit("workPaused"),
            vm_suspended: explicit("vmSuspended"),
            unsupported: explicit("unsupported"),
            not_configured: explicit("notConfigured"),
        }
    }

    fn confirmed(&self) -> bool {
        self.ok && self.work_paused && (self.vm_suspended || self.unsupported)
    }

    fn unsupported_notice(&self) -> bool {
        self.unsupported && !self.not_configured
    }
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

    let evidence = ExitEvidence::from_body(&body);
    if status.is_success() && body.code.is_none() && evidence.confirmed() {
        return ExitOutcome::Confirmed {
            unsupported_notice: evidence.unsupported_notice(),
        };
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

trait DesktopPlatform<R: tauri::Runtime>: Send + Sync {
    fn session(&self) -> Option<serde_json::Value>;
    fn endpoint(&self) -> std::net::SocketAddr;
    fn notice(&self, message: &str);
    fn exit(&self, app: &AppHandle<R>);
}
#[derive(Default)]
struct NativeDesktopPlatform {
    link: crate::transport::ControllerLink,
}
impl<R: tauri::Runtime> DesktopPlatform<R> for NativeDesktopPlatform {
    fn session(&self) -> Option<serde_json::Value> {
        self.link.json(crate::protocol::session_path(), None, None)
    }
    fn endpoint(&self) -> std::net::SocketAddr {
        crate::protocol::controller_endpoint()
    }
    fn notice(&self, message: &str) {
        crate::native_dialog::warning(&crate::native_dialog::NativeDialog, "dant", message);
    }
    fn exit(&self, app: &AppHandle<R>) {
        app.exit(0);
    }
}
pub struct DesktopControl<R: tauri::Runtime>(std::sync::Arc<dyn DesktopPlatform<R>>);
impl<R: tauri::Runtime> Default for DesktopControl<R> {
    fn default() -> Self {
        Self(std::sync::Arc::new(NativeDesktopPlatform::default()))
    }
}
fn control<R: tauri::Runtime>(app: &AppHandle<R>) -> std::sync::Arc<dyn DesktopPlatform<R>> {
    std::sync::Arc::clone(&app.state::<DesktopControl<R>>().0)
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= crate::protocol::SESSION_TOKEN_MAX_BYTES
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
pub(crate) fn confirmed(value: &serde_json::Value) -> bool {
    ExitEvidence::from_value(value).confirmed()
}
fn desktop_open_request(
    client: &reqwest::Client,
    session: &serde_json::Value,
    endpoint: std::net::SocketAddr,
) -> Option<reqwest::Request> {
    desktop_request(client, session, DesktopAction::Open, endpoint)
}

fn desktop_request(
    client: &reqwest::Client,
    session: &serde_json::Value,
    action: DesktopAction,
    endpoint: std::net::SocketAddr,
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
    let route = match action {
        DesktopAction::Open => "desktop/open",
        DesktopAction::Exit => "desktop/exit",
    };
    client
        .post(format!(
            "http://{endpoint}{}/{route}",
            crate::protocol::api_prefix()
        ))
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
async fn open_controller_request<R: tauri::Runtime>(
    host: std::sync::Arc<dyn DesktopPlatform<R>>,
) -> bool {
    let session_host = std::sync::Arc::clone(&host);
    let session = tauri::async_runtime::spawn_blocking(move || session_host.session())
        .await
        .ok()
        .flatten();
    let Ok(client) = desktop_client() else {
        return false;
    };
    open_request_with(session.as_ref(), &client, host.endpoint(), |request| {
        client.execute(request)
    })
    .await
}

async fn open_request_with<
    F: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
>(
    session: Option<&serde_json::Value>,
    client: &reqwest::Client,
    endpoint: std::net::SocketAddr,
    send: impl FnOnce(reqwest::Request) -> F,
) -> bool {
    let Some(request) = session.and_then(|session| desktop_open_request(client, session, endpoint))
    else {
        return false;
    };
    let Ok(mut response) = send(request).await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    desktop_response_bytes(&mut response)
        .await
        .is_some_and(|bytes| desktop_open_confirmed(&bytes))
}
pub fn approved<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<DesktopExit>()
        .is_some_and(|state| state.approved.load(Ordering::SeqCst))
}

/// An external controller outlives the native process. Reopening the app must ask
/// that same controller to restore the VM, without resuming paused task records.
pub fn open_existing_controller<R: tauri::Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let host = control(&app);
    tauri::async_runtime::spawn(async move {
        if open_controller_request(std::sync::Arc::clone(&host)).await {
            return;
        }
        crate::tray::restore(&app);
        let _ = app.emit_to("main", "dant-open-failed", ());
        let message = crate::l10n::text(&crate::tray::language(&app),
            "The work computer could not be restored. dant remains open. Check Work computer before trying again.",
            "未能恢复工作电脑。dant 保持打开，请检查工作电脑后重试。");
        host.notice(&message);
    });
}

/// Called only after the controller's installation lease has confirmed paused
/// work and suspended the VM. The helper's process handoff must not send it twice.
pub fn prepared_update_exit<R: tauri::Runtime>(app: &AppHandle<R>) {
    prepared_update_exit_using(app, || control(app).exit(app));
}
fn prepared_update_exit_using<R: tauri::Runtime>(app: &AppHandle<R>, exit: impl FnOnce()) {
    let Some(state) = app.try_state::<DesktopExit>() else {
        return;
    };
    state.approved.store(true, Ordering::SeqCst);
    crate::tray::mark_exiting(app);
    exit();
}

trait DesktopEffects {
    async fn exit_request(&self) -> ExitOutcome;
    fn language(&self) -> String;
    fn restore(&self);
    fn failed(&self);
    fn notice(&self, message: &str);
    fn exit(&self);
}

struct NativeDesktop<'a, R: tauri::Runtime>(&'a AppHandle<R>);

impl<R: tauri::Runtime> DesktopEffects for NativeDesktop<'_, R> {
    async fn exit_request(&self) -> ExitOutcome {
        let host = control(self.0);
        let session_host = std::sync::Arc::clone(&host);
        let session = tauri::async_runtime::spawn_blocking(move || session_host.session())
            .await
            .ok()
            .flatten();
        let Ok(client) = desktop_client() else {
            return ExitOutcome::Rejected(ExitFailure::Unconfirmed);
        };
        let Some(request) = session.as_ref().and_then(|session| {
            desktop_request(&client, session, DesktopAction::Exit, host.endpoint())
        }) else {
            return ExitOutcome::Rejected(ExitFailure::Unconfirmed);
        };
        execute_exit_request(&client, request).await
    }
    fn language(&self) -> String {
        crate::tray::language(self.0)
    }
    fn restore(&self) {
        crate::tray::restore(self.0);
    }
    fn failed(&self) {
        let _ = self.0.emit_to("main", "dant-exit-failed", ());
    }
    fn notice(&self, message: &str) {
        control(self.0).notice(message);
    }
    fn exit(&self) {
        crate::tray::mark_exiting(self.0);
        control(self.0).exit(self.0);
    }
}

async fn finish_exit(state: &DesktopExit, host: &impl DesktopEffects) {
    let response = host.exit_request().await;
    state.pending.store(false, Ordering::SeqCst);
    match response {
        ExitOutcome::Confirmed { unsupported_notice } => {
            if unsupported_notice {
                host.notice(&crate::l10n::text(&host.language(),
                "Work is paused. This computer connection does not provide a verified identity for suspending the whole virtual machine.",
                "任务已暂停。此电脑连接缺少可验证的虚拟机管理信息，dant 无法挂起整台虚拟机。"));
            }
            state.approved.store(true, Ordering::SeqCst);
            host.exit();
        }
        ExitOutcome::Rejected(failure) => {
            host.restore();
            host.failed();
            host.notice(&exit_failure_message(&host.language(), failure));
        }
    }
}
pub fn request_exit<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<DesktopExit>() else {
        return;
    };
    if state.approved.load(Ordering::SeqCst) {
        control(app).exit(app);
        return;
    }
    if state.pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<DesktopExit>() else {
            return;
        };
        finish_exit(&state, &NativeDesktop(&app)).await;
    });
}

#[cfg(test)]
#[path = "../../tests/native/rust/lifecycle.rs"]
mod tests;
