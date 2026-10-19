use serde::Deserialize;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::{menu::{Menu, MenuItem, PredefinedMenuItem}, tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent}, AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

const ID: &str = "dant-background";
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Status { language: String, connection: String, task: String, queued: u16 }
struct NativeTray { icon: TrayIcon, open: MenuItem<tauri::Wry>, progress: MenuItem<tauri::Wry>, call_window: MenuItem<tauri::Wry>, call_active: bool, call_language: String, status: MenuItem<tauri::Wry>, exit: MenuItem<tauri::Wry>, last: Option<Status> }
#[derive(Default)]
pub struct BackgroundTray { ready: AtomicBool, exiting: AtomicBool, inner: Mutex<Option<NativeTray>> }

fn valid(value: &Status) -> bool {
    crate::l10n::supported(&value.language) && matches!(value.connection.as_str(), "online" | "offline" | "connecting")
        && matches!(value.task.as_str(), "idle" | "running" | "background" | "waiting_user" | "pausing" | "unknown") && value.queued <= 999
}
fn should_hide(ready: bool, exiting: bool, main: bool) -> bool { ready && !exiting && main }
fn call_window_label(language: &str) -> String { crate::l10n::text(language, "Show call window", "显示通话窗口") }
fn labels(value: &Status) -> (String, String, String, String) {
    let (english, chinese) = if value.connection != "online" && value.task != "idle" {
        ("Work status unconfirmed", "任务状态待确认")
    } else { match value.task.as_str() {
        "running" => ("Working", "正在工作"),
        "background" => ("Working in background", "后台执行中"),
        "waiting_user" => ("Waiting for your reply", "等待你回复"),
        "pausing" => ("Pausing work", "正在暂停"),
        "unknown" => ("Work outcome unconfirmed", "任务结果待确认"),
        _ => if value.connection == "online" { ("Online", "在线") } else if value.connection == "connecting" { ("Connecting", "连接中") } else { ("Offline", "离线") },
    }};
    let mut state = crate::l10n::text(&value.language, english, chinese);
    if value.queued > 0 {
        let queued = crate::l10n::text(&value.language, "{count} queued", "{count} 项排队").replace("{count}", &value.queued.to_string());
        state = format!("{state} · {queued}");
    }
    (crate::l10n::text(&value.language, "Open dant", "打开 dant"),
     crate::l10n::text(&value.language, "Work progress", "任务进度"),
     crate::l10n::text(&value.language, "Exit dant", "退出 dant"), state)
}

pub fn restore(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize(); let _ = main.show(); let _ = main.set_focus();
        crate::call_overlay::visibility_changed(app);
    }
}
pub fn call_window_changed(app: &AppHandle, active: bool, language: Option<&str>) {
    let Some(state) = app.try_state::<BackgroundTray>() else { return };
    let Ok(mut inner) = state.inner.lock() else { return };
    let Some(tray) = inner.as_mut() else { return };
    let language = language.or_else(|| tray.last.as_ref().map(|value| value.language.as_str())).unwrap_or(&tray.call_language).to_string();
    if tray.call_active != active { if tray.call_window.set_enabled(active).is_ok() { tray.call_active = active; } }
    if tray.call_language != language { if tray.call_window.set_text(call_window_label(&language)).is_ok() { tray.call_language = language; } }
}
fn exit(app: &AppHandle) {
    crate::lifecycle::request_exit(app);
}
pub fn mark_exiting(app: &AppHandle) {
    if let Some(state) = app.try_state::<BackgroundTray>() { state.exiting.store(true, Ordering::SeqCst); }
}
pub fn language(app: &AppHandle) -> String {
    app.try_state::<BackgroundTray>().and_then(|state|state.inner.lock().ok().and_then(|inner|inner.as_ref().and_then(|tray|tray.last.as_ref().map(|status|status.language.clone())))).unwrap_or_else(||"en".into())
}
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "dant-open", "打开 dant", true, None::<&str>)?;
    let progress = MenuItem::with_id(app, "dant-progress", "任务进度", true, None::<&str>)?;
    let call_window = MenuItem::with_id(app, "dant-call-window", call_window_label("zh"), false, None::<&str>)?;
    let status = MenuItem::with_id(app, "dant-status", "连接中", false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit_item = MenuItem::with_id(app, "dant-exit", "退出 dant", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &progress, &call_window, &status, &separator, &exit_item])?;
    let icon = app.default_window_icon().ok_or_else(|| tauri::Error::AssetNotFound("default app icon".into()))?.clone();
    let icon = TrayIconBuilder::with_id(ID).icon(icon).menu(&menu).tooltip("dant · 连接中").show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "dant-open" => restore(app),
            "dant-progress" => { restore(app); let _ = app.emit_to("main", "dant-tray-progress", ()); },
            "dant-call-window" => crate::call_overlay::show_call_window(app),
            "dant-exit" => exit(app), _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) { restore(tray.app_handle()); }
        }).build(app)?;
    let state = app.state::<BackgroundTray>();
    *state.inner.lock().unwrap() = Some(NativeTray { icon, open, progress, call_window, call_active: false, call_language: "zh".into(), status, exit: exit_item, last: None });
    state.ready.store(true, Ordering::SeqCst); Ok(())
}
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) -> bool {
    let Some(state) = window.app_handle().try_state::<BackgroundTray>() else { return false };
    if let WindowEvent::CloseRequested { api, .. } = event {
        if should_hide(state.ready.load(Ordering::SeqCst), state.exiting.load(Ordering::SeqCst), window.label() == "main") && window.hide().is_ok() {
            api.prevent_close(); crate::call_overlay::visibility_changed(window.app_handle()); return true;
        }
    }
    // If creating the tray or hiding the window fails, ordinary close remains
    // available so the user is never left with an inaccessible background app.
    false
}
#[tauri::command]
pub async fn tray_status_update(app: AppHandle, window: WebviewWindow, status: Status) -> Result<(), String> {
    if window.label() != "main" || !valid(&status) { return Err("Invalid background status".into()) }
    let state = app.state::<BackgroundTray>();
    let mut inner = state.inner.lock().map_err(|_| "The system tray is unavailable")?;
    let Some(tray) = inner.as_mut() else { return Ok(()) };
    if tray.last.as_ref() == Some(&status) { return Ok(()) }
    let (open, progress, exit, text) = labels(&status);
    tray.open.set_text(open).map_err(|_| "The system tray is unavailable")?;
    tray.progress.set_text(progress).map_err(|_| "The system tray is unavailable")?;
    tray.call_window.set_text(call_window_label(&status.language)).map_err(|_| "The system tray is unavailable")?;
    tray.call_language = status.language.clone();
    tray.exit.set_text(exit).map_err(|_| "The system tray is unavailable")?;
    tray.status.set_text(&text).map_err(|_| "The system tray is unavailable")?;
    tray.icon.set_tooltip(Some(format!("dant · {text}"))).map_err(|_| "The system tray is unavailable")?;
    tray.last = Some(status); Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn status() -> Status { Status { language: "en".into(), connection: "online".into(), task: "background".into(), queued: 2 } }
    #[test] fn call_window_restore_labels_are_localized_and_separate_from_exit() {
        assert_eq!(call_window_label("en"), "Show call window"); assert_eq!(call_window_label("zh"), "显示通话窗口");
        assert_ne!(call_window_label("en"), labels(&status()).2);
    }
    #[test] fn close_hides_only_with_a_working_tray_and_never_during_explicit_exit() {
        assert!(should_hide(true, false, true));
        for values in [(false,false,true), (true,true,true), (true,false,false)] { assert!(!should_hide(values.0,values.1,values.2)); }
    }
    #[test] fn statuses_are_bounded_metadata_and_never_arbitrary_text() {
        let mut value = status(); assert!(valid(&value));
        value.task = "private task title".into(); assert!(!valid(&value)); value.task = "running".into();
        value.queued = 1000; assert!(!valid(&value)); value.queued = 0;
        value.connection = "private exception".into(); assert!(!valid(&value));
        assert!(serde_json::from_value::<Status>(serde_json::json!({"language":"en","connection":"online","task":"idle","queued":0,"token":"secret"})).is_err());
    }
    #[test] fn tray_separates_background_waiting_and_unconfirmed_connection_states() {
        let mut value = status(); assert_eq!(labels(&value).3,"Working in background · 2 queued");
        value.task = "waiting_user".into(); value.queued = 0; assert_eq!(labels(&value).3,"Waiting for your reply");
        value.connection = "offline".into(); assert_eq!(labels(&value).3,"Work status unconfirmed");
        value.language = "zh".into(); assert_eq!(labels(&value).0,"打开 dant"); assert_eq!(labels(&value).3,"任务状态待确认");
        value.task = "idle".into(); assert_eq!(labels(&value).3,"离线");
    }
}
