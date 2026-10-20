#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::path::PathBuf;
use tauri::Manager;
mod backend;
mod backup_transfer;
mod call_overlay;
mod downloads;
mod l10n;
mod lifecycle;
mod notifications;
mod protocol;
mod runtime;
mod speech;
mod text_editor;
mod transport;
mod tray;
mod update_helper;
mod updates;
pub(crate) use backend::Backend;
pub(crate) use runtime::runtime_path;
fn startup_error(message: &str) {
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
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
        }
    }
    #[cfg(not(windows))]
    eprintln!("{message}");
}
fn main() {
    if update_helper::run_helper_mode() {
        return;
    }
    if update_helper::startup_fenced() {
        return;
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            tray::restore(app)
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(speech::SpeechProcess::default())
        .manage(call_overlay::CallOverlay::default())
        .manage(tray::BackgroundTray::default())
        .manage(updates::Updates::default())
        .manage(lifecycle::DesktopExit::default())
        .on_window_event(|window, event| {
            if !tray::on_window_event(window, event) {
                call_overlay::on_window_event(window, event);
            }
        })
        .invoke_handler(tauri::generate_handler![
            transport::api_request,
            speech::speech_start,
            speech::speech_stop,
            downloads::save_attachment,
            backup_transfer::export_dant_backup,
            backup_transfer::import_dant_backup,
            call_overlay::call_overlay_update,
            call_overlay::call_overlay_get,
            call_overlay::call_overlay_action,
            call_overlay::call_overlay_drag,
            tray::tray_status_update,
            text_editor::editor_preferences,
            text_editor::installed_text_editors,
            text_editor::select_text_editor,
            text_editor::choose_text_editor,
            text_editor::reset_text_editor,
            text_editor::open_attachment_in_editor,
            updates::download_update,
            updates::install_update,
            updates::update_capabilities
        ])
        .setup(|app| {
            call_overlay::setup(app);
            if tray::setup(app).is_err() {
                eprintln!("The system tray is unavailable; closing dant will exit normally.");
            }
            let backend_root = runtime_path(if cfg!(debug_assertions) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
            } else {
                app.path().resource_dir()?.join("backend")
            });
            let source = transport::bundled_source(&backend_root)?;
            let config = runtime::RuntimeConfig::capture(app.handle())?;
            let data = config.data_directory.clone();
            app.manage(config);

            if transport::existing_controller(&source)? {
                app.manage(Backend::external());
                notifications::start(app);
                lifecycle::open_existing_controller(app.handle());
                return Ok(());
            }
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let config_root = cfg!(debug_assertions).then(|| manifest.parent().unwrap());
            app.manage(Backend::start(&backend_root, &data, config_root)?);
            notifications::start(app);
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            startup_error(&format!("Unable to start dant: {error}"));
            std::process::exit(1);
        }
    };
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            if !lifecycle::approved(handle) {
                api.prevent_exit();
                lifecycle::request_exit(handle);
            }
        }
        if let tauri::RunEvent::Exit = event {
            if let Some(pump) = handle.try_state::<notifications::NotificationPump>() {
                pump.0.store(false, std::sync::atomic::Ordering::Relaxed);
            }
            if let Some(process) = handle.try_state::<speech::SpeechProcess>() {
                speech::stop(&process);
            }
            if let Some(state) = handle.try_state::<Backend>() {
                state.stop();
            }
        }
    });
}
