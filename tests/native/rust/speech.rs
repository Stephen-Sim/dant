use super::*;
use std::cell::RefCell;
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
        |file, _target| {
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
        |delay| waits.push(delay),
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
            |file, _target| {
                attempts += 1;
                Err(tempfile::PersistError {
                    error: std::io::Error::from_raw_os_error(code),
                    file,
                })
            },
            |delay| waits.push(delay),
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
            |file, _target| {
                attempts += 1;
                Err(tempfile::PersistError {
                    error: std::io::Error::from_raw_os_error(WINDOWS_SHARING_VIOLATION),
                    file,
                })
            },
            |_delay| match change {
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
        |_file, _target| panic!("A rebound parent must never reach the rename operation"),
        |_delay| panic!("Identity rejection must never be retried"),
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
