use super::{banner_using, notification_body, start_using, NotificationDelivery, NotificationPump};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Manager;

struct ScriptedRequest {
    session: Option<serde_json::Value>,
    pending: Option<serde_json::Value>,
    allow_ack: bool,
    cancel_after: Option<(usize, Arc<AtomicBool>)>,
    calls: Vec<(String, Option<String>, Option<String>)>,
}

impl ScriptedRequest {
    fn new(session: Option<serde_json::Value>, pending: Option<serde_json::Value>) -> Self {
        Self {
            session,
            pending,
            allow_ack: false,
            cancel_after: None,
            calls: Vec::new(),
        }
    }

    fn request(
        &mut self,
        route: &str,
        token: Option<&str>,
        body: Option<&str>,
    ) -> Option<serde_json::Value> {
        self.calls.push((
            route.into(),
            token.map(str::to_owned),
            body.map(str::to_owned),
        ));
        if let Some((count, active)) = &self.cancel_after {
            if self.calls.len() == *count {
                active.store(false, Ordering::Release);
            }
        }
        if route == crate::protocol::session_path() {
            assert!(token.is_none());
            assert!(body.is_none());
            return self.session.clone();
        }
        let expected_token = self
            .session
            .as_ref()
            .and_then(|value| value.get("token"))
            .and_then(serde_json::Value::as_str);
        assert!(expected_token.is_some());
        assert_eq!(token, expected_token);
        if route == "/api/notifications/pending" {
            assert!(body.is_none());
            return self.pending.clone();
        }
        assert!(
            self.allow_ack,
            "An unavailable notification must not be acknowledged"
        );
        assert!(route.starts_with("/api/notifications/") && route.ends_with("/ack"));
        assert_eq!(body, Some("{}"));
        None
    }
}

enum BannerMode<'a> {
    Accept,
    Refuse,
    Forbidden(&'static str),
    Native {
        app: &'a tauri::AppHandle<tauri::test::MockRuntime>,
        control: &'a super::NotificationControl<tauri::test::MockRuntime>,
    },
}

struct ScriptedBanner<'a> {
    mode: BannerMode<'a>,
    shown: Vec<(String, Option<&'static str>)>,
    cancel_after_show: Option<Arc<AtomicBool>>,
}

impl<'a> ScriptedBanner<'a> {
    fn new(mode: BannerMode<'a>) -> Self {
        Self {
            mode,
            shown: Vec::new(),
            cancel_after_show: None,
        }
    }

    fn show(&mut self, body: String, sound: Option<&'static str>) -> bool {
        if let BannerMode::Forbidden(reason) = self.mode {
            panic!("{reason}");
        }
        self.shown.push((body.clone(), sound));
        if let Some(active) = &self.cancel_after_show {
            active.store(false, Ordering::Release);
        }
        match self.mode {
            BannerMode::Accept => true,
            BannerMode::Refuse => false,
            BannerMode::Native { app, control } => (control.banner)(app, body, sound),
            BannerMode::Forbidden(_) => unreachable!(),
        }
    }

    fn dispatch<'b>(
        &mut self,
        delivery: &mut NotificationDelivery,
        notification: &'b serde_json::Value,
    ) -> Option<&'b str> {
        delivery.dispatch(notification, |body, sound| self.show(body, sound))
    }
}

fn poll(
    delivery: &mut NotificationDelivery,
    request: &mut ScriptedRequest,
    show: &mut ScriptedBanner<'_>,
) {
    poll_script(delivery, request, show, &AtomicBool::new(true));
}

fn poll_script(
    delivery: &mut NotificationDelivery,
    request: &mut ScriptedRequest,
    show: &mut ScriptedBanner<'_>,
    active: &AtomicBool,
) {
    super::poll_active(
        delivery,
        |route, token, body| request.request(route, token, body),
        |body, sound| show.show(body, sound),
        || active.load(Ordering::Acquire),
    );
}

#[test]
fn pending_delivery_observes_cancellation_before_network_and_between_notification_receipts() {
    let active = Arc::new(AtomicBool::new(false));
    let mut request = ScriptedRequest::new(None, None);
    let mut banner = ScriptedBanner::new(BannerMode::Forbidden(
        "A stopped pump must not display anything",
    ));
    poll_script(
        &mut NotificationDelivery::default(),
        &mut request,
        &mut banner,
        &active,
    );
    assert!(request.calls.is_empty());
    assert!(banner.shown.is_empty());
    for stop_after in [1, 2] {
        active.store(true, Ordering::Release);
        let mut request = ScriptedRequest::new(
            Some(json!({"token":"synthetic"})),
            Some(json!({"notifications":[{"id":"first"}]})),
        );
        request.cancel_after = Some((stop_after, Arc::clone(&active)));
        poll_script(
            &mut NotificationDelivery::default(),
            &mut request,
            &mut banner,
            &active,
        );
        assert_eq!(request.calls.len(), stop_after);
        assert!(banner.shown.is_empty());
    }
    active.store(true, Ordering::Release);
    let mut request = ScriptedRequest::new(
        Some(json!({"token":"synthetic"})),
        Some(json!({"notifications":[{"id":"first"}, {"id":"second"}]})),
    );
    request.allow_ack = true;
    let mut banner = ScriptedBanner::new(BannerMode::Accept);
    banner.cancel_after_show = Some(Arc::clone(&active));
    poll_script(
        &mut NotificationDelivery::default(),
        &mut request,
        &mut banner,
        &active,
    );
    assert_eq!(banner.shown.len(), 1);
    assert_eq!(
        request
            .calls
            .iter()
            .map(|call| call.0.as_str())
            .collect::<Vec<_>>(),
        [
            "/api/session",
            "/api/notifications/pending",
            "/api/notifications/first/ack"
        ]
    );
}

#[test]
fn native_shutdown_cancels_and_joins_the_owned_pump_and_repeated_stop_and_drop_are_safe() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    use tauri::Manager;
    let running = Arc::new(AtomicBool::new(true));
    let (entered, waiting) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    let pump = super::spawn_pump(
        Arc::clone(&running),
        || {},
        move |_| {
            entered.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(5)).unwrap();
        },
    );
    let app = tauri::test::mock_app();
    app.manage(pump);
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    let active = Arc::clone(&running);
    let releaser = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while active.load(Ordering::Acquire) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        release.send(()).unwrap();
    });
    crate::shutdown(app.handle());
    releaser.join().unwrap();
    assert!(!running.load(Ordering::Acquire));
    assert!(app
        .state::<super::NotificationPump>()
        .thread
        .lock()
        .unwrap()
        .is_none());
    crate::shutdown(app.handle());
    app.state::<super::NotificationPump>().stop();
    drop(app);
}

#[test]
fn a_callback_can_cancel_its_own_pump_even_when_an_external_stop_is_already_joining_it() {
    use std::sync::{mpsc, Arc};
    use std::time::{Duration, Instant};
    for external in [false, true] {
        let running = Arc::new(AtomicBool::new(true));
        let (entered, waiting) = mpsc::channel();
        let (release, resume) = mpsc::channel::<std::sync::Weak<super::NotificationPump>>();
        let pump = Arc::new(super::spawn_pump(
            Arc::clone(&running),
            move || {
                entered.send(()).unwrap();
                resume
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap()
                    .upgrade()
                    .unwrap()
                    .stop();
            },
            |_| panic!("A self-cancelled pump must not wait"),
        ));
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        let stopper = if external {
            let owner = Arc::clone(&pump);
            let stopper = std::thread::spawn(move || owner.stop());
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match pump.thread.try_lock() {
                    Err(std::sync::TryLockError::WouldBlock) => break,
                    Err(_) => panic!("The pump owner must not poison its lock"),
                    Ok(_) => {
                        assert!(Instant::now() < deadline);
                        std::thread::yield_now();
                    }
                }
            }
            Some(stopper)
        } else {
            None
        };
        release.send(Arc::downgrade(&pump)).unwrap();
        if let Some(stopper) = stopper {
            stopper.join().unwrap();
        }
        pump.stop();
        assert!(!running.load(Ordering::Acquire));
        assert!(pump.thread.lock().unwrap().is_none());
    }
}

#[test]
fn a_finished_or_unwinding_worker_resets_its_running_receipt_before_the_owner_joins() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    struct Completed(mpsc::Sender<()>);
    impl Drop for Completed {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }
    let running = Arc::new(AtomicBool::new(true));
    let (finished, receipt) = mpsc::channel();
    let completed = Completed(finished);
    let pump = super::spawn_pump(
        Arc::clone(&running),
        move || {
            let _ = &completed;
            // Exercise unwinding without changing any process-wide panic hook.
            std::panic::resume_unwind(Box::new(()));
        },
        |_| panic!("An unwinding callback must not reach its polling wait"),
    );
    receipt.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(!running.load(Ordering::Acquire));
    pump.stop();
    assert!(pump.thread.lock().unwrap().is_none());
    pump.stop();
    drop(pump);
}

#[test]
fn a_poisoned_shutdown_owner_still_joins_its_retained_worker() {
    let running = Arc::new(AtomicBool::new(true));
    let (waiting, entered) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let pump = super::spawn_pump(
        Arc::clone(&running),
        || {},
        move |_| {
            waiting.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(5)).unwrap();
        },
    );
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    std::thread::scope(|scope| {
        assert!(scope
            .spawn(|| {
                let _owner = pump.thread.lock().unwrap();
                std::panic::resume_unwind(Box::new(()));
            })
            .join()
            .is_err());
    });
    let stopped = Arc::clone(&running);
    let releaser = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while stopped.load(Ordering::Acquire) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        let _ = release.send(());
    });
    pump.stop();
    releaser.join().unwrap();
    let remaining = pump.thread.lock().unwrap_err().into_inner().take();
    let was_retained = remaining.is_some();
    if let Some(thread) = remaining {
        thread.join().unwrap();
    }
    assert!(
        !was_retained,
        "stop must join even when the handle owner was poisoned"
    );
    pump.stop();
}

#[test]
fn polling_only_acknowledges_submitted_ids_and_never_replays_a_lost_receipt() {
    let mut delivery = NotificationDelivery::default();
    let mut banner = ScriptedBanner::new(BannerMode::Accept);
    for _ in 0..2 {
        let mut request = ScriptedRequest::new(
            Some(json!({"token":"synthetic"})),
            Some(json!({"notifications":[{"id":"result-a","body":"Ready"},{"id":"../invalid"}]})),
        );
        request.allow_ack = true;
        poll(&mut delivery, &mut request, &mut banner);
        assert_eq!(request.calls.len(), 3);
        assert_eq!(
            request.calls[2],
            (
                "/api/notifications/result-a/ack".into(),
                Some("synthetic".into()),
                Some("{}".into())
            )
        );
    }
    assert_eq!(banner.shown.len(), 1);
    assert_eq!(banner.shown[0].0, "Ready");
}

#[test]
fn a_missing_notification_plugin_keeps_the_receipt_pending_without_acknowledging() {
    let app = tauri::test::mock_app();
    let platform = super::NotificationControl::default();
    let mut delivery = NotificationDelivery::default();
    let mut banner = ScriptedBanner::new(BannerMode::Native {
        app: app.handle(),
        control: &platform,
    });
    for _ in 0..2 {
        let mut request = ScriptedRequest::new(
            Some(json!({"token":"synthetic"})),
            Some(json!({"notifications":[{"id":"pending-without-plugin","body":"Ready"}]})),
        );
        poll(&mut delivery, &mut request, &mut banner);
        assert_eq!(request.calls.len(), 2);
        assert!(delivery.submitted.is_empty());
        assert!(delivery.order.is_empty());
    }
}

#[test]
fn the_native_notification_request_uses_the_owned_controller_link_and_exact_receipt_body() {
    let body = b"{\"ok\":true}";
    let server = crate::native_http::Server::new(
        format!(
            "HTTP/1.0 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            std::str::from_utf8(body).unwrap()
        )
        .into_bytes(),
    );
    let control = super::NotificationControl::<tauri::test::MockRuntime>::with_link(
        crate::transport::isolated_http_link(&server),
    );
    assert_eq!(
        (control.request)(
            "/api/notifications/owned-receipt/ack",
            Some("synthetic-token"),
            Some("{}")
        ),
        Some(json!({"ok":true}))
    );
    let request = String::from_utf8(server.completed_request()).unwrap();
    assert!(request.starts_with("POST /api/notifications/owned-receipt/ack HTTP/1.0\r\n"));
    assert!(request.contains("X-Dant-Token: synthetic-token\r\n"));
    assert!(request.ends_with("\r\n\r\n{}"));
}

#[test]
fn polling_stops_at_incomplete_boundaries_without_showing_or_acknowledging() {
    for (session, pending, expected_calls) in [
        (None, None, 1),
        (Some(json!({})), None, 1),
        (Some(json!({"token":42})), None, 1),
        (Some(json!({"token":"synthetic"})), None, 2),
        (
            Some(json!({"token":"synthetic"})),
            Some(json!({"notifications":42})),
            2,
        ),
    ] {
        let mut request = ScriptedRequest::new(session, pending);
        let mut banner = ScriptedBanner::new(BannerMode::Forbidden(
            "Incomplete responses cannot deliver a notification",
        ));
        poll(
            &mut NotificationDelivery::default(),
            &mut request,
            &mut banner,
        );
        assert_eq!(request.calls.len(), expected_calls);
    }
}

#[test]
fn polling_cancellation_is_observed_between_short_waits() {
    let running = AtomicBool::new(false);
    super::run(
        &running,
        || panic!("Stopped owner must not poll"),
        |_| panic!("Stopped owner must not wait"),
    );
    running.store(true, Ordering::Relaxed);
    let mut polls = 0;
    let mut waits = 0;
    super::run(
        &running,
        || polls += 1,
        |delay| {
            assert_eq!(delay, super::POLL_SLEEP);
            waits += 1;
            if waits == super::POLL_INTERVAL_STEPS + 1 {
                running.store(false, Ordering::Relaxed);
            }
        },
    );
    assert_eq!(polls, 2);
    assert_eq!(waits, super::POLL_INTERVAL_STEPS + 1);
}

#[test]
fn banners_use_the_delivered_message_and_keep_localized_fallbacks() {
    assert_eq!(
        notification_body(&json!({"body":"请在电脑上输入验证码。","language":"zh"})),
        "请在电脑上输入验证码。"
    );
    assert_eq!(
        notification_body(&json!({"body":"","language":"en"})),
        "You have an unread message from dant."
    );
    assert_eq!(
        notification_body(&json!({"body":42})),
        "你有来自 dant 的未读消息。"
    );
}

#[test]
fn banners_strip_controls_and_bound_unicode_without_splitting_it() {
    assert_eq!(
        notification_body(&json!({"body":"Done\u{0}\u{202e}!"})),
        "Done!"
    );
    let body = notification_body(&json!({"body":"😀".repeat(300)}));
    assert_eq!(body.chars().count(), 240);
}

#[test]
fn a_lost_ack_retries_the_receipt_without_replaying_the_system_sound() {
    let mut delivery = NotificationDelivery::default();
    let first = json!({"id":"completion-a", "body":"Your result is ready.", "language":"en"});
    let mut banner = ScriptedBanner::new(BannerMode::Accept);
    let id = banner.dispatch(&mut delivery, &first);
    assert_eq!(id, Some("completion-a"));
    // The Controller may return this same ID again if its ACK was lost.
    let repeat = json!({"id":"completion-a", "body":"An edited preview."});
    banner.mode = BannerMode::Forbidden("must only retry the acknowledgement");
    assert_eq!(banner.dispatch(&mut delivery, &repeat), id);
    assert_eq!(banner.shown.len(), 1);
    assert_eq!(banner.shown[0].0, "Your result is ready.");
    #[cfg(windows)]
    assert_eq!(banner.shown[0].1, Some("Default"));
    #[cfg(not(windows))]
    assert_eq!(banner.shown[0].1, None);
    let second = json!({"id":"completion-b", "body":"Another task needs your reply."});
    banner.mode = BannerMode::Accept;
    assert_eq!(
        banner.dispatch(&mut delivery, &second),
        Some("completion-b")
    );
    assert_eq!(
        banner.shown.len(),
        2,
        "different completion IDs remain separate notifications"
    );
}

#[test]
fn failed_submissions_retry_and_malformed_ids_never_show_or_ack() {
    let mut delivery = NotificationDelivery::default();
    let message = json!({"id":"retry-a", "body":"Done"});
    let mut banner = ScriptedBanner::new(BannerMode::Refuse);
    assert_eq!(banner.dispatch(&mut delivery, &message), None);
    banner.mode = BannerMode::Accept;
    assert_eq!(banner.dispatch(&mut delivery, &message), Some("retry-a"));
    banner.mode = BannerMode::Forbidden("invalid notification ID");
    for id in ["", "../private", "a/b", "two words", &"a".repeat(129)] {
        assert_eq!(banner.dispatch(&mut delivery, &json!({"id":id})), None);
    }
    assert_eq!(banner.dispatch(&mut delivery, &json!({"id":42})), None);
}

#[test]
fn the_session_receipt_cache_is_bounded_and_keeps_only_ids() {
    let mut delivery = NotificationDelivery::default();
    let mut banner = ScriptedBanner::new(BannerMode::Accept);
    for number in 0..1030 {
        banner.dispatch(
            &mut delivery,
            &json!({"id":format!("receipt-{number}"),"body":"not retained"}),
        );
    }
    assert_eq!(delivery.submitted.len(), 1024);
    assert_eq!(delivery.order.len(), 1024);
    assert!(!delivery.submitted.contains("receipt-0"));
    assert!(delivery.submitted.contains("receipt-1029"));
}

#[test]
fn managed_pump_builds_a_sanitized_banner_and_acknowledges_before_joined_shutdown_without_showing_ui(
) {
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_notification::init())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let (acknowledged, received) = std::sync::mpsc::channel();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let observed = calls.clone();
    let (release, gate) = std::sync::mpsc::channel();
    let handle = app.handle().clone();
    start_using(
        &app,
        move |route, token, body| {
            observed.lock().unwrap().push(route.to_owned());
            if route == crate::protocol::session_path() {
                assert!(token.is_none());
                Some(json!({"token":"synthetic-token"}))
            } else if route.ends_with("/pending") {
                assert_eq!(token, Some("synthetic-token"));
                Some(json!({"notifications":[{"id":"owned-receipt","body":"preview\0\n"}]}))
            } else {
                assert!(route.ends_with("/owned-receipt/ack"));
                assert_eq!(body, Some("{}"));
                acknowledged.send(()).unwrap();
                Some(json!({"ok":true}))
            }
        },
        move |body, sound| {
            assert_eq!(body, "preview");
            banner_using(&handle, body, sound, |_| true)
        },
        move |_| {
            gate.recv_timeout(Duration::from_secs(5)).unwrap();
        },
    );
    received.recv_timeout(Duration::from_secs(5)).unwrap();
    app.state::<NotificationPump>()
        .running
        .store(false, Ordering::Release);
    let _ = release.send(());
    app.state::<NotificationPump>().stop();
    assert_eq!(calls.lock().unwrap().len(), 3);
    assert!(!app
        .state::<NotificationPump>()
        .running
        .load(Ordering::Acquire));
    assert!(!banner_using(app.handle(), "no sound".into(), None, |_| {
        false
    }));
}

#[test]
fn public_notification_start_uses_its_owned_platform_and_joins_after_one_acknowledged_delivery() {
    use super::NotificationControl;
    use std::sync::mpsc;
    struct Platform {
        routes: Mutex<Vec<String>>,
        delivered: mpsc::Sender<()>,
        waiting: mpsc::Sender<()>,
        resume: Mutex<mpsc::Receiver<()>>,
    }
    impl Platform {
        fn request(
            &self,
            route: &str,
            token: Option<&str>,
            body: Option<&str>,
        ) -> Option<serde_json::Value> {
            self.routes.lock().unwrap().push(route.to_owned());
            if route == crate::protocol::session_path() {
                assert!(token.is_none() && body.is_none());
                Some(json!({"token":"owned-platform"}))
            } else if route.ends_with("/pending") {
                assert_eq!(token, Some("owned-platform"));
                Some(json!({"notifications":[{"id":"owned-start","body":"done\n"}]}))
            } else {
                assert!(route.ends_with("/owned-start/ack"));
                assert_eq!(body, Some("{}"));
                self.delivered.send(()).unwrap();
                Some(json!({"ok":true}))
            }
        }
        fn show(
            &self,
            app: &tauri::AppHandle<tauri::test::MockRuntime>,
            body: String,
            sound: Option<&'static str>,
        ) -> bool {
            assert_eq!(body, "done");
            banner_using(app, body, sound, |_| true)
        }
        fn wait(&self, duration: Duration) {
            assert_eq!(duration, super::POLL_SLEEP);
            self.waiting.send(()).unwrap();
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        }
    }
    let root = tempfile::tempdir().unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = "test.dant.notificationfixture".into();
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.path().to_path_buf()),
    );
    let (acknowledge, received) = mpsc::channel();
    let (waiting, entered) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    let platform = Arc::new(Platform {
        routes: Mutex::new(Vec::new()),
        delivered: acknowledge,
        waiting,
        resume: Mutex::new(resume),
    });
    let requests = Arc::clone(&platform);
    let banners = Arc::clone(&platform);
    let waits = Arc::clone(&platform);
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_notification::init())
        .manage(NotificationControl::<tauri::test::MockRuntime> {
            request: Arc::new(move |route, token, body| requests.request(route, token, body)),
            banner: Arc::new(move |app, body, sound| banners.show(app, body, sound)),
            wait: Arc::new(move |duration| waits.wait(duration)),
        })
        .build(context)
        .unwrap();
    super::start(&app);
    received.recv_timeout(Duration::from_secs(5)).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    app.state::<NotificationPump>()
        .running
        .store(false, Ordering::Release);
    let _ = release.send(());
    app.state::<NotificationPump>().stop();
    assert_eq!(
        *platform.routes.lock().unwrap(),
        [
            "/api/session",
            "/api/notifications/pending",
            "/api/notifications/owned-start/ack"
        ]
    );
    assert!(app
        .state::<NotificationPump>()
        .thread
        .lock()
        .unwrap()
        .is_none());
    let native = NotificationControl::<tauri::test::MockRuntime>::default();
    (native.wait)(Duration::ZERO);
}
