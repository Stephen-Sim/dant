use super::*;
use std::{cell::RefCell, collections::HashSet, rc::Rc};

#[test]
fn sdk_window_failures_keep_the_exact_operation_message_and_redact_native_error_contents() {
    for (failure, expected) in [
        (WindowFailure::Size, "Call window size is unavailable"),
        (
            WindowFailure::Position,
            "Call window position is unavailable",
        ),
        (WindowFailure::Hide, "Call window could not be hidden"),
        (WindowFailure::Show, "Call window could not be shown"),
        (
            WindowFailure::Focusable(false),
            "Call window could not be shown",
        ),
        (
            WindowFailure::Focusable(true),
            "Call window controls are unavailable",
        ),
        (
            WindowFailure::Restore,
            "The main window could not be restored",
        ),
        (
            WindowFailure::MainShow,
            "The main window could not be shown",
        ),
        (
            WindowFailure::MainFocus,
            "The main window could not be focused",
        ),
        (WindowFailure::Drag, "Call window dragging is unavailable"),
        (WindowFailure::Create, "Call window could not be created"),
        (WindowFailure::Action, "The call action was not confirmed"),
    ] {
        assert_eq!(
            redacted_result::<()>(
                Err(tauri::Error::AssetNotFound(
                    "owned private native path".into()
                )),
                failure
            )
            .unwrap_err(),
            expected
        );
    }
    assert_eq!(
        redacted_result(Ok(tauri::PhysicalSize::new(800, 600)), WindowFailure::Size).unwrap(),
        tauri::PhysicalSize::new(800, 600)
    );
    assert_eq!(
        redacted_result::<tauri::PhysicalSize<u32>>(
            Err(tauri::Error::AssetNotFound(
                "owned private size error".into()
            )),
            WindowFailure::Size
        )
        .unwrap_err(),
        "Call window size is unavailable"
    );
}

#[test]
fn sdk_monitor_conversion_uses_the_work_area_and_scale_instead_of_full_screen_bounds() {
    let native = tauri_runtime::monitor::Monitor {
        name: Some("owned synthetic monitor".into()),
        position: PhysicalPosition::new(-1920, -80),
        size: tauri::PhysicalSize::new(1920, 1080),
        work_area: tauri::PhysicalRect {
            position: PhysicalPosition::new(-1900, -60),
            size: tauri::PhysicalSize::new(1880, 1020),
        },
        scale_factor: 1.5,
    };
    let actual = area(native.into());
    assert_eq!(
        actual,
        Area {
            x: -1900,
            y: -60,
            width: 1880,
            height: 1020,
            scale: 1.5
        }
    );
    assert_eq!(
        position(actual, 360, 76, None),
        PhysicalPosition::new(-404, 860)
    );
}

#[derive(Clone)]
struct FakeWindow(Rc<RefCell<WindowState>>);

struct WindowState {
    minimized: bool,
    visible: bool,
    area: Option<Area>,
    size: (u32, u32),
    point: Option<PhysicalPosition<i32>>,
    failures: HashSet<&'static str>,
    operations: Vec<String>,
    published: Vec<CallState>,
}

impl FakeWindow {
    fn new(visible: bool) -> Self {
        Self(Rc::new(RefCell::new(WindowState {
            minimized: false,
            visible,
            area: Some(Area {
                x: 0,
                y: 0,
                width: 1280,
                height: 720,
                scale: 1.0,
            }),
            size: (360, 76),
            point: None,
            failures: HashSet::new(),
            operations: Vec::new(),
            published: Vec::new(),
        })))
    }

    fn operation(&self, name: &'static str) -> Result<(), String> {
        let mut state = self.0.borrow_mut();
        state.operations.push(name.into());
        if state.failures.contains(name) {
            return Err(format!("fixture {name} failed"));
        }
        Ok(())
    }
}

impl CallWindow for FakeWindow {
    fn minimized(&self) -> bool {
        self.0.borrow().minimized
    }
    fn visible(&self, _: bool) -> bool {
        self.0.borrow().visible
    }
    fn monitor(&self) -> Option<Area> {
        self.0.borrow().area
    }
    fn size(&self) -> Result<(u32, u32), String> {
        self.operation("size")?;
        Ok(self.0.borrow().size)
    }
    fn position(&self) -> Option<PhysicalPosition<i32>> {
        self.0.borrow().point
    }
    fn move_to(&self, point: PhysicalPosition<i32>) -> Result<(), String> {
        self.operation("move")?;
        self.0.borrow_mut().point = Some(point);
        Ok(())
    }
    fn hide(&self) -> Result<(), String> {
        self.operation("hide")?;
        self.0.borrow_mut().visible = false;
        Ok(())
    }
    fn show(&self) -> Result<(), String> {
        self.operation("show")?;
        self.0.borrow_mut().visible = true;
        Ok(())
    }
    fn focusable(&self, value: bool) -> Result<(), String> {
        self.operation(if value { "focusable" } else { "unfocusable" })
    }
    fn restore(&self) -> Result<(), String> {
        self.operation("restore")?;
        self.0.borrow_mut().minimized = false;
        self.show()?;
        self.operation("focus")
    }
    fn publish(&self, call: &CallState) {
        self.0.borrow_mut().published.push(call.clone());
    }
    fn destroy(&self) {
        let _ = self.operation("destroy");
    }
    fn drag(&self) -> Result<(), String> {
        self.operation("drag")
    }
}

struct FakeHost {
    main: Option<FakeWindow>,
    overlay: RefCell<Option<FakeWindow>>,
    created: FakeWindow,
    creation_error: bool,
    during_create: RefCell<Option<Box<dyn Fn()>>>,
    actions: RefCell<Vec<Action>>,
    action_error: bool,
    schedules: RefCell<usize>,
    tray: RefCell<Vec<(bool, Option<String>)>>,
}

impl FakeHost {
    fn new() -> Self {
        let main = FakeWindow::new(true);
        main.0.borrow_mut().minimized = true;
        Self {
            main: Some(main),
            overlay: RefCell::new(None),
            created: FakeWindow::new(false),
            creation_error: false,
            during_create: RefCell::new(None),
            actions: RefCell::new(Vec::new()),
            action_error: false,
            schedules: RefCell::new(0),
            tray: RefCell::new(Vec::new()),
        }
    }
}

impl OverlayHost for FakeHost {
    type Window = FakeWindow;
    fn window(&self, label: &str) -> Option<Self::Window> {
        match label {
            "main" => self.main.clone(),
            LABEL => self.overlay.borrow().clone(),
            _ => panic!("unexpected window label"),
        }
    }
    fn create_overlay(&self) -> Result<Self::Window, String> {
        self.created.operation("create")?;
        if self.creation_error {
            return Err("fixture create failed".into());
        }
        self.overlay.replace(Some(self.created.clone()));
        if let Some(callback) = self.during_create.borrow_mut().take() {
            callback();
        }
        Ok(self.created.clone())
    }
    fn action(&self, action: Action) -> Result<(), String> {
        self.actions.borrow_mut().push(action);
        if self.action_error {
            return Err("fixture action failed".into());
        }
        Ok(())
    }
    fn schedule(&self) {
        *self.schedules.borrow_mut() += 1;
    }
    fn tray_changed(&self, active: bool, language: Option<&str>) {
        self.tray
            .borrow_mut()
            .push((active, language.map(str::to_string)));
    }
}

fn active_overlay() -> CallOverlay {
    let managed = CallOverlay::default();
    managed.inner.lock().unwrap().update(Some(call("call-a")));
    managed
}

fn request(action: &str, id: &str) -> Action {
    Action {
        call_id: "call-a".into(),
        action: action.into(),
        request_id: id.into(),
        muted: None,
    }
}

#[test]
fn navigation_only_accepts_the_overlay_at_packaged_or_canonical_development_origins() {
    for origin in [
        "tauri://localhost".to_string(),
        "http://tauri.localhost".to_string(),
        crate::protocol::dev_origin().to_string(),
    ] {
        assert!(allowed_navigation(
            &tauri::Url::parse(&format!("{origin}/call-overlay.html")).unwrap()
        ));
        assert!(!allowed_navigation(
            &tauri::Url::parse(&format!("{origin}/other.html")).unwrap()
        ));
    }

    for url in [
        "https://127.0.0.1:4318/call-overlay.html",
        "http://localhost:4318/call-overlay.html",
        "http://127.0.0.1:4317/call-overlay.html",
        "http://127.0.0.1:4319/call-overlay.html",
        "https://tauri.localhost/call-overlay.html",
        "tauri://external.invalid/call-overlay.html",
        "http://external.invalid:4318/call-overlay.html",
        "file:///call-overlay.html",
    ] {
        assert!(
            !allowed_navigation(&tauri::Url::parse(url).unwrap()),
            "{url}"
        );
    }
}

fn call(id: &str) -> CallState {
    CallState {
        call_id: id.into(),
        status: "talking".into(),
        connected_at: Some(123),
        seconds: 10,
        confirmed: true,
        running: true,
        muted: false,
        can_mute: true,
        language: "en".into(),
        theme: "dark".into(),
    }
}
#[test]
fn hidden_call_survives_metadata_refresh_without_changing_media_state() {
    let mut inner = Inner::default();
    inner.update(Some(call("call-a")));
    inner.hide("call-a").unwrap();
    assert!(inner.visible_call().is_none());
    assert_eq!(inner.call, Some(call("call-a")));
    let mut refreshed = call("call-a");
    refreshed.seconds = 25;
    refreshed.muted = true;
    refreshed.language = "zh".into();
    inner.update(Some(refreshed.clone()));
    assert!(inner.visible_call().is_none());
    assert!(inner.show("call-a"));
    assert_eq!(inner.visible_call(), Some(refreshed));
}
#[test]
fn new_call_is_visible_and_stale_hide_or_show_cannot_affect_it() {
    let mut inner = Inner::default();
    inner.update(Some(call("call-a")));
    inner.hide("call-a").unwrap();
    inner.update(Some(call("call-b")));
    assert_eq!(inner.visible_call(), Some(call("call-b")));
    assert!(inner.hide("call-a").is_err());
    assert_eq!(inner.visible_call(), Some(call("call-b")));
    inner.hide("call-b").unwrap();
    assert!(!inner.show("call-a"));
    assert!(inner.visible_call().is_none());
    assert!(inner.show("call-b"));
    assert_eq!(inner.visible_call(), Some(call("call-b")));
}
#[test]
fn ended_or_closing_calls_cannot_be_restored_or_hidden_by_late_controls() {
    let mut inner = Inner::default();
    inner.update(Some(call("call-a")));
    inner.hide("call-a").unwrap();
    inner.update(None);
    assert!(inner.hidden_for.is_none());
    assert!(!inner.show("call-a"));
    assert!(inner.hide("call-a").is_err());
    assert!(inner.call.is_none());
    inner.update(Some(call("call-b")));
    inner.closing = true;
    assert!(!inner.show("call-b"));
    assert!(inner.hide("call-b").is_err());
    assert!(inner.visible_call().is_none());
}
#[test]
fn work_area_placement_respects_taskbars_negative_monitors_and_dpi() {
    let area = Area {
        x: -1920,
        y: -80,
        width: 1920,
        height: 1040,
        scale: 1.5,
    };
    assert_eq!(
        position(area, 540, 114, None),
        PhysicalPosition::new(-564, 822)
    );
    assert_eq!(
        position(area, 540, 114, Some((-4000, 4000))),
        PhysicalPosition::new(-1896, 822)
    );
    assert_eq!(
        position(area, 540, 114, Some((-1000, 200))),
        PhysicalPosition::new(-1000, 200)
    );
}
#[test]
fn oversized_or_tiny_work_areas_never_panic_or_place_the_origin_outside() {
    let area = Area {
        x: 10,
        y: 20,
        width: 100,
        height: 40,
        scale: 2.0,
    };
    assert_eq!(position(area, 360, 76, None), PhysicalPosition::new(10, 20));
    assert!(!identifier("call\nprivate"));
    assert!(!identifier(""));
    assert!(identifier("call-a:1"));
}
#[test]
fn metadata_validation_rejects_unbounded_or_unknown_context() {
    let mut value = CallState {
        call_id: "call-a".into(),
        status: "talking".into(),
        connected_at: Some(123),
        seconds: 10,
        confirmed: true,
        running: true,
        muted: false,
        can_mute: true,
        language: "en".into(),
        theme: "dark".into(),
    };
    assert!(valid(&value));
    value.status = "private transcript".into();
    assert!(!valid(&value));
    value.status = "talking".into();
    value.connected_at = Some(u64::MAX);
    assert!(!valid(&value));
    assert!(serde_json::from_value::<CallState>(
        serde_json::json!({"callId":"a","token":"secret"})
    )
    .is_err());
}

#[test]
fn background_sync_places_once_publishes_current_state_and_shows_without_focus() {
    let managed = active_overlay();
    let host = FakeHost::new();
    sync(&managed, &host).unwrap();
    assert_eq!(
        host.created.0.borrow().point,
        Some(PhysicalPosition::new(904, 628))
    );
    assert_eq!(host.created.0.borrow().published, [call("call-a")]);
    assert_eq!(
        host.created.0.borrow().operations,
        ["create", "size", "move", "unfocusable", "show", "focusable"]
    );
    assert_eq!(
        managed.inner.lock().unwrap().placed_for.as_deref(),
        Some("call-a")
    );

    host.created.0.borrow_mut().point = Some(PhysicalPosition::new(100, 200));
    sync(&managed, &host).unwrap();
    assert_eq!(
        host.created.0.borrow().point,
        Some(PhysicalPosition::new(100, 200))
    );
    assert_eq!(
        host.created
            .0
            .borrow()
            .operations
            .iter()
            .filter(|op| *op == "create")
            .count(),
        1
    );
    assert_eq!(host.created.0.borrow().published.len(), 2);
}

#[test]
fn foreground_missing_main_ended_and_hidden_calls_do_not_create_or_show_windows() {
    for reason in ["foreground", "ended", "hidden", "closing", "missing-main"] {
        let managed = active_overlay();
        let mut host = FakeHost::new();
        host.overlay.replace(Some(host.created.clone()));
        host.created.0.borrow_mut().visible = true;
        match reason {
            "foreground" => host.main.as_ref().unwrap().0.borrow_mut().minimized = false,
            "ended" => managed.inner.lock().unwrap().update(None),
            "hidden" => managed.inner.lock().unwrap().hide("call-a").unwrap(),
            "closing" => managed.inner.lock().unwrap().closing = true,
            _ => host.main = None,
        }
        sync(&managed, &host).unwrap();
        let state = host.created.0.borrow();
        assert!(state.published.is_empty(), "{reason}");
        assert_eq!(
            state.operations,
            if reason == "missing-main" {
                vec![]
            } else {
                vec!["hide"]
            }
        );
    }
}

#[test]
fn creation_races_cannot_publish_a_retired_call_or_cover_a_restored_main_window() {
    for change in ["ended", "new-call", "closing", "foreground"] {
        let managed = Rc::new(active_overlay());
        let host = FakeHost::new();
        let captured = managed.clone();
        let main = host.main.as_ref().unwrap().clone();
        host.during_create
            .replace(Some(Box::new(move || match change {
                "ended" => captured.inner.lock().unwrap().update(None),
                "new-call" => captured.inner.lock().unwrap().update(Some(call("call-b"))),
                "closing" => captured.inner.lock().unwrap().closing = true,
                _ => main.0.borrow_mut().minimized = false,
            })));
        sync(&managed, &host).unwrap();
        assert!(host.created.0.borrow().published.is_empty(), "{change}");
        assert!(!host.created.0.borrow().visible, "{change}");
        assert_eq!(host.created.0.borrow().operations.last().unwrap(), "hide");
    }
}

#[test]
fn display_failures_preserve_focusability_and_never_recreate_or_repeat_actions() {
    for failure in ["create", "size", "move", "unfocusable", "show", "focusable"] {
        let managed = active_overlay();
        let host = FakeHost::new();
        host.created.0.borrow_mut().failures.insert(failure);
        assert!(sync(&managed, &host).is_err(), "{failure}");
        let state = host.created.0.borrow();
        if failure == "show" {
            assert_eq!(state.operations.last().unwrap(), "focusable");
            assert!(!state.visible);
        }
        assert!(host.actions.borrow().is_empty());
    }
    let managed = active_overlay();
    let mut host = FakeHost::new();
    host.creation_error = true;
    assert!(sync(&managed, &host).is_err());
    assert!(host.overlay.borrow().is_none());
}

#[test]
fn sync_uses_cached_main_monitor_and_keeps_free_dragging_without_a_monitor() {
    let managed = active_overlay();
    let host = FakeHost::new();
    host.main.as_ref().unwrap().0.borrow_mut().minimized = false;
    sync(&managed, &host).unwrap();
    assert_eq!(
        managed.inner.lock().unwrap().main_area,
        host.main.as_ref().unwrap().0.borrow().area
    );
    host.main.as_ref().unwrap().0.borrow_mut().minimized = true;
    host.main.as_ref().unwrap().0.borrow_mut().area = None;
    sync(&managed, &host).unwrap();
    assert_eq!(
        host.created.0.borrow().point,
        Some(PhysicalPosition::new(904, 628))
    );

    let unplaced = active_overlay();
    let another = FakeHost::new();
    another.main.as_ref().unwrap().0.borrow_mut().area = None;
    another.created.0.borrow_mut().area = None;
    sync(&unplaced, &another).unwrap();
    assert!(another.created.0.borrow().visible);
    assert!(another.created.0.borrow().point.is_none());
    drag_allowed(&unplaced, LABEL).unwrap();
    drag(&another.created).unwrap();
}

#[test]
fn update_and_get_validate_window_metadata_and_stop_after_native_shutdown() {
    let managed = CallOverlay::default();
    let host = FakeHost::new();
    assert!(get(&managed, "main").is_err());
    assert!(get(&managed, LABEL).unwrap().is_none());
    assert!(update(&managed, &host, LABEL, Some(call("call-a"))).is_err());
    let mut invalid = call("call-a");
    invalid.language = "private text".into();
    assert!(update(&managed, &host, "main", Some(invalid)).is_err());
    assert!(host.tray.borrow().is_empty());

    update(&managed, &host, "main", Some(call("call-a"))).unwrap();
    assert_eq!(get(&managed, LABEL).unwrap(), Some(call("call-a")));
    assert_eq!(*host.tray.borrow(), [(true, Some("en".into()))]);
    update(&managed, &host, "main", None).unwrap();
    assert_eq!(host.tray.borrow().last(), Some(&(false, None)));
    managed.inner.lock().unwrap().closing = true;
    assert_eq!(
        update(&managed, &host, "main", Some(call("call-b"))).unwrap_err(),
        "Call window has stopped"
    );
    assert_eq!(*host.schedules.borrow(), 2);
}

#[test]
fn hide_changes_only_visibility_and_preserves_the_durable_call_and_media_state() {
    let managed = active_overlay();
    let host = FakeHost::new();
    host.overlay.replace(Some(host.created.clone()));
    act(&managed, &host, LABEL, request("hide", "hide-1")).unwrap();
    assert_eq!(get(&managed, LABEL).unwrap(), Some(call("call-a")));
    assert!(managed.inner.lock().unwrap().visible_call().is_none());
    assert!(host.actions.borrow().is_empty());
    assert_eq!(host.created.0.borrow().operations, ["hide"]);
    show_expected(&managed, &host, "call-old");
    assert_eq!(*host.schedules.borrow(), 1);
    show_expected(&managed, &host, "call-a");
    assert_eq!(*host.schedules.borrow(), 2);
    assert!(managed.inner.lock().unwrap().visible_call().is_some());
}

#[test]
fn controls_reject_wrong_identity_permissions_and_invalid_arguments_before_side_effects() {
    let managed = active_overlay();
    let host = FakeHost::new();
    assert!(act(&managed, &host, "main", request("hangup", "one")).is_err());
    for (field, value) in [
        ("call", "call-old"),
        ("call", ""),
        ("request", "bad\n"),
        ("action", "delete"),
    ] {
        let mut action = request("hangup", "one");
        match field {
            "call" => action.call_id = value.into(),
            "request" => action.request_id = value.into(),
            _ => action.action = value.into(),
        }
        assert!(act(&managed, &host, LABEL, action).is_err());
    }
    assert!(act(&managed, &host, LABEL, request("mute", "mute-1")).is_err());
    let mut action = request("mute", "mute-1");
    action.muted = Some(true);
    managed
        .inner
        .lock()
        .unwrap()
        .call
        .as_mut()
        .unwrap()
        .can_mute = false;
    assert!(act(&managed, &host, LABEL, action).is_err());
    managed.inner.lock().unwrap().closing = true;
    assert!(act(&managed, &host, LABEL, request("hangup", "one")).is_err());
    assert!(host.actions.borrow().is_empty());
    assert!(managed.inner.lock().unwrap().seen.is_empty());
}

#[test]
fn uncertain_actions_are_not_replayed_and_successful_new_ids_keep_a_bounded_history() {
    let managed = active_overlay();
    let mut host = FakeHost::new();
    host.action_error = true;
    assert!(act(&managed, &host, LABEL, request("hangup", "one")).is_err());
    act(&managed, &host, LABEL, request("hangup", "one")).unwrap();
    assert_eq!(host.actions.borrow().len(), 1);
    host.action_error = false;
    let mut mute = request("mute", "mute-1");
    mute.muted = Some(true);
    act(&managed, &host, LABEL, mute.clone()).unwrap();
    assert_eq!(host.actions.borrow().last(), Some(&mute));
    for index in 0..ACTION_HISTORY_LIMIT {
        act(
            &managed,
            &host,
            LABEL,
            request("hangup", &format!("next-{index}")),
        )
        .unwrap();
    }
    assert_eq!(
        managed.inner.lock().unwrap().seen.len(),
        ACTION_HISTORY_LIMIT
    );
    assert_eq!(
        managed.inner.lock().unwrap().seen.front().unwrap(),
        "next-0"
    );
    update(&managed, &host, "main", Some(call("call-b"))).unwrap();
    assert!(managed.inner.lock().unwrap().seen.is_empty());
}

#[test]
fn restore_errors_stop_before_emission_and_hide_errors_still_schedule_reconciliation() {
    for failure in ["restore", "show", "focus"] {
        let managed = active_overlay();
        let host = FakeHost::new();
        host.main
            .as_ref()
            .unwrap()
            .0
            .borrow_mut()
            .failures
            .insert(failure);
        assert!(act(&managed, &host, LABEL, request("restore", "one")).is_err());
        assert!(host.actions.borrow().is_empty());
        assert_eq!(*host.schedules.borrow(), 0);
    }
    let managed = active_overlay();
    let host = FakeHost::new();
    act(&managed, &host, LABEL, request("restore", "one")).unwrap();
    assert_eq!(
        host.main.as_ref().unwrap().0.borrow().operations,
        ["restore", "show", "focus"]
    );
    assert_eq!(
        host.actions.borrow().as_slice(),
        [request("restore", "one")]
    );
    host.overlay.replace(Some(host.created.clone()));
    host.created.0.borrow_mut().failures.insert("hide");
    assert!(act(&managed, &host, LABEL, request("hide", "two")).is_err());
    assert_eq!(*host.schedules.borrow(), 2);
}

#[test]
fn native_close_cleans_overlay_and_blocks_late_updates_while_overlay_close_only_hides() {
    for change in [Change::Close, Change::Destroy] {
        let managed = active_overlay();
        let host = FakeHost::new();
        host.overlay.replace(Some(host.created.clone()));
        assert!(!window_changed(&managed, &host, "main", change));
        assert!(managed.inner.lock().unwrap().closing);
        assert!(get(&managed, LABEL).unwrap().is_none());
        assert_eq!(host.created.0.borrow().operations, ["destroy"]);
        show_expected(&managed, &host, "call-a");
        assert_eq!(*host.schedules.borrow(), 0);
    }
    let managed = active_overlay();
    let host = FakeHost::new();
    host.overlay.replace(Some(host.created.clone()));
    assert!(window_changed(&managed, &host, LABEL, Change::Close));
    assert!(get(&managed, LABEL).unwrap().is_some());
    assert!(host.actions.borrow().is_empty());
    assert_eq!(host.created.0.borrow().operations, ["hide"]);
    assert_eq!(*host.schedules.borrow(), 1);
    assert!(!window_changed(&managed, &host, "main", Change::Geometry));
    assert!(!window_changed(&managed, &host, "main", Change::Focus));
    assert!(!window_changed(&managed, &host, "main", Change::Move));
    assert!(!window_changed(&managed, &host, LABEL, Change::Geometry));
    assert!(!window_changed(&managed, &host, LABEL, Change::Focus));
    assert!(!window_changed(&managed, &host, LABEL, Change::Move));
    assert!(!window_changed(&managed, &host, "unrelated", Change::Close));
    assert!(!window_changed(&managed, &host, "main", Change::Other));
    assert_eq!(*host.schedules.borrow(), 5);
}

#[test]
fn dragging_never_starts_for_unprivileged_or_ended_calls_and_geometry_errors_are_returned() {
    let managed = active_overlay();
    let host = FakeHost::new();
    assert!(drag_allowed(&managed, "main").is_err());
    drag_allowed(&managed, LABEL).unwrap();
    drag(&host.created).unwrap();
    assert_eq!(host.created.0.borrow().operations, ["drag", "size", "move"]);
    for failure in ["drag", "size", "move"] {
        let window = FakeWindow::new(false);
        window.0.borrow_mut().failures.insert(failure);
        assert!(drag(&window).is_err());
    }
    managed.inner.lock().unwrap().update(None);
    assert_eq!(drag_allowed(&managed, LABEL).unwrap_err(), "The call ended");
}

#[test]
fn queued_drag_cannot_start_after_call_replacement_end_or_shutdown() {
    for change in ["replace", "end", "close"] {
        let managed = active_overlay();
        let window = FakeWindow::new(false);
        let expected = drag_allowed(&managed, LABEL).unwrap();
        match change {
            "replace" => managed.inner.lock().unwrap().update(Some(call("call-b"))),
            "end" => managed.inner.lock().unwrap().update(None),
            _ => managed.inner.lock().unwrap().closing = true,
        }
        assert!(
            drag_current(&managed, &window, &expected).is_err(),
            "{change}"
        );
        assert!(window.0.borrow().operations.is_empty(), "{change}");
    }
    let managed = active_overlay();
    let window = FakeWindow::new(false);
    drag_current(&managed, &window, "call-a").unwrap();
    assert_eq!(window.0.borrow().operations.first().unwrap(), "drag");
}

#[test]
fn simultaneous_sync_requests_coalesce_and_dirty_work_is_drained_before_releasing_ownership() {
    let managed = CallOverlay::default();
    assert!(managed.request_sync());
    assert!(!managed.request_sync());
    let mut passes = 0;
    managed.drain_sync(|| {
        passes += 1;
        if passes == 1 {
            assert!(!managed.request_sync());
        }
    });
    assert_eq!(passes, 2);
    assert!(!managed.scheduled.load(Ordering::SeqCst));
    assert!(!managed.dirty.load(Ordering::SeqCst));
    assert!(managed.request_sync());
    managed.drain_sync(|| {});
}

fn ipc(
    window: &WebviewWindow<tauri::test::MockRuntime>,
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
    .map(|response| response.deserialize().unwrap())
}

#[test]
fn sdk_ipc_decodes_real_commands_and_enforces_the_call_window_identity_without_native_windows() {
    let app = crate::application_commands(tauri::test::mock_builder().manage(active_overlay()))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    let host = NativeOverlay(app.handle());
    let overlay = host.create_overlay().unwrap();
    let state = ipc(&overlay, "call_overlay_get", serde_json::json!({})).unwrap();
    assert_eq!(state, serde_json::to_value(call("call-a")).unwrap());
    assert_eq!(
        ipc(&main, "call_overlay_get", serde_json::json!({})).unwrap_err(),
        "Invalid call window"
    );
    assert_eq!(
        ipc(
            &overlay,
            "call_overlay_update",
            serde_json::json!({"state":null})
        )
        .unwrap_err(),
        "Invalid call window state"
    );
    assert!(ipc(
        &main,
        "call_overlay_update",
        serde_json::json!({"state":{"callId":"a","private":"not accepted"}})
    )
    .is_err());
    assert!(ipc(
        &overlay,
        "call_overlay_action",
        serde_json::json!({"callId":"call-a","action":"hangup","requestId":123,"muted":null})
    )
    .is_err());
    assert_eq!(
        ipc(
            &main,
            "call_overlay_action",
            serde_json::json!({"callId":"call-a","action":"hangup","requestId":"one","muted":null})
        )
        .unwrap_err(),
        "Invalid call window action"
    );
    assert_eq!(
        ipc(&main, "call_overlay_drag", serde_json::json!({})).unwrap_err(),
        "Invalid call window"
    );
    assert!(host.create_overlay().is_err());
    assert_eq!(
        get(&app.state::<CallOverlay>(), LABEL).unwrap(),
        Some(call("call-a"))
    );
}

#[test]
fn sdk_window_adapter_delivers_exact_events_and_exposes_only_mock_supported_operations() {
    use std::sync::{Arc, Mutex};
    use tauri::Listener;
    let app = tauri::test::mock_builder()
        .manage(active_overlay())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    let host = NativeOverlay(app.handle());
    let overlay = host.create_overlay().unwrap();
    let published = Arc::new(Mutex::new(Vec::new()));
    let received = published.clone();
    overlay.listen("dant-call-overlay-state", move |event| {
        received
            .lock()
            .unwrap()
            .push(serde_json::from_str::<CallState>(event.payload()).unwrap());
    });
    CallWindow::publish(&overlay, &call("call-a"));
    assert_eq!(*published.lock().unwrap(), [call("call-a")]);
    let actions = Arc::new(Mutex::new(Vec::new()));
    let received = actions.clone();
    main.listen("dant-call-overlay-action", move |event| {
        received
            .lock()
            .unwrap()
            .push(serde_json::from_str::<serde_json::Value>(event.payload()).unwrap());
    });
    host.action(request("hangup", "one")).unwrap();
    assert_eq!(
        *actions.lock().unwrap(),
        [serde_json::to_value(request("hangup", "one")).unwrap()]
    );

    // SDK MockRuntime uses constant geometry/visibility, so these assertions
    // verify adapter calls only. The scripted host tests prove state changes.
    assert_eq!(CallWindow::size(&overlay).unwrap(), (0, 0));
    assert!(!CallWindow::minimized(&main));
    assert!(CallWindow::visible(&main, false));
    assert!(CallWindow::monitor(&main).is_none());
    CallWindow::move_to(&overlay, PhysicalPosition::new(10, 20)).unwrap();
    assert_eq!(
        CallWindow::position(&overlay),
        Some(PhysicalPosition::new(0, 0))
    );
    CallWindow::focusable(&overlay, false).unwrap();
    CallWindow::show(&overlay).unwrap();
    CallWindow::focusable(&overlay, true).unwrap();
    CallWindow::hide(&overlay).unwrap();
    CallWindow::restore(&main).unwrap();
    CallWindow::drag(&overlay).unwrap();
    sync(&app.state::<CallOverlay>(), &host).unwrap();
    host.tray_changed(true, Some("en"));
    CallWindow::destroy(&overlay);
    // MockRuntime removes its dispatcher entry without delivering Destroyed to
    // Tauri's manager. Native cleanup state is asserted in window_changed tests.
}

#[test]
fn sdk_commands_deliver_valid_actions_and_reconcile_updates_without_a_native_tray_or_media() {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tauri::Listener;

    let app =
        crate::application_commands(tauri::test::mock_builder().manage(CallOverlay::default()))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
    let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    let overlay = NativeOverlay(app.handle()).create_overlay().unwrap();
    let wait_for_sync = || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while app.state::<CallOverlay>().scheduled.load(Ordering::SeqCst) {
            assert!(
                Instant::now() < deadline,
                "owned overlay synchronization did not finish"
            );
            std::thread::yield_now();
        }
    };
    ipc(
        &main,
        "call_overlay_update",
        serde_json::json!({"state":call("call-a")}),
    )
    .unwrap();
    wait_for_sync();
    assert_eq!(
        ipc(&overlay, "call_overlay_get", serde_json::json!({})).unwrap(),
        serde_json::to_value(call("call-a")).unwrap()
    );
    let actions = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let received = actions.clone();
    main.listen("dant-call-overlay-action", move |event| {
        received
            .lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });
    ipc(
        &overlay,
        "call_overlay_action",
        serde_json::json!({"callId":"call-a","action":"hangup","requestId":"one","muted":null}),
    )
    .unwrap();
    assert_eq!(actions.lock().unwrap().len(), 1);
    assert_eq!(actions.lock().unwrap()[0]["callId"], "call-a");
    ipc(&overlay, "call_overlay_drag", serde_json::json!({})).unwrap();
    ipc(
        &overlay,
        "call_overlay_action",
        serde_json::json!({"callId":"call-a","action":"hide","requestId":"two","muted":null}),
    )
    .unwrap();
    wait_for_sync();
    show_call_window(app.handle());
    let deadline = Instant::now() + Duration::from_secs(5);
    while app
        .state::<CallOverlay>()
        .inner
        .lock()
        .unwrap()
        .hidden_for
        .is_some()
    {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    wait_for_sync();
    assert_eq!(
        actions.lock().unwrap().len(),
        1,
        "hide/show never emits a media action"
    );
}

#[test]
fn poisoned_state_returns_fixed_errors_and_never_dispatches_controls_or_panics_during_cleanup() {
    fn poison<T: Send>(lock: &Mutex<T>) {
        std::thread::scope(|scope| {
            assert!(scope
                .spawn(|| {
                    let _guard = lock.lock().unwrap();
                    panic!("isolated poisoned fixture");
                })
                .join()
                .is_err());
        });
    }
    for operation in [false, true] {
        let managed = active_overlay();
        let host = FakeHost::new();
        if operation {
            poison(&managed.operation);
        } else {
            poison(&managed.inner);
        }
        assert_eq!(
            sync(&managed, &host).unwrap_err(),
            "Call window is unavailable"
        );
        assert_eq!(
            update(&managed, &host, "main", Some(call("call-b"))).unwrap_err(),
            "Call window is unavailable"
        );
        assert_eq!(
            act(&managed, &host, LABEL, request("hangup", "one")).unwrap_err(),
            "Call window is unavailable"
        );
        show_expected(&managed, &host, "call-a");
        assert_eq!(*host.schedules.borrow(), 0);
        assert!(host.actions.borrow().is_empty());
        if !operation {
            assert_eq!(
                get(&managed, LABEL).unwrap_err(),
                "Call window is unavailable"
            );
            assert_eq!(drag_allowed(&managed, LABEL).unwrap_err(), "The call ended");
            assert!(!window_changed(&managed, &host, "main", Change::Close));
            assert!(window_changed(&managed, &host, LABEL, Change::Close));
        }
    }
}

#[test]
fn startup_captures_the_supplied_monitor_and_preserves_prior_area_when_unavailable() {
    let managed = CallOverlay::default();
    let window = FakeWindow::new(true);
    let expected = window.0.borrow().area;
    capture_main_area(&managed, &window);
    assert_eq!(managed.inner.lock().unwrap().main_area, expected);

    window.0.borrow_mut().area = None;
    capture_main_area(&managed, &window);
    assert_eq!(managed.inner.lock().unwrap().main_area, expected);

    std::thread::scope(|scope| {
        assert!(scope
            .spawn(|| {
                let _owner = managed.inner.lock().unwrap();
                std::panic::resume_unwind(Box::new(()));
            })
            .join()
            .is_err());
    });
    window.0.borrow_mut().area = Some(Area {
        x: -1920,
        y: 100,
        width: 1920,
        height: 1080,
        scale: 1.5,
    });
    capture_main_area(&managed, &window);
    assert_eq!(
        managed
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .main_area,
        expected
    );
    assert!(window.0.borrow().operations.is_empty());
}

#[test]
fn sdk_setup_and_noninteractive_window_events_reconcile_owned_state_and_destroyed_cleanup() {
    use std::time::{Duration, Instant};

    let app = tauri::test::mock_builder()
        .manage(active_overlay())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    setup(&app);
    let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    let host = NativeOverlay(app.handle());
    let overlay = host.create_overlay().unwrap();
    setup(&app);
    let wait = || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while app.state::<CallOverlay>().scheduled.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
    };
    for event in [
        WindowEvent::Resized(tauri::PhysicalSize::new(800, 600)),
        WindowEvent::Moved(PhysicalPosition::new(10, 20)),
        WindowEvent::Focused(true),
        WindowEvent::ThemeChanged(tauri::Theme::Dark),
    ] {
        on_window_event(&main.as_ref().window(), &event);
        wait();
        on_window_event(&overlay.as_ref().window(), &event);
        wait();
    }
    let mut light = call("call-a");
    light.theme = "light".into();
    CallWindow::publish(&overlay, &light);
    on_window_event(&main.as_ref().window(), &WindowEvent::Destroyed);
    assert!(app.state::<CallOverlay>().inner.lock().unwrap().closing);
    assert!(call_overlay_get(app.handle().clone(), overlay)
        .unwrap()
        .is_none());
    show_call_window(app.handle());
    let empty = tauri::test::mock_app();
    visibility_changed(empty.handle());
}
