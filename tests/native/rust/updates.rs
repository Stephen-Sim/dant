use super::*;
use std::{
    io::Cursor,
    net::{SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};
fn asset() -> Asset {
    let data = b"verified installer";
    Asset{version:"0.5.0-beta.2".into(),channel:"beta".into(),url:"https://github.com/Stephen-Sim/dant/releases/download/v0.5.0-beta.2/dant_0.5.0-beta.2_windows_x64_setup.exe".into(),sha256:format!("{:x}",Sha256::digest(data)),size:data.len() as u64,name:"dant_0.5.0-beta.2_windows_x64_setup.exe".into()}
}
#[test]
fn official_asset_and_version_validation_rejects_redirect_injection_and_downgrades() {
    let a = asset();
    assert!(valid_asset(&a));
    for url in [
        a.url.clone() + "?token=x",
        a.url.replace("Stephen-Sim", "other"),
        a.url.replace("https:", "http:"),
        a.url.replace("github.com", "github.com.evil"),
    ] {
        let mut bad = a.clone();
        bad.url = url;
        assert!(!valid_asset(&bad));
    }
    let mut bad = a.clone();
    bad.channel = "stable".into();
    assert!(!valid_asset(&bad));
    bad = a.clone();
    bad.size = MAX_INSTALLER + 1;
    assert!(!valid_asset(&bad));
    assert!(newer("0.5.0", "0.5.0-beta.9"));
    assert!(newer("0.5.0-beta.10", "0.5.0-beta.2"));
    assert!(!newer("0.4.6", "0.4.7-beta.1"));
    for v in ["../0.5.0", "01.0.0", "0.5.0+build", "0.5.0-beta.01", "0.5"] {
        assert!(version(v).is_none());
    }
}
#[test]
fn cached_payload_is_rehashed_and_truncation_tampering_and_links_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let a = asset();
    let file = dir.path().join(&a.name);
    fs::write(&file, b"verified installer").unwrap();
    assert!(verify_file(&file, &a).is_ok());
    fs::write(&file, b"tampered installer").unwrap();
    assert!(verify_file(&file, &a).is_err());
    fs::write(&file, b"short").unwrap();
    assert!(verify_file(&file, &a).is_err());
    assert!(verify_file(dir.path(), &a).is_err());
}
#[test]
fn streamed_installer_requires_exact_size_and_digest_before_a_payload_can_be_committed() {
    let a = asset();
    for bytes in [
        &b"verified installer"[..],
        &b"short"[..],
        &b"verified installerEXTRA"[..],
        &b"untrusted contents"[..],
    ] {
        let mut input = std::io::Cursor::new(bytes);
        let mut output = Vec::new();
        let result = stream_payload(&mut input, &mut output, &a, |_| {});
        assert_eq!(result.is_ok(), bytes == b"verified installer");
        assert!(output.len() <= a.size as usize);
    }
}
fn controller_state() -> serde_json::Value {
    serde_json::json!({"mode":"vm-controller","controller":{"status":"online","cached":false,"authority":"vm","vmConfigured":true,"desktopTransition":"idle","serviceUpdateBusy":false},"call":{"id":"call"},"takeover":true,"computer":{"status":"human","sessionId":"lease"},"provisioning":{"status":"ready","running":false},"active":{"status":"running"},"queue":["keep"]})
}
#[test]
fn installation_preflight_allows_confirmable_work_but_never_bypasses_controller_or_setup_boundaries(
) {
    let state = controller_state();
    assert!(install_allowed(&state));
    for (path, value) in [
        ("/controller/cached", serde_json::json!(true)),
        ("/controller/status", serde_json::json!("unknown")),
        ("/controller/authority", serde_json::json!("cache")),
        ("/controller/vmConfigured", serde_json::Value::Null),
        (
            "/controller/desktopTransition",
            serde_json::json!("suspending"),
        ),
        ("/controller/serviceUpdateBusy", serde_json::json!(true)),
        ("/provisioning/status", serde_json::json!("creating")),
        ("/provisioning/running", serde_json::json!(true)),
        ("/mode", serde_json::json!("vm-worker")),
    ] {
        let mut changed = state.clone();
        *changed.pointer_mut(path).unwrap() = value;
        assert!(!install_allowed(&changed), "{path}");
    }
}
#[test]
fn installation_without_a_vm_reaches_the_backend_lease_instead_of_requiring_a_vm_connection() {
    let mut state = controller_state();
    state["controller"]["vmConfigured"] = serde_json::json!(false);
    state["controller"]["status"] = serde_json::json!("offline");
    state["controller"]["cached"] = serde_json::json!(true);
    state["worker"] = serde_json::json!({"status":"offline"});
    state["active"] = serde_json::Value::Null;
    state["call"] = serde_json::Value::Null;
    state["queue"] = serde_json::json!([]);
    assert!(install_allowed(&state));
}
#[test]
fn stopped_executor_and_disconnected_vm_can_request_a_fresh_backend_pause_witness() {
    for worker in ["offline", "connecting"] {
        let mut state = controller_state();
        state["worker"] = serde_json::json!({"status":worker});
        assert!(
            install_allowed(&state),
            "the backend, not stale executor metadata, must decide {worker}"
        );
    }
    for status in ["offline", "connecting"] {
        let mut state = controller_state();
        state["controller"]["status"] = serde_json::json!(status);
        state["controller"]["cached"] = serde_json::json!(true);
        assert!(install_allowed(&state));
        state["controller"]["authority"] = serde_json::json!("cache");
        assert!(!install_allowed(&state));
    }
}

#[test]
fn release_precedence_and_all_asset_identity_fields_are_checked_independently() {
    for invalid in [
        "",
        "1.2.3-",
        "1..3",
        "1.2.3-a..b",
        "1.2.3-Ã©",
        "1.2.3-01",
        "18446744073709551616.0.0",
        "1.2.3_4",
    ] {
        assert!(version(invalid).is_none(), "{invalid}");
    }
    assert!(version(&"1".repeat(81)).is_none());
    for (a, b, expected) in [
        ("1.2.3", "bad", false),
        ("1.2.3", "1.2.3", false),
        ("1.2.3-beta", "1.2.3", false),
        ("1.2.3-beta.10", "1.2.3-beta.2", true),
        ("1.2.3-beta.a", "1.2.3-beta.9", true),
        ("1.2.3-beta.9", "1.2.3-beta.a", false),
        ("1.2.3-beta.z", "1.2.3-beta.a", true),
        ("1.2.3-beta.a.1", "1.2.3-beta.a", true),
        ("1.2.3-beta.a", "1.2.3-beta.a.1", false),
    ] {
        assert_eq!(newer(a, b), expected, "{a} vs {b}");
    }
    for field in ["version", "channel", "url", "sha256", "name", "size"] {
        let mut value = serde_json::to_value(asset()).unwrap();
        value[field] = if field == "size" {
            serde_json::json!(0)
        } else {
            serde_json::json!("wrong")
        };
        assert!(
            !valid_asset(&serde_json::from_value(value).unwrap()),
            "{field}"
        );
    }
    let mut maximum = asset();
    maximum.size = MAX_INSTALLER;
    assert!(valid_asset(&maximum));
    maximum.sha256 = "A".repeat(64);
    assert!(!valid_asset(&maximum));
    maximum = asset();
    maximum.url = maximum.url.replace("/v0.5.0-beta.2/", "/0.5.0-beta.2/");
    assert!(valid_asset(&maximum));
    let ready = serde_json::to_value(ready(&asset())).unwrap();
    assert_eq!(ready["packageId"], asset().sha256);
    assert_eq!(ready["ready"], true);
    assert!(ready.get("url").is_none());
}

#[test]
fn cache_json_and_directory_boundaries_preserve_foreign_files_and_handle_serialization_failure() {
    let root = tempfile::tempdir().unwrap();
    assert!(directory(Path::new("relative"), true).is_err());
    let nested = root.path().join("a/b");
    assert!(directory(&nested, false).is_err());
    directory(&nested, true).unwrap();
    let file = nested.join("state.json");
    write_json(&file, &serde_json::json!({"text":"ä¸­æ–‡ðŸ˜€"})).unwrap();
    assert_eq!(json_file(&file, 4096).unwrap()["text"], "ä¸­æ–‡ðŸ˜€");
    let previous = fs::read(&file).unwrap();
    assert!(json_file(&file, previous.len() - 1).is_err());
    assert!(json_file(&nested, 4096).is_err());
    assert!(json_file(&nested.join("absent"), 4096).is_err());
    assert!(directory(&file, true).is_err());
    assert!(write_json(&nested, &true).is_err());
    assert!(write_json(Path::new("relative"), &true).is_err());
    struct Invalid;
    impl serde::Serialize for Invalid {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("synthetic serializer refusal"))
        }
    }
    assert!(write_json(&file, &Invalid).is_err());
    assert_eq!(fs::read(&file).unwrap(), previous);
    assert_eq!(fs::read_dir(&nested).unwrap().count(), 1);
    fs::write(&file, b"invalid JSON").unwrap();
    assert!(json_file(&file, 4096).is_err());
    let mut invalid = asset();
    invalid.size = 0;
    assert!(verify_file(&file, &invalid).is_err());
}

#[test]
fn payload_io_failures_never_report_success_or_write_past_the_expected_size() {
    struct Refused;
    impl Read for Refused {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("synthetic read refusal"))
        }
    }
    impl Write for Refused {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("synthetic write refusal"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    assert_eq!(
        stream_payload(&mut Refused, &mut Vec::new(), &asset(), |_| panic!(
            "failed read cannot report progress"
        )),
        Err(FAILED.into())
    );
    assert_eq!(
        stream_payload(
            &mut Cursor::new(b"verified installer"),
            &mut Refused,
            &asset(),
            |_| {}
        ),
        Err(FAILED.into())
    );
    struct Delayed(Cursor<Vec<u8>>);
    impl Read for Delayed {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.0.position() == 0 {
                thread::sleep(Duration::from_millis(260));
            }
            self.0.read(buffer)
        }
    }
    let mut progress = Vec::new();
    let mut bytes = Vec::new();
    stream_payload(
        &mut Delayed(Cursor::new(b"verified installer".to_vec())),
        &mut bytes,
        &asset(),
        |count| progress.push(count),
    )
    .unwrap();
    assert_eq!(progress, vec![asset().size]);
    assert_eq!(bytes, b"verified installer");
}

struct ControllerFixture {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<Vec<u8>>>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl ControllerFixture {
    fn new(reply: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        assert_ne!(address.port(), 4317);
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::clone(&stop);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&requests);
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !cancelled.load(Ordering::Acquire) && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
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
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                while bytes.len() < 65536 {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => bytes.extend_from_slice(&buffer[..count]),
                    };
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let length = String::from_utf8_lossy(&bytes[..end])
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
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                observed.lock().unwrap().push(bytes);
                let _ = stream.write_all(&reply);
                let _ = stream.shutdown(std::net::Shutdown::Write);
                let _ = stream.read(&mut buffer);
            }
        });
        Self {
            address,
            stop,
            requests,
            worker: Some(worker),
        }
    }
    fn request(
        &self,
        method: reqwest::Method,
        body: Option<&str>,
        limit: usize,
    ) -> Result<serde_json::Value, String> {
        tauri::async_runtime::block_on(controller_request_at(
            self.address,
            "desktop/fixture",
            &"a".repeat(64),
            limit,
            method,
            body,
        ))
    }
}
impl Drop for ControllerFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn http(status: &str, body: &[u8]) -> Vec<u8> {
    let mut reply = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    reply.extend_from_slice(body);
    reply
}

#[test]
fn update_controller_http_has_exact_token_json_and_byte_limits_without_redirects_or_retries() {
    let fixture = ControllerFixture::new(http("200 OK", b"{\"ok\":true}"));
    assert_eq!(
        fixture
            .request(reqwest::Method::POST, Some("{}"), 11)
            .unwrap(),
        serde_json::json!({"ok":true})
    );
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let wire = String::from_utf8_lossy(&requests[0]).to_ascii_lowercase();
    assert!(wire.starts_with("post /api/desktop/fixture http/1.1\r\n"));
    assert!(wire.contains(&format!("x-dant-token: {}\r\n", "a".repeat(64))));
    assert!(wire.ends_with("{}"));
    drop(requests);
    for raw in [
        http("500 Failed", b"{}"),
        http("302 Found", b"{}"),
        http("200 OK", b"{} "),
        http("200 OK", b"x"),
        http("200 OK", &[255]),
        b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\na".to_vec(),
    ] {
        let fixture = ControllerFixture::new(raw);
        assert_eq!(
            fixture.request(reqwest::Method::GET, None, 2),
            Err(FAILED.into())
        );
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }
    for method in [
        reqwest::Method::GET,
        reqwest::Method::POST,
        reqwest::Method::DELETE,
    ] {
        let fixture = ControllerFixture::new(Vec::new());
        assert!(fixture.request(method, Some("{}"), 1024).is_err());
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }
    let fixture = ControllerFixture::new(http("200 OK", b"{}"));
    assert_eq!(
        fixture.request(reqwest::Method::GET, None, 2).unwrap(),
        serde_json::json!({})
    );
    for token in [
        "",
        "invalid",
        &"f".repeat(63),
        &"g".repeat(64),
        &"f".repeat(65),
    ] {
        assert!(tauri::async_runtime::block_on(controller_request_at(
            fixture.address,
            "state",
            token,
            1024,
            reqwest::Method::GET,
            None
        ))
        .is_err());
    }
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
}

fn synthetic_installer_command() -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--list",
            "--format=terse",
            "--exact",
            "updates::tests::synthetic_installer_fixture_marker",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

#[test]
fn synthetic_installer_fixture_marker() {}

fn synthetic_download_asset() -> Asset {
    let mut selected = asset();
    let bytes = b"updates::tests::synthetic_installer_fixture_marker: test\n";
    selected.size = bytes.len() as u64;
    selected.sha256 = format!("{:x}", Sha256::digest(bytes));
    selected
}

#[test]
fn download_commits_only_a_verified_owned_child_payload_and_never_replays_a_cached_or_failed_action(
) {
    let root = tempfile::tempdir().unwrap();
    let selected = synthetic_download_asset();
    let mut progress = Vec::new();
    download_using(
        root.path(),
        &selected,
        || Ok(synthetic_installer_command()),
        |bytes| progress.push(bytes),
    )
    .unwrap();
    let destination = package(root.path(), &selected).unwrap();
    verify_file(&destination, &selected).unwrap();
    assert_eq!(progress.first(), Some(&0));
    assert!(progress.iter().all(|received| *received <= selected.size));
    assert!(progress.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(
        json_file(&destination.parent().unwrap().join("asset.json"), 65536).unwrap()["sha256"],
        selected.sha256
    );
    download_using(
        root.path(),
        &selected,
        || panic!("verified payload must not spawn another downloader"),
        |_| panic!("cache reuse is not a download"),
    )
    .unwrap();
    fs::write(&destination, b"preserved invalid cached bytes").unwrap();
    let original = fs::read(&destination).unwrap();
    assert!(download_using(
        root.path(),
        &selected,
        || Err("synthetic child not available".into()),
        |_| {}
    )
    .is_err());
    assert_eq!(fs::read(&destination).unwrap(), original);
    let mut wrong = selected.clone();
    wrong.sha256 = "b".repeat(64);
    assert!(download_using(
        root.path(),
        &wrong,
        || Ok(synthetic_installer_command()),
        |_| {}
    )
    .is_err());
    assert!(!package(root.path(), &wrong).unwrap().exists());
    let files = fs::read_dir(package(root.path(), &wrong).unwrap().parent().unwrap())
        .unwrap()
        .count();
    assert_eq!(files, 0);
    assert!(download_using(
        root.path(),
        &selected,
        || Ok(Command::new(root.path().join("missing-downloader.exe"))),
        |_| {}
    )
    .is_err());
    let mut no_pipe = synthetic_installer_command();
    no_pipe.stdout(Stdio::null());
    assert!(download_using(root.path(), &selected, || Ok(no_pipe), |_| {}).is_err());
    fs::remove_file(&destination).unwrap();
    fs::create_dir(&destination).unwrap();
    assert!(download_using(
        root.path(),
        &selected,
        || panic!("foreign destination must not launch a process"),
        |_| {}
    )
    .is_err());
}

#[test]
fn downloader_uses_only_the_windows_https_executable_and_fixed_safety_arguments() {
    let root = tempfile::tempdir().unwrap();
    let exe = root.path().join("System32/curl.exe");
    assert!(downloader_command(root.path(), &asset()).is_err());
    fs::create_dir(exe.parent().unwrap()).unwrap();
    fs::write(&exe, b"synthetic executable, never launched").unwrap();
    let selected = asset();
    let command = downloader_command(root.path(), &selected).unwrap();
    assert_eq!(command.get_program(), exe);
    let args: Vec<_> = command
        .get_args()
        .map(|arg| arg.to_str().unwrap())
        .collect();
    assert_eq!(&args[..5], &["-q", "--noproxy", "*", "--proto", "=https"]);
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--proto-redir", "=https"]));
    assert!(args.windows(2).any(|pair| pair == ["--max-redirs", "3"]));
    assert!(args.windows(2).any(|pair| pair == ["--max-time", "900"]));
    assert_eq!(args.last(), Some(&selected.url.as_str()));
    fs::remove_file(&exe).unwrap();
    fs::create_dir(&exe).unwrap();
    assert!(downloader_command(root.path(), &selected).is_err());
}

const INSTALL_LEASE: &str = "11111111-1111-4111-8111-111111111111";
const FIXTURE_NOW: u64 = 100_000;

struct InstallFixture {
    root: PathBuf,
    replies: Mutex<std::collections::VecDeque<Result<serde_json::Value, String>>>,
    requests: Mutex<Vec<(String, reqwest::Method, Option<serde_json::Value>)>>,
    prepared: std::sync::atomic::AtomicUsize,
    exits: std::sync::atomic::AtomicUsize,
    owns: bool,
    prepare_failed: bool,
    blocked_authorization: bool,
}

impl InstallFixture {
    fn new(root: &Path, replies: Vec<Result<serde_json::Value, String>>) -> Self {
        Self {
            root: root.to_owned(),
            replies: Mutex::new(replies.into()),
            requests: Mutex::new(Vec::new()),
            prepared: std::sync::atomic::AtomicUsize::new(0),
            exits: std::sync::atomic::AtomicUsize::new(0),
            owns: true,
            prepare_failed: false,
            blocked_authorization: false,
        }
    }

    fn run(&self, state: &Updates) -> Result<InstallResult, String> {
        let installer = self.root.join("synthetic-installer.exe");
        fs::write(&installer, b"verified installer").unwrap();
        verify_file(&installer, &asset()).unwrap();
        tauri::async_runtime::block_on(install_verified(
            self,
            state,
            asset(),
            self.root.clone(),
            installer,
            777,
        ))
    }

    fn routes(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|value| value.0.clone())
            .collect()
    }

    fn assert_no_exit_or_authorization(&self) {
        assert_eq!(self.exits.load(Ordering::Acquire), 0);
        let go = self.root.join("helper/go.json");
        assert!(!go.is_file());
    }
}

impl InstallEffects for InstallFixture {
    async fn request(
        &self,
        route: &str,
        method: reqwest::Method,
        body: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        let body = body.map(|value| serde_json::from_str(value).unwrap());
        self.requests
            .lock()
            .unwrap()
            .push((route.to_owned(), method, body));
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected Controller action; automatic replay is forbidden")
    }

    async fn prepare(
        &self,
        root: &Path,
        installer: &Path,
        selected: &Asset,
        controller_id: u32,
    ) -> Result<PathBuf, String> {
        self.prepared.fetch_add(1, Ordering::AcqRel);
        assert_eq!(root, self.root);
        assert_eq!(installer, root.join("synthetic-installer.exe"));
        assert_eq!(selected, &asset());
        assert_eq!(controller_id, 777);
        if self.prepare_failed {
            return Err("synthetic helper preparation refused".into());
        }
        let folder = root.join("helper");
        fs::create_dir(&folder).unwrap();
        if self.blocked_authorization {
            fs::create_dir(folder.join("go.json")).unwrap();
        }
        Ok(folder)
    }

    fn owns_controller(&self) -> bool {
        self.owns
    }
    fn now_ms(&self) -> u64 {
        FIXTURE_NOW
    }
    fn schedule_exit(&self) {
        self.exits.fetch_add(1, Ordering::AcqRel);
    }
}

fn install_replies(expires: serde_json::Value) -> Vec<Result<serde_json::Value, String>> {
    vec![
        Ok(serde_json::json!({"leaseId":INSTALL_LEASE})),
        Ok(
            serde_json::json!({"ok":true,"workPaused":true,"vmSuspended":true,"leaseId":INSTALL_LEASE,"expiresAt":expires}),
        ),
    ]
}

fn with_cleanup(
    mut replies: Vec<Result<serde_json::Value, String>>,
) -> Vec<Result<serde_json::Value, String>> {
    replies.extend([
        Ok(serde_json::json!({"ok":true})),
        Ok(serde_json::json!({"ok":true})),
    ]);
    replies
}

#[test]
fn install_handoff_requires_one_exact_lease_suspension_and_fresh_owned_authorization() {
    let root = tempfile::tempdir().unwrap();
    let state = Updates::default();
    let fixture = InstallFixture::new(
        root.path(),
        install_replies(serde_json::json!(FIXTURE_NOW + 20000)),
    );
    assert!(fixture.run(&state).unwrap().launched);
    assert_eq!(fixture.routes(), ["updates/install-lease", "desktop/exit"]);
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests[0].1, reqwest::Method::POST);
    assert_eq!(requests[0].2, Some(serde_json::json!({})));
    assert_eq!(
        requests[1].2,
        Some(serde_json::json!({"reason":"install","leaseId":INSTALL_LEASE}))
    );
    drop(requests);
    assert_eq!(fixture.prepared.load(Ordering::Acquire), 1);
    assert_eq!(fixture.exits.load(Ordering::Acquire), 1);
    assert!(
        *state.installing.lock().unwrap(),
        "handoff remains reserved until process exit"
    );
    let go = json_file(&root.path().join("helper/go.json"), 4096).unwrap();
    assert_eq!(
        go,
        serde_json::json!({"authorized":true,"sha256":asset().sha256,"leaseId":INSTALL_LEASE,"expiresAt":FIXTURE_NOW+20000})
    );
    assert!(!root.path().join("helper/cancel.json").exists());
    assert_eq!(
        fixture.run(&state).err().as_deref(),
        Some("An update installation is already pending.")
    );
    assert_eq!(fixture.routes().len(), 2);
}

#[test]
fn missing_unknown_or_invalid_install_leases_never_prepare_exit_or_replay() {
    for reply in [
        Err("synthetic unconfirmed request".into()),
        Ok(serde_json::json!({})),
        Ok(serde_json::json!({"leaseId":null})),
        Ok(serde_json::json!({"leaseId":4})),
        Ok(serde_json::json!({"leaseId":"wrong"})),
        Ok(serde_json::json!({"leaseId":"x".repeat(36)})),
    ] {
        let root = tempfile::tempdir().unwrap();
        let state = Updates::default();
        let fixture = InstallFixture::new(root.path(), vec![reply]);
        assert_eq!(fixture.run(&state).err().as_deref(), Some(BLOCKED));
        fixture.assert_no_exit_or_authorization();
        assert_eq!(fixture.prepared.load(Ordering::Acquire), 0);
        assert_eq!(fixture.routes(), ["updates/install-lease"]);
        assert!(!*state.installing.lock().unwrap());
    }
}

#[test]
fn failed_or_foreign_suspension_cancels_only_its_known_lease_without_preparing_a_helper() {
    for response in [
        Err("synthetic unconfirmed suspension".into()),
        Ok(serde_json::json!({"ok":true,"leaseId":INSTALL_LEASE})),
        Ok(serde_json::json!({"ok":true,"workPaused":true,"vmSuspended":true,"leaseId":"other"})),
    ] {
        let root = tempfile::tempdir().unwrap();
        let state = Updates::default();
        let fixture = InstallFixture::new(
            root.path(),
            with_cleanup(vec![
                Ok(serde_json::json!({"leaseId":INSTALL_LEASE})),
                response,
            ]),
        );
        assert_eq!(fixture.run(&state).err().as_deref(), Some(BLOCKED));
        fixture.assert_no_exit_or_authorization();
        assert_eq!(fixture.prepared.load(Ordering::Acquire), 0);
        assert!(!*state.installing.lock().unwrap());
        assert_eq!(
            fixture.routes(),
            vec![
                "updates/install-lease".to_string(),
                "desktop/exit".into(),
                "desktop/cancel-exit".into(),
                format!("updates/install-lease/{INSTALL_LEASE}")
            ]
        );
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests[3].1, reqwest::Method::DELETE);
        assert!(requests[3].2.is_none());
        assert_eq!(requests[2].2, requests[1].2);
    }
}

#[test]
fn helper_preparation_failure_cleans_up_the_reserved_lease_and_keeps_the_application_open() {
    let root = tempfile::tempdir().unwrap();
    let state = Updates::default();
    let mut fixture = InstallFixture::new(
        root.path(),
        with_cleanup(install_replies(serde_json::json!(FIXTURE_NOW + 20000))),
    );
    fixture.prepare_failed = true;
    assert_eq!(
        fixture.run(&state).err().as_deref(),
        Some("synthetic helper preparation refused")
    );
    fixture.assert_no_exit_or_authorization();
    assert_eq!(fixture.prepared.load(Ordering::Acquire), 1);
    assert_eq!(fixture.routes().len(), 4);
    assert!(!*state.installing.lock().unwrap());
}

#[test]
fn expired_oversized_missing_or_non_integer_deadlines_can_only_write_a_cancellation_receipt() {
    for expires in [
        serde_json::json!(FIXTURE_NOW + 5000),
        serde_json::json!(FIXTURE_NOW + 35001),
        serde_json::Value::Null,
        serde_json::json!("120000"),
        serde_json::json!(120000.5),
    ] {
        let root = tempfile::tempdir().unwrap();
        let state = Updates::default();
        let fixture = InstallFixture::new(root.path(), with_cleanup(install_replies(expires)));
        assert_eq!(fixture.run(&state).err().as_deref(), Some(BLOCKED));
        fixture.assert_no_exit_or_authorization();
        assert_eq!(
            json_file(&root.path().join("helper/cancel.json"), 32).unwrap(),
            true
        );
        assert_eq!(fixture.routes().len(), 4);
        assert!(!*state.installing.lock().unwrap());
    }
}

#[test]
fn changed_process_ownership_or_failed_authorization_write_never_authorizes_installation_or_retries_cleanup(
) {
    for block_file in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let state = Updates::default();
        let mut replies = install_replies(serde_json::json!(FIXTURE_NOW + 20000));
        replies.extend([
            Err("synthetic cleanup unknown".into()),
            Err("synthetic release unknown".into()),
        ]);
        let mut fixture = InstallFixture::new(root.path(), replies);
        fixture.blocked_authorization = block_file;
        fixture.owns = block_file;
        assert_eq!(fixture.run(&state).err().as_deref(), Some(BLOCKED));
        fixture.assert_no_exit_or_authorization();
        assert_eq!(
            json_file(&root.path().join("helper/cancel.json"), 32).unwrap(),
            true
        );
        assert_eq!(fixture.routes().len(), 4);
        assert!(!*state.installing.lock().unwrap());
    }
}

struct DownloadFixture {
    root: PathBuf,
    metadata: Result<serde_json::Value, String>,
    cache_failed: bool,
    download_failed: bool,
    metadata_calls: std::sync::atomic::AtomicUsize,
    download_calls: std::sync::atomic::AtomicUsize,
    progress: Mutex<Vec<(String, u64, String)>>,
}

impl DownloadFixture {
    fn new(root: &Path) -> Self {
        Self {
            root: root.to_owned(),
            metadata: Ok(
                serde_json::json!({"asset":asset(),"channel":"beta","updateAvailable":true}),
            ),
            cache_failed: false,
            download_failed: false,
            metadata_calls: std::sync::atomic::AtomicUsize::new(0),
            download_calls: std::sync::atomic::AtomicUsize::new(0),
            progress: Mutex::new(Vec::new()),
        }
    }
    fn run(
        &self,
        state: &Updates,
        window: &str,
        channel: &str,
        expected: &str,
    ) -> Result<Ready, String> {
        tauri::async_runtime::block_on(download_selected(
            self,
            state,
            window,
            channel.to_owned(),
            expected.to_owned(),
        ))
    }
}

impl DownloadEffects for DownloadFixture {
    async fn metadata(&self, channel: &str) -> Result<serde_json::Value, String> {
        self.metadata_calls.fetch_add(1, Ordering::AcqRel);
        assert!(matches!(channel, "stable" | "beta"));
        self.metadata.clone()
    }
    fn cache(&self) -> Result<PathBuf, String> {
        if self.cache_failed {
            Err(FAILED.into())
        } else {
            Ok(self.root.clone())
        }
    }
    async fn download(&self, root: &Path, selected: &Asset) -> Result<(), String> {
        self.download_calls.fetch_add(1, Ordering::AcqRel);
        assert_eq!(root, self.root);
        assert!(valid_asset(selected));
        if self.download_failed {
            Err(FAILED.into())
        } else {
            Ok(())
        }
    }
    fn progress(&self, selected: &Asset, received: u64, status: &str) {
        self.progress
            .lock()
            .unwrap()
            .push((selected.sha256.clone(), received, status.to_owned()));
    }
}

#[test]
fn download_admission_rejects_non_main_windows_invalid_channels_and_versions_before_any_effect() {
    let root = tempfile::tempdir().unwrap();
    let fixture = DownloadFixture::new(root.path());
    let state = Updates::default();
    for (window, channel, version) in [
        ("overlay", "beta", "0.5.0"),
        ("main", "preview", "0.5.0"),
        ("main", "beta", "bad"),
    ] {
        assert_eq!(
            fixture
                .run(&state, window, channel, version)
                .err()
                .as_deref(),
            Some(FAILED)
        );
    }
    assert_eq!(fixture.metadata_calls.load(Ordering::Acquire), 0);
    assert_eq!(fixture.download_calls.load(Ordering::Acquire), 0);
    assert!(state.busy.lock().unwrap().is_empty());
    assert!(state.packages.lock().unwrap().is_empty());
}

#[test]
fn downloaded_descriptor_must_match_channel_expected_version_and_available_newer_release() {
    let root = tempfile::tempdir().unwrap();
    let mut invalid = Vec::new();
    for (path, value) in [
        ("/asset/version", serde_json::json!("0.5.0-beta.3")),
        ("/asset/channel", serde_json::json!("stable")),
        ("/asset/sha256", serde_json::json!("invalid")),
        ("/channel", serde_json::json!("stable")),
        ("/updateAvailable", serde_json::json!(false)),
        ("/asset", serde_json::Value::Null),
    ] {
        let mut fixture = DownloadFixture::new(root.path());
        let mut value_object = fixture.metadata.clone().unwrap();
        *value_object.pointer_mut(path).unwrap() = value;
        fixture.metadata = Ok(value_object);
        invalid.push(fixture);
    }
    let mut missing = DownloadFixture::new(root.path());
    missing.metadata = Ok(serde_json::json!({"channel":"beta"}));
    invalid.push(missing);
    let mut failed = DownloadFixture::new(root.path());
    failed.metadata = Err("synthetic Controller unavailable".into());
    invalid.push(failed);
    let mut downgrade = DownloadFixture::new(root.path());
    let mut old = asset();
    old.version = "0.1.0-beta.1".into();
    old.name = format!("dant_{}_windows_x64_setup.exe", old.version);
    old.url = format!(
        "https://github.com/Stephen-Sim/dant/releases/download/v{}/{}",
        old.version, old.name
    );
    downgrade.metadata =
        Ok(serde_json::json!({"asset":old,"channel":"beta","updateAvailable":true}));
    assert!(downgrade
        .run(&Updates::default(), "main", "beta", "0.1.0-beta.1")
        .is_err());
    for fixture in invalid {
        let state = Updates::default();
        assert!(fixture
            .run(&state, "main", "beta", &asset().version)
            .is_err());
        assert_eq!(fixture.download_calls.load(Ordering::Acquire), 0);
        assert!(fixture.progress.lock().unwrap().is_empty());
        assert!(state.busy.lock().unwrap().is_empty());
        assert!(state.packages.lock().unwrap().is_empty());
    }
}

#[test]
fn successful_download_registers_only_the_captured_verified_identity_and_emits_exact_ready_progress(
) {
    let root = tempfile::tempdir().unwrap();
    let fixture = DownloadFixture::new(root.path());
    let state = Updates::default();
    let selected = asset();
    let result = fixture
        .run(&state, "main", "beta", &selected.version)
        .unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        serde_json::to_value(ready(&selected)).unwrap()
    );
    assert_eq!(fixture.download_calls.load(Ordering::Acquire), 1);
    assert!(state.busy.lock().unwrap().is_empty());
    assert_eq!(
        state.packages.lock().unwrap().get(&selected.sha256),
        Some(&selected)
    );
    assert_eq!(
        *fixture.progress.lock().unwrap(),
        vec![(selected.sha256, selected.size, "ready".into())]
    );
}

#[test]
fn busy_download_or_cache_failure_never_spawns_and_failed_download_releases_only_its_reservation() {
    let root = tempfile::tempdir().unwrap();
    let fixture = DownloadFixture::new(root.path());
    let state = Updates::default();
    state.busy.lock().unwrap().insert("beta".into());
    assert_eq!(
        fixture
            .run(&state, "main", "beta", &asset().version)
            .err()
            .as_deref(),
        Some("This update is already downloading.")
    );
    assert_eq!(fixture.download_calls.load(Ordering::Acquire), 0);
    assert!(state.busy.lock().unwrap().contains("beta"));
    let mut fixture = DownloadFixture::new(root.path());
    fixture.cache_failed = true;
    let state = Updates::default();
    assert!(fixture
        .run(&state, "main", "beta", &asset().version)
        .is_err());
    assert_eq!(fixture.download_calls.load(Ordering::Acquire), 0);
    fixture.cache_failed = false;
    fixture.download_failed = true;
    state.busy.lock().unwrap().insert("stable".into());
    assert!(fixture
        .run(&state, "main", "beta", &asset().version)
        .is_err());
    assert_eq!(fixture.download_calls.load(Ordering::Acquire), 1);
    assert_eq!(
        *state.busy.lock().unwrap(),
        HashSet::from(["stable".into()])
    );
    assert!(state.packages.lock().unwrap().is_empty());
    assert_eq!(
        *fixture.progress.lock().unwrap(),
        vec![(asset().sha256, 0, "failed".into())]
    );
}

#[test]
fn valid_but_different_descriptors_cannot_cross_expected_version_or_channel_boundaries() {
    let root = tempfile::tempdir().unwrap();
    let fixture = DownloadFixture::new(root.path());
    for (channel, expected) in [("beta", "0.5.0-beta.3"), ("stable", "0.5.0-beta.2")] {
        assert!(fixture
            .run(&Updates::default(), "main", channel, expected)
            .is_err());
    }
    assert_eq!(fixture.download_calls.load(Ordering::Acquire), 0);
    let mut fixture = DownloadFixture::new(root.path());
    let mut stable = asset();
    stable.channel = "stable".into();
    stable.version = "0.5.0".into();
    stable.name = format!("dant_{}_windows_x64_setup.exe", stable.version);
    stable.url = format!(
        "https://github.com/Stephen-Sim/dant/releases/download/v{}/{}",
        stable.version, stable.name
    );
    fixture.metadata =
        Ok(serde_json::json!({"asset":stable,"channel":"stable","updateAvailable":true}));
    assert_eq!(
        fixture
            .run(&Updates::default(), "main", "stable", "0.5.0")
            .unwrap()
            .channel,
        "stable"
    );
}

#[test]
fn install_deadline_accepts_only_the_documented_open_lower_and_closed_upper_bounds() {
    for remaining in [5001, 35000] {
        let root = tempfile::tempdir().unwrap();
        let fixture = InstallFixture::new(
            root.path(),
            install_replies(serde_json::json!(FIXTURE_NOW + remaining)),
        );
        assert!(fixture.run(&Updates::default()).unwrap().launched);
        assert_eq!(fixture.exits.load(Ordering::Acquire), 1);
        assert_eq!(fixture.routes(), ["updates/install-lease", "desktop/exit"]);
    }
}

#[test]
fn missing_parent_and_uncreatable_directory_failures_have_no_filesystem_side_effects() {
    assert!(json_file(Path::new(""), 4096).is_err());
    assert!(write_json(Path::new(""), &true).is_err());
    assert!(verify_file(Path::new(""), &asset()).is_err());
    let root = tempfile::tempdir().unwrap();
    let ordinary = root.path().join("ordinary");
    fs::write(&ordinary, b"preserved").unwrap();
    assert!(directory(&ordinary.join("blocked"), true).is_err());
    assert_eq!(fs::read(&ordinary).unwrap(), b"preserved");
    for value in [
        "0.18446744073709551616.0",
        "0.0.18446744073709551616",
        "0.5.0-beta_1",
    ] {
        assert!(version(value).is_none());
    }
}

#[cfg(windows)]
#[test]
fn locked_cache_payloads_fail_closed_without_overwriting_the_original_or_leaking_temporary_files() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("locked.json");
    fs::write(&file, b"verified installer").unwrap();
    let guard = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&file)
        .unwrap();
    assert!(json_file(&file, 4096).is_err());
    assert!(verify_file(&file, &asset()).is_err());
    assert!(write_json(&file, &serde_json::json!({"replace":true})).is_err());
    drop(guard);
    assert_eq!(fs::read(&file).unwrap(), b"verified installer");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}
