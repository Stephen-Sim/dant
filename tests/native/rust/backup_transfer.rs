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

const ACTIVE: fn() -> bool = || true;
const INACTIVE: fn() -> bool = || false;

enum StreamInput {
    Bytes(io::Cursor<Vec<u8>>),
    Repeated(io::Take<io::Repeat>),
    Interrupted,
}

impl Read for StreamInput {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Bytes(bytes) => bytes.read(buffer),
            Self::Repeated(bytes) => bytes.read(buffer),
            Self::Interrupted => Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "isolated private failure",
            )),
        }
    }
}

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
    assert!(save_stream(&mut &b"complete"[..], &file, Some(8), 64, ACTIVE).is_ok());
    assert_eq!(fs::read(&file).unwrap(), b"complete");
    for (value, declared, limit) in [(&b"too long"[..], None, 2), (&b"short"[..], Some(10), 64)] {
        assert!(save_stream(&mut &value[..], &file, declared, limit, ACTIVE).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"complete");
    }
    assert!(save_stream(&mut &b"discard"[..], &file, None, 64, INACTIVE).is_err());
    assert!(save_stream(
        &mut StreamInput::Repeated(io::repeat(0).take(100)),
        &file,
        None,
        20,
        ACTIVE
    )
    .is_err());
    assert_eq!(
        save_stream(
            &mut &b"x"[..],
            &file,
            Some(MAX_PORTABLE_BYTES + 1),
            MAX_PORTABLE_BYTES,
            ACTIVE
        )
        .unwrap_err(),
        TOO_LARGE
    );
    save_stream(
        &mut StreamInput::Bytes(io::Cursor::new(b"complete".to_vec())),
        &file,
        Some(8),
        64,
        ACTIVE,
    )
    .unwrap();
    assert_eq!(
        save_stream(&mut StreamInput::Interrupted, &file, None, 64, ACTIVE).unwrap_err(),
        INTERRUPTED
    );
    assert!(save_stream(&mut &b"x"[..], Path::new("relative.dant"), None, 20, ACTIVE).is_err());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn backup_output_failures_preserve_the_previous_destination_and_remove_uncommitted_temporary_files()
{
    struct Output {
        temporary: tempfile::NamedTempFile,
        failure: &'static str,
    }
    fn refused() -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::PermissionDenied, "owned output failure")
    }
    impl Write for Output {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.failure == "write" {
                Err(refused())
            } else {
                self.temporary.write(bytes)
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            if self.failure == "flush" {
                Err(refused())
            } else {
                self.temporary.flush()
            }
        }
    }
    impl StagedOutput for Output {
        fn sync_all(&self) -> std::io::Result<()> {
            if self.failure == "sync" {
                Err(refused())
            } else {
                self.temporary.as_file().sync_all()
            }
        }
        fn commit(self, destination: &Path) -> std::io::Result<()> {
            if self.failure == "commit" {
                Err(refused())
            } else {
                self.temporary
                    .persist(destination)
                    .map(|_| ())
                    .map_err(|failure| failure.error)
            }
        }
    }
    for failure in ["none", "create", "write", "flush", "sync", "commit"] {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("selected.dant");
        fs::write(&destination, b"previous complete archive").unwrap();
        let result = save_stream_using(
            &mut b"new".as_slice(),
            &destination,
            Some(3),
            32,
            ACTIVE,
            |parent| {
                assert_eq!(parent, root.path());
                if failure == "create" {
                    Err(refused())
                } else {
                    Ok(Output {
                        temporary: tempfile::NamedTempFile::new_in(parent)?,
                        failure,
                    })
                }
            },
        );
        if failure == "none" {
            result.unwrap();
            assert_eq!(fs::read(&destination).unwrap(), b"new");
        } else {
            assert_eq!(result.unwrap_err(), FAILED);
            assert_eq!(
                fs::read(&destination).unwrap(),
                b"previous complete archive"
            );
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}

const BACKUP_ID: &str = "00000000-0000-4000-8000-000000000009";

#[test]
fn final_backup_validation_keeps_the_original_error_and_io_failures_keep_the_transfer_code() {
    let root = tempfile::tempdir().unwrap();
    let blocked = root.path().join("ordinary-file");
    fs::write(&blocked, b"preserved").unwrap();
    let expected = crate::updates::directory(&blocked, false).unwrap_err();
    let output = tempfile::NamedTempFile::new_in(root.path()).unwrap();
    let result = crate::atomic_file::finish(
        output,
        &root.path().join("selected.dant"),
        crate::atomic_file::FlushPolicy::BeforeSync,
        || crate::updates::directory(&blocked, false),
    );
    assert_eq!(result.map_err(backup_commit_error), Err(expected));
    for failure in [
        crate::atomic_file::CommitFailure::Flush,
        crate::atomic_file::CommitFailure::Sync,
        crate::atomic_file::CommitFailure::Publish,
    ] {
        assert_eq!(backup_commit_error(failure), FAILED);
    }
    assert_eq!(fs::read(&blocked).unwrap(), b"preserved");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}
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
        ACTIVE
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
        ACTIVE
    )
    .unwrap());
    assert_eq!(fs::read(&destination).unwrap(), b"DANT");
    for raw in [
        response("200 OK", Some("text/plain"), b"private"),
        response("200 OK", None, b"private"),
        b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 99\r\nConnection: close\r\n\r\nshort".to_vec(),
        b"HTTP/1.1 302 Found\r\nLocation: /unexpected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        Vec::new(),
    ] {
        let server = Server::new(raw);
        assert!(export_to(
            server.endpoint,
            BACKUP_ID,
            &"a".repeat(64),
            PASSPHRASE,
            &destination,
            ACTIVE,
        )
        .is_err());
        assert_eq!(server.calls.lock().unwrap().len(), 1);
        assert_eq!(fs::read(&destination).unwrap(), b"DANT");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
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
                ACTIVE
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
                ACTIVE
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
        ACTIVE,
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
                ACTIVE
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
                ACTIVE
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
            ACTIVE
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
            ACTIVE
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
            INACTIVE
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
        ACTIVE
    )
    .is_err());
    assert!(export_to(
        server.endpoint,
        BACKUP_ID,
        "bad",
        PASSPHRASE,
        &destination,
        ACTIVE
    )
    .is_err());
    assert!(import_from(server.endpoint, &source, "bad", PASSPHRASE, ACTIVE).is_err());
    assert!(import_from(server.endpoint, &source, &"a".repeat(64), "short", ACTIVE).is_err());
    assert!(import_from(
        server.endpoint,
        &source,
        &"a".repeat(64),
        PASSPHRASE,
        INACTIVE
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
    for limit in [3, usize::MAX] {
        let mut calls = 0;
        let result = save_stream(&mut &b"new"[..], &destination, Some(3), 32, || {
            calls += 1;
            calls < limit
        });
        if limit == 3 {
            assert_eq!(result.unwrap_err(), INTERRUPTED);
            assert_eq!(fs::read(&destination).unwrap(), b"preserved");
        } else {
            result.unwrap();
            assert_eq!(fs::read(&destination).unwrap(), b"new");
        }
    }
    fs::write(&destination, b"preserved").unwrap();
    assert_eq!(
        save_stream(&mut &b""[..], &destination, None, 32, ACTIVE).unwrap_err(),
        INTERRUPTED
    );
    assert_eq!(
        save_stream(&mut &b"x"[..], &destination, Some(0), 32, ACTIVE).unwrap_err(),
        TOO_LARGE
    );
    assert!(save_stream(&mut &b"x"[..], root.path(), None, 32, ACTIVE).is_err());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn backup_dialog_cancellation_invalid_paths_and_transfers_keep_the_selected_file_boundary() {
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_dialog::init())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let main =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let root = tempfile::tempdir().unwrap();
    for choice in ["save", "cancel", "invalid", "panic"] {
        let server = Server::new(response(
            "200 OK",
            Some("application/octet-stream"),
            b"DANT\0\xff",
        ));
        let target = root.path().join(format!("{choice}.dant"));
        let selected = target.clone();
        let result = tauri::async_runtime::block_on(export_selected(
            app.handle().clone(),
            main.clone(),
            BACKUP_ID.into(),
            "a".repeat(64),
            PASSPHRASE.into(),
            server.endpoint,
            std::sync::Arc::new(move |_| match choice {
                "cancel" => None,
                "invalid" => Some(tauri_plugin_dialog::FilePath::Url(
                    "https://invalid.example/no-file".parse().unwrap(),
                )),
                "panic" => std::panic::resume_unwind(Box::new(())),
                _ => Some(tauri_plugin_dialog::FilePath::Path(selected.clone())),
            }),
        ));
        match choice {
            "save" => {
                assert!(result.unwrap());
                assert_eq!(fs::read(&target).unwrap(), b"DANT\0\xff");
                assert_eq!(server.calls.lock().unwrap().len(), 1);
            }
            "cancel" => assert!(!result.unwrap()),
            _ => assert_eq!(result.unwrap_err(), FAILED),
        }
        if choice != "save" {
            assert!(!target.exists());
            assert!(server.calls.lock().unwrap().is_empty());
        }
    }
    let source = root.path().join("save.dant");
    for choice in ["import", "cancel", "invalid", "missing", "panic"] {
        let server = Server::new(response(
            "200 OK",
            Some("application/json"),
            metadata().to_string().as_bytes(),
        ));
        let selected = source.clone();
        let result = tauri::async_runtime::block_on(import_selected(
            app.handle().clone(),
            main.clone(),
            "a".repeat(64),
            PASSPHRASE.into(),
            server.endpoint,
            std::sync::Arc::new(move |_| match choice {
                "cancel" => None,
                "invalid" => Some(tauri_plugin_dialog::FilePath::Url(
                    "https://invalid.example/no-file".parse().unwrap(),
                )),
                "missing" => Some(tauri_plugin_dialog::FilePath::Path(
                    selected.join("missing"),
                )),
                "panic" => std::panic::resume_unwind(Box::new(())),
                _ => Some(tauri_plugin_dialog::FilePath::Path(selected.clone())),
            }),
        ));
        match choice {
            "import" => {
                assert_eq!(result.unwrap().unwrap().id, BACKUP_ID);
                assert_eq!(server.calls.lock().unwrap().len(), 1);
            }
            "cancel" => assert!(result.unwrap().is_none()),
            _ => assert!(result.is_err()),
        }
        if choice != "import" {
            assert!(server.calls.lock().unwrap().is_empty());
        }
    }
    assert_eq!(fs::read(&source).unwrap(), b"DANT\0\xff");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn backup_source_rejects_oversize_sparse_files_and_changed_snapshots_before_upload() {
    let root = tempfile::tempdir().unwrap();
    let huge = root.path().join("oversized.dant");
    let file = fs::File::create(&huge).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        const FSCTL_SET_SPARSE: u32 = 590020;
        #[link(name = "kernel32")]
        extern "system" {
            fn DeviceIoControl(
                handle: *mut std::ffi::c_void,
                code: u32,
                input: *mut std::ffi::c_void,
                input_size: u32,
                output: *mut std::ffi::c_void,
                output_size: u32,
                returned: *mut u32,
                overlapped: *mut std::ffi::c_void,
            ) -> i32;
        }
        let mut returned = 0;
        assert_ne!(
            unsafe {
                DeviceIoControl(
                    file.as_raw_handle(),
                    FSCTL_SET_SPARSE,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            },
            0,
            "An isolated sparse file is required; never allocate a large real payload"
        );
    }
    file.set_len(MAX_PORTABLE_BYTES + 1).unwrap();
    drop(file);
    assert_eq!(selected_file(&huge).unwrap_err(), TOO_LARGE);
    fs::remove_file(&huge).unwrap();
    for change in ["length", "time", "open"] {
        let path = root.path().join(format!("{change}.dant"));
        fs::write(&path, b"owned").unwrap();
        let result = selected_file_using(&path, |path| {
            if change == "open" {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "synthetic private detail",
                ));
            }
            let file = fs::File::options().write(true).open(path)?;
            if change == "length" {
                file.set_len(8)?;
            } else {
                file.set_times(
                    fs::FileTimes::new()
                        .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(10)),
                )?;
            }
            fs::File::open(path)
        });
        assert_eq!(result.unwrap_err(), FAILED);
    }
}

#[test]
fn public_backup_ipc_round_trips_selected_binary_files_and_cancellation_through_private_platform() {
    for export in [false, true] {
        for cancel in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let selected = root.path().join("selected.dant");
            if !export {
                fs::write(&selected, b"DANT\0\xff").unwrap();
            }
            let reply = if export {
                b"DANT\0\xff".to_vec()
            } else {
                metadata().to_string().into_bytes()
            };
            let server = Server::new(response(
                "200 OK",
                Some(if export {
                    "application/octet-stream"
                } else {
                    "application/json"
                }),
                &reply,
            ));
            let choices = Arc::new(Mutex::new(Vec::new()));
            let saved = selected.clone();
            let opened = selected.clone();
            let save_choices = Arc::clone(&choices);
            let open_choices = Arc::clone(&choices);
            let platform = BackupControl::<tauri::test::MockRuntime> {
                endpoint: server.endpoint,
                save: Arc::new(move |_| {
                    save_choices.lock().unwrap().push("save");
                    (!cancel).then(|| tauri_plugin_dialog::FilePath::Path(saved.clone()))
                }),
                open: Arc::new(move |_| {
                    open_choices.lock().unwrap().push("open");
                    (!cancel).then(|| tauri_plugin_dialog::FilePath::Path(opened.clone()))
                }),
            };
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().identifier = "test.dant.backupfixture".into();
            context.config_mut().app.app_directories_override = Some(
                tauri::utils::config::AppDirectoriesOverride::Root(root.path().to_path_buf()),
            );
            let app = crate::application_commands(
                tauri::test::mock_builder()
                    .plugin(tauri_plugin_dialog::init())
                    .manage(platform),
            )
            .build(context)
            .unwrap();
            let main = tauri::WebviewWindowBuilder::new(
                &app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .build()
            .unwrap();
            let reply = tauri::test::get_ipc_response(&main, tauri::webview::InvokeRequest {
                cmd: if export { "export_dant_backup" } else { "import_dant_backup" }.into(),
                callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1), url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({"backupId":BACKUP_ID,"token":"a".repeat(64),"passphrase":PASSPHRASE})),
                headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into(),
            }).unwrap().deserialize::<serde_json::Value>().unwrap();
            assert_eq!(
                *choices.lock().unwrap(),
                [if export { "save" } else { "open" }]
            );
            if export {
                assert_eq!(reply, !cancel);
            } else if cancel {
                assert!(reply.is_null());
            } else {
                assert_eq!(reply["id"], BACKUP_ID);
            }
            assert_eq!(server.calls.lock().unwrap().len(), usize::from(!cancel));
            if !cancel {
                assert_eq!(fs::read(&selected).unwrap(), b"DANT\0\xff");
            }
        }
    }
    assert_eq!(
        BackupControl::<tauri::test::MockRuntime>::default().endpoint,
        crate::protocol::controller_endpoint()
    );
}
