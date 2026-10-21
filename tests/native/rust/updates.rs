use super::*;

const NO_PROGRESS: fn(u64) = |_| {};

#[cfg(windows)]
#[test]
fn native_downloader_configuration_is_checked_in_a_private_process_before_any_transfer() {
    use std::os::windows::process::CommandExt;
    let root = tempfile::Builder::new()
        .prefix("dant-downloader-environment-")
        .tempdir()
        .unwrap();
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "updates::tests::isolated_downloader_environment_child",
            "--nocapture",
        ])
        .env("DANT_DOWNLOADER_ENVIRONMENT_FIXTURE", root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(crate::runtime::CREATE_NO_WINDOW);
    let mut child = OwnedChild(command.spawn().unwrap());
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success(), "The private downloader fixture failed");
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        fs::read(root.path().join("verified")).unwrap(),
        b"no transfer"
    );
}

#[cfg(windows)]
#[test]
fn isolated_downloader_environment_child() {
    let Some(root) = std::env::var_os("DANT_DOWNLOADER_ENVIRONMENT_FIXTURE").map(PathBuf::from)
    else {
        return;
    };
    assert!(root.is_absolute());
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("dant-downloader-environment-"));
    assert!(root
        .canonicalize()
        .unwrap()
        .starts_with(std::env::temp_dir().canonicalize().unwrap()));
    let system_root = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
    assert!(system_root.is_absolute());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut selected = asset();
    selected.url = format!(
        "https://{}/must-not-contact",
        listener.local_addr().unwrap()
    );
    let app = tauri::test::mock_app();
    let effects = NativeDownloadEffects {
        app: app.handle(),
        token: "invalid",
    };
    for configured in [true, false] {
        if configured {
            std::env::set_var("SystemRoot", &root);
        } else {
            std::env::remove_var("SystemRoot");
        }
        let error =
            tauri::async_runtime::block_on(effects.download(&root.join("cache"), &selected))
                .unwrap_err();
        assert_eq!(
            error,
            if configured {
                "The Windows HTTPS downloader is unavailable."
            } else {
                FAILED
            }
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert!(!root.join("System32/curl.exe").exists());
        assert!(!package(&root.join("cache"), &selected).unwrap().exists());
    }

    let relative_system_root = Path::new("owned-relative-system-root");
    assert!(!relative_system_root.is_absolute());
    std::env::set_var("SystemRoot", relative_system_root);
    let speech_app = crate::application_commands(
        tauri::test::mock_builder().manage(crate::speech::SpeechProcess::default()),
    )
    .build(tauri::test::mock_context(tauri::test::noop_assets()))
    .unwrap();
    let speech_window = tauri::WebviewWindowBuilder::new(
        &speech_app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .build()
    .unwrap();
    assert_eq!(
        crate::command_tests::invoke(
            &speech_window,
            "speech_start",
            serde_json::json!({"mode":"capabilities","language":"en","text":null}),
        )
        .unwrap_err(),
        "speech-unavailable"
    );
    assert!(speech_app
        .state::<crate::speech::SpeechProcess>()
        .0
        .lock()
        .unwrap()
        .is_none());

    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    assert!(executable
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("dant-"));
    assert_eq!(executable.parent().unwrap().file_name().unwrap(), "deps");
    assert!(fs::symlink_metadata(&executable).unwrap().is_file());
    let fake_downloader = root.join("System32/curl.exe");
    fs::create_dir(fake_downloader.parent().unwrap()).unwrap();
    let copied_bytes = fs::copy(&executable, &fake_downloader).unwrap();
    assert_eq!(copied_bytes, fs::metadata(&executable).unwrap().len());
    fn digest(path: &Path) -> String {
        let mut input = fs::File::open(path).unwrap();
        let mut hash = Sha256::new();
        let mut buffer = [0; 8192];
        loop {
            let count = input.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        format!("{:x}", hash.finalize())
    }
    assert_eq!(digest(&executable), digest(&fake_downloader));
    std::env::set_var("SystemRoot", &root);
    let error = tauri::async_runtime::block_on(effects.download(&root.join("cache"), &selected))
        .unwrap_err();
    assert_eq!(error, FAILED);
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(!package(&root.join("cache"), &selected).unwrap().exists());

    let script = "[Console]::Out.Write('verified installer'); exit 7";
    let mut rejected =
        Command::new(system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    rejected
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .env("SystemRoot", &system_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        rejected.creation_flags(crate::runtime::CREATE_NO_WINDOW);
    }
    let selected = asset();
    let previous = package(&root.join("rejected"), &selected).unwrap();
    fs::write(&previous, b"preserved cached bytes").unwrap();
    let result = ChildDownloadFixture::new(DownloaderPlan::Run(Ok(rejected)))
        .run(&root.join("rejected"), &selected);
    assert_eq!(result.0.unwrap_err(), FAILED);
    assert_eq!(result.1.first(), Some(&0));
    assert_eq!(fs::read(&previous).unwrap(), b"preserved cached bytes");
    assert_eq!(fs::read_dir(previous.parent().unwrap()).unwrap().count(), 1);
    let guarded = tauri::test::mock_app();
    assert!(guarded
        .try_state::<crate::lifecycle::DesktopExit>()
        .is_none());
    // No DesktopExit owner means the real delay adapter can only return from
    // prepared_update_exit's missing-state guard. This is not an SDK exit test.
    spawn_prepared_exit(guarded.handle().clone())
        .join()
        .unwrap();
    assert!(guarded
        .try_state::<crate::lifecycle::DesktopExit>()
        .is_none());
    fs::write(root.join("verified"), b"no transfer").unwrap();
}

#[test]
fn metadata_and_installer_reads_refuse_changes_after_their_snapshots_and_redact_io_failures() {
    let root = tempfile::tempdir().unwrap();
    let metadata = root.path().join("metadata.json");
    for failure in ["success", "growth", "open", "read", "malformed"] {
        fs::write(&metadata, b"{}").unwrap();
        let result = json_file_using(&metadata, 2, |path| match failure {
            "success" => fs::File::open(path),
            "growth" => {
                fs::write(path, b"{} ").unwrap();
                fs::File::open(path)
            }
            "malformed" => {
                fs::write(path, b"x").unwrap();
                fs::File::open(path)
            }
            "read" => fs::OpenOptions::new().write(true).open(path),
            _ => Err(std::io::Error::other("private owned path failure")),
        });
        if failure == "success" {
            assert_eq!(result.unwrap(), serde_json::json!({}));
        } else {
            assert_eq!(result.unwrap_err(), FAILED);
        }
    }

    let selected = asset();
    let installer = root.path().join(&selected.name);
    for failure in ["growth", "shrink", "open", "read"] {
        fs::write(&installer, b"verified installer").unwrap();
        let result = verify_file_using(&installer, &selected, |path| match failure {
            "growth" => {
                fs::write(path, b"verified installer plus extra bytes").unwrap();
                fs::File::open(path)
            }
            "shrink" => {
                fs::write(path, b"").unwrap();
                fs::File::open(path)
            }
            "read" => fs::OpenOptions::new().write(true).open(path),
            _ => Err(std::io::Error::other("private owned installer failure")),
        });
        assert_eq!(result.unwrap_err(), FAILED);
    }
}
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
fn native_effect_adapters_reject_invalid_auth_before_http_and_reuse_verified_local_payloads() {
    let app = tauri::test::mock_app();
    let root = tempfile::tempdir().unwrap();
    let selected = asset();
    let target = package(root.path(), &selected).unwrap();
    fs::write(&target, b"verified installer").unwrap();
    let download = NativeDownloadEffects {
        app: app.handle(),
        token: "invalid",
    };
    assert!(tauri::async_runtime::block_on(download.metadata("beta")).is_err());
    tauri::async_runtime::block_on(download.download(root.path(), &selected)).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"verified installer");
    let install = NativeInstallEffects {
        app: app.handle(),
        token: "invalid",
    };
    assert!(tauri::async_runtime::block_on(install.request(
        "desktop/exit",
        reqwest::Method::POST,
        Some("{}")
    ))
    .is_err());
    assert!(!install.owns_controller());
    assert!(install.now_ms() > 0 && install.now_ms() < u64::MAX);
    assert!(
        tauri::async_runtime::block_on(install.prepare(
            root.path(),
            &target,
            &selected,
            std::process::id()
        ))
        .is_err(),
        "A test process has no installed NSIS layout and must never launch an installer"
    );
    app.manage(crate::Backend::external());
    assert!(!install.owns_controller());
}

#[test]
fn controller_ownership_tracks_the_owned_synthetic_child_and_never_an_external_service() {
    let app = tauri::test::mock_app();
    app.manage(crate::Backend::external());
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "backend::tests::synthetic_backend_child",
            "--nocapture",
        ])
        .env("DANT_SYNTHETIC_BACKEND_FIXTURE", "blocked")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(crate::runtime::CREATE_NO_WINDOW);
    *app.state::<crate::Backend>().0.lock().unwrap() = Some(command.spawn().unwrap());
    assert!(owns_controller(app.handle()));
    assert_eq!(
        owned_controller_id(app.handle()).unwrap(),
        app.state::<crate::Backend>()
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .id()
    );
    app.state::<crate::Backend>().stop();
    assert!(!owns_controller(app.handle()));
    assert_eq!(owned_controller_id(app.handle()).unwrap_err(), BLOCKED);
    assert_eq!(
        owned_controller_id(tauri::test::mock_app().handle()).unwrap_err(),
        BLOCKED
    );
}

#[test]
fn an_already_exited_owned_controller_and_a_poisoned_owner_never_authorize_installation() {
    let app = tauri::test::mock_app();
    app.manage(crate::Backend::external());
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .arg("--list")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(crate::runtime::CREATE_NO_WINDOW);
    let mut child = command.spawn().unwrap();
    assert!(child.wait().unwrap().success());
    *app.state::<crate::Backend>().0.lock().unwrap() = Some(child);
    assert_eq!(owned_controller_id(app.handle()).unwrap_err(), BLOCKED);
    assert!(!owns_controller(app.handle()));
    app.state::<crate::Backend>().stop();
    std::thread::scope(|scope| {
        let owner = app.state::<crate::Backend>();
        assert!(scope
            .spawn(move || {
                let _guard = owner.0.lock().unwrap();
                panic!("isolated owner failure");
            })
            .join()
            .is_err());
    });
    assert!(!owns_controller(app.handle()));
    assert_eq!(owned_controller_id(app.handle()).unwrap_err(), BLOCKED);
}

#[test]
fn native_progress_publishes_only_captured_asset_identity_and_bounded_transfer_counts() {
    use tauri::Listener;
    let app = tauri::test::mock_app();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let listener = Arc::clone(&observed);
    app.listen_any("dant-update-progress", move |event| {
        listener
            .lock()
            .unwrap()
            .push(serde_json::from_str::<serde_json::Value>(event.payload()).unwrap());
    });
    let selected = asset();
    let host = NativeDownloadEffects {
        app: app.handle(),
        token: "unused",
    };
    host.progress(&selected, 7, "downloading");
    let observed = observed.lock().unwrap();
    assert_eq!(
        *observed,
        [
            serde_json::json!({"version":selected.version,"channel":selected.channel,"sha256":selected.sha256,"received":7,"total":selected.size,"status":"downloading"})
        ]
    );
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
        let result = stream_payload(&mut input, &mut output, &a, NO_PROGRESS);
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
    struct FaultingStream {
        bytes: Cursor<Vec<u8>>,
        read_failed: bool,
        write_failed: bool,
    }
    impl Read for FaultingStream {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.read_failed {
                Err(std::io::Error::other("synthetic read refusal"))
            } else {
                self.bytes.read(buffer)
            }
        }
    }
    impl Write for FaultingStream {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.write_failed {
                Err(std::io::Error::other("synthetic write refusal"))
            } else {
                self.bytes.write(bytes)
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    for failure in ["none", "read", "write"] {
        let mut input = FaultingStream {
            bytes: Cursor::new(b"verified installer".to_vec()),
            read_failed: failure == "read",
            write_failed: false,
        };
        let mut output = FaultingStream {
            bytes: Cursor::new(Vec::new()),
            read_failed: false,
            write_failed: failure == "write",
        };
        let mut progress = Vec::new();
        let result = stream_payload(&mut input, &mut output, &asset(), |count| {
            progress.push(count)
        });
        if failure == "none" {
            result.unwrap();
            assert_eq!(output.bytes.into_inner(), b"verified installer");
        } else {
            assert_eq!(result, Err(FAILED.into()));
            assert!(
                progress.is_empty(),
                "A refused read or write cannot report progress"
            );
            assert!(output.bytes.into_inner().is_empty());
        }
    }
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
    let ordinary = ControllerFixture::new(http("200 OK", b"{}"));
    assert_eq!(
        tauri::async_runtime::block_on(controller_request_at(
            ordinary.address,
            "state",
            &"a".repeat(64),
            2,
            reqwest::Method::GET,
            None,
        ))
        .unwrap(),
        serde_json::json!({})
    );
    let ordinary_requests = ordinary.requests.lock().unwrap();
    assert_eq!(ordinary_requests.len(), 1);
    assert!(
        String::from_utf8_lossy(&ordinary_requests[0]).starts_with("GET /api/state HTTP/1.1\r\n")
    );
    drop(ordinary_requests);
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

enum DownloaderPlan {
    Run(Result<Command, String>),
    Forbidden(&'static str),
}

struct ChildDownloadFixture {
    plan: DownloaderPlan,
    progress: Vec<u64>,
    forbid_progress: bool,
}

impl ChildDownloadFixture {
    fn new(plan: DownloaderPlan) -> Self {
        Self {
            plan,
            progress: Vec::new(),
            forbid_progress: false,
        }
    }

    fn run(self, root: &Path, selected: &Asset) -> (Result<(), String>, Vec<u64>) {
        let Self {
            plan,
            mut progress,
            forbid_progress,
        } = self;
        let result = download_using(
            root,
            selected,
            move || match plan {
                DownloaderPlan::Run(command) => command,
                DownloaderPlan::Forbidden(reason) => panic!("{reason}"),
            },
            |bytes| {
                assert!(
                    !forbid_progress,
                    "Cache reuse must not report a new transfer"
                );
                progress.push(bytes);
            },
        );
        (result, progress)
    }
}

#[test]
fn download_commits_only_a_verified_owned_child_payload_and_never_replays_a_cached_or_failed_action(
) {
    let root = tempfile::tempdir().unwrap();
    let selected = synthetic_download_asset();
    let (result, progress) =
        ChildDownloadFixture::new(DownloaderPlan::Run(Ok(synthetic_installer_command())))
            .run(root.path(), &selected);
    result.unwrap();
    let destination = package(root.path(), &selected).unwrap();
    verify_file(&destination, &selected).unwrap();
    assert_eq!(progress.first(), Some(&0));
    assert!(progress.iter().all(|received| *received <= selected.size));
    assert!(progress.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(
        json_file(&destination.parent().unwrap().join("asset.json"), 65536).unwrap()["sha256"],
        selected.sha256
    );
    let mut cached = ChildDownloadFixture::new(DownloaderPlan::Forbidden(
        "verified payload must not spawn another downloader",
    ));
    cached.forbid_progress = true;
    cached.run(root.path(), &selected).0.unwrap();
    fs::write(&destination, b"preserved invalid cached bytes").unwrap();
    let original = fs::read(&destination).unwrap();
    assert!(ChildDownloadFixture::new(DownloaderPlan::Run(Err(
        "synthetic child not available".into()
    )))
    .run(root.path(), &selected)
    .0
    .is_err());
    assert_eq!(fs::read(&destination).unwrap(), original);
    let mut wrong = selected.clone();
    wrong.sha256 = "b".repeat(64);
    assert!(
        ChildDownloadFixture::new(DownloaderPlan::Run(Ok(synthetic_installer_command())))
            .run(root.path(), &wrong)
            .0
            .is_err()
    );
    assert!(!package(root.path(), &wrong).unwrap().exists());
    let files = fs::read_dir(package(root.path(), &wrong).unwrap().parent().unwrap())
        .unwrap()
        .count();
    assert_eq!(files, 0);
    assert!(
        ChildDownloadFixture::new(DownloaderPlan::Run(Ok(Command::new(
            root.path().join("missing-downloader.exe")
        ))))
        .run(root.path(), &selected)
        .0
        .is_err()
    );
    let mut no_pipe = synthetic_installer_command();
    no_pipe.stdout(Stdio::null());
    assert!(ChildDownloadFixture::new(DownloaderPlan::Run(Ok(no_pipe)))
        .run(root.path(), &selected)
        .0
        .is_err());
    fs::remove_file(&destination).unwrap();
    fs::create_dir(&destination).unwrap();
    assert!(ChildDownloadFixture::new(DownloaderPlan::Forbidden(
        "foreign destination must not launch a process"
    ))
    .run(root.path(), &selected)
    .0
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
        assert!(
            installer == root.join("synthetic-installer.exe")
                || installer == package(root, selected).unwrap()
        );
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

fn admissible_state() -> serde_json::Value {
    serde_json::json!({"mode":"vm-controller","controller":{"authority":"vm","vmConfigured":true,"status":"online","cached":false,"desktopTransition":"idle","serviceUpdateBusy":false},"provisioning":{"running":false,"status":"ready"}})
}
#[test]
fn release_install_selection_checks_public_identity_fresh_state_owned_controller_and_cached_hash_before_lease(
) {
    for mode in [
        "success",
        "foreign",
        "development",
        "bad-id",
        "missing-state",
        "missing-package",
        "blocked-state",
        "state-unknown",
        "controller",
        "cache",
        "corrupted",
    ] {
        let root = tempfile::tempdir().unwrap();
        let selected = asset();
        let target = package(root.path(), &selected).unwrap();
        fs::write(
            &target,
            if mode == "corrupted" {
                b"unverified payload".as_slice()
            } else {
                b"verified installer".as_slice()
            },
        )
        .unwrap();
        let state = Updates::default();
        if mode != "missing-package" {
            state
                .packages
                .lock()
                .unwrap()
                .insert(selected.sha256.clone(), selected.clone());
        }
        let mut replies = vec![if mode == "state-unknown" {
            Err("synthetic unknown state".into())
        } else if mode == "blocked-state" {
            Ok(serde_json::json!({}))
        } else {
            Ok(admissible_state())
        }];
        replies.extend(install_replies(serde_json::json!(FIXTURE_NOW + 20000)));
        let host = InstallFixture::new(root.path(), replies);
        let result = tauri::async_runtime::block_on(install_selected(
            &host,
            if mode == "missing-state" {
                None
            } else {
                Some(&state)
            },
            InstallRequest {
                window: if mode == "foreign" {
                    "call-overlay"
                } else {
                    "main"
                },
                packaged: mode != "development",
                package_id: if mode == "bad-id" {
                    "invalid"
                } else {
                    &selected.sha256
                },
            },
            || {
                if mode == "cache" {
                    Err("synthetic inaccessible cache".into())
                } else {
                    Ok(root.path().to_owned())
                }
            },
            || {
                if mode == "controller" {
                    Err(BLOCKED.into())
                } else {
                    Ok(777)
                }
            },
        ));
        if mode == "success" {
            assert!(result.unwrap().launched);
            assert_eq!(host.prepared.load(Ordering::Acquire), 1);
            assert_eq!(host.exits.load(Ordering::Acquire), 1);
            assert_eq!(
                host.routes(),
                vec![
                    crate::protocol::state_route(),
                    "updates/install-lease",
                    "desktop/exit"
                ]
            );
        } else {
            assert!(result.is_err(), "{mode}");
            assert_eq!(host.prepared.load(Ordering::Acquire), 0);
            host.assert_no_exit_or_authorization();
            assert!(host.requests.lock().unwrap().len() <= 1);
        }
    }
}
#[test]
fn capability_reasons_and_update_cache_follow_packaged_ownership_and_the_actual_runtime_directory()
{
    for (installed, owned, reason) in [
        (false, false, Some("installed-app-required")),
        (false, true, Some("installed-app-required")),
        (true, false, Some("owned-controller-required")),
        (true, true, None),
    ] {
        let value = capabilities(installed, owned);
        assert_eq!(value.install, installed && owned);
        assert_eq!(value.reason, reason);
    }
    let root = tempfile::tempdir().unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.path().to_owned()),
    );
    let app = tauri::test::mock_builder().build(context).unwrap();
    let host = NativeDownloadEffects {
        app: app.handle(),
        token: "invalid",
    };
    let path = host.cache().unwrap();
    assert!(path.starts_with(root.path()));
    assert_eq!(
        path,
        crate::runtime_path(app.path().app_cache_dir().unwrap()).join("updates")
    );
    assert!(path.is_dir());
}

#[test]
fn install_state_retains_the_full_state_response_budget_while_actions_remain_small() {
    assert_eq!(
        install_response_limit(crate::protocol::state_route(), &reqwest::Method::GET),
        crate::protocol::API_RESPONSE_MAX_BYTES
    );
    assert_eq!(
        install_response_limit(crate::protocol::state_route(), &reqwest::Method::POST),
        UPDATE_ACTION_RESPONSE_MAX_BYTES
    );
    assert_eq!(
        install_response_limit("desktop/exit", &reqwest::Method::POST),
        UPDATE_ACTION_RESPONSE_MAX_BYTES
    );
}
