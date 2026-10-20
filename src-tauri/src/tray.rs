use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindow, WindowEvent,
};

const ID: &str = "dant-background";
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Status {
    language: String,
    connection: String,
    task: String,
    queued: u16,
}
struct NativeTray {
    icon: TrayIcon,
    open: MenuItem<tauri::Wry>,
    progress: MenuItem<tauri::Wry>,
    call_window: MenuItem<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    exit: MenuItem<tauri::Wry>,
}

struct TrayState {
    call_active: bool,
    call_language: String,
    last: Option<Status>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            call_active: false,
            call_language: "zh".into(),
            last: None,
        }
    }
}

struct Tray<S> {
    surface: S,
    state: TrayState,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Item {
    Open,
    Progress,
    CallWindow,
    Status,
    Exit,
}

trait TraySurface {
    fn text(&mut self, item: Item, value: &str) -> Result<(), String>;
    fn call_enabled(&mut self, active: bool) -> Result<(), String>;
    fn tooltip(&mut self, value: &str) -> Result<(), String>;
}

impl TraySurface for NativeTray {
    fn text(&mut self, item: Item, value: &str) -> Result<(), String> {
        let item = match item {
            Item::Open => &self.open,
            Item::Progress => &self.progress,
            Item::CallWindow => &self.call_window,
            Item::Status => &self.status,
            Item::Exit => &self.exit,
        };
        item.set_text(value)
            .map_err(|_| "The system tray is unavailable".into())
    }

    fn call_enabled(&mut self, active: bool) -> Result<(), String> {
        self.call_window
            .set_enabled(active)
            .map_err(|_| "The system tray is unavailable".into())
    }

    fn tooltip(&mut self, value: &str) -> Result<(), String> {
        self.icon
            .set_tooltip(Some(value))
            .map_err(|_| "The system tray is unavailable".into())
    }
}
#[derive(Default)]
pub struct BackgroundTray {
    ready: AtomicBool,
    exiting: AtomicBool,
    inner: Mutex<Option<Tray<NativeTray>>>,
}

fn valid(value: &Status) -> bool {
    crate::l10n::supported(&value.language)
        && matches!(
            value.connection.as_str(),
            "online" | "offline" | "connecting"
        )
        && matches!(
            value.task.as_str(),
            "idle" | "running" | "background" | "waiting_user" | "pausing" | "unknown"
        )
        && value.queued <= 999
}
fn should_hide(ready: bool, exiting: bool, main: bool) -> bool {
    ready && !exiting && main
}
fn call_window_label(language: &str) -> String {
    crate::l10n::text(language, "Show call window", "显示通话窗口")
}
fn labels(value: &Status) -> (String, String, String, String) {
    let (english, chinese) = if value.connection != "online" && value.task != "idle" {
        ("Work status unconfirmed", "任务状态待确认")
    } else {
        match value.task.as_str() {
            "running" => ("Working", "正在工作"),
            "background" => ("Working in background", "后台执行中"),
            "waiting_user" => ("Waiting for your reply", "等待你回复"),
            "pausing" => ("Pausing work", "正在暂停"),
            "unknown" => ("Work outcome unconfirmed", "任务结果待确认"),
            _ => {
                if value.connection == "online" {
                    ("Online", "在线")
                } else if value.connection == "connecting" {
                    ("Connecting", "连接中")
                } else {
                    ("Offline", "离线")
                }
            }
        }
    };
    let mut state = crate::l10n::text(&value.language, english, chinese);
    if value.queued > 0 {
        let queued = crate::l10n::text(&value.language, "{count} queued", "{count} 项排队")
            .replace("{count}", &value.queued.to_string());
        state = format!("{state} · {queued}");
    }
    (
        crate::l10n::text(&value.language, "Open dant", "打开 dant"),
        crate::l10n::text(&value.language, "Work progress", "任务进度"),
        crate::l10n::text(&value.language, "Exit dant", "退出 dant"),
        state,
    )
}

pub fn restore<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        crate::call_overlay::visibility_changed(app);
    }
}
pub fn call_window_changed<R: tauri::Runtime>(
    app: &AppHandle<R>,
    active: bool,
    language: Option<&str>,
) {
    let Some(state) = app.try_state::<BackgroundTray>() else {
        return;
    };
    let Ok(mut inner) = state.inner.lock() else {
        return;
    };
    let Some(tray) = inner.as_mut() else { return };
    call_changed(tray, active, language);
}

fn call_changed(tray: &mut Tray<impl TraySurface>, active: bool, language: Option<&str>) {
    let language = language
        .or_else(|| {
            tray.state
                .last
                .as_ref()
                .map(|value| value.language.as_str())
        })
        .unwrap_or(&tray.state.call_language)
        .to_string();
    if tray.state.call_active != active {
        if tray.surface.call_enabled(active).is_ok() {
            tray.state.call_active = active;
        }
    }
    if tray.state.call_language != language {
        if tray
            .surface
            .text(Item::CallWindow, &call_window_label(&language))
            .is_ok()
        {
            tray.state.call_language = language;
        }
    }
}
fn exit(app: &AppHandle) {
    crate::lifecycle::request_exit(app);
}
pub fn mark_exiting<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<BackgroundTray>() {
        state.exiting.store(true, Ordering::SeqCst);
    }
}
pub fn language<R: tauri::Runtime>(app: &AppHandle<R>) -> String {
    app.try_state::<BackgroundTray>()
        .and_then(|state| {
            state.inner.lock().ok().and_then(|inner| {
                inner.as_ref().and_then(|tray| {
                    tray.state
                        .last
                        .as_ref()
                        .map(|status| status.language.clone())
                })
            })
        })
        .unwrap_or_else(|| "en".into())
}

trait TrayActions {
    fn restore(&self);
    fn progress(&self);
    fn call_window(&self);
    fn exit(&self);
}

struct NativeActions<'a>(&'a AppHandle);

impl TrayActions for NativeActions<'_> {
    fn restore(&self) {
        restore(self.0);
    }
    fn progress(&self) {
        let _ = self.0.emit_to("main", "dant-tray-progress", ());
    }
    fn call_window(&self) {
        crate::call_overlay::show_call_window(self.0);
    }
    fn exit(&self) {
        exit(self.0);
    }
}

fn activate(actions: &impl TrayActions, item: &str) {
    match item {
        "dant-open" => actions.restore(),
        "dant-progress" => {
            actions.restore();
            actions.progress();
        }
        "dant-call-window" => actions.call_window(),
        "dant-exit" => actions.exit(),
        _ => {}
    }
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "dant-open", "打开 dant", true, None::<&str>)?;
    let progress = MenuItem::with_id(app, "dant-progress", "任务进度", true, None::<&str>)?;
    let call_window = MenuItem::with_id(
        app,
        "dant-call-window",
        call_window_label("zh"),
        false,
        None::<&str>,
    )?;
    let status = MenuItem::with_id(app, "dant-status", "连接中", false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit_item = MenuItem::with_id(app, "dant-exit", "退出 dant", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &progress,
            &call_window,
            &status,
            &separator,
            &exit_item,
        ],
    )?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("default app icon".into()))?
        .clone();
    let icon = TrayIconBuilder::with_id(ID)
        .icon(icon)
        .menu(&menu)
        .tooltip("dant · 连接中")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| activate(&NativeActions(app), event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore(tray.app_handle());
            }
        })
        .build(app)?;
    let state = app.state::<BackgroundTray>();
    install_tray(
        &state.ready,
        &state.inner,
        NativeTray {
            icon,
            open,
            progress,
            call_window,
            status,
            exit: exit_item,
        },
    );
    Ok(())
}

fn install_tray<S>(ready: &AtomicBool, target: &Mutex<Option<Tray<S>>>, surface: S) {
    *target.lock().unwrap() = Some(Tray {
        surface,
        state: TrayState::default(),
    });
    ready.store(true, Ordering::SeqCst);
}
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) -> bool {
    let Some(state) = window.app_handle().try_state::<BackgroundTray>() else {
        return false;
    };
    if let WindowEvent::CloseRequested { api, .. } = event {
        if intercept_close(
            state.ready.load(Ordering::SeqCst),
            state.exiting.load(Ordering::SeqCst),
            window.label(),
            || window.hide().is_ok(),
        ) {
            api.prevent_close();
            crate::call_overlay::visibility_changed(window.app_handle());
            return true;
        }
    }
    // If creating the tray or hiding the window fails, ordinary close remains
    // available so the user is never left with an inaccessible background app.
    false
}

fn intercept_close(ready: bool, exiting: bool, label: &str, hide: impl FnOnce() -> bool) -> bool {
    should_hide(ready, exiting, label == "main") && hide()
}

#[tauri::command]
pub async fn tray_status_update<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    status: Status,
) -> Result<(), String> {
    update_status(&app.state::<BackgroundTray>().inner, window.label(), status)
}

fn update_status<S: TraySurface>(
    target: &Mutex<Option<Tray<S>>>,
    label: &str,
    status: Status,
) -> Result<(), String> {
    if label != "main" || !valid(&status) {
        return Err("Invalid background status".into());
    }
    let mut inner = target
        .lock()
        .map_err(|_| "The system tray is unavailable")?;
    let Some(tray) = inner.as_mut() else {
        return Ok(());
    };
    if tray.state.last.as_ref() == Some(&status) {
        return Ok(());
    }
    let (open, progress, exit, text) = labels(&status);
    tray.surface.text(Item::Open, &open)?;
    tray.surface.text(Item::Progress, &progress)?;
    tray.surface
        .text(Item::CallWindow, &call_window_label(&status.language))?;
    tray.state.call_language = status.language.clone();
    tray.surface.text(Item::Exit, &exit)?;
    tray.surface.text(Item::Status, &text)?;
    tray.surface.tooltip(&format!("dant · {text}"))?;
    tray.state.last = Some(status);
    Ok(())
}

#[cfg(test)]
#[path = "../../tests/native/rust/tray.rs"]
mod tests;
