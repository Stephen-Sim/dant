use super::*;
use std::cell::RefCell;

#[derive(Debug, PartialEq)]
enum Effect {
    Text(Item, String),
    Enabled(bool),
    Tooltip(String),
}

#[derive(Default)]
struct Surface {
    effects: Vec<Effect>,
    fail_at: Option<usize>,
}

impl Surface {
    fn record(&mut self, effect: Effect) -> Result<(), String> {
        self.effects.push(effect);
        if self.fail_at == Some(self.effects.len()) {
            return Err("fixture tray failure".into());
        }
        Ok(())
    }
}

impl TraySurface for Surface {
    fn text(&mut self, item: Item, value: &str) -> Result<(), String> {
        self.record(Effect::Text(item, value.into()))
    }
    fn call_enabled(&mut self, active: bool) -> Result<(), String> {
        self.record(Effect::Enabled(active))
    }
    fn tooltip(&mut self, value: &str) -> Result<(), String> {
        self.record(Effect::Tooltip(value.into()))
    }
}

fn tray() -> Tray<Surface> {
    Tray {
        surface: Surface::default(),
        state: TrayState::default(),
    }
}
fn status() -> Status {
    Status {
        language: "en".into(),
        connection: "online".into(),
        task: "background".into(),
        queued: 2,
    }
}
#[test]
fn call_window_restore_labels_are_localized_and_separate_from_exit() {
    assert_eq!(call_window_label("en"), "Show call window");
    assert_eq!(call_window_label("zh"), "显示通话窗口");
    assert_ne!(call_window_label("en"), labels(&status()).2);
}
#[test]
fn close_hides_only_with_a_working_tray_and_never_during_explicit_exit() {
    assert!(should_hide(true, false, true));
    for values in [
        (false, false, true),
        (true, true, true),
        (true, false, false),
    ] {
        assert!(!should_hide(values.0, values.1, values.2));
    }
}
#[test]
fn statuses_are_bounded_metadata_and_never_arbitrary_text() {
    let mut value = status();
    assert!(valid(&value));
    value.task = "private task title".into();
    assert!(!valid(&value));
    value.task = "running".into();
    value.queued = 1000;
    assert!(!valid(&value));
    value.queued = 0;
    value.connection = "private exception".into();
    assert!(!valid(&value));
    assert!(serde_json::from_value::<Status>(serde_json::json!({"language":"en","connection":"online","task":"idle","queued":0,"token":"secret"})).is_err());
}
#[test]
fn tray_separates_background_waiting_and_unconfirmed_connection_states() {
    let mut value = status();
    assert_eq!(labels(&value).3, "Working in background · 2 queued");
    value.task = "waiting_user".into();
    value.queued = 0;
    assert_eq!(labels(&value).3, "Waiting for your reply");
    value.connection = "offline".into();
    assert_eq!(labels(&value).3, "Work status unconfirmed");
    value.language = "zh".into();
    assert_eq!(labels(&value).0, "打开 dant");
    assert_eq!(labels(&value).3, "任务状态待确认");
    value.task = "idle".into();
    assert_eq!(labels(&value).3, "离线");
}

#[test]
fn failed_hide_or_unavailable_tray_keeps_normal_close_available_without_hiding_other_windows() {
    let hides = RefCell::new(0);
    for (ready, exiting, label) in [
        (false, false, "main"),
        (true, true, "main"),
        (true, false, "call-overlay"),
    ] {
        assert!(!intercept_close(ready, exiting, label, || {
            *hides.borrow_mut() += 1;
            true
        }));
    }
    assert_eq!(*hides.borrow(), 0);
    assert!(!intercept_close(true, false, "main", || {
        *hides.borrow_mut() += 1;
        false
    }));
    assert!(intercept_close(true, false, "main", || {
        *hides.borrow_mut() += 1;
        true
    }));
    assert_eq!(*hides.borrow(), 2);
}

#[test]
fn installed_surface_becomes_ready_only_after_it_is_available_to_status_updates() {
    let ready = AtomicBool::new(false);
    let target = Mutex::new(None);
    assert!(!intercept_close(
        ready.load(Ordering::SeqCst),
        false,
        "main",
        || panic!("no tray")
    ));
    update_status::<Surface>(&target, "main", status()).unwrap();
    assert!(target.lock().unwrap().is_none());
    install_tray(&ready, &target, Surface::default());
    assert!(ready.load(Ordering::SeqCst));
    assert!(target.lock().unwrap().is_some());
    update_status(&target, "main", status()).unwrap();
    assert_eq!(
        target.lock().unwrap().as_ref().unwrap().state.last,
        Some(status())
    );
}

#[test]
fn native_status_updates_all_labels_and_tooltip_once_and_deduplicates_confirmed_state_only() {
    let target = Mutex::new(Some(tray()));
    update_status(&target, "main", status()).unwrap();
    update_status(&target, "main", status()).unwrap();
    let state = target.lock().unwrap();
    let tray = state.as_ref().unwrap();
    assert_eq!(
        tray.surface.effects,
        [
            Effect::Text(Item::Open, "Open dant".into()),
            Effect::Text(Item::Progress, "Work progress".into()),
            Effect::Text(Item::CallWindow, "Show call window".into()),
            Effect::Text(Item::Exit, "Exit dant".into()),
            Effect::Text(Item::Status, "Working in background · 2 queued".into()),
            Effect::Tooltip("dant · Working in background · 2 queued".into()),
        ]
    );
    assert_eq!(tray.state.call_language, "en");
    assert_eq!(tray.state.last, Some(status()));
}

#[test]
fn each_failed_menu_or_tooltip_write_leaves_the_status_unconfirmed_and_allows_a_fresh_update() {
    for fail_at in 1..=6 {
        let mut surface = tray();
        surface.surface.fail_at = Some(fail_at);
        let target = Mutex::new(Some(surface));
        assert!(update_status(&target, "main", status()).is_err());
        {
            let mut state = target.lock().unwrap();
            let tray = state.as_mut().unwrap();
            assert!(tray.state.last.is_none());
            assert_eq!(tray.surface.effects.len(), fail_at);
            tray.surface.fail_at = None;
        }
        update_status(&target, "main", status()).unwrap();
        let state = target.lock().unwrap();
        let tray = state.as_ref().unwrap();
        assert_eq!(tray.surface.effects.len(), fail_at + 6);
        assert_eq!(tray.state.last, Some(status()));
    }
}

#[test]
fn invalid_status_and_window_identity_never_touch_the_native_surface() {
    let target = Mutex::new(Some(tray()));
    assert!(update_status(&target, "call-overlay", status()).is_err());
    let mut invalid = status();
    invalid.language = "private text".into();
    assert!(update_status(&target, "main", invalid).is_err());
    assert!(target
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .surface
        .effects
        .is_empty());

    let poisoned = Mutex::new(Some(tray()));
    std::thread::scope(|scope| {
        assert!(scope
            .spawn(|| {
                let _guard = poisoned.lock().unwrap();
                panic!("isolated poisoned fixture");
            })
            .join()
            .is_err());
    });
    assert_eq!(
        update_status(&poisoned, "main", status()).unwrap_err(),
        "The system tray is unavailable"
    );
}

#[test]
fn call_availability_and_language_commit_only_after_their_independent_native_operations_succeed() {
    let mut tray = tray();
    tray.surface.fail_at = Some(1);
    call_changed(&mut tray, true, Some("en"));
    assert!(!tray.state.call_active);
    assert_eq!(tray.state.call_language, "en");
    assert_eq!(
        tray.surface.effects,
        [
            Effect::Enabled(true),
            Effect::Text(Item::CallWindow, "Show call window".into())
        ]
    );
    tray.surface.fail_at = None;
    call_changed(&mut tray, true, None);
    assert!(tray.state.call_active);
    assert_eq!(tray.surface.effects.last(), Some(&Effect::Enabled(true)));
    let count = tray.surface.effects.len();
    call_changed(&mut tray, true, None);
    assert_eq!(tray.surface.effects.len(), count);

    tray.surface.fail_at = Some(count + 1);
    call_changed(&mut tray, true, Some("zh"));
    assert_eq!(tray.state.call_language, "en");
    tray.surface.fail_at = None;
    tray.state.last = Some(Status {
        language: "zh".into(),
        ..status()
    });
    call_changed(&mut tray, false, None);
    assert!(!tray.state.call_active);
    assert_eq!(tray.state.call_language, "zh");
    assert_eq!(
        tray.surface.effects.last(),
        Some(&Effect::Text(Item::CallWindow, "显示通话窗口".into()))
    );
}

#[test]
fn every_supported_task_and_connection_maps_to_bounded_localized_tray_status() {
    for (task, english) in [
        ("idle", "Online"),
        ("running", "Working"),
        ("background", "Working in background"),
        ("waiting_user", "Waiting for your reply"),
        ("pausing", "Pausing work"),
        ("unknown", "Work outcome unconfirmed"),
    ] {
        let value = Status {
            task: task.into(),
            queued: 0,
            ..status()
        };
        assert!(valid(&value));
        assert_eq!(labels(&value).3, english);
        assert!(!labels(&Status {
            language: "zh".into(),
            ..value
        })
        .3
        .is_empty());
    }
    for (connection, label) in [("connecting", "Connecting"), ("offline", "Offline")] {
        let value = Status {
            connection: connection.into(),
            task: "idle".into(),
            queued: 0,
            ..status()
        };
        assert!(valid(&value));
        assert_eq!(labels(&value).3, label);
    }
}

#[test]
fn menu_actions_restore_before_progress_and_never_confuse_call_visibility_with_exit() {
    #[derive(Default)]
    struct Actions(RefCell<Vec<&'static str>>);
    impl TrayActions for Actions {
        fn restore(&self) {
            self.0.borrow_mut().push("restore");
        }
        fn progress(&self) {
            self.0.borrow_mut().push("progress");
        }
        fn call_window(&self) {
            self.0.borrow_mut().push("call");
        }
        fn exit(&self) {
            self.0.borrow_mut().push("protected-exit");
        }
    }
    let actions = Actions::default();
    activate(&actions, "unknown");
    activate(&actions, "dant-status");
    assert!(actions.0.borrow().is_empty());
    for menu in [
        "dant-open",
        "dant-progress",
        "dant-call-window",
        "dant-exit",
    ] {
        activate(&actions, menu);
    }
    assert_eq!(
        *actions.0.borrow(),
        ["restore", "restore", "progress", "call", "protected-exit"]
    );
}

#[test]
fn sdk_ipc_keeps_tray_state_metadata_only_and_does_not_construct_a_real_tray() {
    let app = tauri::test::mock_builder()
        .manage(BackgroundTray::default())
        .invoke_handler(tauri::generate_handler![tray_status_update])
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
    let invoke = |window: &WebviewWindow<tauri::test::MockRuntime>, value| {
        tauri::test::get_ipc_response(
            window,
            tauri::webview::InvokeRequest {
                cmd: "tray_status_update".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(value),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
    };
    let status =
        serde_json::json!({"language":"en","connection":"online","task":"idle","queued":0});
    assert!(invoke(&main, serde_json::json!({"status":status})).is_ok());
    assert_eq!(
        invoke(&overlay, serde_json::json!({"status":status})).unwrap_err(),
        "Invalid background status"
    );
    let mut private = status.clone();
    private["title"] = "must not enter native state".into();
    assert!(invoke(&main, serde_json::json!({"status":private})).is_err());
    assert_eq!(language(app.handle()), "en");
    call_window_changed(app.handle(), true, Some("zh"));
    restore(app.handle());
    mark_exiting(app.handle());
    let state = app.state::<BackgroundTray>();
    assert!(state.exiting.load(Ordering::SeqCst));
    assert!(!state.ready.load(Ordering::SeqCst));
    assert!(state.inner.lock().unwrap().is_none());
}
