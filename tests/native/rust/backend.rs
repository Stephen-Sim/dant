use super::*;
use std::{io::Read, time::Instant};

const FIXTURE_MODE: &str = "DANT_SYNTHETIC_BACKEND_FIXTURE";

fn fixture(mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "backend::tests::synthetic_backend_child",
            "--nocapture",
        ])
        .env(FIXTURE_MODE, mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

#[test]
fn synthetic_backend_child() {
    let Ok(mode) = std::env::var(FIXTURE_MODE) else {
        return;
    };
    if mode == "exited" {
        return;
    }
    if mode == "oversized" {
        println!("{}", "x".repeat(MAX_OUTPUT_LINE_BYTES + 1));
    } else if mode == "ready" {
        println!("unrelated diagnostic, not a readiness witness");
        println!(
            "{}",
            String::from_utf8_lossy(crate::protocol::readiness_line().as_bytes())
        );
        std::io::stdout().flush().unwrap();
    } else if mode == "foreign" {
        println!("dant listening at http://127.0.0.1:9999");
    }
    let mut discarded = Vec::new();
    std::io::stdin().read_to_end(&mut discarded).unwrap();
    if let Some(path) = std::env::var_os("DANT_SYNTHETIC_BACKEND_EXIT_RECEIPT") {
        fs::write(path, b"stdin-closed-gracefully").unwrap();
    }
}

#[test]
fn controller_command_uses_only_the_owned_core_and_exact_capture_paths() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data with spaces");
    let config = root.path().join("config");
    let log = fs::File::create(root.path().join("fixture.log")).unwrap();
    let command = controller_command(root.path(), &data, Some(&config), log);
    assert_eq!(command.get_program(), root.path().join("dant-core.exe"));
    assert_eq!(command.get_current_dir(), Some(root.path()));
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        vec![
            "--role=controller".as_ref(),
            "--root".as_ref(),
            root.path().as_os_str(),
            "--config-root".as_ref(),
            config.as_os_str()
        ]
    );
    let environment = command
        .get_envs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        environment[std::ffi::OsStr::new("DANT_DATA")],
        Some(data.as_os_str())
    );
    assert_eq!(
        environment[std::ffi::OsStr::new("DANT_MANAGED")],
        Some(std::ffi::OsStr::new("1"))
    );
    let log = fs::File::create(root.path().join("fixture-other.log")).unwrap();
    let command = controller_command(root.path(), &data, None, log);
    assert_eq!(command.get_args().count(), 3);
}

#[test]
fn startup_failure_keeps_fixed_diagnostics_and_never_launches_a_different_executable() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("private/data");
    let error = Backend::start(root.path(), &data, None)
        .err()
        .unwrap()
        .to_string();
    assert!(error.starts_with("dant backend could not start."));
    assert!(fs::read_to_string(data.join("startup.log"))
        .unwrap()
        .starts_with("Starting dant backend in "));
    let blocked = root.path().join("ordinary-file");
    fs::write(&blocked, b"preserved").unwrap();
    assert!(Backend::start(root.path(), &blocked.join("data"), None).is_err());
    assert_eq!(fs::read(&blocked).unwrap(), b"preserved");
}

#[test]
fn readiness_requires_an_exact_bounded_witness_and_every_failed_child_is_reaped() {
    for mode in ["exited", "foreign", "oversized", "silent"] {
        let started = Instant::now();
        assert!(
            start_owned(fixture(mode), Duration::from_millis(150)).is_err(),
            "{mode}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "{mode} leaked a pipe reader or process"
        );
    }
    let mut no_output = fixture("silent");
    no_output.stdout(Stdio::null());
    assert!(start_owned(no_output, Duration::from_millis(150)).is_err());
    let directory = tempfile::tempdir().unwrap();
    assert!(start_owned(
        Command::new(directory.path().join("missing.exe")),
        Duration::ZERO
    )
    .is_err());
}

#[test]
fn owned_backend_closes_stdin_and_joins_its_reader_without_replaying_or_harming_an_external_owner()
{
    let directory = tempfile::tempdir().unwrap();
    let receipt = directory.path().join("closed.json");
    let mut command = fixture("ready");
    command.env("DANT_SYNTHETIC_BACKEND_EXIT_RECEIPT", &receipt);
    let backend = start_owned(command, Duration::from_secs(2)).unwrap();
    assert!(backend
        .0
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none());
    backend.stop();
    assert!(backend.0.lock().unwrap().is_none());
    assert!(backend.1.lock().unwrap().is_none());
    assert_eq!(fs::read(&receipt).unwrap(), b"stdin-closed-gracefully");
    backend.stop();
    let external = Backend::external();
    external.stop();
    assert!(external.0.lock().unwrap().is_none());
}

#[test]
fn poisoned_ownership_bookkeeping_does_not_panic_during_shutdown() {
    let backend = Backend::external();
    let _ = std::panic::catch_unwind(|| {
        let _guard = backend.0.lock().unwrap();
        panic!("synthetic poisoned child slot");
    });
    let _ = std::panic::catch_unwind(|| {
        let _guard = backend.1.lock().unwrap();
        panic!("synthetic poisoned reader slot");
    });
    backend.stop();
}

#[test]
fn reader_cancellation_joins_while_the_owned_pipe_writer_is_still_alive() {
    let mut child = fixture("silent").spawn().unwrap();
    let output = child.stdout.take().unwrap();
    let (sender, _) = mpsc::channel();
    let reader = OutputReader::start(output, sender);
    let started = Instant::now();
    reader.stop();
    let joined = started.elapsed();
    let writer_still_alive = child.try_wait().unwrap().is_none();
    // Always reap the synthetic process, even when an assertion below fails.
    stop_child(child, 0, Duration::ZERO);
    assert!(writer_still_alive);
    assert!(joined < Duration::from_secs(1));
}

#[test]
fn readiness_normalizes_crlf_and_ignores_repeated_or_different_announcements() {
    let (sender, receiver) = mpsc::channel();
    let mut sender = Some(sender);
    let mut wrong = b"dant listening at http://127.0.0.1:9999\r\n".to_vec();
    signal_ready(&mut wrong, &mut sender);
    assert!(receiver.try_recv().is_err());
    let mut line = crate::protocol::readiness_line().as_bytes().to_vec();
    line.extend_from_slice(b"\r\n");
    signal_ready(&mut line, &mut sender);
    assert!(receiver.try_recv().is_ok());
    let mut duplicate = crate::protocol::readiness_line().as_bytes().to_vec();
    signal_ready(&mut duplicate, &mut sender);
    assert!(sender.is_none());
    assert!(duplicate.is_empty());
}
