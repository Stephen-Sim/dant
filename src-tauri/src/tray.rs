use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindow, WindowEvent,
};

const ID: &str = "dant-background";
const PAINT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Status {
    language: String,
    connection: String,
    task: String,
    queued: u16,
}
trait TrayTooltip {
    fn set_tooltip(&self, value: &str) -> tauri::Result<()>;
}
impl<R: tauri::Runtime> TrayTooltip for TrayIcon<R> {
    fn set_tooltip(&self, value: &str) -> tauri::Result<()> {
        self.set_tooltip(Some(value))
    }
}
struct NativeTray<R: tauri::Runtime = tauri::Wry, I: TrayTooltip = TrayIcon<R>> {
    icon: I,
    open: MenuItem<R>,
    progress: MenuItem<R>,
    call_window: MenuItem<R>,
    status: MenuItem<R>,
    exit: MenuItem<R>,
}

struct TrayState {
    call_active: bool,
    call_language: String,
    last: Option<Status>,
    exit_pending: bool,
    displayed_exit_pending: Option<bool>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            call_active: false,
            call_language: "zh".into(),
            last: None,
            exit_pending: false,
            displayed_exit_pending: None,
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

impl<S: TraySurface + ?Sized> TraySurface for Box<S> {
    fn text(&mut self, item: Item, value: &str) -> Result<(), String> {
        (**self).text(item, value)
    }
    fn call_enabled(&mut self, active: bool) -> Result<(), String> {
        (**self).call_enabled(active)
    }
    fn tooltip(&mut self, value: &str) -> Result<(), String> {
        (**self).tooltip(value)
    }
}

impl<R: tauri::Runtime, I: TrayTooltip> TraySurface for NativeTray<R, I> {
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
            .set_tooltip(value)
            .map_err(|_| "The system tray is unavailable".into())
    }
}
#[derive(Default)]
pub struct BackgroundTray {
    ready: AtomicBool,
    exiting: AtomicBool,
    inner: Mutex<Option<Tray<Box<dyn TraySurface + Send>>>>,
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

fn exit_pending_label(language: &str) -> String {
    crate::l10n::text(language, "Exiting dant…", "正在退出 dant…")
}

fn exit_pending_detail(language: &str) -> String {
    crate::l10n::text(
        language,
        "Waiting for work to pause and the VM to suspend; Windows confirmation may be needed.",
        "正在等待任务暂停及虚拟机挂起，可能需要 Windows 确认。",
    )
}

fn exit_pending_status(language: &str) -> String {
    crate::l10n::text(language, "Waiting", "等待")
}

fn exit_window_title(language: &str, pending: bool) -> String {
    if pending {
        crate::l10n::text(language, "dant · Exiting…", "dant · 正在退出…")
    } else {
        "dant".into()
    }
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
    let language = language.map(str::to_string);
    let _ = paint_on_main_thread(app, move |app| {
        let Some(state) = app.try_state::<BackgroundTray>() else {
            return Ok(());
        };
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "The system tray is unavailable")?;
        let Some(tray) = inner.as_mut() else {
            return Ok(());
        };
        call_changed(tray, active, language.as_deref());
        Ok(())
    });
}

// Keep each complete native update in one UI callback. The caller must not hold
// the tray mutex while dispatching or waiting for the callback to finish.
fn paint_on_main_thread<R: tauri::Runtime>(
    app: &AppHandle<R>,
    paint: impl FnOnce(&AppHandle<R>) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    paint_with_timeout(app, paint, PAINT_TIMEOUT)
}

fn paint_with_timeout<R: tauri::Runtime>(
    app: &AppHandle<R>,
    paint: impl FnOnce(&AppHandle<R>) -> Result<(), String> + Send + 'static,
    timeout: std::time::Duration,
) -> Result<(), String> {
    let (result, received) = std::sync::mpsc::channel();
    let queued = std::sync::Arc::new(AtomicBool::new(true));
    let pending = queued.clone();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        // A timed-out callback that has not started must never repaint stale
        // state after a later status or exit result has already been applied.
        if pending.swap(false, Ordering::SeqCst) {
            let _ = result.send(paint(&handle));
        }
    })
    .map_err(|_| "The system tray is unavailable")?;
    match received.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            queued.store(false, Ordering::SeqCst);
            Err("The system tray is unavailable".into())
        }
    }
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
fn exit<R: tauri::Runtime>(app: &AppHandle<R>) {
    crate::lifecycle::request_exit(app);
}
pub fn mark_exiting<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<BackgroundTray>() {
        state.exiting.store(true, Ordering::SeqCst);
    }
}

// Called on the owned asynchronous exit task, never while the UI thread waits
// for the tray's state lock. Native display failures cannot approve an exit.
pub fn exit_pending<R: tauri::Runtime>(app: &AppHandle<R>, pending: bool) {
    if pending {
        restore(app);
    }
    // Retain the requested state even if the UI loop cannot repaint before the
    // deadline. A later status update must clear a failed exit's old display.
    if let Some(state) = app.try_state::<BackgroundTray>() {
        let _ = request_exit_pending(&state.inner, pending);
    }
    let _ = paint_on_main_thread(app, move |app| {
        let language = language(app);
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.set_title(&exit_window_title(&language, pending));
        }
        if let Some(state) = app.try_state::<BackgroundTray>() {
            set_exit_pending(&state.inner, pending, &language)?;
        }
        Ok(())
    });
}

fn request_exit_pending<S>(target: &Mutex<Option<Tray<S>>>, pending: bool) -> Result<(), String> {
    let mut inner = target
        .lock()
        .map_err(|_| "The system tray is unavailable")?;
    if let Some(tray) = inner.as_mut() {
        tray.state.exit_pending = pending;
    }
    Ok(())
}

fn set_exit_pending<S: TraySurface>(
    target: &Mutex<Option<Tray<S>>>,
    pending: bool,
    language: &str,
) -> Result<(), String> {
    let mut inner = target
        .lock()
        .map_err(|_| "The system tray is unavailable")?;
    let Some(tray) = inner.as_mut() else {
        return Ok(());
    };
    tray.state.exit_pending = pending;
    let status = tray.state.last.clone().unwrap_or_else(|| Status {
        language: language.into(),
        connection: "connecting".into(),
        task: "idle".into(),
        queued: 0,
    });
    display_status(tray, status)
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

struct NativeActions<'a, R: tauri::Runtime>(&'a AppHandle<R>);

impl<R: tauri::Runtime> TrayActions for NativeActions<'_, R> {
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

fn menu_event<R: tauri::Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    activate(&NativeActions(app), event.id.as_ref());
}

fn tray_icon_event<R: tauri::Runtime>(app: &AppHandle<R>, event: TrayIconEvent) {
    if left_click(&event) {
        restore(app);
    }
}

struct NativeMenu<R: tauri::Runtime> {
    open: MenuItem<R>,
    progress: MenuItem<R>,
    call_window: MenuItem<R>,
    status: MenuItem<R>,
    exit: MenuItem<R>,
    menu: Menu<R>,
}
fn native_menu<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<NativeMenu<R>> {
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
    Ok(NativeMenu {
        open,
        progress,
        call_window,
        status,
        exit: exit_item,
        menu,
    })
}
pub fn setup<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    setup_using(app, |builder| builder.build(app))
}
fn left_click(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}
fn setup_using<R: tauri::Runtime, I: TrayTooltip + Send + 'static>(
    app: &tauri::App<R>,
    create: impl FnOnce(TrayIconBuilder<R>) -> tauri::Result<I>,
) -> tauri::Result<()> {
    let NativeMenu {
        open,
        progress,
        call_window,
        status,
        exit: exit_item,
        menu,
    } = native_menu(app)?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("default app icon".into()))?
        .clone();
    let builder = TrayIconBuilder::with_id(ID)
        .icon(icon)
        .menu(&menu)
        .tooltip("dant · 连接中")
        .show_menu_on_left_click(false)
        .on_menu_event(menu_event)
        .on_tray_icon_event(|tray, event| tray_icon_event(tray.app_handle(), event));
    let icon = create(builder)?;
    let state = app.state::<BackgroundTray>();
    install_tray(
        &state.ready,
        &state.inner,
        Box::new(NativeTray {
            icon,
            open,
            progress,
            call_window,
            status,
            exit: exit_item,
        }) as Box<dyn TraySurface + Send>,
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
pub fn on_window_event<R: tauri::Runtime>(window: &tauri::Window<R>, event: &WindowEvent) -> bool {
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
    update_status_on_main_thread(&app, window.label(), status)
}

fn update_status_on_main_thread<R: tauri::Runtime>(
    app: &AppHandle<R>,
    label: &str,
    status: Status,
) -> Result<(), String> {
    if label != "main" || !valid(&status) {
        return Err("Invalid background status".into());
    }
    paint_on_main_thread(app, move |app| {
        update_status(&app.state::<BackgroundTray>().inner, "main", status)
    })
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
    display_status(tray, status)
}

fn display_status(tray: &mut Tray<impl TraySurface>, status: Status) -> Result<(), String> {
    if tray.state.last.as_ref() == Some(&status)
        && tray.state.displayed_exit_pending == Some(tray.state.exit_pending)
    {
        return Ok(());
    }
    let (open, progress, mut exit, mut text) = labels(&status);
    let mut tooltip = text.clone();
    if tray.state.exit_pending {
        exit = exit_pending_label(&status.language);
        text = exit_pending_status(&status.language);
        tooltip = exit_pending_detail(&status.language);
    }
    // Any failed native operation leaves the whole display unconfirmed. Even
    // returning to the previous status must then repaint every owned item.
    tray.state.displayed_exit_pending = None;
    tray.surface.text(Item::Open, &open)?;
    tray.surface.text(Item::Progress, &progress)?;
    tray.surface
        .text(Item::CallWindow, &call_window_label(&status.language))?;
    tray.state.call_language = status.language.clone();
    tray.surface.text(Item::Exit, &exit)?;
    tray.surface.text(Item::Status, &text)?;
    tray.surface.tooltip(&format!("dant · {tooltip}"))?;
    tray.state.last = Some(status);
    tray.state.displayed_exit_pending = Some(tray.state.exit_pending);
    Ok(())
}

#[cfg(test)]
#[path = "../../tests/native/rust/tray.rs"]
mod tests;
