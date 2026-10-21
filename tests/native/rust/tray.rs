use super::*;

struct TooltipFixture {
    values: std::cell::RefCell<Vec<String>>,
    fail: std::cell::Cell<bool>,
}
impl TrayTooltip for TooltipFixture {
    fn set_tooltip(&self, value: &str) -> tauri::Result<()> {
        if self.fail.get() {
            return Err(tauri::Error::AssetNotFound(
                "synthetic unavailable icon".into(),
            ));
        }
        self.values.borrow_mut().push(value.into());
        Ok(())
    }
}

#[test]
fn native_menu_adapter_updates_only_owned_menu_handles_without_creating_a_tray_icon() {
    let app = tauri::test::mock_app();
    let menu = native_menu(&app).unwrap();
    assert_eq!(menu.menu.items().unwrap().len(), 6);
    assert_eq!(menu.open.text().unwrap(), "打开 dant");
    assert!(!menu.call_window.is_enabled().unwrap());
    assert!(!menu.status.is_enabled().unwrap());
    assert!(menu.exit.is_enabled().unwrap());
    let mut surface = NativeTray {
        icon: TooltipFixture {
            values: Default::default(),
            fail: Default::default(),
        },
        open: menu.open,
        progress: menu.progress,
        call_window: menu.call_window,
        status: menu.status,
        exit: menu.exit,
    };
    for (item, label) in [
        (Item::Open, "Open"),
        (Item::Progress, "Progress"),
        (Item::CallWindow, "Call"),
        (Item::Status, "Status"),
        (Item::Exit, "Exit"),
    ] {
        surface.text(item, label).unwrap();
    }
    assert_eq!(surface.open.text().unwrap(), "Open");
    assert_eq!(surface.progress.text().unwrap(), "Progress");
    assert_eq!(surface.call_window.text().unwrap(), "Call");
    assert_eq!(surface.status.text().unwrap(), "Status");
    assert_eq!(surface.exit.text().unwrap(), "Exit");
    surface.call_enabled(true).unwrap();
    assert!(surface.call_window.is_enabled().unwrap());
    surface.call_enabled(false).unwrap();
    assert!(!surface.call_window.is_enabled().unwrap());
    surface.tooltip("dant · synthetic").unwrap();
    assert_eq!(*surface.icon.values.borrow(), ["dant · synthetic"]);
    surface.icon.fail.set(true);
    assert_eq!(
        surface.tooltip("discarded").unwrap_err(),
        "The system tray is unavailable"
    );
}
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
fn pending_menu_rows_stay_short_and_nonempty_in_every_supported_language() {
    let registry: serde_json::Value = serde_json::from_str(include_str!(
        "../../../resources/i18n/language-registry.json"
    ))
    .unwrap();
    for entry in registry.as_array().unwrap() {
        let language = entry["code"].as_str().unwrap();
        let target = Mutex::new(Some(tray()));
        update_status(
            &target,
            "main",
            Status {
                language: language.into(),
                ..status()
            },
        )
        .unwrap();
        set_exit_pending(&target, true, language).unwrap();
        let inner = target.lock().unwrap();
        let effects = &inner.as_ref().unwrap().surface.effects;
        for effect in &effects[effects.len() - 6..effects.len() - 1] {
            let Effect::Text(_, text) = effect else {
                panic!("Every tray menu row must keep its label");
            };
            assert!(!text.trim().is_empty(), "Missing {language} menu text");
        }
        let pending = exit_pending_status(language);
        assert!(pending.chars().count() <= 24, "Oversized {language} status");
        assert_eq!(
            effects[effects.len() - 2],
            Effect::Text(Item::Status, pending)
        );
        assert_eq!(
            effects.last(),
            Some(&Effect::Tooltip(format!(
                "dant · {}",
                exit_pending_detail(language)
            )))
        );
        if !matches!(language, "en" | "zh") {
            assert_ne!(exit_pending_status(language), "Waiting");
        }
    }
}

#[test]
fn production_tray_writers_apply_complete_paints_on_the_ui_thread() {
    fn paint<R: tauri::Runtime>(handle: &AppHandle<R>, queued: u16, active: bool) {
        update_status_on_main_thread(handle, "main", Status { queued, ..status() }).unwrap();
        call_window_changed(handle, active, Some("zh"));
        exit_pending(handle, true);
        exit_pending(handle, false);
    }

    struct ThreadSurface {
        owner: std::thread::ThreadId,
        effects: std::sync::Arc<Mutex<Vec<Effect>>>,
    }
    impl TraySurface for ThreadSurface {
        fn text(&mut self, item: Item, value: &str) -> Result<(), String> {
            assert_eq!(std::thread::current().id(), self.owner);
            self.effects
                .lock()
                .unwrap()
                .push(Effect::Text(item, value.into()));
            Ok(())
        }
        fn call_enabled(&mut self, active: bool) -> Result<(), String> {
            assert_eq!(std::thread::current().id(), self.owner);
            self.effects.lock().unwrap().push(Effect::Enabled(active));
            Ok(())
        }
        fn tooltip(&mut self, value: &str) -> Result<(), String> {
            assert_eq!(std::thread::current().id(), self.owner);
            self.effects
                .lock()
                .unwrap()
                .push(Effect::Tooltip(value.into()));
            Ok(())
        }
    }

    let app = tauri::test::mock_builder()
        .manage(BackgroundTray::default())
        .build(tray_context())
        .unwrap();
    let effects = std::sync::Arc::new(Mutex::new(Vec::new()));
    let main = WebviewWindow::builder(&app, "main", tauri::WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    let state = app.state::<BackgroundTray>();
    install_tray(
        &state.ready,
        &state.inner,
        Box::new(ThreadSurface {
            owner: std::thread::current().id(),
            effects: effects.clone(),
        }) as Box<dyn TraySurface + Send>,
    );
    let worker = std::sync::Arc::new(Mutex::new(None));
    let started = worker.clone();
    app.run(move |handle, event| {
        if let tauri::RunEvent::Ready = event {
            paint(handle, 2, true);
            let handle = handle.clone();
            let main = main.clone();
            *started.lock().unwrap() = Some(std::thread::spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    paint(&handle, 3, false);
                }));
                main.close().unwrap();
                result.unwrap();
            }));
        }
    });
    worker.lock().unwrap().take().unwrap().join().unwrap();
    let effects = effects.lock().unwrap();
    assert_eq!(effects.len(), 40);
    assert_eq!(effects[6], Effect::Enabled(true));
    assert_eq!(
        effects[7],
        Effect::Text(Item::CallWindow, "显示通话窗口".into())
    );
    assert_eq!(
        effects[12],
        Effect::Text(Item::Status, exit_pending_status("en"))
    );
    assert_eq!(
        effects[18],
        Effect::Text(Item::Status, "Working in background · 2 queued".into())
    );
    assert_eq!(
        effects.last(),
        Some(&Effect::Tooltip(
            "dant · Working in background · 3 queued".into()
        ))
    );
}

#[test]
fn a_timed_out_queued_paint_never_runs_when_the_ui_loop_recovers() {
    let app = tauri::test::mock_builder().build(tray_context()).unwrap();
    let main = WebviewWindow::builder(&app, "main", tauri::WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    let painted = std::sync::Arc::new(AtomicBool::new(false));
    let observed = painted.clone();
    app.run(move |handle, event| {
        if let tauri::RunEvent::Ready = event {
            let handle = handle.clone();
            let painted = observed.clone();
            let main = main.clone();
            // Hold the isolated mock event loop here until the queued paint
            // expires, then let it process that callback and the mock close.
            std::thread::spawn(move || {
                assert_eq!(
                    paint_with_timeout(
                        &handle,
                        move |_| {
                            painted.store(true, Ordering::SeqCst);
                            Ok(())
                        },
                        std::time::Duration::from_millis(10),
                    )
                    .unwrap_err(),
                    "The system tray is unavailable"
                );
                main.close().unwrap();
            })
            .join()
            .unwrap();
        }
    });
    assert!(!painted.load(Ordering::SeqCst));
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
fn exit_progress_survives_normal_status_updates_and_restores_the_latest_language() {
    let target = Mutex::new(Some(tray()));
    update_status(&target, "main", status()).unwrap();
    set_exit_pending(&target, true, "en").unwrap();
    let changed = Status {
        language: "zh".into(),
        task: "idle".into(),
        queued: 0,
        ..status()
    };
    update_status(&target, "main", changed.clone()).unwrap();
    {
        let inner = target.lock().unwrap();
        let tray = inner.as_ref().unwrap();
        assert!(tray.state.exit_pending);
        assert_eq!(tray.state.displayed_exit_pending, Some(true));
        assert_eq!(tray.state.last.as_ref(), Some(&changed));
        let last = &tray.surface.effects[tray.surface.effects.len() - 3..];
        assert_eq!(last[0], Effect::Text(Item::Exit, "正在退出 dant…".into()));
        assert_eq!(
            last[1],
            Effect::Text(Item::Status, exit_pending_status("zh"))
        );
        assert_eq!(
            last[2],
            Effect::Tooltip(format!("dant · {}", exit_pending_detail("zh")))
        );
    }
    set_exit_pending(&target, false, "en").unwrap();
    let inner = target.lock().unwrap();
    let tray = inner.as_ref().unwrap();
    assert!(!tray.state.exit_pending);
    assert_eq!(tray.state.displayed_exit_pending, Some(false));
    let last = &tray.surface.effects[tray.surface.effects.len() - 3..];
    assert_eq!(last[0], Effect::Text(Item::Exit, "退出 dant".into()));
    assert_eq!(last[1], Effect::Text(Item::Status, "在线".into()));
}

#[test]
fn a_failed_exit_clear_is_retained_until_the_ui_can_repaint() {
    let target = Mutex::new(Some(tray()));
    update_status(&target, "main", status()).unwrap();
    set_exit_pending(&target, true, "en").unwrap();
    request_exit_pending(&target, false).unwrap();
    {
        let inner = target.lock().unwrap();
        let tray = inner.as_ref().unwrap();
        assert!(!tray.state.exit_pending);
        assert_eq!(tray.state.displayed_exit_pending, Some(true));
    }

    update_status(&target, "main", status()).unwrap();
    let inner = target.lock().unwrap();
    let tray = inner.as_ref().unwrap();
    assert_eq!(tray.state.displayed_exit_pending, Some(false));
    let effects = &tray.surface.effects;
    assert_eq!(
        effects[effects.len() - 3],
        Effect::Text(Item::Exit, "Exit dant".into())
    );
    assert_eq!(
        effects.last(),
        Some(&Effect::Tooltip(
            "dant · Working in background · 2 queued".into()
        ))
    );
}

#[test]
fn failed_exit_progress_display_keeps_the_requested_state_and_can_refresh_again() {
    for pending in [true, false] {
        for fail_at in 1..=6 {
            let target = Mutex::new(Some(tray()));
            update_status(&target, "main", status()).unwrap();
            if !pending {
                set_exit_pending(&target, true, "en").unwrap();
            }
            {
                let mut inner = target.lock().unwrap();
                let tray = inner.as_mut().unwrap();
                tray.surface.fail_at = Some(tray.surface.effects.len() + fail_at);
            }
            assert!(set_exit_pending(&target, pending, "en").is_err());
            {
                let mut inner = target.lock().unwrap();
                let tray = inner.as_mut().unwrap();
                assert_eq!(tray.state.exit_pending, pending);
                assert_eq!(tray.state.displayed_exit_pending, None);
                tray.surface.fail_at = None;
            }
            update_status(&target, "main", status()).unwrap();
            assert_eq!(
                target
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .state
                    .displayed_exit_pending,
                Some(pending)
            );
        }
    }
}

#[test]
fn partial_exit_progress_is_cleared_without_an_intermediate_successful_refresh() {
    for fail_at in 1..=6 {
        let target = Mutex::new(Some(tray()));
        update_status(&target, "main", status()).unwrap();
        {
            let mut inner = target.lock().unwrap();
            let tray = inner.as_mut().unwrap();
            tray.surface.fail_at = Some(tray.surface.effects.len() + fail_at);
        }
        assert!(set_exit_pending(&target, true, "en").is_err());
        let partial = {
            let mut inner = target.lock().unwrap();
            let tray = inner.as_mut().unwrap();
            tray.surface.fail_at = None;
            tray.surface.effects.len()
        };
        set_exit_pending(&target, false, "en").unwrap();
        let inner = target.lock().unwrap();
        let effects = &inner.as_ref().unwrap().surface.effects;
        assert_eq!(effects.len(), partial + 6);
        assert_eq!(
            effects[effects.len() - 3],
            Effect::Text(Item::Exit, "Exit dant".into())
        );
        assert_eq!(
            effects.last(),
            Some(&Effect::Tooltip(
                "dant · Working in background · 2 queued".into()
            ))
        );
    }
}

#[test]
fn partial_status_change_can_return_to_the_previously_confirmed_status() {
    for fail_at in 1..=6 {
        let target = Mutex::new(Some(tray()));
        update_status(&target, "main", status()).unwrap();
        {
            let mut inner = target.lock().unwrap();
            let tray = inner.as_mut().unwrap();
            tray.surface.fail_at = Some(tray.surface.effects.len() + fail_at);
        }
        let changed = Status {
            language: "zh".into(),
            connection: "offline".into(),
            task: "idle".into(),
            queued: 0,
        };
        assert!(update_status(&target, "main", changed).is_err());
        let partial = {
            let mut inner = target.lock().unwrap();
            let tray = inner.as_mut().unwrap();
            tray.surface.fail_at = None;
            tray.surface.effects.len()
        };
        update_status(&target, "main", status()).unwrap();
        let inner = target.lock().unwrap();
        let effects = &inner.as_ref().unwrap().surface.effects;
        assert_eq!(effects.len(), partial + 6);
        assert_eq!(
            effects[effects.len() - 3],
            Effect::Text(Item::Exit, "Exit dant".into())
        );
        assert_eq!(
            effects.last(),
            Some(&Effect::Tooltip(
                "dant · Working in background · 2 queued".into()
            ))
        );
    }
}

#[test]
fn native_exit_progress_is_nonfatal_when_the_tray_display_is_unavailable() {
    let app = crate::application_builder(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let main = WebviewWindow::builder(&app, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("dant")
        .build()
        .unwrap();
    std::thread::scope(|scope| {
        let state = app.state::<BackgroundTray>();
        assert!(scope
            .spawn(move || {
                let _guard = state.inner.lock().unwrap();
                panic!("isolated unavailable tray");
            })
            .join()
            .is_err());
    });
    exit_pending(app.handle(), true);
    assert_eq!(exit_window_title("en", true), "dant · Exiting…");
    assert_eq!(exit_window_title("zh", true), "dant · 正在退出…");
    assert!(main.is_visible().unwrap());
    exit_pending(app.handle(), false);
    assert_eq!(exit_window_title("zh", false), "dant");
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
    let app = crate::application_builder(tauri::test::mock_builder())
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

fn tray_context() -> tauri::Context<tauri::test::MockRuntime> {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.dant.trayfixture.p{}", std::process::id());
    assert_ne!(context.config().identifier, "com.dant.desktop");
    context.set_default_window_icon(Some(tauri::image::Image::new_owned(
        vec![0, 0, 0, 255],
        1,
        1,
    )));
    context
}
#[test]
fn tray_setup_uses_the_actual_sdk_menu_builder_and_manages_only_the_supplied_surface() {
    let app = crate::application_builder(tauri::test::mock_builder())
        .build(tray_context())
        .unwrap();
    let main =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    setup_using(&app, |_| {
        Ok(TooltipFixture {
            values: Default::default(),
            fail: Default::default(),
        })
    })
    .unwrap();
    let state = app.state::<BackgroundTray>();
    assert!(state.ready.load(Ordering::Acquire));
    update_status(&state.inner, "main", status()).unwrap();
    assert_eq!(language(app.handle()), "en");
    call_window_changed(app.handle(), true, None);
    call_window_changed(app.handle(), false, Some("zh"));
    {
        let inner = state.inner.lock().unwrap();
        let tray = inner.as_ref().unwrap();
        assert!(!tray.state.call_active);
        assert_eq!(tray.state.call_language, "zh");
    }
    use tauri::Listener;
    let events = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = events.clone();
    main.listen("dant-tray-progress", move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
    });
    for id in ["dant-open", "dant-progress", "dant-call-window", "unknown"] {
        menu_event(app.handle(), MenuEvent { id: id.into() });
    }
    // No DesktopExit state means this adapter cannot request a real transition.
    let empty = tauri::test::mock_app();
    let untracked = tauri::WebviewWindowBuilder::new(
        &empty,
        "untracked",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .build()
    .unwrap();
    assert!(!on_window_event(
        &untracked.as_ref().window(),
        &tauri::WindowEvent::Focused(true)
    ));
    menu_event(
        empty.handle(),
        MenuEvent {
            id: "dant-exit".into(),
        },
    );
    assert_eq!(events.load(Ordering::SeqCst), 1);
    for (button, button_state, expected) in [
        (MouseButton::Left, MouseButtonState::Up, true),
        (MouseButton::Left, MouseButtonState::Down, false),
        (MouseButton::Right, MouseButtonState::Up, false),
    ] {
        let event = TrayIconEvent::Click {
            id: ID.into(),
            position: tauri::PhysicalPosition::new(0.0, 0.0),
            rect: tauri::Rect {
                position: tauri::PhysicalPosition::new(0, 0).into(),
                size: tauri::PhysicalSize::new(1, 1).into(),
            },
            button,
            button_state,
        };
        assert_eq!(left_click(&event), expected);
        tray_icon_event(app.handle(), event);
    }
    assert!(!left_click(&TrayIconEvent::Enter {
        id: ID.into(),
        position: tauri::PhysicalPosition::new(0.0, 0.0),
        rect: tauri::Rect {
            position: tauri::PhysicalPosition::new(0, 0).into(),
            size: tauri::PhysicalSize::new(1, 1).into()
        }
    }));
}
#[test]
fn missing_icon_failed_creation_and_poisoned_surface_leave_ordinary_close_available() {
    let app = tauri::test::mock_builder()
        .manage(BackgroundTray::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    assert!(setup_using(&app, |_| -> tauri::Result<TooltipFixture> {
        panic!("No icon must not create any tray")
    })
    .is_err());
    assert!(!app.state::<BackgroundTray>().ready.load(Ordering::Acquire));
    let app = tauri::test::mock_builder()
        .manage(BackgroundTray::default())
        .build(tray_context())
        .unwrap();
    assert!(setup_using(&app, |_| -> tauri::Result<TooltipFixture> {
        Err(tauri::Error::AssetNotFound("synthetic failed tray".into()))
    })
    .is_err());
    assert!(!app.state::<BackgroundTray>().ready.load(Ordering::Acquire));
    let state = app.state::<BackgroundTray>();
    std::thread::scope(|scope| {
        assert!(scope
            .spawn(|| {
                let _guard = state.inner.lock().unwrap();
                std::panic::resume_unwind(Box::new(()));
            })
            .join()
            .is_err());
    });
    call_window_changed(app.handle(), true, Some("zh"));
    assert_eq!(language(app.handle()), "en");
}
#[cfg(windows)]
#[test]
fn sdk_close_interception_hides_then_allows_explicit_exit_inside_an_isolated_child() {
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let output = tempfile::tempfile().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "tray::tests::synthetic_tray_event_child",
            "--nocapture",
        ])
        .env("DANT_NATIVE_TRAY_FIXTURE", "owned")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(output.try_clone().unwrap()))
        .creation_flags(crate::runtime::CREATE_NO_WINDOW);
    let mut child = OwnedChild(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            if !status.success() {
                use std::io::{Read, Seek};
                let mut output = output;
                output.rewind().unwrap();
                let mut bytes = Vec::new();
                output.take(65536).read_to_end(&mut bytes).unwrap();
                panic!(
                    "Synthetic SDK event fixture failed: {}",
                    String::from_utf8_lossy(&bytes)
                );
            }
            break;
        }
        assert!(
            Instant::now() < deadline,
            "The isolated SDK event fixture must terminate"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[cfg(windows)]
#[test]
fn synthetic_tray_event_child() {
    if std::env::var("DANT_NATIVE_TRAY_FIXTURE").as_deref() != Ok("owned") {
        return;
    }
    let app = crate::application_builder(tauri::test::mock_builder())
        .build(tray_context())
        .unwrap();
    setup_using(&app, |_| {
        Ok(TooltipFixture {
            values: Default::default(),
            fail: Default::default(),
        })
    })
    .unwrap();
    let main =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let closes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = closes.clone();
    app.run(move |handle, event| {
        // MockRuntime exposes the real close API through app events but does
        // not dispatch registered window listeners. Feed the production entry.
        if let tauri::RunEvent::WindowEvent { label, event, .. } = &event {
            crate::application_window_event(
                &handle.get_webview_window(label).unwrap().as_ref().window(),
                event,
            );
        }
        match &event {
            tauri::RunEvent::Ready => main.close().unwrap(),
            tauri::RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { .. },
                ..
            } => {
                if observed.fetch_add(1, Ordering::SeqCst) == 0 {
                    assert!(handle
                        .state::<BackgroundTray>()
                        .ready
                        .load(Ordering::Acquire));
                    mark_exiting(handle);
                    main.close().unwrap();
                }
            }
            tauri::RunEvent::Exit => crate::application_event(handle, event),
            _ => {}
        }
    });
    assert_eq!(closes.load(Ordering::SeqCst), 2);
}
