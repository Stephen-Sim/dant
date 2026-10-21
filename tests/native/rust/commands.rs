use super::*;

#[test]
fn singleton_activation_preserves_the_owned_main_window_and_ignores_a_missing_window() {
    let app = tauri::test::mock_app();
    existing_instance(
        app.handle(),
        vec!["untrusted argument".into()],
        "untrusted directory".into(),
    );
    assert!(app.webview_windows().is_empty());
    let main =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let label = main.label().to_owned();
    existing_instance(app.handle(), Vec::new(), String::new());
    assert_eq!(app.webview_windows().len(), 1);
    assert_eq!(app.get_webview_window("main").unwrap().label(), label);
    assert!(main.is_visible().unwrap());
    assert!(!main.is_minimized().unwrap());
    assert!(app.try_state::<Backend>().is_none());
    assert!(app.try_state::<lifecycle::DesktopExit>().is_none());
}

#[test]
fn application_launch_orders_helper_fence_build_and_run_and_reports_a_failed_build_once() {
    use std::cell::RefCell;
    for (helper, fenced, error, expected) in [
        (true, false, false, vec!["helper"]),
        (false, true, false, vec!["helper", "fence"]),
        (false, false, false, vec!["helper", "fence", "build", "run"]),
        (
            false,
            false,
            true,
            vec!["helper", "fence", "build", "failed"],
        ),
    ] {
        let observed = RefCell::new(Vec::new());
        launch(
            || {
                observed.borrow_mut().push("helper");
                helper
            },
            || {
                observed.borrow_mut().push("fence");
                fenced
            },
            || {
                observed.borrow_mut().push("build");
                if error {
                    Err("owned startup failure")
                } else {
                    Ok("owned app")
                }
            },
            |message| {
                assert_eq!(message, "Unable to start dant: owned startup failure");
                observed.borrow_mut().push("failed");
            },
            |app| {
                assert_eq!(app, "owned app");
                observed.borrow_mut().push("run");
            },
        );
        assert_eq!(*observed.borrow(), expected);
    }
}

#[test]
fn native_startup_error_preserves_its_fixed_title_and_complete_failure_text() {
    struct Sink;
    impl native_dialog::MessageSink for Sink {
        fn send(&self, text: &[u16], title: &[u16], kind: u32) {
            assert_eq!(
                String::from_utf16(&text[..text.len() - 1]).unwrap(),
                "Unable to start dant: owned startup failure"
            );
            assert_eq!(
                String::from_utf16(&title[..title.len() - 1]).unwrap(),
                "dant"
            );
            assert_eq!(kind, 0x10);
        }
    }
    startup_error(&Sink, "Unable to start dant: owned startup failure");
}

pub(crate) fn invoke(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    tauri::test::get_ipc_response(
        window,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|value| value.deserialize().unwrap())
}

#[test]
fn ipc_argument_decoding_rejects_every_missing_required_and_wrong_typed_field_before_feature_execution(
) {
    let root = tempfile::tempdir().unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = "test.dant.ipcfixture".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.path().to_path_buf()),
    );
    let app = application_builder(tauri::test::mock_builder())
        .build(context)
        .unwrap();
    let main =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let file = serde_json::json!({"fileId":"11111111-1111-4111-8111-111111111111", "token":"a".repeat(64), "fileName":"owned.md"});
    for (command, body, required, optional) in [
        (
            "api_request",
            serde_json::json!({"route":"/api/state", "method":"GET", "body":"{}", "token":"a".repeat(64)}),
            vec!["route"],
            vec!["method", "body", "token"],
        ),
        (
            "speech_start",
            serde_json::json!({"mode":"capabilities", "language":"en", "text":"owned"}),
            vec!["mode", "language"],
            vec!["text"],
        ),
        (
            "save_attachment",
            file.clone(),
            vec!["fileId", "token", "fileName"],
            vec![],
        ),
        (
            "open_attachment_in_editor",
            file,
            vec!["fileId", "token", "fileName"],
            vec![],
        ),
        (
            "export_dant_backup",
            serde_json::json!({"backupId":"11111111-1111-4111-8111-111111111111", "token":"a".repeat(64), "passphrase":"owned passphrase"}),
            vec!["backupId", "token", "passphrase"],
            vec![],
        ),
        (
            "import_dant_backup",
            serde_json::json!({"token":"a".repeat(64), "passphrase":"owned passphrase"}),
            vec!["token", "passphrase"],
            vec![],
        ),
        (
            "call_overlay_update",
            serde_json::json!({"state":null}),
            vec![],
            vec!["state"],
        ),
        (
            "call_overlay_action",
            serde_json::json!({"callId":"owned", "action":"mute", "requestId":"owned-request", "muted":false}),
            vec!["callId", "action", "requestId"],
            vec!["muted"],
        ),
        (
            "tray_status_update",
            serde_json::json!({"status":{"language":"en", "connection":"online", "task":"idle", "queued":0}}),
            vec!["status"],
            vec![],
        ),
        (
            "select_text_editor",
            serde_json::json!({"editorId":"notepad"}),
            vec!["editorId"],
            vec![],
        ),
        (
            "download_update",
            serde_json::json!({"channel":"beta", "token":"a".repeat(64), "expectedVersion":"0.5.0-beta.2"}),
            vec!["channel", "token", "expectedVersion"],
            vec![],
        ),
        (
            "install_update",
            serde_json::json!({"packageId":"a".repeat(64), "token":"a".repeat(64)}),
            vec!["packageId", "token"],
            vec![],
        ),
    ] {
        for field in &required {
            let mut missing = body.clone();
            missing.as_object_mut().unwrap().remove(*field);
            let error = invoke(&main, command, missing).unwrap_err().to_string();
            assert!(error.contains("invalid args"), "{command}.{field}: {error}");
            assert!(
                error.contains(field),
                "The decoder must identify only the invalid field"
            );
        }
        for field in required.iter().chain(&optional) {
            let mut wrong = body.clone();
            wrong[*field] = serde_json::json!(42);
            let error = invoke(&main, command, wrong).unwrap_err().to_string();
            assert!(error.contains("invalid args"), "{command}.{field}: {error}");
            assert!(error.contains(field));
        }
    }
    assert_eq!(
        std::fs::read_dir(root.path()).unwrap().count(),
        0,
        "Malformed IPC must not create application data"
    );
    assert!(invoke(&main, "unknown-native-command", serde_json::json!({})).is_err());
}

#[test]
fn ipc_commands_reject_untrusted_windows_before_network_audio_dialog_or_user_file_access() {
    let app = application_builder(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let foreign = tauri::WebviewWindowBuilder::new(
        &app,
        "foreign",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .build()
    .unwrap();
    let main =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let file = serde_json::json!({"fileId":"11111111-1111-4111-8111-111111111111", "token":"a".repeat(64), "fileName":"note.md"});
    for (command, body) in [
        ("api_request", serde_json::json!({"route":"/api/state"})),
        ("save_attachment", file.clone()),
        ("open_attachment_in_editor", file),
        (
            "export_dant_backup",
            serde_json::json!({"backupId":"11111111-1111-4111-8111-111111111111", "token":"a".repeat(64), "passphrase":"a synthetic passphrase"}),
        ),
        (
            "import_dant_backup",
            serde_json::json!({"token":"a".repeat(64), "passphrase":"a synthetic passphrase"}),
        ),
        (
            "speech_start",
            serde_json::json!({"mode":"speak", "language":"en", "text":"synthetic input"}),
        ),
        ("speech_stop", serde_json::json!({})),
        ("editor_preferences", serde_json::json!({})),
        ("installed_text_editors", serde_json::json!({})),
        (
            "select_text_editor",
            serde_json::json!({"editorId":"notepad"}),
        ),
        ("reset_text_editor", serde_json::json!({})),
        ("choose_text_editor", serde_json::json!({})),
        (
            "download_update",
            serde_json::json!({"channel":"beta", "token":"a".repeat(64), "expectedVersion":"0.5.0-beta.2"}),
        ),
        (
            "install_update",
            serde_json::json!({"packageId":"a".repeat(64), "token":"a".repeat(64)}),
        ),
        ("update_capabilities", serde_json::json!({})),
    ] {
        assert!(invoke(&foreign, command, body).is_err(), "{command}");
    }
    for (command, body) in [
        (
            "api_request",
            serde_json::json!({"route":"https://invalid.example"}),
        ),
        (
            "save_attachment",
            serde_json::json!({"fileId":"bad", "token":"a".repeat(64), "fileName":"note.md"}),
        ),
        (
            "open_attachment_in_editor",
            serde_json::json!({"fileId":"bad", "token":"a".repeat(64), "fileName":"note.md"}),
        ),
        (
            "import_dant_backup",
            serde_json::json!({"token":"bad", "passphrase":"a synthetic passphrase"}),
        ),
        (
            "export_dant_backup",
            serde_json::json!({"backupId":"bad", "token":"a".repeat(64), "passphrase":"a synthetic passphrase"}),
        ),
        (
            "speech_start",
            serde_json::json!({"mode":"invalid", "language":"en"}),
        ),
        (
            "speech_start",
            serde_json::json!({"mode":"speak", "language":"invalid"}),
        ),
        (
            "speech_start",
            serde_json::json!({"mode":"speak", "language":"en", "text":"x".repeat(10001)}),
        ),
        (
            "select_text_editor",
            serde_json::json!({"editorId":"invalid"}),
        ),
        (
            "download_update",
            serde_json::json!({"channel":"invalid", "token":"a".repeat(64), "expectedVersion":"0.5.0-beta.2"}),
        ),
        (
            "download_update",
            serde_json::json!({"channel":"beta", "token":"a".repeat(64), "expectedVersion":"invalid"}),
        ),
        (
            "install_update",
            serde_json::json!({"packageId":"invalid", "token":"a".repeat(64)}),
        ),
    ] {
        assert!(invoke(&main, command, body).is_err(), "{command}");
    }
    assert!(invoke(&main, "speech_stop", serde_json::json!({})).is_ok());
    let capabilities = invoke(&main, "update_capabilities", serde_json::json!({})).unwrap();
    assert_eq!(capabilities["install"], false);
    assert_eq!(capabilities["reason"], "installed-app-required");
}

#[test]
fn application_shutdown_stops_only_its_managed_notification_and_process_owners() {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::atomic::Ordering;
    shutdown(tauri::test::mock_app().handle());
    let app = application_builder(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(Backend::external());
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "backend::tests::synthetic_backend_child",
            "--nocapture",
        ])
        .env("DANT_SYNTHETIC_BACKEND_FIXTURE", "blocked")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(runtime::CREATE_NO_WINDOW);
    *app.state::<Backend>().0.lock().unwrap() = Some(command.spawn().unwrap());
    shutdown(app.handle());
    assert!(app.state::<Backend>().0.lock().unwrap().is_none());
    assert_eq!(
        app.state::<speech::SpeechProcess>()
            .1
            .load(Ordering::SeqCst),
        1
    );
    shutdown(app.handle());
    assert_eq!(
        app.state::<speech::SpeechProcess>()
            .1
            .load(Ordering::SeqCst),
        2
    );
}

#[test]
fn startup_reuses_only_a_compatible_controller_or_starts_one_owned_backend_before_notifications() {
    use std::cell::RefCell;
    for existing in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let config = root.path().join("configuration");
        let source = "a".repeat(40);
        std::fs::write(
            root.path().join("resource-manifest.json"),
            serde_json::json!({"sourceCommit":source}).to_string(),
        )
        .unwrap();
        let source = transport::bundled_source(root.path()).unwrap();
        let app = tauri::test::mock_app();
        let events = RefCell::new(Vec::new());
        configure_controller(
            &app,
            ControllerStartup {
                source: &source,
                backend: root.path(),
                data: &data,
                configuration: Some(&config),
            },
            ControllerEffects {
                existing: |captured: &str| {
                    assert_eq!(captured, source);
                    events.borrow_mut().push("inspect");
                    Ok(existing)
                },
                start: |backend: &std::path::Path,
                        captured: &std::path::Path,
                        configuration: Option<&std::path::Path>| {
                    assert_eq!(backend, root.path());
                    assert_eq!(captured, data);
                    assert_eq!(configuration, Some(config.as_path()));
                    events.borrow_mut().push("start");
                    Ok(Backend::external())
                },
                notifications: |app: &tauri::App<tauri::test::MockRuntime>| {
                    assert!(app.try_state::<Backend>().is_some());
                    events.borrow_mut().push("notifications");
                },
                reopen: |app: &tauri::AppHandle<tauri::test::MockRuntime>| {
                    assert!(existing);
                    assert!(app.try_state::<Backend>().is_some());
                    events.borrow_mut().push("reopen");
                },
            },
        )
        .unwrap();
        assert_eq!(
            *events.borrow(),
            if existing {
                vec!["inspect", "notifications", "reopen"]
            } else {
                vec!["inspect", "start", "notifications"]
            }
        );
        assert!(
            !data.exists(),
            "Assembly tests must not start a real Controller or create runtime data"
        );
    }
}

#[test]
fn unknown_existing_service_or_failed_backend_start_cannot_install_a_backend_or_start_notifications(
) {
    for inspect_fails in [true, false] {
        let app = tauri::test::mock_app();
        let source = "a".repeat(40);
        let error = configure_controller(
            &app,
            ControllerStartup {
                source: &source,
                backend: std::path::Path::new("synthetic-resources"),
                data: std::path::Path::new("synthetic-data"),
                configuration: None,
            },
            ControllerEffects {
                existing: |_: &str| {
                    if inspect_fails {
                        Err("The local service could not be identified")
                    } else {
                        Ok(false)
                    }
                },
                start: |_: &std::path::Path, _: &std::path::Path, _: Option<&std::path::Path>| {
                    assert!(!inspect_fails);
                    Err("The owned Controller could not start".into())
                },
                notifications: |_: &tauri::App<tauri::test::MockRuntime>| {
                    panic!("An unconfirmed backend must not start a notification worker")
                },
                reopen: |_: &tauri::AppHandle<tauri::test::MockRuntime>| {
                    panic!("An unconfirmed service must never be reopened")
                },
            },
        )
        .unwrap_err();
        assert!(!error.to_string().is_empty());
        assert!(app.try_state::<Backend>().is_none());
    }
}

#[test]
fn application_setup_validates_resources_before_capturing_runtime_and_configuring_exact_controller_paths(
) {
    use std::sync::{Arc, Mutex};
    for existing in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let backend = root.path().join("backend");
        let data = root.path().join("data");
        let configuration = root.path().join("configuration");
        std::fs::create_dir(&backend).unwrap();
        std::fs::write(
            backend.join("resource-manifest.json"),
            serde_json::json!({"sourceCommit":"b".repeat(40)}).to_string(),
        )
        .unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture_events = events.clone();
        let inspect_events = events.clone();
        let start_events = events.clone();
        let notification_events = events.clone();
        let reopen_events = events.clone();
        let expected_backend = backend.clone();
        let expected_configuration = configuration.clone();
        let expected_data = data.clone();
        let captured_data = data.clone();
        let mut app = application_builder(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        application_setup(
            StartupDirectories {
                development_resources: Some(backend),
                configuration: Some(configuration),
            },
            move |_| {
                if existing {
                    Err(tauri::Error::AssetNotFound(
                        "synthetic tray unavailable".into(),
                    ))
                } else {
                    Ok(())
                }
            },
            move |_| {
                capture_events.lock().unwrap().push("runtime");
                Ok(runtime::RuntimeConfig {
                    data_directory: captured_data,
                })
            },
            ControllerEffects {
                existing: move |source: &str| {
                    assert_eq!(source, "b".repeat(40));
                    inspect_events.lock().unwrap().push("inspect");
                    Ok(existing)
                },
                start: move |backend: &std::path::Path,
                             data: &std::path::Path,
                             configuration: Option<&std::path::Path>| {
                    assert!(!existing);
                    assert_eq!(backend, expected_backend);
                    assert_eq!(data, expected_data);
                    assert_eq!(configuration, Some(expected_configuration.as_path()));
                    start_events.lock().unwrap().push("start");
                    Ok(Backend::external())
                },
                notifications: move |app: &tauri::App<tauri::test::MockRuntime>| {
                    assert!(runtime::data_directory(app.handle()).is_some());
                    notification_events.lock().unwrap().push("notifications");
                },
                reopen: move |_: &tauri::AppHandle<tauri::test::MockRuntime>| {
                    reopen_events.lock().unwrap().push("reopen");
                },
            },
        )(&mut app)
        .unwrap();
        assert_eq!(runtime::data_directory(app.handle()), Some(data.clone()));
        assert!(!data.exists());
        assert_eq!(
            *events.lock().unwrap(),
            if existing {
                vec!["runtime", "inspect", "notifications", "reopen"]
            } else {
                vec!["runtime", "inspect", "start", "notifications"]
            }
        );
    }
}
#[test]
fn invalid_startup_resources_or_runtime_capture_failure_cannot_start_or_reopen_a_service() {
    for mode in ["missing", "invalid", "runtime", "packaged"] {
        let root = tempfile::tempdir().unwrap();
        if mode == "invalid" {
            std::fs::write(root.path().join("resource-manifest.json"), b"{}").unwrap();
        }
        if mode == "runtime" {
            std::fs::write(
                root.path().join("resource-manifest.json"),
                serde_json::json!({"sourceCommit":"b".repeat(40)}).to_string(),
            )
            .unwrap();
        }
        let mut app = application_builder(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let result = application_setup(
            StartupDirectories {
                development_resources: if mode == "packaged" {
                    None
                } else {
                    Some(root.path().to_owned())
                },
                configuration: None,
            },
            |_| Ok(()),
            move |_| {
                assert_eq!(mode, "runtime");
                Err(tauri::Error::AssetNotFound(
                    "synthetic configuration capture refused".into(),
                ))
            },
            ControllerEffects {
                existing: |_: &str| -> Result<bool, &'static str> {
                    panic!("Invalid startup cannot inspect a live service")
                },
                start: |_: &std::path::Path,
                        _: &std::path::Path,
                        _: Option<&std::path::Path>|
                 -> Result<Backend, Box<dyn std::error::Error>> {
                    panic!("Invalid startup cannot launch a Controller")
                },
                notifications: |_: &tauri::App<tauri::test::MockRuntime>| {
                    panic!("Invalid startup cannot poll")
                },
                reopen: |_: &tauri::AppHandle<tauri::test::MockRuntime>| {
                    panic!("Invalid startup cannot reconnect a VM")
                },
            },
        )(&mut app);
        assert!(result.is_err());
        assert!(app.try_state::<runtime::RuntimeConfig>().is_none());
        assert!(app.try_state::<Backend>().is_none());
    }
}

#[cfg(windows)]
#[path = "startup_plugins.rs"]
mod plugins;

#[test]
fn native_startup_refuses_missing_resources_before_service_access_and_dynamic_build_paths_match_the_mode(
) {
    let root = tempfile::tempdir().unwrap();
    let manifest = root.path().join("native");
    let directories = StartupDirectories::for_build(&manifest, true);
    assert_eq!(
        directories.development_resources,
        Some(manifest.join("resources"))
    );
    assert_eq!(directories.configuration, Some(root.path().to_owned()));
    let packaged = StartupDirectories::for_build(&manifest, false);
    assert!(packaged.development_resources.is_none());
    assert!(packaged.configuration.is_none());
    let mut app = application_builder(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    assert!(
        app.default_window_icon().is_none(),
        "The native tray adapter must stop before creating an icon"
    );
    let error = native_setup(directories)(&mut app).unwrap_err();
    assert_eq!(
        error.to_string(),
        "The Go core resource manifest is missing"
    );
    assert!(app.try_state::<Backend>().is_none());
    assert!(runtime::data_directory(app.handle()).is_none());
    assert!(!manifest.exists());
}
