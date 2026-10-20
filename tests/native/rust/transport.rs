use super::{
    api_request_timeout, compatible_controller, validate_json_body, API_JSON_BODY_BYTES,
    API_REQUEST_TIMEOUT, CORE_PROTOCOL_VERSION, WORKER_DEPLOYMENT_REQUEST_TIMEOUT,
};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    net::{SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

struct HttpFixture {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<Vec<u8>>>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl HttpFixture {
    fn new(responses: Vec<Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        assert_ne!(
            address.port(),
            4317,
            "fixtures must never use the real Controller"
        );
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let worker_stop = Arc::clone(&stop);
        let observed = Arc::clone(&requests);
        let thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut responses = VecDeque::from(responses);
            while !worker_stop.load(Ordering::SeqCst) && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(_) => break,
                };
                // Windows can inherit the listener's nonblocking mode. The
                // bounded read/write timeouts below require a blocking peer.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 8192];
                while request.len() <= API_JSON_BODY_BYTES + 16384 {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => request.extend_from_slice(&buffer[..count]),
                    }
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                observed.lock().unwrap().push(request);
                let response = responses.pop_front().unwrap_or_default();
                // Early client rejection can close a large response mid-write.
                let _ = stream.write_all(&response);
                // Half-close before draining the client so Windows does not
                // turn an ordinary completed response into a reset on drop.
                let _ = stream.shutdown(std::net::Shutdown::Write);
                let _ = stream.read(&mut buffer);
            }
        });
        Self {
            address,
            stop,
            requests,
            thread: Some(thread),
        }
    }

    fn requests(&self) -> Vec<Vec<u8>> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}

fn response(status: &str, content_type: Option<&str>, body: &[u8]) -> Vec<u8> {
    let mut result = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    )
    .into_bytes();
    if let Some(value) = content_type {
        result.extend_from_slice(format!("Content-Type: {value}\r\n").as_bytes());
    }
    result.extend_from_slice(b"\r\n");
    result.extend_from_slice(body);
    result
}

fn request(
    fixture: &HttpFixture,
    method: &str,
    body: Option<&str>,
    token: Option<&str>,
) -> Result<super::ApiResponse, String> {
    let input =
        super::validate_request("main", "/api/fixture?value=1", Some(method), body, token).unwrap();
    tauri::async_runtime::block_on(super::request_at(fixture.address, input))
}

#[test]
fn deployment_requests_keep_the_full_upgrade_budget_without_extending_other_requests() {
    for route in ["/api/connect", "/api/prepare", "/api/service-update"] {
        assert_eq!(
            api_request_timeout("POST", route),
            WORKER_DEPLOYMENT_REQUEST_TIMEOUT
        );
        assert_eq!(api_request_timeout("GET", route), API_REQUEST_TIMEOUT);
    }

    for route in [
        "/api/state",
        "/api/chat",
        "/api/desktop/exit",
        "/api/connect/other",
        "/api/connect?unexpected=true",
    ] {
        assert_eq!(api_request_timeout("POST", route), API_REQUEST_TIMEOUT);
    }
}

#[test]
fn controller_reuse_requires_the_same_go_build_and_role() {
    let source = "a".repeat(40);
    let session = serde_json::json!({
        "product": "dant", "mode": "controller", "runtime": "go",
        "protocol": CORE_PROTOCOL_VERSION, "version": env!("CARGO_PKG_VERSION"),
        "source": source
    });
    assert!(compatible_controller(&session, &source));
    for (key, value) in [
        ("product", serde_json::json!("other")),
        ("mode", serde_json::json!("worker")),
        ("runtime", serde_json::json!("node")),
        ("protocol", serde_json::json!(0)),
        ("version", serde_json::json!("0.0.0")),
        ("source", serde_json::json!("b".repeat(40))),
    ] {
        let mut changed = session.clone();
        changed[key] = value;
        assert!(!compatible_controller(&changed, &source), "{key}");
    }
    assert!(!compatible_controller(
        &serde_json::json!({"product":"dant"}),
        &source
    ));
}

#[test]
fn json_body_accepts_absence_and_the_exact_byte_limit() {
    assert_eq!(validate_json_body(None), Ok(()));
    assert_eq!(validate_json_body(Some("")), Ok(()));
    let maximum = "x".repeat(API_JSON_BODY_BYTES);
    assert_eq!(validate_json_body(Some(&maximum)), Ok(()));
    let unicode_maximum = "é".repeat(API_JSON_BODY_BYTES / 2);
    assert_eq!(validate_json_body(Some(&unicode_maximum)), Ok(()));
}

#[test]
fn json_body_rejects_overflow_by_bytes_including_multibyte_text() {
    let oversized = "x".repeat(API_JSON_BODY_BYTES + 1);
    assert_eq!(
        validate_json_body(Some(&oversized)),
        Err("Local API request is too large")
    );
    let unicode_oversized = "é".repeat(API_JSON_BODY_BYTES / 2 + 1);
    assert_eq!(
        validate_json_body(Some(&unicode_oversized)),
        Err("Local API request is too large")
    );
}

#[test]
fn ipc_validation_rejects_wrong_window_injection_methods_and_nonhex_sessions_before_transport() {
    assert_eq!(super::local_endpoint().to_string(), "127.0.0.1:4317");
    let valid = super::validate_request("main", "/api/session", None, None, None).unwrap();
    assert_eq!(valid.method, "GET");
    assert_eq!(valid.token, "");
    for (window, route, method, token, expected) in [
        (
            "call-overlay",
            "/api/session",
            "GET",
            "",
            "Local API requests require the main window",
        ),
        (
            "main",
            "https://example.invalid",
            "GET",
            "",
            "Invalid local API route",
        ),
        ("main", "/api/a\r\nb", "GET", "", "Invalid local API route"),
        (
            "main",
            "/api/a#fragment",
            "GET",
            "",
            "Invalid local API route",
        ),
        ("main", "/api/a\\b", "GET", "", "Invalid local API route"),
        (
            "main",
            "/api/session",
            "PUT",
            "",
            "Unsupported local API method",
        ),
        (
            "main",
            "/api/session",
            "get",
            "",
            "Unsupported local API method",
        ),
        (
            "main",
            "/api/session",
            "POST",
            "private\r\nheader",
            "Invalid local API session",
        ),
    ] {
        assert_eq!(
            super::validate_request(window, route, Some(method), None, Some(token)).err(),
            Some(expected)
        );
    }
    assert_eq!(
        super::validate_request(
            "main",
            &format!("/api/{}", "x".repeat(2048)),
            None,
            None,
            None
        )
        .err(),
        Some("Invalid local API route")
    );
    assert_eq!(
        super::validate_request("main", "/api/ok", None, None, Some(&"a".repeat(257))).err(),
        Some("Invalid local API session")
    );
    assert_eq!(
        super::validate_request(
            "main",
            "/api/ok",
            None,
            Some(&"x".repeat(API_JSON_BODY_BYTES + 1)),
            None
        )
        .err(),
        Some("Local API request is too large")
    );
    assert!(super::validate_request(
        "main",
        &format!("/api/{}", "x".repeat(2048 - 5)),
        None,
        None,
        Some(&"a".repeat(256))
    )
    .is_ok());
}

#[test]
fn async_http_preserves_unicode_status_headers_body_and_exact_token_without_redirecting() {
    let fixture = HttpFixture::new(vec![response(
        "201 Created",
        Some("text/plain; charset=utf-8"),
        "你好".as_bytes(),
    )]);
    let attempted = request(&fixture, "POST", Some("{\"text\":\"中文\"}"), Some("aA12"));
    assert!(
        attempted.is_ok(),
        "{:?}; synthetic requests: {:?}",
        attempted.as_ref().err(),
        fixture.requests()
    );
    let result = attempted.unwrap();
    assert_eq!(result.status, 201);
    assert_eq!(result.content_type, "text/plain; charset=utf-8");
    assert_eq!(result.body, "你好");
    let requests = fixture.requests();
    assert_eq!(requests.len(), 1);
    let wire = String::from_utf8_lossy(&requests[0]).to_lowercase();
    assert!(wire.starts_with("post /api/fixture?value=1 http/1.1\r\n"));
    assert!(wire.contains("x-dant-token: aa12\r\n"));
    assert!(wire.contains("content-type: application/json\r\n"));
    assert!(wire.ends_with("{\"text\":\"中文\"}"));
}

#[test]
fn async_http_does_not_follow_local_redirect_or_automatically_retry_any_method() {
    let fixture = HttpFixture::new(vec![b"HTTP/1.1 302 Found\r\nLocation: /api/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()]);
    let attempted = request(&fixture, "GET", None, None);
    assert!(
        attempted.is_ok(),
        "{:?}; synthetic requests: {:?}",
        attempted.as_ref().err(),
        fixture.requests()
    );
    assert_eq!(attempted.unwrap().status, 302);
    assert_eq!(fixture.requests().len(), 1);
    for method in ["GET", "POST", "PATCH", "DELETE"] {
        let fixture = HttpFixture::new(vec![Vec::new()]);
        let error = request(&fixture, method, Some("{}"), None).err().unwrap();
        assert_eq!(
            error,
            if method == "GET" {
                "The local controller is disconnected"
            } else {
                "The request outcome is unconfirmed. It has not been resent."
            }
        );
        assert_eq!(
            fixture.requests().len(),
            1,
            "unknown requests must not be resent"
        );
    }
}

#[test]
fn async_http_rejects_interrupted_non_utf8_and_oversized_response_bodies() {
    for (raw, expected) in [
        (
            response("200 OK", None, &[0xff, 0xfe]),
            "Local API response is not UTF-8 text",
        ),
        (
            b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\na".to_vec(),
            "Local API response was interrupted",
        ),
        (
            response("200 OK", None, &vec![b'x'; super::API_RESPONSE_BYTES + 1]),
            "Local API response is too large",
        ),
    ] {
        let fixture = HttpFixture::new(vec![raw]);
        assert_eq!(
            request(&fixture, "GET", None, None).err().as_deref(),
            Some(expected)
        );
        assert_eq!(fixture.requests().len(), 1);
    }
    let fixture = HttpFixture::new(vec![response("200 OK", None, b"{}")]);
    assert_eq!(
        request(&fixture, "GET", None, None).unwrap().content_type,
        "application/json"
    );
}

#[test]
fn async_http_accepts_the_exact_response_limit_and_uses_a_safe_content_type_fallback() {
    let body = "x".repeat(super::API_RESPONSE_BYTES);
    let fixture = HttpFixture::new(vec![response("200 OK", None, body.as_bytes())]);
    let result = request(&fixture, "GET", None, None).unwrap();
    assert_eq!(result.body, body);
    assert_eq!(fixture.requests().len(), 1);

    let fixture = HttpFixture::new(vec![
        b"HTTP/1.1 200 OK\r\nContent-Type: \xff\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
            .to_vec(),
    ]);
    let result = request(&fixture, "GET", None, None).unwrap();
    assert_eq!(result.content_type, "application/json");
    assert_eq!(result.body, "{}");
}

#[test]
fn sync_json_uses_the_owned_socket_and_preserves_post_body_and_token() {
    let fixture = HttpFixture::new(vec![response("200 OK", None, b"{\"ok\":true}")]);
    assert_eq!(
        super::local_json_at(
            fixture.address,
            "/api/task",
            Some("synthetic-token"),
            Some("{\"x\":1}")
        ),
        Some(serde_json::json!({"ok":true}))
    );
    let requests = fixture.requests();
    assert_eq!(requests.len(), 1);
    let wire = String::from_utf8_lossy(&requests[0]);
    assert!(wire.starts_with("POST /api/task HTTP/1.0\r\n"));
    assert!(wire.contains("X-Dant-Token: synthetic-token\r\n"));
    assert!(wire.ends_with("{\"x\":1}"));
}

#[test]
fn sync_json_rejects_non_success_malformed_utf8_and_json() {
    for raw in [
        response("403 Forbidden", None, b"{}"),
        b"no headers".to_vec(),
        response("200 OK", None, b"invalid"),
        response("200 OK", None, &[0xff]),
        b"\r\n\r\n{}".to_vec(),
        b"INVALID 200 OK\r\n\r\n{}".to_vec(),
    ] {
        let fixture = HttpFixture::new(vec![raw]);
        assert!(super::local_json_at(fixture.address, "/api/session", None, None).is_none());
    }
}

#[test]
fn a_closed_owned_endpoint_is_absent_and_cannot_receive_an_execution_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    assert_ne!(address.port(), 4317);
    drop(listener);

    assert!(super::local_json_at(address, "/api/session", None, None).is_none());
    assert_eq!(
        super::existing_controller_at(address, &"a".repeat(40)),
        Ok(false)
    );
}

#[test]
fn sync_json_never_treats_a_reason_phrase_as_the_success_status() {
    let fixture = HttpFixture::new(vec![response(
        "500 Failed 200 Reason",
        None,
        b"{\"ok\":true}",
    )]);
    assert!(super::local_json_at(fixture.address, "/api/session", None, None).is_none());
}

#[test]
fn sync_json_rejects_oversized_whitespace_after_a_valid_object() {
    let mut body = b"{}".to_vec();
    body.resize(super::LOCAL_JSON_RESPONSE_BYTES as usize + 1, b' ');
    let fixture = HttpFixture::new(vec![response("200 OK", None, &body)]);
    assert!(super::local_json_at(fixture.address, "/api/session", None, None).is_none());
}

#[test]
fn existing_controller_requires_a_live_matching_session_and_rejects_an_unidentified_listener() {
    let source = "a".repeat(40);
    let session = serde_json::to_vec(
        &serde_json::json!({"product":"dant", "mode":"controller", "runtime":"go", "protocol":1,
        "version":env!("CARGO_PKG_VERSION"), "source":source}),
    )
    .unwrap();
    let fixture = HttpFixture::new(vec![response("200 OK", None, &session)]);
    assert_eq!(
        super::existing_controller_at(fixture.address, &source),
        Ok(true)
    );
    let foreign = HttpFixture::new(vec![response("200 OK", None, b"{\"product\":\"other\"}")]);
    assert!(super::existing_controller_at(foreign.address, &source)
        .unwrap_err()
        .starts_with("A different dant service"));
    let unknown = HttpFixture::new(vec![response("503 Busy", None, b"{}")]);
    assert!(super::existing_controller_at(unknown.address, &source)
        .unwrap_err()
        .starts_with("The local service could not be identified"));
}

#[test]
fn bundled_manifest_requires_an_ordinary_bounded_file_and_exact_lowercase_source() {
    let root = tempfile::tempdir().unwrap();
    let manifest = root.path().join("resource-manifest.json");
    assert_eq!(
        super::bundled_source(root.path()).err(),
        Some("The Go core resource manifest is missing")
    );
    for (raw, expected) in [
        (
            b"invalid".to_vec(),
            "The Go core resource manifest is invalid",
        ),
        (b"{}".to_vec(), "The Go core source is missing"),
        (
            serde_json::to_vec(&serde_json::json!({"sourceCommit":"A".repeat(40)})).unwrap(),
            "The Go core source is invalid",
        ),
        (
            serde_json::to_vec(&serde_json::json!({"sourceCommit":"a".repeat(39)})).unwrap(),
            "The Go core source is invalid",
        ),
        (
            vec![b'x'; super::RESOURCE_MANIFEST_BYTES as usize + 1],
            "The Go core resource manifest is invalid",
        ),
    ] {
        std::fs::write(&manifest, raw).unwrap();
        assert_eq!(super::bundled_source(root.path()).err(), Some(expected));
    }
    std::fs::write(
        &manifest,
        serde_json::to_vec(&serde_json::json!({"sourceCommit":"a".repeat(40)})).unwrap(),
    )
    .unwrap();
    assert_eq!(super::bundled_source(root.path()).unwrap(), "a".repeat(40));
    std::fs::remove_file(&manifest).unwrap();
    std::fs::create_dir(&manifest).unwrap();
    assert_eq!(
        super::bundled_source(root.path()).err(),
        Some("The Go core resource manifest is invalid")
    );
}

#[cfg(windows)]
#[test]
fn a_locked_manifest_is_a_read_failure_and_never_an_invented_build_identity() {
    use std::os::windows::fs::OpenOptionsExt;

    let root = tempfile::tempdir().unwrap();
    let manifest = root.path().join("resource-manifest.json");
    std::fs::write(&manifest, b"{\"sourceCommit\":\"synthetic\"}").unwrap();
    let guard = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&manifest)
        .unwrap();
    assert_eq!(
        super::bundled_source(root.path()).err(),
        Some("The Go core resource manifest could not be read")
    );
    drop(guard);
}
