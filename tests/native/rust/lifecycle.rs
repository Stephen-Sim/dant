use super::*;
use std::cell::RefCell;

fn reopen_with_reply(
    session: Option<&serde_json::Value>,
    reply: Option<Result<reqwest::Response, reqwest::Error>>,
) -> (bool, usize) {
    let client = desktop_client().unwrap();
    let sent = std::cell::Cell::new(0);
    let confirmed = tauri::async_runtime::block_on(open_request_with(
        session,
        &client,
        crate::protocol::controller_endpoint(),
        |request| {
            sent.set(sent.get() + 1);
            assert_eq!(
                request.url().as_str(),
                crate::protocol::api_url("desktop/open")
            );
            assert_eq!(request.method(), reqwest::Method::POST);
            assert_eq!(request.headers()["X-Dant-Token"], "a".repeat(64));
            std::future::ready(reply.expect("Invalid sessions must never send a request"))
        },
    ));
    (confirmed, sent.get())
}

#[test]
fn controller_reopening_validates_session_before_send_and_requires_a_bounded_explicit_response() {
    let session =
        serde_json::json!({"product":"dant", "mode":"controller", "token":"a".repeat(64)});
    for session in [
        None,
        Some(serde_json::json!({})),
        Some(serde_json::json!({"product":"dant","mode":"worker","token":"a".repeat(64)})),
    ] {
        assert_eq!(reopen_with_reply(session.as_ref(), None), (false, 0));
    }
    for (status, body, confirmed) in [
        (200, br#"{"ok":true}"#.to_vec(), true),
        (201, br#"{"ok":true}"#.to_vec(), true),
        (200, br#"{"ok":false}"#.to_vec(), false),
        (200, b"not-json".to_vec(), false),
        (403, br#"{"ok":true}"#.to_vec(), false),
        (200, vec![b'x'; DESKTOP_RESPONSE_MAX_BYTES + 1], false),
    ] {
        let response = reqwest::Response::from(
            tauri::http::Response::builder()
                .status(status)
                .body(body)
                .unwrap(),
        );
        assert_eq!(
            reopen_with_reply(Some(&session), Some(Ok(response))),
            (confirmed, 1)
        );
    }
    let error = desktop_client()
        .unwrap()
        .get("http://[")
        .build()
        .unwrap_err();
    assert_eq!(
        reopen_with_reply(Some(&session), Some(Err(error))),
        (false, 1)
    );
}
use std::io::{BufRead, Read, Write};

struct DesktopFixture<'a> {
    state: &'a DesktopExit,
    outcome: ExitOutcome,
    language: &'static str,
    events: RefCell<Vec<String>>,
}
impl DesktopEffects for DesktopFixture<'_> {
    async fn exit_request(&self) -> ExitOutcome {
        assert!(self.state.pending.load(Ordering::SeqCst));
        assert!(!self.state.approved.load(Ordering::SeqCst));
        self.events.borrow_mut().push("request".into());
        self.outcome
    }
    fn language(&self) -> String {
        self.language.into()
    }
    fn restore(&self) {
        self.events.borrow_mut().push("restore".into());
    }
    fn failed(&self) {
        self.events.borrow_mut().push("failed".into());
    }
    fn notice(&self, message: &str) {
        self.events.borrow_mut().push(message.into());
    }
    fn exit(&self) {
        assert!(self.state.approved.load(Ordering::SeqCst));
        assert!(!self.state.pending.load(Ordering::SeqCst));
        self.events.borrow_mut().push("exit".into());
    }
}

#[test]
fn native_exit_approves_only_after_confirmed_pause_and_suspension_and_keeps_rejections_open() {
    for language in ["en", "zh"] {
        for unsupported in [false, true] {
            let state = DesktopExit::default();
            state.pending.store(true, Ordering::SeqCst);
            let host = DesktopFixture {
                state: &state,
                outcome: ExitOutcome::Confirmed {
                    unsupported_notice: unsupported,
                },
                language,
                events: RefCell::new(Vec::new()),
            };
            tauri::async_runtime::block_on(finish_exit(&state, &host));
            let events = host.events.borrow();
            assert_eq!(events[0], "request");
            assert_eq!(events.last().unwrap(), "exit");
            assert_eq!(events.len(), if unsupported { 3 } else { 2 });
            if unsupported {
                assert!(!events[1].is_empty());
            }
        }
        for failure in [
            ExitFailure::Unconfirmed,
            ExitFailure::WorkPauseUnconfirmed,
            ExitFailure::VMSuspensionUnconfirmed,
            ExitFailure::VMOperationBusy,
            ExitFailure::VMIdentityUnverified,
            ExitFailure::VMUnsupported,
            ExitFailure::BackupRunning,
            ExitFailure::BackupUnconfirmed,
            ExitFailure::DesktopBusy,
        ] {
            let state = DesktopExit::default();
            state.pending.store(true, Ordering::SeqCst);
            let host = DesktopFixture {
                state: &state,
                outcome: ExitOutcome::Rejected(failure),
                language,
                events: RefCell::new(Vec::new()),
            };
            tauri::async_runtime::block_on(finish_exit(&state, &host));
            assert!(!state.pending.load(Ordering::SeqCst));
            assert!(!state.approved.load(Ordering::SeqCst));
            let events = host.events.borrow();
            assert_eq!(&events[..3], ["request", "restore", "failed"]);
            assert_eq!(events[3], exit_failure_message(language, failure));
            assert_eq!(events.len(), 4);
        }
    }
}

#[test]
fn native_prepared_update_exit_marks_only_managed_confirmed_desktop_state() {
    let app = tauri::test::mock_app();
    assert!(!approved(app.handle()));
    prepared_update_exit(app.handle());
    app.manage(DesktopExit::default());
    assert!(!approved(app.handle()));
    let mut exited = false;
    prepared_update_exit_using(app.handle(), || exited = true);
    assert!(exited);
    assert!(approved(app.handle()));
}

#[test]
fn exit_requires_explicit_quiescence_not_a_generic_success_or_cached_state() {
    assert!(confirmed(
        &serde_json::json!({"ok":true,"workPaused":true,"vmSuspended":true})
    ));
    assert!(confirmed(
        &serde_json::json!({"ok":true,"workPaused":true,"unsupported":true})
    ));
    for value in [
        serde_json::json!({"ok":true}),
        serde_json::json!({"ok":true,"workPaused":true}),
        serde_json::json!({"ok":false,"workPaused":true,"vmSuspended":true}),
        serde_json::json!({"ok":true,"workPaused":false,"unsupported":true}),
    ] {
        assert!(!confirmed(&value));
    }
}
#[test]
fn exit_session_is_bounded_and_not_an_arbitrary_header() {
    assert!(valid_token("0123456789abcdef"));
    for value in ["", "token\r\nOther: value", "private token"] {
        assert!(!valid_token(value));
    }
    assert!(!valid_token(&"a".repeat(257)));
}
#[test]
fn no_vm_configuration_does_not_claim_an_unsupported_ssh_connection() {
    for (value, expected) in [
        (
            serde_json::json!({"unsupported":true,"notConfigured":true}),
            false,
        ),
        (serde_json::json!({"unsupported":true}), true),
        (
            serde_json::json!({"unsupported":true,"notConfigured":false}),
            true,
        ),
        (
            serde_json::json!({"unsupported":false,"notConfigured":false}),
            false,
        ),
    ] {
        assert_eq!(
            ExitEvidence::from_value(&value).unsupported_notice(),
            expected
        );
    }
}

#[test]
fn typed_exit_evidence_preserves_legacy_omissions_and_rejects_wrong_typed_wire_fields() {
    for (body, expected) in [
        (
            br#"{"ok":true,"workPaused":true,"unsupported":true,"notConfigured":true}"#.as_slice(),
            ExitOutcome::Confirmed {
                unsupported_notice: false,
            },
        ),
        (
            br#"{"ok":true,"workPaused":true,"unsupported":true,"other":"ignored"}"#,
            ExitOutcome::Confirmed {
                unsupported_notice: true,
            },
        ),
        (
            br#"{"ok":true,"workPaused":true,"vmSuspended":true,"unsupported":"true"}"#,
            ExitOutcome::Rejected(ExitFailure::Unconfirmed),
        ),
        (
            br#"{"ok":true,"workPaused":true,"vmSuspended":true,"code":42}"#,
            ExitOutcome::Rejected(ExitFailure::Unconfirmed),
        ),
        (
            br#"{"ok":true,"workPaused":true,"vmSuspended":true,"code":"backup_running"}"#,
            ExitOutcome::Rejected(ExitFailure::BackupRunning),
        ),
    ] {
        assert_eq!(exit_response(reqwest::StatusCode::OK, body), expected);
    }
    assert!(confirmed(&serde_json::json!({
        "ok":true, "workPaused":true, "vmSuspended":true, "code":42,
        "unsupported":"unconfirmed"
    })));
    assert!(!confirmed(&serde_json::json!({
        "ok":true, "workPaused":true, "vmSuspended":"true", "unsupported":null
    })));
}
#[test]
fn reopening_uses_only_an_authenticated_controller_and_the_fixed_local_endpoint() {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let session =
        serde_json::json!({"product":"dant","mode":"controller","token":"0123456789abcdef"});
    let request =
        desktop_open_request(&client, &session, crate::protocol::controller_endpoint()).unwrap();
    assert_eq!(request.method(), reqwest::Method::POST);
    assert_eq!(
        request.url().as_str(),
        "http://127.0.0.1:4317/api/desktop/open"
    );
    assert_eq!(request.headers()["X-Dant-Token"], "0123456789abcdef");
    assert_eq!(request.headers()["Content-Type"], "application/json");
    assert_eq!(
        request.body().and_then(|body| body.as_bytes()),
        Some(b"{}".as_slice())
    );
    assert_eq!(request.timeout(), Some(&Duration::from_secs(150)));
    for value in [
        serde_json::json!({"product":"other","mode":"controller","token":"ab"}),
        serde_json::json!({"product":"dant","mode":"worker","token":"ab"}),
        serde_json::json!({"product":"dant","token":"ab"}),
        serde_json::json!({"product":"dant","mode":"controller","token":""}),
        serde_json::json!({"product":"dant","mode":"controller","token":"ab\r\nOther: value"}),
        serde_json::json!({"product":"dant","mode":"controller","token":"a".repeat(257)}),
    ] {
        assert!(
            desktop_open_request(&client, &value, crate::protocol::controller_endpoint()).is_none()
        );
    }
}
#[test]
fn reopening_requires_a_bounded_explicit_confirmation() {
    assert!(desktop_open_confirmed(br#"{"ok":true}"#));
    for value in [
        br#"{}"#.as_slice(),
        br#"{"ok":false}"#.as_slice(),
        br#"{"ok":"true"}"#.as_slice(),
        br#"{"error":"installing"}"#.as_slice(),
        b"not JSON".as_slice(),
    ] {
        assert!(!desktop_open_confirmed(value));
    }
    let oversized = format!("{{\"ok\":true,\"padding\":\"{}\"}}", "a".repeat(4096));
    assert!(!desktop_open_confirmed(oversized.as_bytes()));
}

#[test]
fn exit_requests_require_the_controller_identity_and_fixed_authenticated_action() {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let session =
        serde_json::json!({"product":"dant","mode":"controller","token":"0123456789abcdef"});
    let request = desktop_request(
        &client,
        &session,
        DesktopAction::Exit,
        crate::protocol::controller_endpoint(),
    )
    .unwrap();
    assert_eq!(request.method(), reqwest::Method::POST);
    assert_eq!(
        request.url().as_str(),
        "http://127.0.0.1:4317/api/desktop/exit"
    );
    assert_eq!(request.headers()["X-Dant-Token"], "0123456789abcdef");
    assert_eq!(
        request.body().and_then(|body| body.as_bytes()),
        Some(b"{}".as_slice())
    );
    assert_eq!(request.timeout(), Some(&DESKTOP_TRANSITION_TIMEOUT));
    for session in [
        serde_json::json!({"product":"dant","mode":"worker","token":"ab"}),
        serde_json::json!({"product":"dant","token":"ab"}),
        serde_json::json!({"product":"other","mode":"controller","token":"ab"}),
    ] {
        assert!(desktop_request(
            &client,
            &session,
            DesktopAction::Exit,
            crate::protocol::controller_endpoint()
        )
        .is_none());
    }
}

#[test]
fn exit_error_codes_are_allowlisted_without_inventing_permission_or_uac_failures() {
    for (code, expected) in [
        ("vm_pause_unconfirmed", ExitFailure::WorkPauseUnconfirmed),
        (
            "executor_stop_unconfirmed",
            ExitFailure::WorkPauseUnconfirmed,
        ),
        (
            "vm_lifecycle_unconfirmed",
            ExitFailure::VMSuspensionUnconfirmed,
        ),
        ("vm_lifecycle_busy", ExitFailure::VMOperationBusy),
        (
            "vm_lifecycle_invalid_identity",
            ExitFailure::VMIdentityUnverified,
        ),
        (
            "vm_lifecycle_invalid_receipt",
            ExitFailure::VMIdentityUnverified,
        ),
        (
            "vm_lifecycle_binding_changed",
            ExitFailure::VMIdentityUnverified,
        ),
        (
            "vm_lifecycle_intent_changed",
            ExitFailure::VMIdentityUnverified,
        ),
        ("vm_lifecycle_unsupported", ExitFailure::VMUnsupported),
        ("backup_running", ExitFailure::BackupRunning),
        ("backup_restore_unconfirmed", ExitFailure::BackupUnconfirmed),
        ("desktop_transition_busy", ExitFailure::DesktopBusy),
    ] {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "code": code,
            "error": "PRIVATE_TOKEN C:\\private\\process-output",
        }))
        .unwrap();
        assert_eq!(
            exit_response(reqwest::StatusCode::CONFLICT, &bytes),
            ExitOutcome::Rejected(expected)
        );
        let message = exit_failure_message("en", expected);
        assert!(!message.contains("PRIVATE_TOKEN") && !message.contains("process-output"));
    }
    for (phase, expected) in [
        ("pausing", ExitFailure::WorkPauseUnconfirmed),
        ("suspending", ExitFailure::VMSuspensionUnconfirmed),
        ("unknown", ExitFailure::Unconfirmed),
    ] {
        assert_eq!(
            ExitFailure::from_code(Some("request_timeout"), Some(phase)),
            expected
        );
        assert_eq!(
            ExitFailure::from_code(Some("request_cancelled"), Some(phase)),
            expected
        );
    }
    for code in [
        "vm_lifecycle_permission_denied",
        "uac_cancelled",
        "private-future-code",
    ] {
        assert_eq!(
            ExitFailure::from_code(Some(code), Some("suspending")),
            ExitFailure::Unconfirmed
        );
    }
}

#[test]
fn exit_responses_require_success_status_and_strong_bounded_confirmation() {
    let confirmed_bytes = br#"{"ok":true,"workPaused":true,"vmSuspended":true}"#;
    assert_eq!(
        exit_response(reqwest::StatusCode::OK, confirmed_bytes),
        ExitOutcome::Confirmed {
            unsupported_notice: false
        }
    );
    assert_eq!(
        exit_response(reqwest::StatusCode::CONFLICT, confirmed_bytes),
        ExitOutcome::Rejected(ExitFailure::Unconfirmed)
    );
    for bytes in [
        br#"{"ok":true}"#.as_slice(),
        br#"{"ok":true,"workPaused":true}"#.as_slice(),
        br#"{"ok":"true","workPaused":true,"vmSuspended":true}"#.as_slice(),
        br#"{"ok":true,"ok":false,"workPaused":true,"vmSuspended":true}"#.as_slice(),
        br#"{"code":"unknown","error":"PRIVATE_TOKEN"}"#.as_slice(),
        br#"{"code":{},"error":"PRIVATE_TOKEN"}"#.as_slice(),
        br#"{"code":"backup_running","code":"vm_pause_unconfirmed"}"#.as_slice(),
        b"PRIVATE_TOKEN not JSON".as_slice(),
        b"\xff".as_slice(),
    ] {
        assert_eq!(
            exit_response(reqwest::StatusCode::OK, bytes),
            ExitOutcome::Rejected(ExitFailure::Unconfirmed)
        );
    }
    let mut bounded = confirmed_bytes.to_vec();
    bounded.resize(DESKTOP_RESPONSE_MAX_BYTES, b' ');
    assert!(matches!(
        exit_response(reqwest::StatusCode::OK, &bounded),
        ExitOutcome::Confirmed { .. }
    ));
    bounded.push(b' ');
    assert_eq!(
        exit_response(reqwest::StatusCode::OK, &bounded),
        ExitOutcome::Rejected(ExitFailure::Unconfirmed)
    );
    let conflicting =
        br#"{"ok":true,"workPaused":true,"vmSuspended":true,"code":"vm_pause_unconfirmed"}"#;
    assert_eq!(
        exit_response(reqwest::StatusCode::OK, conflicting),
        ExitOutcome::Rejected(ExitFailure::WorkPauseUnconfirmed)
    );
}

fn isolated_exit_response(response: Vec<u8>) -> ExitOutcome {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/api/desktop/exit", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut connection, _) = listener.accept().unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        connection
            .set_write_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut input = std::io::BufReader::new(connection.try_clone().unwrap());
        let mut line = String::new();
        input.read_line(&mut line).unwrap();
        assert_eq!(line, "POST /api/desktop/exit HTTP/1.1\r\n");
        loop {
            line.clear();
            assert!(input.read_line(&mut line).unwrap() > 0);
            if line == "\r\n" {
                break;
            }
        }
        let mut body = [0; 2];
        input.read_exact(&mut body).unwrap();
        assert_eq!(&body, b"{}");
        let _ = connection.write_all(&response);
    });
    let result = tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let request = client.post(endpoint).body("{}").build().unwrap();
        execute_exit_request(&client, request).await
    });
    server.join().unwrap();
    result
}

#[test]
fn non_success_http_responses_are_bounded_and_classified_without_raw_body_leaks() {
    let body =
        br#"{"code":"vm_lifecycle_unconfirmed","phase":"suspending","error":"PRIVATE_TOKEN"}"#;
    let response = format!(
        "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    assert_eq!(
        isolated_exit_response([response.as_bytes(), body].concat()),
        ExitOutcome::Rejected(ExitFailure::VMSuspensionUnconfirmed)
    );

    let large = vec![b' '; DESKTOP_RESPONSE_MAX_BYTES + 1];
    let response = format!(
        "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        large.len()
    );
    assert_eq!(
        isolated_exit_response([response.as_bytes(), large.as_slice()].concat()),
        ExitOutcome::Rejected(ExitFailure::Unconfirmed)
    );
    let response = format!(
        "HTTP/1.1 409 Conflict\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n",
        large.len()
    );
    assert_eq!(
        isolated_exit_response([response.as_bytes(), large.as_slice(), b"\r\n0\r\n\r\n"].concat()),
        ExitOutcome::Rejected(ExitFailure::Unconfirmed)
    );
    let response =
        b"HTTP/1.1 503 Unavailable\r\nContent-Length: 13\r\nConnection: close\r\n\r\nPRIVATE_TOKEN";
    assert_eq!(
        isolated_exit_response(response.to_vec()),
        ExitOutcome::Rejected(ExitFailure::Unconfirmed)
    );
}

#[test]
fn every_registered_language_has_safe_native_exit_reasons() {
    let registry: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../resources/i18n/language-registry.json"
    ))
    .unwrap();
    for entry in registry {
        let language = entry["code"].as_str().unwrap();
        for failure in [
            ExitFailure::Unconfirmed,
            ExitFailure::WorkPauseUnconfirmed,
            ExitFailure::VMSuspensionUnconfirmed,
            ExitFailure::VMOperationBusy,
            ExitFailure::VMIdentityUnverified,
            ExitFailure::VMUnsupported,
            ExitFailure::BackupRunning,
            ExitFailure::BackupUnconfirmed,
            ExitFailure::DesktopBusy,
        ] {
            let message = exit_failure_message(language, failure);
            assert!(message.contains("\n\n"));
            if language != "en" {
                let english = exit_failure_message("en", failure);
                let localized: Vec<_> = message.split("\n\n").collect();
                let source: Vec<_> = english.split("\n\n").collect();
                assert_ne!(localized[0], source[0]);
                assert_ne!(localized[1], source[1]);
            }
        }
    }
}

struct DesktopPlatformFixture {
    _root: tempfile::TempDir,
    exit_window: AtomicBool,
    endpoint: std::net::SocketAddr,
    session: Option<serde_json::Value>,
    events: std::sync::Mutex<Vec<String>>,
    completed: std::sync::mpsc::Sender<&'static str>,
    gate: std::sync::Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    entered: Option<std::sync::mpsc::Sender<()>>,
}
impl DesktopPlatform<tauri::test::MockRuntime> for DesktopPlatformFixture {
    fn session(&self) -> Option<serde_json::Value> {
        self.events.lock().unwrap().push("session".into());
        if let Some(entered) = &self.entered {
            entered.send(()).unwrap();
        }
        if let Some(gate) = self.gate.lock().unwrap().take() {
            gate.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        self.session.clone()
    }
    fn endpoint(&self) -> std::net::SocketAddr {
        self.endpoint
    }
    fn notice(&self, message: &str) {
        self.events.lock().unwrap().push(message.into());
        self.completed.send("notice").unwrap();
    }
    fn exit(&self, app: &AppHandle<tauri::test::MockRuntime>) {
        assert!(approved(app));
        assert!(!app.state::<DesktopExit>().pending.load(Ordering::SeqCst));
        self.events.lock().unwrap().push("exit".into());
        if self.exit_window.load(Ordering::Acquire) {
            let handle = app.clone();
            app.run_on_main_thread(move || {
                tauri::WebviewWindowBuilder::new(
                    &handle,
                    "exit-fixture",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .build()
                .unwrap()
                .close()
                .unwrap();
            })
            .unwrap();
        }
        self.completed.send("exit").unwrap();
    }
}
fn native_desktop_fixture(
    endpoint: std::net::SocketAddr,
    session: Option<serde_json::Value>,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    std::sync::Arc<DesktopPlatformFixture>,
    std::sync::mpsc::Receiver<&'static str>,
) {
    let (completed, received) = std::sync::mpsc::channel();
    let root = tempfile::tempdir().unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.dant.desktopfixture.p{}", std::process::id());
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.path().to_owned()),
    );
    let host = std::sync::Arc::new(DesktopPlatformFixture {
        _root: root,
        exit_window: AtomicBool::new(false),
        endpoint,
        session,
        events: Default::default(),
        completed,
        gate: Default::default(),
        entered: None,
    });
    let app = tauri::test::mock_builder()
        .manage(DesktopExit::default())
        .manage(DesktopControl::<tauri::test::MockRuntime>(host.clone()))
        .manage(crate::tray::BackgroundTray::default())
        .manage(crate::call_overlay::CallOverlay::default())
        .build(context)
        .unwrap();
    tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    (app, host, received)
}
#[test]
fn native_exit_command_reconciles_one_isolated_controller_response_before_exit_or_failure_notice() {
    use crate::native_http::Server;
    use tauri::Listener;
    request_exit(tauri::test::mock_app().handle());
    for (body, confirmed, unsupported) in [
        (
            br#"{"ok":true,"workPaused":true,"vmSuspended":true}"#.as_slice(),
            true,
            false,
        ),
        (
            br#"{"ok":true,"workPaused":true,"unsupported":true}"#.as_slice(),
            true,
            true,
        ),
        (br#"{"code":"backup_running"}"#.as_slice(), false, false),
        (b"invalid".as_slice(), false, false),
    ] {
        let server = Server::new(
            [
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
                body,
            ]
            .concat(),
        );
        let (app, host, received) = native_desktop_fixture(
            server.address,
            Some(serde_json::json!({"product":"dant","mode":"controller","token":"a".repeat(64)})),
        );
        let failed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = failed.clone();
        app.get_webview_window("main")
            .unwrap()
            .listen("dant-exit-failed", move |_| {
                observed.fetch_add(1, Ordering::SeqCst);
            });
        request_exit(app.handle());
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            if confirmed && !unsupported {
                "exit"
            } else {
                "notice"
            }
        );
        if unsupported {
            assert_eq!(
                received.recv_timeout(Duration::from_secs(5)).unwrap(),
                "exit"
            );
        }
        assert_eq!(approved(app.handle()), confirmed);
        assert!(!app.state::<DesktopExit>().pending.load(Ordering::SeqCst));
        assert_eq!(failed.load(Ordering::SeqCst), usize::from(!confirmed));
        let wire = String::from_utf8(server.request()).unwrap();
        assert!(wire.starts_with("POST /api/desktop/exit HTTP/1.1\r\n"));
        assert_eq!(host.events.lock().unwrap()[0], "session");
        if confirmed {
            request_exit(app.handle());
            assert_eq!(
                received.recv_timeout(Duration::from_secs(5)).unwrap(),
                "exit"
            );
            assert_eq!(
                host.events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|event| event.as_str() == "session")
                    .count(),
                1
            );
        }
    }
}
#[test]
fn native_reopen_and_prepared_exit_use_only_the_captured_platform_and_never_resume_work() {
    use crate::native_http::Server;
    for session in [
        None,
        Some(serde_json::json!({"product":"dant","mode":"worker","token":"a".repeat(64)})),
    ] {
        let (app, host, received) = native_desktop_fixture("127.0.0.1:1".parse().unwrap(), session);
        assert!(!tauri::async_runtime::block_on(open_controller_request::<
            tauri::test::MockRuntime,
        >(host.clone())));
        open_existing_controller(app.handle());
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            "notice"
        );
        assert!(!approved(app.handle()));
        assert_eq!(host.events.lock().unwrap().len(), 3);
    }
    let body = br#"{"ok":true}"#;
    let server = Server::new(
        [
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
            body,
        ]
        .concat(),
    );
    let (app, host, received) = native_desktop_fixture(
        server.address,
        Some(serde_json::json!({"product":"dant","mode":"controller","token":"a".repeat(64)})),
    );
    assert!(tauri::async_runtime::block_on(open_controller_request::<
        tauri::test::MockRuntime,
    >(host)));
    assert!(String::from_utf8(server.request())
        .unwrap()
        .starts_with("POST /api/desktop/open HTTP/1.1\r\n"));
    prepared_update_exit(app.handle());
    assert_eq!(
        received.recv_timeout(Duration::from_secs(5)).unwrap(),
        "exit"
    );
    assert!(approved(app.handle()));
}

#[test]
fn native_exit_rejects_missing_session_and_interrupted_transport_without_approving_or_resending() {
    use crate::native_http::Server;
    let (app, host, received) = native_desktop_fixture("127.0.0.1:1".parse().unwrap(), None);
    request_exit(app.handle());
    assert_eq!(
        received.recv_timeout(Duration::from_secs(5)).unwrap(),
        "notice"
    );
    assert_eq!(host.events.lock().unwrap().len(), 2);
    assert_eq!(host.events.lock().unwrap()[0], "session");
    assert!(host.events.lock().unwrap()[1].contains("outcome could not be confirmed"));
    assert!(!approved(app.handle()));
    let client = desktop_client().unwrap();
    let server = Server::new(b"not an HTTP response".to_vec());
    let request = client
        .post(format!("http://{}/api/desktop/exit", server.address))
        .body("{}")
        .build()
        .unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(execute_exit_request(&client, request)),
        ExitOutcome::Rejected(ExitFailure::Unconfirmed)
    );
    assert!(String::from_utf8(server.request())
        .unwrap()
        .starts_with("POST /api/desktop/exit"));
    let native = NativeDesktopPlatform::default();
    assert_eq!(
        <NativeDesktopPlatform as DesktopPlatform<tauri::test::MockRuntime>>::endpoint(&native),
        crate::protocol::controller_endpoint()
    );
}

#[test]
fn the_native_session_adapter_uses_only_its_owned_controller_link() {
    let body = br#"{"product":"dant","mode":"controller","token":"synthetic"}"#;
    let server = crate::native_http::Server::new(
        [
            format!(
                "HTTP/1.0 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
            body,
        ]
        .concat(),
    );
    let native = NativeDesktopPlatform {
        link: crate::transport::isolated_http_link(&server),
    };
    assert_eq!(
        <NativeDesktopPlatform as DesktopPlatform<tauri::test::MockRuntime>>::session(&native),
        Some(serde_json::from_slice(body).unwrap())
    );
    let wire = String::from_utf8(server.completed_request()).unwrap();
    assert!(wire.starts_with("GET /api/session HTTP/1.0\r\n"));
    assert!(!wire.contains("X-Dant-Token"));
}

#[test]
fn successful_public_reopen_does_not_emit_a_failure_notice_or_change_exit_approval() {
    use crate::native_http::Server;
    let server = Server::new(
        b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}".to_vec(),
    );
    let (app, host, received) = native_desktop_fixture(
        server.address,
        Some(serde_json::json!({"product":"dant","mode":"controller","token":"a".repeat(64)})),
    );
    open_existing_controller(app.handle());
    assert!(String::from_utf8(server.completed_request())
        .unwrap()
        .starts_with("POST /api/desktop/open"));
    assert!(received.recv_timeout(Duration::from_millis(150)).is_err());
    assert_eq!(*host.events.lock().unwrap(), ["session"]);
    assert!(!approved(app.handle()));
}

#[cfg(windows)]
#[test]
fn sdk_exit_events_preserve_the_pause_transaction_and_deduplicate_pending_requests_in_an_isolated_child(
) {
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::Instant,
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
            "lifecycle::tests::synthetic_desktop_event_child",
            "--nocapture",
        ])
        .env("DANT_NATIVE_DESKTOP_FIXTURE", "owned")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(output.try_clone().unwrap()))
        .creation_flags(crate::runtime::CREATE_NO_WINDOW);
    let mut child = OwnedChild(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            if !status.success() {
                use std::io::Seek;
                let mut output = output;
                output.rewind().unwrap();
                let mut bytes = Vec::new();
                output.take(65536).read_to_end(&mut bytes).unwrap();
                panic!(
                    "Synthetic desktop fixture failed: {}",
                    String::from_utf8_lossy(&bytes)
                );
            }
            break;
        }
        assert!(
            Instant::now() < deadline,
            "The isolated desktop event fixture must terminate"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[cfg(windows)]
#[test]
fn synthetic_desktop_event_child() {
    if std::env::var("DANT_NATIVE_DESKTOP_FIXTURE").as_deref() != Ok("owned") {
        return;
    }
    let body = br#"{"ok":true,"workPaused":true,"vmSuspended":true}"#;
    let server = crate::native_http::Server::new(
        [
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
            body,
        ]
        .concat(),
    );
    let (app, host, received) = native_desktop_fixture(
        server.address,
        Some(serde_json::json!({"product":"dant","mode":"controller","token":"a".repeat(64)})),
    );
    host.exit_window.store(true, Ordering::Release);
    let (release, gate) = std::sync::mpsc::channel();
    *host.gate.lock().unwrap() = Some(gate);
    let mut release = Some(release);
    let main = app.get_webview_window("main").unwrap();
    let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = requests.clone();
    app.run(move |handle, event| {
        if let tauri::RunEvent::WindowEvent { label, event, .. } = &event {
            crate::application_window_event(
                &handle.get_webview_window(label).unwrap().as_ref().window(),
                event,
            );
        }
        if matches!(event, tauri::RunEvent::Ready) {
            main.close().unwrap();
        }
        let first = matches!(event, tauri::RunEvent::ExitRequested { .. })
            && observed.fetch_add(1, Ordering::SeqCst) == 0;
        crate::application_event(handle, event);
        if first {
            assert!(handle.state::<DesktopExit>().pending.load(Ordering::SeqCst));
            request_exit(handle);
            release.take().unwrap().send(()).unwrap();
        }
    });
    assert_eq!(
        received.recv_timeout(Duration::from_secs(5)).unwrap(),
        "exit"
    );
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    assert_eq!(*host.events.lock().unwrap(), vec!["session", "exit"]);
    let wire = String::from_utf8(server.request()).unwrap();
    assert!(wire.starts_with("POST /api/desktop/exit HTTP/1.1\r\n"));
}
