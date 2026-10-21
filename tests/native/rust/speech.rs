use super::*;
use std::cell::RefCell;
use tauri::Manager;

struct SpeechCommandsFixture {
    succeed: bool,
    panic: bool,
    requests: Mutex<Vec<(String, String, Option<String>)>>,
}
impl SpeechCommands for SpeechCommandsFixture {
    fn command(
        &self,
        mode: &str,
        language: &str,
        text: Option<&str>,
    ) -> Result<(Command, String), SpeechFailure> {
        self.requests
            .lock()
            .unwrap()
            .push((mode.into(), language.into(), text.map(str::to_owned)));
        if self.panic {
            std::panic::resume_unwind(Box::new("private synthetic command failure"));
        }
        Ok((synthetic_speech_command(self.succeed), "{}".into()))
    }
}

#[test]
#[cfg(windows)]
fn native_speech_command_runs_only_its_injected_child_and_persists_bounded_result_metadata() {
    for diagnostics in [false, true] {
        let root = fixture();
        let commands = Arc::new(SpeechCommandsFixture {
            succeed: true,
            panic: false,
            requests: Mutex::default(),
        });
        let app = crate::application_commands(
            tauri::test::mock_builder().manage(SpeechProcess::with_commands(commands.clone())),
        )
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
        if diagnostics {
            app.manage(crate::runtime::RuntimeConfig {
                data_directory: root.path().join("data"),
            });
        }
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        for mode in ["speak", "recognize", "capabilities"] {
            let result = crate::command_tests::invoke(
                &window,
                "speech_start",
                serde_json::json!({"mode":mode,"language":"en","text":"private fixture text"}),
            )
            .unwrap();
            assert_eq!(result, "synthetic result");
            assert!(app.state::<SpeechProcess>().0.lock().unwrap().is_none());
        }
        assert!(
            crate::command_tests::invoke(&window, "speech_stop", serde_json::json!({}))
                .unwrap()
                .is_null()
        );
        assert_eq!(commands.requests.lock().unwrap().len(), 3);
        assert_eq!(
            commands.requests.lock().unwrap()[0],
            (
                "speak".into(),
                "en".into(),
                Some("private fixture text".into())
            )
        );
        let path = root.path().join("data/native-speech.jsonl");
        if diagnostics {
            let bytes = fs::read_to_string(path).unwrap();
            assert!(!bytes.contains("private fixture text"));
            assert!(!bytes.contains("synthetic result"));
            assert_eq!(bytes.lines().count(), 3);
            for line in bytes.lines() {
                let value: serde_json::Value = serde_json::from_str(line).unwrap();
                assert_eq!(value["status"], "completed");
                assert_eq!(value["reason"], "ok");
            }
        } else {
            assert!(!path.exists());
        }
    }
    let commands = Arc::new(SpeechCommandsFixture {
        succeed: false,
        panic: false,
        requests: Mutex::default(),
    });
    let app = crate::application_commands(
        tauri::test::mock_builder().manage(SpeechProcess::with_commands(commands)),
    )
    .build(tauri::test::mock_context(tauri::test::noop_assets()))
    .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    assert_eq!(
        crate::command_tests::invoke(
            &window,
            "speech_start",
            serde_json::json!({"mode":"speak","language":"en","text":null})
        )
        .unwrap_err(),
        "speech-language-unavailable"
    );
}

#[test]
#[cfg(windows)]
fn speech_command_owner_failure_returns_only_the_fixed_unavailable_code_without_spawning() {
    let commands = Arc::new(SpeechCommandsFixture {
        succeed: true,
        panic: true,
        requests: Mutex::default(),
    });
    let app = crate::application_commands(
        tauri::test::mock_builder().manage(SpeechProcess::with_commands(commands.clone())),
    )
    .build(tauri::test::mock_context(tauri::test::noop_assets()))
    .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    assert_eq!(
        crate::command_tests::invoke(
            &window,
            "speech_start",
            serde_json::json!({"mode":"capabilities","language":"en","text":null}),
        )
        .unwrap_err(),
        "speech-unavailable"
    );
    assert_eq!(commands.requests.lock().unwrap().len(), 1);
    assert!(app.state::<SpeechProcess>().0.lock().unwrap().is_none());
}

#[test]
fn the_builtin_speech_factory_only_constructs_the_fixed_os_helper_and_never_launches_on_capture() {
    let captured = NativeSpeechCommands.command("capabilities", "en", None);
    if let Err(error) = captured.as_ref() {
        assert!(!cfg!(windows));
        assert_eq!(error.code, "speech-unavailable");
        assert_eq!(error.phase, "process-start");
        return;
    }
    let (command, input) = captured.unwrap();
    assert!(Path::new(command.get_program())
        .ends_with("System32/WindowsPowerShell/v1.0/powershell.exe"));
    let value: serde_json::Value = serde_json::from_str(&input).unwrap();
    assert_eq!(value["mode"], "capabilities");
    assert_eq!(value["language"], "en");
    assert!(value["text"].is_null());
}

fn synthetic_speech_command(success: bool) -> Command {
    #[cfg(windows)]
    let mut command = {
        let root = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        let mut command = Command::new(root.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
        let script = if success {
            "[Console]::In.ReadToEnd() | Out-Null; [Console]::Out.Write('{\"text\":\"synthetic result\"}')"
        } else {
            "[Console]::In.ReadToEnd() | Out-Null; [Console]::Out.Write('{\"errorCode\":\"speech-language-unavailable\",\"phase\":\"voice-selection\"}'); exit 1"
        };
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded,
        ]);
        command.creation_flags(crate::runtime::CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", if success { "while IFS= read -r line || [ -n \"$line\" ]; do :; done; printf '%s' '{\"text\":\"synthetic result\"}'" } else { "while IFS= read -r line || [ -n \"$line\" ]; do :; done; printf '%s' '{\"errorCode\":\"speech-language-unavailable\",\"phase\":\"voice-selection\"}'; exit 1" }]);
        command
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SpeechInterruption {
    Generation,
    Removed,
    Poisoned,
}

enum SpeechClock {
    Wall,
    Deadline {
        base: Instant,
        first: bool,
    },
    Interrupt {
        kind: SpeechInterruption,
        first: bool,
    },
}

enum SpeechWait {
    Real,
    Forbidden(&'static str),
}

fn execute_speech_scripted(
    shared: &SpeechProcess,
    command: Command,
    input: &str,
    timeout: Duration,
    mut clock: SpeechClock,
    wait: SpeechWait,
) -> Result<String, SpeechFailure> {
    execute_speech(
        shared,
        command,
        input,
        timeout,
        || match &mut clock {
            SpeechClock::Wall => Instant::now(),
            SpeechClock::Deadline { base, first } => {
                if std::mem::take(first) {
                    *base
                } else {
                    *base + Duration::from_secs(1)
                }
            }
            SpeechClock::Interrupt { kind, first } => {
                if std::mem::take(first) {
                    match kind {
                        SpeechInterruption::Removed => {
                            let mut child = shared.0.lock().unwrap().take().unwrap();
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        SpeechInterruption::Poisoned => {
                            std::thread::scope(|scope| {
                                assert!(scope
                                    .spawn(|| {
                                        let _owner = shared.0.lock().unwrap();
                                        std::panic::resume_unwind(Box::new(()));
                                    })
                                    .join()
                                    .is_err());
                            });
                        }
                        SpeechInterruption::Generation => {
                            shared.1.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                }
                Instant::now()
            }
        },
        |delay| match wait {
            SpeechWait::Real => std::thread::sleep(delay),
            SpeechWait::Forbidden(message) => panic!("{message}"),
        },
    )
}

#[test]
fn speech_child_execution_returns_validated_results_and_cleans_owned_processes() {
    let shared = SpeechProcess::default();
    for piped in [true, false] {
        let mut command = synthetic_speech_command(true);
        if !piped {
            command.stdin(Stdio::null());
        }
        assert_eq!(
            execute_speech_scripted(
                &shared,
                command,
                "{}",
                Duration::from_secs(5),
                SpeechClock::Wall,
                SpeechWait::Real
            )
            .unwrap(),
            "synthetic result"
        );
    }
    assert!(shared.0.lock().unwrap().is_none());
    assert_eq!(
        execute_speech_scripted(
            &shared,
            synthetic_speech_command(false),
            "{}",
            Duration::from_secs(5),
            SpeechClock::Wall,
            SpeechWait::Real
        )
        .unwrap_err(),
        failed("speech-language-unavailable", "voice-selection")
    );
    assert!(shared.0.lock().unwrap().is_none());
}

#[test]
fn speech_deadline_and_generation_changes_stop_without_claiming_completion() {
    for interruption in [
        SpeechInterruption::Generation,
        SpeechInterruption::Removed,
        SpeechInterruption::Poisoned,
    ] {
        let shared = SpeechProcess::default();
        let result = execute_speech_scripted(
            &shared,
            synthetic_speech_command(true),
            "{}",
            Duration::from_secs(5),
            SpeechClock::Interrupt {
                kind: interruption,
                first: true,
            },
            SpeechWait::Forbidden("Cancellation must be checked before waiting"),
        );
        assert_eq!(
            result.unwrap_err(),
            failed(
                if interruption == SpeechInterruption::Poisoned {
                    "speech-unavailable"
                } else {
                    "speech-cancelled"
                },
                "process-wait"
            )
        );
        stop(&shared);
        assert!(shared
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_none());
    }
    let shared = SpeechProcess::default();
    let base = Instant::now();
    let result = execute_speech_scripted(
        &shared,
        synthetic_speech_command(true),
        "{}",
        Duration::from_secs(1),
        SpeechClock::Deadline { base, first: true },
        SpeechWait::Forbidden("Expired deadlines must not wait"),
    );
    assert_eq!(
        result.unwrap_err(),
        failed("speech-timeout", "process-wait")
    );
    assert!(shared.0.lock().unwrap().is_none());
}

#[test]
fn a_poisoned_speech_owner_still_cancels_and_joins_its_retained_child() {
    let process = SpeechProcess::default();
    *process.0.lock().unwrap() = Some(synthetic_speech_command(true).spawn().unwrap());
    std::thread::scope(|scope| {
        assert!(scope
            .spawn(|| {
                let _owner = process.0.lock().unwrap();
                std::panic::resume_unwind(Box::new(()));
            })
            .join()
            .is_err());
    });
    let generation = process.1.load(Ordering::SeqCst);
    let root = fixture();
    assert_eq!(
        execute_speech_scripted(
            &process,
            Command::new(root.path().join("must-not-spawn.exe")),
            "{}",
            Duration::from_secs(5),
            SpeechClock::Wall,
            SpeechWait::Forbidden("A poisoned owner must not wait"),
        )
        .unwrap_err(),
        failed("speech-unavailable", "process-start")
    );
    stop(&process);
    let mut owner = process
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let was_retained = owner.is_some();
    if let Some(mut child) = owner.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    assert!(
        !was_retained,
        "Shutdown must join even a poisoned child owner"
    );
    assert_eq!(process.1.load(Ordering::SeqCst), generation + 1);
    drop(owner);
    stop(&process);
}

#[test]
fn speech_admission_preserves_an_existing_child_and_failed_spawns_leave_no_owner() {
    let shared = SpeechProcess::default();
    let directory = fixture();
    assert_eq!(
        execute_speech_scripted(
            &shared,
            Command::new(directory.path().join("missing.exe")),
            "{}",
            Duration::from_secs(1),
            SpeechClock::Wall,
            SpeechWait::Forbidden("A failed spawn must not wait")
        )
        .unwrap_err(),
        failed("speech-unavailable", "process-start")
    );
    assert!(shared.0.lock().unwrap().is_none());
    *shared.0.lock().unwrap() = Some(synthetic_speech_command(true).spawn().unwrap());
    let before = shared.0.lock().unwrap().as_ref().unwrap().id();
    assert_eq!(
        execute_speech_scripted(
            &shared,
            Command::new(directory.path().join("missing.exe")),
            "{}",
            Duration::from_secs(1),
            SpeechClock::Wall,
            SpeechWait::Forbidden("A busy owner must not wait")
        )
        .unwrap_err(),
        failed("speech-busy", "process-start")
    );
    assert_eq!(shared.0.lock().unwrap().as_ref().unwrap().id(), before);
    stop(&shared);
    assert!(shared.0.lock().unwrap().is_none());
}

#[test]
fn a_child_that_closes_its_input_before_the_request_is_written_is_joined_without_an_owner() {
    let shared = SpeechProcess::default();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .arg("--list")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(crate::runtime::CREATE_NO_WINDOW);
    let result = execute_speech_scripted(
        &shared,
        command,
        &"x".repeat(1024 * 1024),
        Duration::from_secs(5),
        SpeechClock::Wall,
        SpeechWait::Forbidden("A failed request write must not enter the process polling loop"),
    );
    assert_eq!(
        result.unwrap_err(),
        failed("speech-unavailable", "request-write")
    );
    assert!(shared.0.lock().unwrap().is_none());
}

#[test]
fn speech_command_keeps_the_script_fixed_and_user_content_only_in_stdin() {
    let system = PathBuf::from("synthetic-system");
    let (command, request) = speech_command(&system, "speak", "zh", Some("private & user content"));
    assert_eq!(
        command.get_program(),
        system.join("System32/WindowsPowerShell/v1.0/powershell.exe")
    );
    let args: Vec<_> = command
        .get_args()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        &args[..4],
        [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand"
        ]
    );
    let script = STANDARD.decode(&args[4]).unwrap();
    let expected: Vec<_> = include_str!("../../../native/speech.ps1")
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    assert_eq!(script, expected);
    assert!(!args.iter().any(|value| value.contains("private")));
    let request: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["text"], "private & user content");
    assert_eq!(request["locale"].as_str(), crate::l10n::speech_locale("zh"));
}

#[test]
fn diagnostic_paths_follow_captured_runtime_data_without_creating_a_file() {
    let app = tauri::test::mock_app();
    assert!(diagnostic_file(app.handle()).is_none());
    app.manage(crate::runtime::RuntimeConfig {
        data_directory: PathBuf::from("synthetic-relative-data"),
    });
    assert_eq!(
        diagnostic_file(app.handle()),
        Some(
            std::env::current_dir()
                .unwrap()
                .join("synthetic-relative-data/native-speech.jsonl")
        )
    );
    let root = fixture();
    let app = tauri::test::mock_app();
    app.manage(crate::runtime::RuntimeConfig {
        data_directory: root.path().join("data"),
    });
    let expected = root.path().join("data/native-speech.jsonl");
    assert_eq!(diagnostic_file(app.handle()), Some(expected.clone()));
    assert!(!expected.exists());
    assert!(parent_identity(Path::new("relative")).is_err());
    assert!(ordinary_parent(Path::new("relative")).is_err());
    let directory = fs::File::open(root.path());
    #[cfg(not(windows))]
    assert!(file_stamp(&directory.unwrap()).is_err());
    #[cfg(windows)]
    assert!(directory.is_err());
    assert_eq!(
        response_result(true, b"[]").unwrap_err(),
        failed("speech-response-invalid", "process-response")
    );
    assert_eq!(
        response_result(
            true,
            serde_json::json!({"text":"x".repeat(MAX_SPEECH_CHARACTERS + 1)})
                .to_string()
                .as_bytes()
        )
        .unwrap_err(),
        failed("speech-response-invalid", "process-response")
    );
}
fn fixture() -> tempfile::TempDir {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".cache/tests");
    fs::create_dir_all(&root).unwrap();
    tempfile::tempdir_in(root).unwrap()
}
fn rotation_fixture() -> (
    tempfile::TempDir,
    PathBuf,
    tempfile::NamedTempFile,
    DiagnosticPathIdentity,
) {
    let directory = fixture();
    let parent = directory.path().join("data");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("native-speech.jsonl");
    fs::write(&path, b"previous metadata").unwrap();
    let identity = diagnostic_identity(&path).unwrap();
    let mut temporary = tempfile::NamedTempFile::new_in(&parent).unwrap();
    temporary.write_all(b"replacement metadata").unwrap();
    temporary.as_file().sync_all().unwrap();
    (directory, path, temporary, identity)
}
#[test]
fn diagnostic_rotation_retries_only_the_same_metadata_after_windows_sharing_failures() {
    let (_directory, path, temporary, identity) = rotation_fixture();
    let mut attempts = 0;
    let mut waits = Vec::new();
    let committed = RefCell::new(Vec::new());
    persist_diagnostic_with(
        &path,
        temporary,
        identity,
        true,
        &mut |file, _target| {
            attempts += 1;
            assert_eq!(fs::read(file.path()).unwrap(), b"replacement metadata");
            if attempts <= 2 {
                return Err(tempfile::PersistError {
                    error: std::io::Error::from_raw_os_error(WINDOWS_SHARING_VIOLATION),
                    file,
                });
            }
            // The injected commit records the payload; the existing 140-write
            // retention test separately exercises the real atomic rename.
            committed.replace(fs::read(file.path()).unwrap());
            Ok(file.into_file())
        },
        &mut |delay| waits.push(delay),
    )
    .unwrap();
    assert_eq!(attempts, 3);
    assert_eq!(
        waits,
        [Duration::from_millis(20), Duration::from_millis(40)]
    );
    assert_eq!(*committed.borrow(), b"replacement metadata");
    assert_eq!(fs::read(&path).unwrap(), b"previous metadata");
}

#[test]
fn diagnostic_rotation_refuses_a_temporary_file_from_another_parent_before_commit() {
    let (_directory, path, _temporary, identity) = rotation_fixture();
    let other = fixture();
    let temporary = tempfile::NamedTempFile::new_in(other.path()).unwrap();
    let staged = temporary.path().to_owned();
    let result = persist_diagnostic_with(
        &path,
        temporary,
        identity,
        true,
        &mut |_, _| panic!("A foreign staged file must never be published"),
        &mut |_| panic!("A foreign staged file must never be retried"),
    );
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    assert_eq!(fs::read(&path).unwrap(), b"previous metadata");
    assert!(!staged.exists());
}
#[test]
fn diagnostic_rotation_never_retries_other_errors_or_platforms_and_has_a_fixed_attempt_limit() {
    for (windows, code, expected_attempts) in [
        (false, WINDOWS_ACCESS_DENIED, 1),
        (false, WINDOWS_SHARING_VIOLATION, 1),
        (true, 13, 1),
        (true, 112, 1),
        (true, WINDOWS_ACCESS_DENIED, DIAGNOSTIC_PERSIST_ATTEMPTS),
        (true, WINDOWS_SHARING_VIOLATION, DIAGNOSTIC_PERSIST_ATTEMPTS),
    ] {
        let (_directory, path, temporary, identity) = rotation_fixture();
        let mut attempts = 0;
        let mut waits = Vec::new();
        let result = persist_diagnostic_with(
            &path,
            temporary,
            identity,
            windows,
            &mut |file, _target| {
                attempts += 1;
                Err(tempfile::PersistError {
                    error: std::io::Error::from_raw_os_error(code),
                    file,
                })
            },
            &mut |delay| waits.push(delay),
        );
        assert_eq!(result.unwrap_err().raw_os_error(), Some(code));
        assert_eq!(attempts, expected_attempts);
        assert_eq!(waits.len(), expected_attempts - 1);
        assert!(waits.iter().sum::<Duration>() <= Duration::from_millis(300));
        assert_eq!(fs::read(&path).unwrap(), b"previous metadata");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }
}
#[test]
fn diagnostic_rotation_refuses_rebound_targets_parents_links_and_modified_temporary_files_before_retry(
) {
    for change in ["target", "replacement", "hardlink", "temporary"] {
        let (directory, path, temporary, identity) = rotation_fixture();
        let temporary_path = temporary.path().to_path_buf();
        let protected = directory.path().join("protected.txt");
        fs::write(&protected, b"protected").unwrap();
        let mut attempts = 0;
        let result = persist_diagnostic_with(
            &path,
            temporary,
            identity,
            true,
            &mut |file, _target| {
                attempts += 1;
                Err(tempfile::PersistError {
                    error: std::io::Error::from_raw_os_error(WINDOWS_SHARING_VIOLATION),
                    file,
                })
            },
            &mut |_delay| match change {
                "target" => fs::write(&path, b"changed metadata with a different length").unwrap(),
                "replacement" => {
                    fs::rename(&path, directory.path().join("previous-kept.jsonl")).unwrap();
                    fs::write(&path, b"previous metadata").unwrap();
                }
                "hardlink" => {
                    fs::remove_file(&path).unwrap();
                    fs::hard_link(&protected, &path).unwrap();
                }
                "temporary" => fs::write(
                    &temporary_path,
                    b"modified temporary payload with a different length",
                )
                .unwrap(),
                _ => unreachable!(),
            },
        );
        assert_eq!(
            result.unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput,
            "{change}"
        );
        assert_eq!(attempts, 1, "{change}");
        assert_eq!(fs::read(&protected).unwrap(), b"protected");
    }
    // Windows prevents moving a directory while its staging file is open.
    // Model a real parent rebind between the initial identity capture and
    // staging-file creation instead, retaining the exact same target inode.
    let directory = fixture();
    let parent = directory.path().join("data");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("native-speech.jsonl");
    fs::write(&path, b"previous metadata").unwrap();
    let identity = diagnostic_identity(&path).unwrap();
    let previous = directory.path().join("previous-data");
    fs::rename(&parent, &previous).unwrap();
    fs::create_dir(&parent).unwrap();
    fs::rename(previous.join("native-speech.jsonl"), &path).unwrap();
    assert_eq!(diagnostic_target(&path).unwrap(), identity.target);
    let mut temporary = tempfile::NamedTempFile::new_in(&parent).unwrap();
    temporary.write_all(b"replacement metadata").unwrap();
    temporary.as_file().sync_all().unwrap();
    let result = persist_diagnostic_with(
        &path,
        temporary,
        identity,
        true,
        &mut |_file, _target| panic!("A rebound parent must never reach the rename operation"),
        &mut |_delay| panic!("Identity rejection must never be retried"),
    );
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    assert_eq!(fs::read(&path).unwrap(), b"previous metadata");
}
#[test]
fn responses_accept_only_stable_metadata_never_raw_exceptions() {
    let error=response_result(false,br#"{"errorCode":"speech-output-unavailable","phase":"speak-run","numericCode":2,"error":"PRIVATE secret transcript /path"}"#).unwrap_err();
    assert_eq!(
        error,
        SpeechFailure {
            code: "speech-output-unavailable",
            phase: "speak-run",
            numeric_code: Some(2)
        }
    );
    let untrusted=response_result(false,br#"{"errorCode":"PRIVATE transcript","phase":"/private/path","numericCode":"secret","error":"raw secret"}"#).unwrap_err();
    assert_eq!(untrusted, failed("speech-unavailable", "process-response"));
    assert_eq!(
        response_result(true, br#"{"text":"recognized text"}"#).unwrap(),
        "recognized text"
    );
    assert!(response_result(true, b"invalid").is_err());
    assert!(response_result(true, &vec![b'a'; 65537]).is_err());
}
#[test]
fn diagnostics_are_bounded_metadata_with_retention_and_no_text() {
    let directory = fixture();
    let file = directory.path().join("data/native-speech.jsonl");
    let outcome = Err(SpeechFailure {
        code: "speech-output-unavailable",
        phase: "speak-run",
        numeric_code: Some(2),
    });
    append_diagnostic(&file, "speak", "zh", &outcome, 100).unwrap();
    let mut row: serde_json::Value =
        serde_json::from_str(fs::read_to_string(&file).unwrap().trim()).unwrap();
    row["raw"] = serde_json::json!("PRIVATE spoken text /path");
    fs::write(&file, format!("{row}\n")).unwrap();
    append_diagnostic(&file, "speak", "zh", &outcome, 200).unwrap();
    assert!(!fs::read_to_string(&file).unwrap().contains("PRIVATE"));
    for index in 0..140 {
        append_diagnostic(&file, "speak", "en", &outcome, 300 + index).unwrap();
    }
    let text = fs::read_to_string(&file).unwrap();
    assert_eq!(text.lines().count(), 128);
    assert!(text.len() <= 65536);
    assert!(!text.contains("transcript"));
    append_diagnostic(
        &file,
        "speak",
        "zh",
        &Ok("PRIVATE successful spoken text".into()),
        3 * 86400000 + 1000,
    )
    .unwrap();
    let lines = fs::read_to_string(&file).unwrap();
    assert_eq!(lines.lines().count(), 1);
    assert!(!lines.contains("PRIVATE"));
    assert!(lines.contains("completed"));
}

#[test]
fn diagnostic_history_discards_overlong_future_and_invalid_records_and_keeps_only_typed_metadata() {
    let root = fixture();
    let path = root.path().join("native-speech.jsonl");
    let valid = serde_json::json!({"schema":"dant.native-speech.v1","event":"speech.operation","at":100,"mode":"speak","language":"en","phase":"finished","status":"completed","reason":"ok","numericCode":42});
    let mut lines = vec!["x".repeat(513), "not-json".into(), "null".into()];
    for (key, value) in [
        ("at", serde_json::json!(1000)),
        ("at", serde_json::json!(-1)),
        ("schema", serde_json::json!("unknown")),
        ("event", serde_json::json!("private event")),
        ("mode", serde_json::json!("invalid")),
        ("language", serde_json::json!("invalid")),
        ("phase", serde_json::json!("invalid")),
        ("status", serde_json::json!("unknown")),
        ("reason", serde_json::json!("unknown")),
    ] {
        let mut row = valid.clone();
        row[key] = value;
        lines.push(row.to_string());
    }
    let mut no_time = valid.clone();
    no_time.as_object_mut().unwrap().remove("at");
    lines.push(no_time.to_string());
    lines.push(valid.to_string());
    fs::write(&path, lines.join("\n")).unwrap();
    append_diagnostic(&path, "speak", "en", &Ok(String::new()), 200).unwrap();
    let rows: Vec<serde_json::Value> = fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["at"], 100);
    assert_eq!(rows[0]["numericCode"], 42);
    assert_eq!(rows[1]["at"], 200);
}

#[test]
fn diagnostic_history_read_commits_valid_metadata_and_refuses_changes_or_io_failures() {
    for failure in [
        "success",
        "failed-operation",
        "growth",
        "link",
        "read",
        "open",
    ] {
        let root = fixture();
        let path = root.path().join("native-speech.jsonl");
        let retained = serde_json::json!({"schema":"dant.native-speech.v1","event":"speech.operation","at":50,"mode":"speak","language":"en","phase":"finished","status":"completed","reason":"ok","numericCode":42,"private":"discarded content"});
        fs::write(&path, format!("previous metadata\n{retained}\n")).unwrap();
        let outcome = if failure == "failed-operation" {
            Err(failed("speech-language-unavailable", "voice-selection"))
        } else {
            Ok(String::new())
        };
        let result = append_diagnostic_using(&path, "speak", "en", &outcome, 100, |selected| {
            assert_eq!(selected, path);
            match failure {
                "success" | "failed-operation" => {}
                "growth" => {
                    fs::write(selected, vec![b'x'; MAX_DIAGNOSTIC_BYTES as usize + 1]).unwrap()
                }
                "link" => fs::hard_link(selected, root.path().join("other-link")).unwrap(),
                "read" => return fs::OpenOptions::new().write(true).open(selected),
                "open" => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "owned private failure",
                    ))
                }
                _ => unreachable!(),
            }
            fs::File::open(selected)
        });
        let stored = fs::read_to_string(&path).unwrap();
        if matches!(failure, "success" | "failed-operation") {
            result.unwrap();
            let records: Vec<serde_json::Value> = stored
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(records.len(), 2);
            assert_eq!(records[0]["at"], 50);
            assert_eq!(records[0]["numericCode"], 42);
            assert!(records[0].get("private").is_none());
            let record = &records[1];
            assert_eq!(record["schema"], "dant.native-speech.v1");
            assert_eq!(record["at"], 100);
            assert_eq!(record["mode"], "speak");
            assert_eq!(record["language"], "en");
            assert_eq!(
                record["status"],
                if outcome.is_ok() {
                    "completed"
                } else {
                    "failed"
                }
            );
            assert!(!stored.contains("previous metadata"));
        } else {
            assert!(result.is_err());
            assert!(!stored.contains("\"at\":100"));
        }
        assert!(fs::read_dir(root.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".native-speech-")));
    }
}
#[test]
fn diagnostics_reject_hardlinks_symlinks_and_oversize_without_affecting_result() {
    let directory = fixture();
    let original = directory.path().join("original");
    let linked_file = directory.path().join("linked");
    fs::write(&original, b"preserve").unwrap();
    fs::hard_link(&original, &linked_file).unwrap();
    let outcome = Err(failed("speech-output-unavailable", "speak-output"));
    assert!(append_diagnostic(&linked_file, "speak", "zh", &outcome, 100).is_err());
    assert_eq!(fs::read(&original).unwrap(), b"preserve");
    #[cfg(windows)]
    {
        use std::os::windows::fs::symlink_file;
        if symlink_file(&original, directory.path().join("symlink")).is_ok() {
            assert!(append_diagnostic(
                &directory.path().join("symlink"),
                "speak",
                "zh",
                &outcome,
                100
            )
            .is_err());
        }
    }
    let oversized = directory.path().join("oversized");
    fs::write(&oversized, vec![b'a'; 65537]).unwrap();
    assert!(append_diagnostic(&oversized, "speak", "zh", &outcome, 100).is_err());
    assert_eq!(outcome.unwrap_err().code, "speech-output-unavailable");
}

#[test]
fn speech_system_paths_are_dynamic_and_missing_or_relative_values_never_guess_a_drive() {
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        speech_system_root(Some(root.path().to_owned()), || panic!(
            "An explicit absolute system path must retain precedence"
        ))
        .unwrap(),
        root.path()
    );
    assert_eq!(
        speech_system_root(None, || Some(root.path().to_owned())).unwrap(),
        root.path()
    );
    for configured in [
        Some(PathBuf::from("relative-system")),
        Some(PathBuf::new()),
        None,
    ] {
        let error = speech_system_root(configured, || None).unwrap_err();
        assert_eq!(error.code, "speech-unavailable");
        assert_eq!(error.phase, "process-start");
    }
    #[cfg(windows)]
    {
        let actual = windows_directory().unwrap();
        assert!(actual.is_absolute());
        assert!(actual.is_dir());
        assert_eq!(speech_system_root(None, windows_directory).unwrap(), actual);
    }
    #[cfg(not(windows))]
    assert!(windows_directory().is_none());
}

#[test]
fn diagnostic_guards_refuse_non_directories_invalid_paths_and_stale_initial_identity_before_commit()
{
    let root = fixture();
    let file = root.path().join("ordinary-file");
    fs::write(&file, b"unchanged").unwrap();
    assert!(parent_identity(&file).is_err());
    assert!(ordinary_parent(&file).is_err());
    assert!(diagnostic_target(&root.path().join("invalid\0name")).is_err());
    let oversized = root.path().join("oversized");
    fs::write(&oversized, vec![0; MAX_DIAGNOSTIC_BYTES as usize + 1]).unwrap();
    assert!(file_stamp(&fs::File::open(&oversized).unwrap()).is_err());
    let (directory, path, temporary, _) = rotation_fixture();
    let other = directory.path().join("other.jsonl");
    fs::write(&other, b"other identity").unwrap();
    let wrong = diagnostic_identity(&other).unwrap();
    let result = persist_diagnostic_with(
        &path,
        temporary,
        wrong,
        true,
        &mut |_, _| panic!("Stale identity must not reach commit"),
        &mut |_| panic!("An unstarted commit must not retry"),
    );
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    assert_eq!(fs::read(&path).unwrap(), b"previous metadata");
    assert!(append_diagnostic(
        &root.path().join("new/invalid.jsonl"),
        "unsupported",
        "en",
        &Ok(String::new()),
        1
    )
    .is_err());
    assert!(!root.path().join("new").exists());
}
#[cfg(windows)]
#[test]
fn native_file_identity_failure_on_an_owned_non_file_handle_cannot_confirm_an_inode() {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateEventW(
            security: *const std::ffi::c_void,
            manual_reset: i32,
            initial_state: i32,
            name: *const u16,
        ) -> *mut std::ffi::c_void;
    }
    // An unnamed, unsignalled event belongs only to this test. Safe File's
    // OwnedHandle conversion lets the native information API reject its type.
    let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
    assert!(!event.is_null());
    let file = fs::File::from(unsafe { OwnedHandle::from_raw_handle(event) });
    assert!(file_information(&file).is_err());
    assert!(!one_link(&file));
}
