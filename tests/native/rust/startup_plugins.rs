use super::*;
use std::os::windows::process::CommandExt;
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

#[link(name = "kernel32")]
extern "system" {
    fn OpenMutexW(access: u32, inherit: i32, name: *const u16) -> *mut std::ffi::c_void;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}
fn singleton_exists(identifier: &str) -> bool {
    assert!(identifier.starts_with("test.dant.nativefixture."));
    assert_ne!(identifier, "com.dant.desktop");
    let name: Vec<u16> = format!("{identifier}-sim")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let handle = unsafe { OpenMutexW(0x00100000, 0, name.as_ptr()) };
    if handle.is_null() {
        false
    } else {
        unsafe { CloseHandle(handle) };
        true
    }
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
fn native_plugin_initialization_uses_a_private_child_namespace_and_releases_its_singleton() {
    let root = tempfile::Builder::new()
        .prefix("dant-native-plugin-")
        .tempdir()
        .unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "command_tests::plugins::isolated_plugin_child",
            "--nocapture",
        ])
        .env("DANT_NATIVE_PLUGIN_FIXTURE_ROOT", root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(runtime::CREATE_NO_WINDOW);
    let mut child = OwnedChild(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "The isolated plugin fixture must terminate"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(status.success(), "The synthetic plugin child failed");
    assert_eq!(
        std::fs::read(root.path().join("plugins-verified")).unwrap(),
        b"private plugins initialized and singleton released"
    );
}
#[test]
fn isolated_plugin_child() {
    let Some(root) = std::env::var_os("DANT_NATIVE_PLUGIN_FIXTURE_ROOT").map(PathBuf::from) else {
        return;
    };
    assert!(root.is_absolute());
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("dant-native-plugin-"));
    assert!(runtime_path(root.canonicalize().unwrap())
        .starts_with(runtime_path(std::env::temp_dir().canonicalize().unwrap())));
    let identifier = format!(
        "test.dant.nativefixture.p{}.{}",
        std::process::id(),
        root.file_name().unwrap().to_string_lossy()
    );
    assert_ne!(identifier, "com.dant.desktop");
    assert!(
        !singleton_exists(&identifier),
        "The fixture can only create a new singleton"
    );
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = identifier.clone();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.clone()),
    );
    let app = application_builder(application_plugins(tauri::test::mock_builder()))
        .build(context)
        .unwrap();
    struct Singleton<'a>(&'a tauri::App<tauri::test::MockRuntime>);
    impl Drop for Singleton<'_> {
        fn drop(&mut self) {
            tauri_plugin_single_instance::destroy(self.0);
        }
    }
    let singleton = Singleton(&app);
    assert!(singleton_exists(&identifier));
    for path in [
        app.path().app_data_dir().unwrap(),
        app.path().app_config_dir().unwrap(),
        app.path().app_cache_dir().unwrap(),
    ] {
        assert!(path.starts_with(&root));
    }
    assert!(app
        .try_state::<tauri_plugin_dialog::Dialog<tauri::test::MockRuntime>>()
        .is_some());
    assert!(app
        .try_state::<tauri_plugin_notification::Notification<tauri::test::MockRuntime>>()
        .is_some());
    assert!(app
        .try_state::<tauri_plugin_opener::Opener<tauri::test::MockRuntime>>()
        .is_some());
    drop(singleton);
    assert!(!singleton_exists(&identifier));
    // The in-memory runtime exposes the real close API through app events.
    // Feed that API to the registered production entry; no native window exists.
    let app = application_builder(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let main =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let overlay = tauri::WebviewWindowBuilder::new(
        &app,
        "call-overlay",
        tauri::WebviewUrl::App("call-overlay.html".into()),
    )
    .build()
    .unwrap();
    let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = std::sync::Arc::clone(&closed);
    app.run(move |handle, event| {
        if let tauri::RunEvent::WindowEvent { label, event, .. } = &event {
            let window = if label == "main" { &main } else { &overlay };
            application_window_event(&window.as_ref().window(), event);
            if label == "call-overlay" && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                observed.store(true, std::sync::atomic::Ordering::Release);
                main.close().unwrap();
            }
        }
        if matches!(event, tauri::RunEvent::Ready) {
            overlay.close().unwrap();
        }
        if !matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            application_event(handle, event);
        }
    });
    assert!(closed.load(std::sync::atomic::Ordering::Acquire));
    std::fs::write(
        Path::new(&root).join("plugins-verified"),
        b"private plugins initialized and singleton released",
    )
    .unwrap();
}
