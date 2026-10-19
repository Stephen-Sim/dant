use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, sync::{Mutex, atomic::{AtomicBool, Ordering}}};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const LABEL: &str = "call-overlay";
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallState {
    call_id: String, status: String, connected_at: Option<u64>, seconds: u64,
    confirmed: bool, running: bool, muted: bool, can_mute: bool, language: String, theme: String,
}
#[derive(Clone, Copy, Debug)]
struct Area { x: i32, y: i32, width: u32, height: u32, scale: f64 }
#[derive(Default)]
struct Inner { call: Option<CallState>, hidden_for: Option<String>, placed_for: Option<String>, main_area: Option<Area>, seen: VecDeque<String>, closing: bool }
impl Inner {
    fn update(&mut self, call: Option<CallState>) {
        if self.call.as_ref().map(|value| &value.call_id) != call.as_ref().map(|value| &value.call_id) { self.seen.clear(); self.hidden_for = None; }
        self.call = call;
    }
    fn hide(&mut self, call_id: &str) -> Result<(), String> {
        if self.closing || self.call.as_ref().map(|value| value.call_id.as_str()) != Some(call_id) { return Err("The call changed".into()) }
        self.hidden_for = Some(call_id.to_string()); Ok(())
    }
    fn visible_call(&self) -> Option<CallState> {
        self.call.as_ref().filter(|call| !self.closing && self.hidden_for.as_deref() != Some(call.call_id.as_str())).cloned()
    }
    fn show(&mut self, call_id: &str) -> bool {
        if self.closing || self.call.as_ref().map(|value| value.call_id.as_str()) != Some(call_id) { return false }
        self.hidden_for = None; true
    }
}
#[derive(Default)]
pub struct CallOverlay { inner: Mutex<Inner>, operation: Mutex<()>, scheduled: AtomicBool, dirty: AtomicBool }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Action { call_id: String, action: String, request_id: String, muted: Option<bool> }

fn identifier(value: &str) -> bool { !value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_: .".contains(&byte)) && !value.contains(' ') }
fn valid(value: &CallState) -> bool {
    identifier(&value.call_id) && matches!(value.status.as_str(), "calling" | "talking" | "recovering" | "stopping")
        && crate::l10n::supported(&value.language) && matches!(value.theme.as_str(), "light" | "dark")
        && value.seconds <= 9_007_199_254_740 && value.connected_at.is_none_or(|at| at <= 8_640_000_000_000_000)
}
fn area(monitor: tauri::Monitor) -> Area { let work = monitor.work_area(); Area { x: work.position.x, y: work.position.y, width: work.size.width, height: work.size.height, scale: monitor.scale_factor() } }
fn monitor(window: &WebviewWindow) -> Option<Area> { window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten()).map(area) }
fn position(area: Area, width: u32, height: u32, desired: Option<(i32, i32)>) -> PhysicalPosition<i32> {
    let inset = (16.0 * area.scale).round().max(0.0) as i64;
    let left = i64::from(area.x); let top = i64::from(area.y);
    let right = left + i64::from(area.width.saturating_sub(width)); let bottom = top + i64::from(area.height.saturating_sub(height));
    let x_inset = inset.min((right - left) / 2); let y_inset = inset.min((bottom - top) / 2);
    let (x, y) = desired.map(|(x, y)| (i64::from(x), i64::from(y))).unwrap_or((right - x_inset, bottom - y_inset));
    PhysicalPosition::new(x.clamp(left + x_inset, right - x_inset).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y.clamp(top + y_inset, bottom - y_inset).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32)
}
fn clamp(window: &WebviewWindow, area: Area, initial: bool) -> Result<(), String> {
    let size = window.outer_size().map_err(|_| "Call window size is unavailable")?;
    let desired = if initial { None } else { window.outer_position().ok().map(|point| (point.x, point.y)) };
    let point = position(area, size.width, size.height, desired);
    if window.outer_position().ok() != Some(point) { window.set_position(point).map_err(|_| "Call window position is unavailable")?; }
    Ok(())
}
fn sync(app: &AppHandle) -> Result<(), String> {
    let managed = app.state::<CallOverlay>(); let _operation = managed.operation.lock().map_err(|_| "Call window is unavailable")?;
    let Some(main) = app.get_webview_window("main") else { return Ok(()) };
    let minimized = main.is_minimized().unwrap_or(false);
    let background = minimized || !main.is_visible().unwrap_or(true);
    let foreground_area = if background { None } else { monitor(&main) };
    let call = { let mut inner = managed.inner.lock().map_err(|_| "Call window is unavailable")?;
        if let Some(area) = foreground_area { inner.main_area = Some(area); }
        inner.visible_call()
    };
    if !background || call.is_none() { if let Some(window) = app.get_webview_window(LABEL) { let _ = window.hide(); } return Ok(()) }
    let call = call.unwrap();
    let window = if let Some(window) = app.get_webview_window(LABEL) { window } else {
        // Creating WebView2 from a synchronous window event can deadlock. This
        // function only runs on an async-runtime worker, never the UI thread.
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("call-overlay.html".into()))
            .title("dant call").inner_size(360.0, 76.0).decorations(false).resizable(false)
            .maximizable(false).minimizable(false).closable(false).always_on_top(true).skip_taskbar(true)
            .visible(false).focused(false).transparent(true).shadow(true)
            .on_navigation(|url| url.path() == "/call-overlay.html" && ((url.scheme() == "tauri" && url.host_str() == Some("localhost")) ||
                (url.scheme() == "http" && (url.host_str() == Some("tauri.localhost") || (url.host_str() == Some("127.0.0.1") && url.port() == Some(4318))))))
            .build().map_err(|_| "Call window could not be created")?
    };
    let (initial, main_area) = { let inner = managed.inner.lock().map_err(|_| "Call window is unavailable")?; (inner.placed_for.as_deref() != Some(call.call_id.as_str()), inner.main_area) };
    let work = if initial { main_area.or_else(|| monitor(&main)) } else { monitor(&window).or(main_area) };
    if let Some(work) = work { clamp(&window, work, initial)?; }
    // Recheck after window creation: restoring or ending a call must not leave
    // a late-created overlay visible over the desktop.
    let current = { let mut inner = managed.inner.lock().map_err(|_| "Call window is unavailable")?;
        if inner.visible_call().as_ref().map(|value| &value.call_id) != Some(&call.call_id) { false }
        else { inner.placed_for = Some(call.call_id.clone()); true }
    };
    if !current || (!main.is_minimized().unwrap_or(false) && main.is_visible().unwrap_or(true)) { let _ = window.hide(); return Ok(()) }
    let _ = window.emit("dant-call-overlay-state", &call);
    let _ = window.set_theme(Some(if call.theme == "dark" { tauri::Theme::Dark } else { tauri::Theme::Light }));
    if !window.is_visible().unwrap_or(false) {
        // Creation's focused(false) does not govern later SW_SHOW calls.
        // Show without activating over the app the user is currently using.
        window.set_focusable(false).map_err(|_| "Call window could not be shown")?;
        let shown = window.show(); let focusable = window.set_focusable(true);
        shown.map_err(|_| "Call window could not be shown")?;
        focusable.map_err(|_| "Call window controls are unavailable")?;
    }
    Ok(())
}
fn schedule(app: &AppHandle) {
    let managed = app.state::<CallOverlay>(); managed.dirty.store(true, Ordering::SeqCst);
    if managed.scheduled.swap(true, Ordering::SeqCst) { return }
    let app = app.clone(); tauri::async_runtime::spawn_blocking(move || loop {
        let managed = app.state::<CallOverlay>(); managed.dirty.store(false, Ordering::SeqCst); let _ = sync(&app);
        managed.scheduled.store(false, Ordering::SeqCst);
        if !managed.dirty.load(Ordering::SeqCst) || managed.scheduled.swap(true, Ordering::SeqCst) { break }
    });
}
pub fn setup(app: &tauri::App) { if let Some(main) = app.get_webview_window("main") { if let Some(area) = monitor(&main) { if let Ok(mut inner) = app.state::<CallOverlay>().inner.lock() { inner.main_area = Some(area); } } } }
pub fn visibility_changed(app: &AppHandle) { if app.try_state::<CallOverlay>().is_some() { schedule(app); } }
pub fn show_call_window(app: &AppHandle) {
    let managed = app.state::<CallOverlay>();
    let expected = managed.inner.lock().ok().and_then(|inner| if inner.closing { None } else { inner.call.as_ref().map(|call| call.call_id.clone()) });
    let Some(expected) = expected else { return };
    // Tray callbacks run on the UI thread. Do not wait there for a sync that
    // may itself be waiting for a native window operation on the same thread.
    let app = app.clone(); tauri::async_runtime::spawn_blocking(move || {
        let managed = app.state::<CallOverlay>(); let Ok(_operation) = managed.operation.lock() else { return };
        let changed = managed.inner.lock().map(|mut inner| inner.show(&expected)).unwrap_or(false);
        if changed { schedule(&app); }
    });
}
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    if window.label() == "main" {
        if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
            if let Ok(mut inner) = app.state::<CallOverlay>().inner.lock() { inner.closing = true; inner.call = None; }
            if let Some(overlay) = app.get_webview_window(LABEL) { let _ = overlay.destroy(); }
        } else if matches!(event, WindowEvent::Resized(_) | WindowEvent::Focused(_) | WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. }) { schedule(app); }
    } else if window.label() == LABEL {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Ok(mut inner) = app.state::<CallOverlay>().inner.lock() { if let Some(call_id) = inner.call.as_ref().map(|value| value.call_id.clone()) { let _ = inner.hide(&call_id); } }
            let _ = window.hide(); schedule(app);
        }
        if matches!(event, WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }) { schedule(app); }
    }
}
#[tauri::command]
pub async fn call_overlay_update(app: AppHandle, window: WebviewWindow, state: Option<CallState>) -> Result<(), String> {
    if window.label() != "main" || state.as_ref().is_some_and(|value| !valid(value)) { return Err("Invalid call window state".into()) }
    let language = state.as_ref().map(|value| value.language.clone()); let active = state.is_some();
    { let managed = app.state::<CallOverlay>(); let _operation = managed.operation.lock().map_err(|_| "Call window is unavailable")?; let mut inner = managed.inner.lock().map_err(|_| "Call window is unavailable")?;
        if inner.closing { return Err("Call window has stopped".into()) }
        inner.update(state);
    }
    crate::tray::call_window_changed(&app, active, language.as_deref());
    schedule(&app); Ok(())
}
#[tauri::command]
pub fn call_overlay_get(app: AppHandle, window: WebviewWindow) -> Result<Option<CallState>, String> {
    if window.label() != LABEL { return Err("Invalid call window".into()) }
    app.state::<CallOverlay>().inner.lock().map(|inner| inner.call.clone()).map_err(|_| "Call window is unavailable".into())
}
#[tauri::command]
pub async fn call_overlay_action(app: AppHandle, window: WebviewWindow, call_id: String, action: String, request_id: String, muted: Option<bool>) -> Result<(), String> {
    if window.label() != LABEL || !identifier(&call_id) || !identifier(&request_id) || !matches!(action.as_str(), "mute" | "hangup" | "restore" | "hide") { return Err("Invalid call window action".into()) }
    let managed = app.state::<CallOverlay>(); let _operation = managed.operation.lock().map_err(|_| "Call window is unavailable")?;
    { let mut inner = managed.inner.lock().map_err(|_| "Call window is unavailable")?;
        let call = inner.call.as_ref().filter(|value| value.call_id == call_id).ok_or("The call changed")?;
        if inner.closing || (action == "mute" && (!call.can_mute || muted.is_none())) { return Err("The call action is unavailable".into()) }
        if inner.seen.contains(&request_id) { return Ok(()) } inner.seen.push_back(request_id.clone()); while inner.seen.len() > 128 { inner.seen.pop_front(); }
        if action == "hide" { inner.hide(&call_id)?; }
    }
    if action == "hide" {
        // Hiding changes native visibility only. Never send it to the media or
        // task handler, and retain the call ID across ordinary status updates.
        let hidden = app.get_webview_window(LABEL).map(|overlay| overlay.hide().map_err(|_| "Call window could not be hidden".to_string())).unwrap_or(Ok(()));
        schedule(&app); return hidden
    }
    if action == "restore" { if let Some(main) = app.get_webview_window("main") { main.unminimize().map_err(|_| "The main window could not be restored")?; main.show().map_err(|_| "The main window could not be shown")?; main.set_focus().map_err(|_| "The main window could not be focused")?; } schedule(&app); }
    app.emit_to("main", "dant-call-overlay-action", Action { call_id, action, request_id, muted }).map_err(|_| "The call action was not confirmed".into())
}
#[tauri::command]
pub async fn call_overlay_drag(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL { return Err("Invalid call window".into()) }
    let active = app.state::<CallOverlay>().inner.lock().map(|inner| !inner.closing && inner.call.is_some()).unwrap_or(false);
    if !active { return Err("The call ended".into()) }
    tauri::async_runtime::spawn_blocking(move || { window.start_dragging().map_err(|_| "Call window dragging is unavailable")?; if let Some(area) = monitor(&window) { clamp(&window, area, false)?; } Ok::<(), String>(()) }).await.map_err(|_| "Call window dragging stopped".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(id: &str) -> CallState { CallState { call_id: id.into(), status: "talking".into(), connected_at: Some(123), seconds: 10, confirmed: true, running: true, muted: false, can_mute: true, language: "en".into(), theme: "dark".into() } }
    #[test] fn hidden_call_survives_metadata_refresh_without_changing_media_state() {
        let mut inner = Inner::default(); inner.update(Some(call("call-a"))); inner.hide("call-a").unwrap();
        assert!(inner.visible_call().is_none()); assert_eq!(inner.call, Some(call("call-a")));
        let mut refreshed = call("call-a"); refreshed.seconds = 25; refreshed.muted = true; refreshed.language = "zh".into();
        inner.update(Some(refreshed.clone())); assert!(inner.visible_call().is_none());
        assert!(inner.show("call-a")); assert_eq!(inner.visible_call(), Some(refreshed));
    }
    #[test] fn new_call_is_visible_and_stale_hide_or_show_cannot_affect_it() {
        let mut inner = Inner::default(); inner.update(Some(call("call-a"))); inner.hide("call-a").unwrap();
        inner.update(Some(call("call-b"))); assert_eq!(inner.visible_call(), Some(call("call-b")));
        assert!(inner.hide("call-a").is_err()); assert_eq!(inner.visible_call(), Some(call("call-b")));
        inner.hide("call-b").unwrap(); assert!(!inner.show("call-a")); assert!(inner.visible_call().is_none());
        assert!(inner.show("call-b")); assert_eq!(inner.visible_call(), Some(call("call-b")));
    }
    #[test] fn ended_or_closing_calls_cannot_be_restored_or_hidden_by_late_controls() {
        let mut inner = Inner::default(); inner.update(Some(call("call-a"))); inner.hide("call-a").unwrap(); inner.update(None);
        assert!(inner.hidden_for.is_none()); assert!(!inner.show("call-a")); assert!(inner.hide("call-a").is_err()); assert!(inner.call.is_none());
        inner.update(Some(call("call-b"))); inner.closing = true;
        assert!(!inner.show("call-b")); assert!(inner.hide("call-b").is_err()); assert!(inner.visible_call().is_none());
    }
    #[test] fn work_area_placement_respects_taskbars_negative_monitors_and_dpi() {
        let area = Area { x: -1920, y: -80, width: 1920, height: 1040, scale: 1.5 };
        assert_eq!(position(area, 540, 114, None), PhysicalPosition::new(-564, 822));
        assert_eq!(position(area, 540, 114, Some((-4000, 4000))), PhysicalPosition::new(-1896, 822));
        assert_eq!(position(area, 540, 114, Some((-1000, 200))), PhysicalPosition::new(-1000, 200));
    }
    #[test] fn oversized_or_tiny_work_areas_never_panic_or_place_the_origin_outside() {
        let area = Area { x: 10, y: 20, width: 100, height: 40, scale: 2.0 };
        assert_eq!(position(area, 360, 76, None), PhysicalPosition::new(10, 20));
        assert!(!identifier("call\nprivate")); assert!(!identifier("")); assert!(identifier("call-a:1"));
    }
    #[test] fn metadata_validation_rejects_unbounded_or_unknown_context() {
        let mut value = CallState { call_id: "call-a".into(), status: "talking".into(), connected_at: Some(123), seconds: 10, confirmed: true, running: true, muted: false, can_mute: true, language: "en".into(), theme: "dark".into() };
        assert!(valid(&value)); value.status = "private transcript".into(); assert!(!valid(&value)); value.status = "talking".into(); value.connected_at = Some(u64::MAX); assert!(!valid(&value));
        assert!(serde_json::from_value::<CallState>(serde_json::json!({"callId":"a","token":"secret"})).is_err());
    }
}
