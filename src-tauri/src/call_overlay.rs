use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

const LABEL: &str = "call-overlay";
const DOCUMENT_PATH: &str = "/call-overlay.html";
const IDENTIFIER_MAX_BYTES: usize = 128;
const ACTION_HISTORY_LIMIT: usize = 128;
const WINDOW_WIDTH: f64 = 360.0;
const WINDOW_HEIGHT: f64 = 76.0;
const WORK_AREA_INSET: f64 = 16.0;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallState {
    call_id: String,
    status: String,
    connected_at: Option<u64>,
    seconds: u64,
    confirmed: bool,
    running: bool,
    muted: bool,
    can_mute: bool,
    language: String,
    theme: String,
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Area {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}
#[derive(Default)]
struct Inner {
    call: Option<CallState>,
    hidden_for: Option<String>,
    placed_for: Option<String>,
    main_area: Option<Area>,
    seen: VecDeque<String>,
    closing: bool,
}
impl Inner {
    fn update(&mut self, call: Option<CallState>) {
        if self.call.as_ref().map(|value| &value.call_id)
            != call.as_ref().map(|value| &value.call_id)
        {
            self.seen.clear();
            self.hidden_for = None;
        }
        self.call = call;
    }
    fn hide(&mut self, call_id: &str) -> Result<(), String> {
        if self.closing || self.call.as_ref().map(|value| value.call_id.as_str()) != Some(call_id) {
            return Err("The call changed".into());
        }
        self.hidden_for = Some(call_id.to_string());
        Ok(())
    }
    fn visible_call(&self) -> Option<CallState> {
        self.call
            .as_ref()
            .filter(|call| {
                !self.closing && self.hidden_for.as_deref() != Some(call.call_id.as_str())
            })
            .cloned()
    }
    fn show(&mut self, call_id: &str) -> bool {
        if self.closing || self.call.as_ref().map(|value| value.call_id.as_str()) != Some(call_id) {
            return false;
        }
        self.hidden_for = None;
        true
    }
}
#[derive(Default)]
pub struct CallOverlay {
    inner: Mutex<Inner>,
    operation: Mutex<()>,
    scheduled: AtomicBool,
    dirty: AtomicBool,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Action {
    call_id: String,
    action: String,
    request_id: String,
    muted: Option<bool>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= IDENTIFIER_MAX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_: .".contains(&byte))
        && !value.contains(' ')
}
fn valid(value: &CallState) -> bool {
    identifier(&value.call_id)
        && matches!(
            value.status.as_str(),
            "calling" | "talking" | "recovering" | "stopping"
        )
        && crate::l10n::supported(&value.language)
        && matches!(value.theme.as_str(), "light" | "dark")
        && value.seconds <= 9_007_199_254_740
        && value
            .connected_at
            .is_none_or(|at| at <= 8_640_000_000_000_000)
}
fn area(monitor: tauri::Monitor) -> Area {
    let work = monitor.work_area();
    Area {
        x: work.position.x,
        y: work.position.y,
        width: work.size.width,
        height: work.size.height,
        scale: monitor.scale_factor(),
    }
}
fn monitor<R: tauri::Runtime>(window: &WebviewWindow<R>) -> Option<Area> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .map(area)
}
fn position(
    area: Area,
    width: u32,
    height: u32,
    desired: Option<(i32, i32)>,
) -> PhysicalPosition<i32> {
    let inset = (WORK_AREA_INSET * area.scale).round().max(0.0) as i64;
    let left = i64::from(area.x);
    let top = i64::from(area.y);
    let right = left + i64::from(area.width.saturating_sub(width));
    let bottom = top + i64::from(area.height.saturating_sub(height));
    let x_inset = inset.min((right - left) / 2);
    let y_inset = inset.min((bottom - top) / 2);
    let (x, y) = desired
        .map(|(x, y)| (i64::from(x), i64::from(y)))
        .unwrap_or((right - x_inset, bottom - y_inset));
    PhysicalPosition::new(
        x.clamp(left + x_inset, right - x_inset)
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y.clamp(top + y_inset, bottom - y_inset)
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    )
}
trait CallWindow: Clone {
    fn minimized(&self) -> bool;
    fn visible(&self, fallback: bool) -> bool;
    fn monitor(&self) -> Option<Area>;
    fn size(&self) -> Result<(u32, u32), String>;
    fn position(&self) -> Option<PhysicalPosition<i32>>;
    fn move_to(&self, point: PhysicalPosition<i32>) -> Result<(), String>;
    fn hide(&self) -> Result<(), String>;
    fn show(&self) -> Result<(), String>;
    fn focusable(&self, value: bool) -> Result<(), String>;
    fn restore(&self) -> Result<(), String>;
    fn publish(&self, call: &CallState);
    fn destroy(&self);
    fn drag(&self) -> Result<(), String>;
}

#[derive(Clone, Copy)]
enum WindowFailure {
    Size,
    Position,
    Hide,
    Show,
    Focusable(bool),
    Restore,
    MainShow,
    MainFocus,
    Drag,
    Create,
    Action,
}
impl WindowFailure {
    fn message(self) -> &'static str {
        match self {
            Self::Size => "Call window size is unavailable",
            Self::Position => "Call window position is unavailable",
            Self::Hide => "Call window could not be hidden",
            Self::Show | Self::Focusable(false) => "Call window could not be shown",
            Self::Focusable(true) => "Call window controls are unavailable",
            Self::Restore => "The main window could not be restored",
            Self::MainShow => "The main window could not be shown",
            Self::MainFocus => "The main window could not be focused",
            Self::Drag => "Call window dragging is unavailable",
            Self::Create => "Call window could not be created",
            Self::Action => "The call action was not confirmed",
        }
    }
}
fn redacted_result<T>(result: tauri::Result<T>, failure: WindowFailure) -> Result<T, String> {
    result.map_err(|_| failure.message().into())
}

impl<R: tauri::Runtime> CallWindow for WebviewWindow<R> {
    fn minimized(&self) -> bool {
        self.is_minimized().unwrap_or(false)
    }
    fn visible(&self, fallback: bool) -> bool {
        self.is_visible().unwrap_or(fallback)
    }
    fn monitor(&self) -> Option<Area> {
        monitor(self)
    }
    fn size(&self) -> Result<(u32, u32), String> {
        redacted_result(self.outer_size(), WindowFailure::Size)
            .map(|size| (size.width, size.height))
    }
    fn position(&self) -> Option<PhysicalPosition<i32>> {
        self.outer_position().ok()
    }
    fn move_to(&self, point: PhysicalPosition<i32>) -> Result<(), String> {
        redacted_result(self.set_position(point), WindowFailure::Position)
    }
    fn hide(&self) -> Result<(), String> {
        redacted_result(self.hide(), WindowFailure::Hide)
    }
    fn show(&self) -> Result<(), String> {
        redacted_result(self.show(), WindowFailure::Show)
    }
    fn focusable(&self, value: bool) -> Result<(), String> {
        redacted_result(self.set_focusable(value), WindowFailure::Focusable(value))
    }
    fn restore(&self) -> Result<(), String> {
        redacted_result(self.unminimize(), WindowFailure::Restore)?;
        redacted_result(self.show(), WindowFailure::MainShow)?;
        redacted_result(self.set_focus(), WindowFailure::MainFocus)
    }
    fn publish(&self, call: &CallState) {
        let _ = self.emit("dant-call-overlay-state", call);
        let _ = self.set_theme(Some(if call.theme == "dark" {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }));
    }
    fn destroy(&self) {
        let _ = self.destroy();
    }
    fn drag(&self) -> Result<(), String> {
        redacted_result(self.start_dragging(), WindowFailure::Drag)
    }
}

trait OverlayHost {
    type Window: CallWindow;

    fn window(&self, label: &str) -> Option<Self::Window>;
    fn create_overlay(&self) -> Result<Self::Window, String>;
    fn action(&self, action: Action) -> Result<(), String>;
    fn schedule(&self);
    fn tray_changed(&self, active: bool, language: Option<&str>);
}

struct NativeOverlay<'a, R: tauri::Runtime>(&'a AppHandle<R>);

impl<R: tauri::Runtime> OverlayHost for NativeOverlay<'_, R> {
    type Window = WebviewWindow<R>;

    fn window(&self, label: &str) -> Option<Self::Window> {
        self.0.get_webview_window(label)
    }
    fn create_overlay(&self) -> Result<Self::Window, String> {
        // Creating WebView2 from a synchronous window event can deadlock. The
        // caller runs on an async-runtime worker, never the UI thread.
        let result =
            WebviewWindowBuilder::new(self.0, LABEL, WebviewUrl::App("call-overlay.html".into()))
                .title("dant call")
                .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
                .decorations(false)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .closable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .focused(false)
                .transparent(true)
                .shadow(true)
                .on_navigation(allowed_navigation)
                .build();
        redacted_result(result, WindowFailure::Create)
    }
    fn action(&self, action: Action) -> Result<(), String> {
        redacted_result(
            self.0.emit_to("main", "dant-call-overlay-action", action),
            WindowFailure::Action,
        )
    }
    fn schedule(&self) {
        schedule(self.0);
    }
    fn tray_changed(&self, active: bool, language: Option<&str>) {
        crate::tray::call_window_changed(self.0, active, language);
    }
}

fn clamp(window: &impl CallWindow, area: Area, initial: bool) -> Result<(), String> {
    let (width, height) = window.size()?;
    let desired = if initial {
        None
    } else {
        window.position().map(|point| (point.x, point.y))
    };
    let point = position(area, width, height, desired);
    if window.position() != Some(point) {
        window.move_to(point)?;
    }
    Ok(())
}
// Tauri's packaged origins are fixed SDK origins. Development navigation must
// match the canonical local origin; caller-provided ports never reach this gate.
fn allowed_navigation(url: &tauri::Url) -> bool {
    url.path() == DOCUMENT_PATH
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
            || (url.scheme() == "http"
                && url.host_str() == Some(crate::protocol::loopback_host())
                && url.port_or_known_default() == Some(crate::protocol::dev_endpoint().port())))
}

fn sync(managed: &CallOverlay, host: &impl OverlayHost) -> Result<(), String> {
    let _operation = managed
        .operation
        .lock()
        .map_err(|_| "Call window is unavailable")?;
    let Some(main) = host.window("main") else {
        return Ok(());
    };
    let background = main.minimized() || !main.visible(true);
    let foreground_area = if background { None } else { main.monitor() };
    let call = {
        let mut inner = managed
            .inner
            .lock()
            .map_err(|_| "Call window is unavailable")?;
        if let Some(area) = foreground_area {
            inner.main_area = Some(area);
        }
        inner.visible_call()
    };
    if !background || call.is_none() {
        if let Some(window) = host.window(LABEL) {
            let _ = window.hide();
        }
        return Ok(());
    }
    let call = call.unwrap();
    let window = if let Some(window) = host.window(LABEL) {
        window
    } else {
        host.create_overlay()?
    };
    let (initial, main_area) = {
        let inner = managed
            .inner
            .lock()
            .map_err(|_| "Call window is unavailable")?;
        (
            inner.placed_for.as_deref() != Some(call.call_id.as_str()),
            inner.main_area,
        )
    };
    let work = if initial {
        main_area.or_else(|| main.monitor())
    } else {
        window.monitor().or(main_area)
    };
    if let Some(work) = work {
        clamp(&window, work, initial)?;
    }
    // Recheck after window creation: restoring or ending a call must not leave
    // a late-created overlay visible over the desktop.
    let current = {
        let mut inner = managed
            .inner
            .lock()
            .map_err(|_| "Call window is unavailable")?;
        if inner.visible_call().as_ref().map(|value| &value.call_id) != Some(&call.call_id) {
            false
        } else {
            inner.placed_for = Some(call.call_id.clone());
            true
        }
    };
    if !current || (!main.minimized() && main.visible(true)) {
        let _ = window.hide();
        return Ok(());
    }
    window.publish(&call);
    if !window.visible(false) {
        // Creation's focused(false) does not govern later SW_SHOW calls.
        // Show without activating over the app the user is currently using.
        window.focusable(false)?;
        let shown = window.show();
        let focusable = window.focusable(true);
        shown?;
        focusable?;
    }
    Ok(())
}
fn schedule<R: tauri::Runtime>(app: &AppHandle<R>) {
    let managed = app.state::<CallOverlay>();
    if !managed.request_sync() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let managed = app.state::<CallOverlay>();
        managed.drain_sync(|| {
            let _ = sync(&managed, &NativeOverlay(&app));
        });
    });
}
impl CallOverlay {
    fn request_sync(&self) -> bool {
        self.dirty.store(true, Ordering::SeqCst);
        !self.scheduled.swap(true, Ordering::SeqCst)
    }

    fn drain_sync(&self, mut synchronize: impl FnMut()) {
        loop {
            self.dirty.store(false, Ordering::SeqCst);
            synchronize();
            self.scheduled.store(false, Ordering::SeqCst);
            if !self.dirty.load(Ordering::SeqCst) || self.scheduled.swap(true, Ordering::SeqCst) {
                break;
            }
        }
    }
}
pub fn setup<R: tauri::Runtime>(app: &tauri::App<R>) {
    if let Some(main) = app.get_webview_window("main") {
        capture_main_area(&app.state::<CallOverlay>(), &main);
    }
}

fn capture_main_area(managed: &CallOverlay, main: &impl CallWindow) {
    if let Some(area) = main.monitor() {
        if let Ok(mut inner) = managed.inner.lock() {
            inner.main_area = Some(area);
        }
    }
}
pub fn visibility_changed<R: tauri::Runtime>(app: &AppHandle<R>) {
    if app.try_state::<CallOverlay>().is_some() {
        schedule(app);
    }
}
pub fn show_call_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    let managed = app.state::<CallOverlay>();
    let expected = managed.inner.lock().ok().and_then(|inner| {
        if inner.closing {
            None
        } else {
            inner.call.as_ref().map(|call| call.call_id.clone())
        }
    });
    let Some(expected) = expected else { return };
    // Tray callbacks run on the UI thread. Do not wait there for a sync that
    // may itself be waiting for a native window operation on the same thread.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let managed = app.state::<CallOverlay>();
        show_expected(&managed, &NativeOverlay(&app), &expected);
    });
}

fn show_expected(managed: &CallOverlay, host: &impl OverlayHost, expected: &str) {
    let Ok(_operation) = managed.operation.lock() else {
        return;
    };
    let changed = managed
        .inner
        .lock()
        .map(|mut inner| inner.show(expected))
        .unwrap_or(false);
    if changed {
        host.schedule();
    }
}

#[derive(Clone, Copy)]
enum Change {
    Close,
    Destroy,
    Geometry,
    Move,
    Focus,
    Other,
}

pub fn on_window_event<R: tauri::Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    let app = window.app_handle();
    let change = match event {
        WindowEvent::CloseRequested { .. } => Change::Close,
        WindowEvent::Destroyed => Change::Destroy,
        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => Change::Geometry,
        WindowEvent::Moved(_) => Change::Move,
        WindowEvent::Focused(_) => Change::Focus,
        _ => Change::Other,
    };
    if window_changed(
        &app.state::<CallOverlay>(),
        &NativeOverlay(app),
        window.label(),
        change,
    ) {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
    }
}

fn window_changed(
    managed: &CallOverlay,
    host: &impl OverlayHost,
    label: &str,
    change: Change,
) -> bool {
    if label == "main" {
        if matches!(change, Change::Close | Change::Destroy) {
            if let Ok(mut inner) = managed.inner.lock() {
                inner.closing = true;
                inner.call = None;
            }
            if let Some(overlay) = host.window(LABEL) {
                overlay.destroy();
            }
        } else if matches!(change, Change::Geometry | Change::Move | Change::Focus) {
            host.schedule();
        }
    } else if label == LABEL {
        if matches!(change, Change::Close) {
            if let Ok(mut inner) = managed.inner.lock() {
                if let Some(call_id) = inner.call.as_ref().map(|value| value.call_id.clone()) {
                    let _ = inner.hide(&call_id);
                }
            }
            if let Some(window) = host.window(LABEL) {
                let _ = window.hide();
            }
            host.schedule();
            return true;
        }
        if matches!(change, Change::Geometry) {
            host.schedule();
        }
    }
    false
}
#[tauri::command]
pub async fn call_overlay_update<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: Option<CallState>,
) -> Result<(), String> {
    update(
        &app.state::<CallOverlay>(),
        &NativeOverlay(&app),
        window.label(),
        state,
    )
}

fn update(
    managed: &CallOverlay,
    host: &impl OverlayHost,
    label: &str,
    state: Option<CallState>,
) -> Result<(), String> {
    if label != "main" || state.as_ref().is_some_and(|value| !valid(value)) {
        return Err("Invalid call window state".into());
    }
    let language = state.as_ref().map(|value| value.language.clone());
    let active = state.is_some();
    {
        let _operation = managed
            .operation
            .lock()
            .map_err(|_| "Call window is unavailable")?;
        let mut inner = managed
            .inner
            .lock()
            .map_err(|_| "Call window is unavailable")?;
        if inner.closing {
            return Err("Call window has stopped".into());
        }
        inner.update(state);
    }
    host.tray_changed(active, language.as_deref());
    host.schedule();
    Ok(())
}
#[tauri::command]
pub fn call_overlay_get<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Option<CallState>, String> {
    get(&app.state::<CallOverlay>(), window.label())
}

fn get(managed: &CallOverlay, label: &str) -> Result<Option<CallState>, String> {
    if label != LABEL {
        return Err("Invalid call window".into());
    }
    managed
        .inner
        .lock()
        .map(|inner| inner.call.clone())
        .map_err(|_| "Call window is unavailable".into())
}
#[tauri::command]
pub async fn call_overlay_action<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    call_id: String,
    action: String,
    request_id: String,
    muted: Option<bool>,
) -> Result<(), String> {
    act(
        &app.state::<CallOverlay>(),
        &NativeOverlay(&app),
        window.label(),
        Action {
            call_id,
            action,
            request_id,
            muted,
        },
    )
}

fn act(
    managed: &CallOverlay,
    host: &impl OverlayHost,
    label: &str,
    request: Action,
) -> Result<(), String> {
    let Action {
        call_id,
        action,
        request_id,
        muted,
    } = &request;
    if label != LABEL
        || !identifier(&call_id)
        || !identifier(&request_id)
        || !matches!(action.as_str(), "mute" | "hangup" | "restore" | "hide")
    {
        return Err("Invalid call window action".into());
    }
    let _operation = managed
        .operation
        .lock()
        .map_err(|_| "Call window is unavailable")?;
    {
        let mut inner = managed
            .inner
            .lock()
            .map_err(|_| "Call window is unavailable")?;
        let call = inner
            .call
            .as_ref()
            .filter(|value| &value.call_id == call_id)
            .ok_or("The call changed")?;
        if inner.closing || (action == "mute" && (!call.can_mute || muted.is_none())) {
            return Err("The call action is unavailable".into());
        }
        if inner.seen.contains(&request_id) {
            return Ok(());
        }
        inner.seen.push_back(request_id.clone());
        while inner.seen.len() > ACTION_HISTORY_LIMIT {
            inner.seen.pop_front();
        }
        if action == "hide" {
            inner.hide(&call_id)?;
        }
    }
    if action == "hide" {
        // Hiding changes native visibility only. Never send it to the media or
        // task handler, and retain the call ID across ordinary status updates.
        let hidden = host
            .window(LABEL)
            .map(|overlay| overlay.hide())
            .unwrap_or(Ok(()));
        host.schedule();
        return hidden;
    }
    if action == "restore" {
        if let Some(main) = host.window("main") {
            main.restore()?;
        }
        host.schedule();
    }
    host.action(request)
}
#[tauri::command]
pub async fn call_overlay_drag<R: tauri::Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    let expected = drag_allowed(&app.state::<CallOverlay>(), window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        drag_current(&app.state::<CallOverlay>(), &window, &expected)
    })
    .await
    .map_err(|_| "Call window dragging stopped".to_string())?
}

fn drag_allowed(managed: &CallOverlay, label: &str) -> Result<String, String> {
    if label != LABEL {
        return Err("Invalid call window".into());
    }
    managed
        .inner
        .lock()
        .ok()
        .and_then(|inner| {
            inner
                .call
                .as_ref()
                .filter(|_| !inner.closing)
                .map(|call| call.call_id.clone())
        })
        .ok_or_else(|| "The call ended".into())
}

fn drag_current(
    managed: &CallOverlay,
    window: &impl CallWindow,
    expected: &str,
) -> Result<(), String> {
    if drag_allowed(managed, LABEL)? != expected {
        return Err("The call changed".into());
    }
    drag(window)
}

fn drag(window: &impl CallWindow) -> Result<(), String> {
    window.drag()?;
    if let Some(area) = window.monitor() {
        clamp(window, area, false)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../tests/native/rust/call_overlay.rs"]
mod tests;
