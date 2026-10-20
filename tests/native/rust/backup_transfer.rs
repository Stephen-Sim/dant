use super::*;
use std::{
    net::{SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Instant,
};
#[test]
fn main_window_token_and_password_are_bounded_without_trimming_passwords() {
    assert!(arguments("main", &"a".repeat(64), "twelve bytes").is_ok());
    assert!(arguments("call-overlay", &"a".repeat(64), "twelve bytes").is_err());
    for token in ["", "abc", &"g".repeat(64)] {
        assert!(arguments("main", token, "twelve bytes").is_err());
    }
    for pass in ["short".to_string(), "x".repeat(1025)] {
        assert_eq!(
            arguments("main", &"a".repeat(64), &pass).unwrap_err(),
            PASSWORD
        );
    }
    assert!(arguments("main", &"a".repeat(64), "中文中文").is_ok());
    assert!(valid_id("00000000-0000-4000-8000-000000000009"));
    assert!(!valid_id("../private"));
}
#[test]
fn streamed_save_is_atomic_bounded_and_cleans_up_on_interrupt_or_cancel() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".cache/tests");
    fs::create_dir_all(&workspace).unwrap();
    let root = tempfile::tempdir_in(workspace).unwrap();
    let file = root.path().join("chosen.dant");
    fs::write(&file, b"old").unwrap();
    assert!(save_stream(&mut &b"complete"[..], &file, Some(8), 64, || true).is_ok());
    assert_eq!(fs::read(&file).unwrap(), b"complete");
    for (value, declared, limit) in [(&b"too long"[..], None, 2), (&b"short"[..], Some(10), 64)] {
        assert!(save_stream(&mut &value[..], &file, declared, limit, || true).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"complete");
    }
    assert!(save_stream(&mut &b"discard"[..], &file, None, 64, || false).is_err());
    assert!(save_stream(&mut io::repeat(0).take(100), &file, None, 20, || true).is_err());
    assert_eq!(
        save_stream(
            &mut &b"x"[..],
            &file,
            Some(MAX_PORTABLE_BYTES + 1),
            MAX_PORTABLE_BYTES,
            || true
        )
        .unwrap_err(),
        TOO_LARGE
    );
    struct Interrupted;
    impl Read for Interrupted {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "isolated private failure",
            ))
        }
    }
    assert_eq!(
        save_stream(&mut Interrupted, &file, None, 64, || true).unwrap_err(),
        INTERRUPTED
    );
    assert!(
        save_stream(&mut &b"x"[..], Path::new("relative.dant"), None, 20, || {
            true
        })
        .is_err()
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

const BACKUP_ID: &str = "00000000-0000-4000-8000-000000000009";
const PASSPHRASE: &str = "synthetic passphrase";

struct Server {
    endpoint: SocketAddr,
    stop: Arc<AtomicBool>,
    calls: Arc<Mutex<Vec<Vec<u8>>>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(response: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = listener.local_addr().unwrap();
        assert_ne!(endpoint.port(), 4317);
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::clone(&stop);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&calls);
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !cancelled.load(Ordering::Acquire) && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(_) => break,
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 8192];
                while request.len() < 1024 * 1024 {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => request.extend_from_slice(&buffer[..count]),
                    };
                    if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let length = String::from_utf8_lossy(&request[..end])
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                if name.eq_ignore_ascii_case("Content-Length") {
                                    value.trim().parse::<usize>().ok()
                                } else {
                                    None
                                }
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                observed.lock().unwrap().push(request);
                let _ = stream.write_all(&response);
                let _ = stream.shutdown(std::net::Shutdown::Write);
                let _ = stream.read(&mut buffer);
            }
        });
        Self {
            endpoint,
            stop,
            calls,
            worker: Some(worker),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn response(status: &str, kind: Option<&str>, body: &[u8]) -> Vec<u8> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(kind) = kind {
        head.push_str(&format!("Content-Type: {kind}\r\n"));
    }
    head.push_str("\r\n");
    let mut bytes = head.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}
fn metadata() -> serde_json::Value {
    serde_json::json!({"backup":{"id":BACKUP_ID,"createdAt":123,"appVersion":"0.5.0","bytes":42,"files":2,"source":"abcdef012345"}})
}

#[test]
fn export_streams_binary_exactly_to_the_owned_destination_and_sends_only_the_authenticated_request()
{
    assert_eq!(controller_endpoint().to_string(), "127.0.0.1:4317");
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("selected.dant");
    let payload: Vec<u8> = (0..BUFFER_BYTES * 3 + 7).map(|n| (n % 256) as u8).collect();
    let server = Server::new(response(
        "200 OK",
        Some("application/octet-stream; charset=binary"),
        &payload,
    ));
    assert!(export_to(
        server.endpoint,
        BACKUP_ID,
        &"a".repeat(64),
        PASSPHRASE,
        &destination,
        || true
    )
    .unwrap());
    assert_eq!(fs::read(&destination).unwrap(), payload);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    let calls = server.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let wire = String::from_utf8_lossy(&calls[0]);
    assert!(wire.starts_with(&format!(
        "POST /api/backups/{BACKUP_ID}/export HTTP/1.1\r\n"
    )));
    assert!(wire
        .to_ascii_lowercase()
        .contains(&format!("x-dant-token: {}\r\n", "a".repeat(64))));
    assert!(wire.ends_with(&serde_json::json!({"passphrase":PASSPHRASE}).to_string()));
}

#[test]
fn export_accepts_unknown_chunked_lengths_but_never_wrong_type_partial_data_or_unconfirmed_requests(
) {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("chosen.dant");
    let server=Server::new(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n4\r\nDANT\r\n0\r\n\r\n".to_vec());
    assert!(export_to(
        server.endpoint,
        BACKUP_ID,
        &"a".repeat(64),
        PASSPHRASE,
        &destination,
        || true
    )
    .unwrap());
    assert_eq!(fs::read(&destination).unwrap(), b"DANT");
    for raw in [response("200 OK",Some("text/plain"),b"private"),response("200 OK",None,b"private"),b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 99\r\nConnection: close\r\n\r\nshort".to_vec(),b"HTTP/1.1 302 Found\r\nLocation: /unexpected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),Vec::new()] {
        let server=Server::new(raw);assert!(export_to(server.endpoint,BACKUP_ID,&"a".repeat(64),PASSPHRASE,&destination,||true).is_err());assert_eq!(server.calls.lock().unwrap().len(),1);assert_eq!(fs::read(&destination).unwrap(),b"DANT");assert_eq!(fs::read_dir(root.path()).unwrap().count(),1);
    }
}

#[test]
fn transfer_error_payloads_are_bounded_classified_and_never_expose_arbitrary_server_text() {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("out.dant");
    for code in [
        PASSWORD,
        "backup_invalid",
        TOO_LARGE,
        "backup_exists",
        "backup_busy",
        "private server text",
    ] {
        let server = Server::new(response(
            "400 Failed",
            Some("application/json"),
            serde_json::json!({"code":code,"error":"synthetic private content"})
                .to_string()
                .as_bytes(),
        ));
        let expected = if code == "private server text" {
            FAILED
        } else {
            code
        };
        assert_eq!(
            export_to(
                server.endpoint,
                BACKUP_ID,
                &"a".repeat(64),
                PASSPHRASE,
                &destination,
                || true
            )
            .unwrap_err(),
            expected
        );
    }
    for bytes in [vec![b'x'; JSON_LIMIT as usize + 1], b"not JSON".to_vec()] {
        let server = Server::new(response("500 Failed", None, &bytes));
        assert_eq!(
            export_to(
                server.endpoint,
                BACKUP_ID,
                &"a".repeat(64),
                PASSPHRASE,
                &destination,
                || true
            )
            .unwrap_err(),
            FAILED
        );
    }
    assert!(!destination.exists());
}

#[test]
fn import_streams_exact_binary_with_a_bounded_encoded_passphrase_and_validates_the_receipt() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.dant");
    let payload: Vec<u8> = (0..BUFFER_BYTES + 17).map(|n| (n % 255) as u8).collect();
    fs::write(&source, &payload).unwrap();
    let reply = serde_json::to_vec(&metadata()).unwrap();
    let server = Server::new(response("200 OK", Some("application/json"), &reply));
    let result = import_from(
        server.endpoint,
        &source,
        &"b".repeat(64),
        "中文中文",
        || true,
    )
    .unwrap()
    .unwrap();
    assert_eq!(result.id, BACKUP_ID);
    assert_eq!(result.bytes, 42);
    assert_eq!(result.files, 2);
    let calls = server.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let split = calls[0]
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .unwrap()
        + 4;
    assert_eq!(&calls[0][split..], payload);
    let headers = String::from_utf8_lossy(&calls[0][..split]).to_ascii_lowercase();
    assert!(headers.starts_with("post /api/backups/import http/1.1\r\n"));
    assert!(headers.contains(&format!("content-length: {}\r\n", payload.len())));
    assert!(headers.contains(&format!(
        "x-dant-backup-passphrase: {}\r\n",
        base64::engine::general_purpose::STANDARD
            .encode("中文中文")
            .to_ascii_lowercase()
    )));
    assert_eq!(fs::read(&source).unwrap(), payload);
}

#[test]
fn invalid_import_metadata_and_unknown_transport_outcomes_cannot_report_a_restored_backup() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.dant");
    fs::write(&source, b"synthetic portable bytes").unwrap();
    for (field, bad) in [
        ("id", serde_json::json!("invalid")),
        ("createdAt", serde_json::json!(0)),
        ("createdAt", serde_json::json!(9_007_199_254_740_992u64)),
        ("bytes", serde_json::json!(10 * 1024 * 1024 * 1024u64 + 1)),
        ("files", serde_json::json!(100001)),
        ("source", serde_json::json!("bad")),
        ("source", serde_json::json!("g".repeat(12))),
        ("appVersion", serde_json::json!("")),
        ("appVersion", serde_json::json!("x".repeat(65))),
    ] {
        let mut reply = metadata();
        reply["backup"][field] = bad;
        let server = Server::new(response(
            "200 OK",
            Some("application/json"),
            &serde_json::to_vec(&reply).unwrap(),
        ));
        assert_eq!(
            import_from(
                server.endpoint,
                &source,
                &"a".repeat(64),
                PASSPHRASE,
                || true
            )
            .err()
            .as_deref(),
            Some(INTERRUPTED),
            "{field}"
        );
        assert_eq!(server.calls.lock().unwrap().len(), 1);
    }
    for raw in [
        response("200 OK", None, b"not JSON"),
        Vec::new(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\nConnection: close\r\n\r\nx".to_vec(),
    ] {
        let server = Server::new(raw);
        assert_eq!(
            import_from(
                server.endpoint,
                &source,
                &"a".repeat(64),
                PASSPHRASE,
                || true
            )
            .err()
            .as_deref(),
            Some(INTERRUPTED)
        );
        assert_eq!(server.calls.lock().unwrap().len(), 1);
    }
    let server = Server::new(response(
        "200 OK",
        None,
        &vec![b' '; JSON_LIMIT as usize + 1],
    ));
    assert_eq!(
        import_from(
            server.endpoint,
            &source,
            &"a".repeat(64),
            PASSPHRASE,
            || true
        )
        .err()
        .as_deref(),
        Some(FAILED)
    );
    let server = Server::new(response("400 Bad", None, b"{\"code\":\"backup_invalid\"}"));
    assert_eq!(
        import_from(
            server.endpoint,
            &source,
            &"a".repeat(64),
            PASSPHRASE,
            || true
        )
        .err()
        .as_deref(),
        Some("backup_invalid")
    );
}

#[test]
fn vanished_windows_bad_arguments_and_unusable_sources_fail_before_any_network_or_destination_write(
) {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.dant");
    fs::write(&source, b"synthetic").unwrap();
    let destination = root.path().join("target.dant");
    let server = Server::new(Vec::new());
    assert_eq!(
        export_to(
            server.endpoint,
            BACKUP_ID,
            &"a".repeat(64),
            PASSPHRASE,
            &destination,
            || false
        )
        .unwrap_err(),
        INTERRUPTED
    );
    assert!(export_to(
        server.endpoint,
        "bad",
        &"a".repeat(64),
        PASSPHRASE,
        &destination,
        || true
    )
    .is_err());
    assert!(export_to(
        server.endpoint,
        BACKUP_ID,
        "bad",
        PASSPHRASE,
        &destination,
        || true
    )
    .is_err());
    assert!(import_from(server.endpoint, &source, "bad", PASSPHRASE, || true).is_err());
    assert!(import_from(server.endpoint, &source, &"a".repeat(64), "short", || true).is_err());
    assert!(import_from(
        server.endpoint,
        &source,
        &"a".repeat(64),
        PASSPHRASE,
        || false
    )
    .is_err());
    assert!(selected_file(root.path()).is_err());
    assert!(selected_file(&root.path().join("absent")).is_err());
    assert!(selected_file(Path::new("")).is_err());
    fs::write(&source, b"").unwrap();
    assert_eq!(
        selected_file(&source).err().as_deref(),
        Some("backup_invalid")
    );
    assert!(server.calls.lock().unwrap().is_empty());
    assert!(!destination.exists());
}

#[test]
fn cancellation_after_eof_and_foreign_destinations_preserve_prior_bytes_and_remove_partial_temps() {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("original.dant");
    fs::write(&destination, b"preserved").unwrap();
    let mut calls = 0;
    assert_eq!(
        save_stream(&mut &b"new"[..], &destination, Some(3), 32, || {
            calls += 1;
            calls < 3
        })
        .unwrap_err(),
        INTERRUPTED
    );
    assert_eq!(fs::read(&destination).unwrap(), b"preserved");
    assert_eq!(
        save_stream(&mut &b""[..], &destination, None, 32, || true).unwrap_err(),
        INTERRUPTED
    );
    assert_eq!(
        save_stream(&mut &b"x"[..], &destination, Some(0), 32, || true).unwrap_err(),
        TOO_LARGE
    );
    assert!(save_stream(&mut &b"x"[..], root.path(), None, 32, || true).is_err());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}
