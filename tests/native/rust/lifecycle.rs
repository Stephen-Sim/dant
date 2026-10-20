use super::*;
use std::io::{BufRead, Read, Write};

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
    assert!(!unsupported_notice(
        &serde_json::json!({"unsupported":true,"notConfigured":true})
    ));
    assert!(unsupported_notice(&serde_json::json!({"unsupported":true})));
    assert!(unsupported_notice(
        &serde_json::json!({"unsupported":true,"notConfigured":false})
    ));
    assert!(!unsupported_notice(
        &serde_json::json!({"unsupported":false,"notConfigured":false})
    ));
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
    let request = desktop_open_request(&client, &session).unwrap();
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
        assert!(desktop_open_request(&client, &value).is_none());
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
    let request = desktop_request(&client, &session, DesktopAction::Exit).unwrap();
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
        assert!(desktop_request(&client, &session, DesktopAction::Exit).is_none());
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
