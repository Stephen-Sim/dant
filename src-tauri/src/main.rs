#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::path::PathBuf;
use tauri::Manager;
mod atomic_file;
mod backend;
mod backup_transfer;
mod call_overlay;
mod downloads;
mod l10n;
mod lifecycle;
mod native_dialog;
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
#[cfg(test)]
#[path = "../../tests/native/rust/commands.rs"]
mod command_tests;
#[cfg(test)]
#[path = "../../tests/support/native-http.rs"]
mod native_http;
fn startup_error(sink: &dyn native_dialog::MessageSink, message: &str) {
    native_dialog::error(sink, "dant", message);
}

fn application_plugins<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_single_instance::init(existing_instance))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
}

fn existing_instance<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    _arguments: Vec<String>,
    _directory: String,
) {
    tray::restore(app);
}

fn application_builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    let builder = builder
        .manage(speech::SpeechProcess::default())
        .manage(call_overlay::CallOverlay::default())
        .manage(tray::BackgroundTray::default())
        .manage(updates::Updates::default())
        .manage(text_editor::TextEditors::<R>::default())
        .manage(lifecycle::DesktopExit::default())
        .manage(lifecycle::DesktopControl::<R>::default())
        .manage(notifications::NotificationControl::<R>::default())
        .manage(backup_transfer::BackupControl::<R>::default())
        .on_window_event(application_window_event);
    application_commands(builder)
}

fn application_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
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
}

fn application_window_event<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &tauri::WindowEvent,
) {
    if !tray::on_window_event(window, event) {
        call_overlay::on_window_event(window, event);
    }
}

struct ControllerStartup<'a> {
    source: &'a str,
    backend: &'a std::path::Path,
    data: &'a std::path::Path,
    configuration: Option<&'a std::path::Path>,
}

struct ControllerEffects<E, S, N, O> {
    existing: E,
    start: S,
    notifications: N,
    reopen: O,
}

fn configure_controller<R, E, S, N, O>(
    app: &tauri::App<R>,
    context: ControllerStartup<'_>,
    effects: ControllerEffects<E, S, N, O>,
) -> Result<(), Box<dyn std::error::Error>>
where
    R: tauri::Runtime,
    E: FnOnce(&str) -> Result<bool, &'static str>,
    S: FnOnce(
        &std::path::Path,
        &std::path::Path,
        Option<&std::path::Path>,
    ) -> Result<Backend, Box<dyn std::error::Error>>,
    N: FnOnce(&tauri::App<R>),
    O: FnOnce(&tauri::AppHandle<R>),
{
    if (effects.existing)(context.source)? {
        app.manage(Backend::external());
        (effects.notifications)(app);
        (effects.reopen)(app.handle());
        return Ok(());
    }
    let backend = (effects.start)(context.backend, context.data, context.configuration)?;
    app.manage(backend);
    (effects.notifications)(app);
    Ok(())
}

struct StartupDirectories {
    development_resources: Option<PathBuf>,
    configuration: Option<PathBuf>,
}

fn application_setup<R, T, C, E, S, N, O>(
    directories: StartupDirectories,
    tray_setup: T,
    capture: C,
    effects: ControllerEffects<E, S, N, O>,
) -> impl FnOnce(&mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> + Send
where
    R: tauri::Runtime,
    T: FnOnce(&tauri::App<R>) -> tauri::Result<()> + Send + 'static,
    C: FnOnce(&tauri::AppHandle<R>) -> tauri::Result<runtime::RuntimeConfig> + Send + 'static,
    E: FnOnce(&str) -> Result<bool, &'static str> + Send + 'static,
    S: FnOnce(
            &std::path::Path,
            &std::path::Path,
            Option<&std::path::Path>,
        ) -> Result<Backend, Box<dyn std::error::Error>>
        + Send
        + 'static,
    N: FnOnce(&tauri::App<R>) + Send + 'static,
    O: FnOnce(&tauri::AppHandle<R>) + Send + 'static,
{
    move |app| {
        call_overlay::setup(app);
        if tray_setup(app).is_err() {
            eprintln!("The system tray is unavailable; closing dant will exit normally.");
        }
        let backend_root = runtime_path(match directories.development_resources {
            Some(resources) => resources,
            None => app.path().resource_dir()?.join("backend"),
        });
        let source = transport::bundled_source(&backend_root)?;
        let config = capture(app.handle())?;
        let data = config.data_directory.clone();
        app.manage(config);
        configure_controller(
            app,
            ControllerStartup {
                source: &source,
                backend: &backend_root,
                data: &data,
                configuration: directories.configuration.as_deref(),
            },
            effects,
        )
    }
}

fn native_setup<R: tauri::Runtime>(
    directories: StartupDirectories,
) -> impl FnOnce(&mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> + Send {
    application_setup(
        directories,
        tray::setup,
        runtime::RuntimeConfig::capture,
        ControllerEffects {
            existing: |source: &str| transport::ControllerLink::default().existing(source),
            start: Backend::start,
            notifications: notifications::start,
            reopen: lifecycle::open_existing_controller,
        },
    )
}

impl StartupDirectories {
    fn for_build(manifest: &std::path::Path, development: bool) -> Self {
        Self {
            development_resources: development.then(|| manifest.join("resources")),
            configuration: development.then(|| manifest.parent().unwrap().to_owned()),
        }
    }
}

fn application_event<R: tauri::Runtime>(handle: &tauri::AppHandle<R>, event: tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested { api, .. } = &event {
        if !lifecycle::approved(handle) {
            api.prevent_exit();
            lifecycle::request_exit(handle);
        }
    }
    if let tauri::RunEvent::Exit = event {
        shutdown(handle);
    }
}

fn main() {
    launch(
        update_helper::run_helper_mode,
        update_helper::startup_fenced,
        || {
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            application_builder(application_plugins(tauri::Builder::default()))
                .setup(native_setup(StartupDirectories::for_build(
                    &manifest,
                    cfg!(debug_assertions),
                )))
                .build(tauri::generate_context!())
        },
        |message| {
            startup_error(&native_dialog::NativeDialog, &message);
            std::process::exit(1);
        },
        |app| app.run(application_event),
    );
}

fn launch<A, E: std::fmt::Display>(
    helper: impl FnOnce() -> bool,
    fenced: impl FnOnce() -> bool,
    build: impl FnOnce() -> Result<A, E>,
    failed: impl FnOnce(String),
    run: impl FnOnce(A),
) {
    if helper() {
        return;
    }
    if fenced() {
        return;
    }
    match build() {
        Ok(app) => run(app),
        Err(error) => failed(format!("Unable to start dant: {error}")),
    }
}

fn shutdown<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) {
    if let Some(pump) = handle.try_state::<notifications::NotificationPump>() {
        pump.stop();
    }
    if let Some(process) = handle.try_state::<speech::SpeechProcess>() {
        speech::stop(&process);
    }
    if let Some(state) = handle.try_state::<Backend>() {
        state.stop();
    }
}
