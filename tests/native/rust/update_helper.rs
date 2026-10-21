use super::*;

#[cfg(windows)]
#[test]
fn installed_location_environment_uses_only_the_private_child_configuration() {
    use std::os::windows::process::CommandExt;
    let root = tempfile::Builder::new()
        .prefix("dant-installed-environment-")
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
            "update_helper::tests::isolated_installed_environment_child",
            "--nocapture",
        ])
        .env("DANT_INSTALLED_ENVIRONMENT_FIXTURE", root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(crate::runtime::CREATE_NO_WINDOW);
    let mut child = OwnedChild(command.spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(
                status.success(),
                "The private installed-location fixture failed"
            );
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        fs::read(root.path().join("verified")).unwrap(),
        b"private layout"
    );
}

#[cfg(windows)]
#[test]
fn isolated_installed_environment_child() {
    let Some(root) = std::env::var_os("DANT_INSTALLED_ENVIRONMENT_FIXTURE").map(PathBuf::from)
    else {
        return;
    };
    assert!(root.is_absolute());
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("dant-installed-environment-"));
    assert!(root
        .canonicalize()
        .unwrap()
        .starts_with(std::env::temp_dir().canonicalize().unwrap()));
    let local = root.join("Local");
    let app = local.join("dant/dant.exe");
    fs::create_dir_all(app.parent().unwrap().join("backend")).unwrap();
    fs::write(&app, b"owned synthetic executable, never launched").unwrap();
    fs::write(
        app.parent().unwrap().join("backend/package.json"),
        br#"{"version":"0.1.0"}"#,
    )
    .unwrap();

    std::env::set_var("LOCALAPPDATA", &local);
    assert!(default_install_location(&app));
    assert!(installed_version(&app, "0.1.0"));
    assert!(!installed_version(&app, "0.1.1"));
    std::env::set_var("LOCALAPPDATA", root.join("another-user/Local"));
    assert!(!default_install_location(&app));
    assert!(!installed_version(&app, "0.1.0"));
    std::env::remove_var("LOCALAPPDATA");
    assert!(!default_install_location(&app));
    assert!(!installed_version(&app, "0.1.0"));
    assert_eq!(
        fs::read(&app).unwrap(),
        b"owned synthetic executable, never launched"
    );
    fs::write(root.join("verified"), b"private layout").unwrap();
}

#[cfg(windows)]
#[test]
fn native_process_inventory_and_wait_statuses_fail_closed_when_os_results_are_unknown_or_truncated()
{
    assert_eq!(process::process_count(1, 0, 32).unwrap(), 0);
    assert_eq!(process::process_count(1, 12, 32).unwrap(), 3);
    for (result, needed) in [(0, 0), (0, 12), (1, 32), (1, 36)] {
        assert_eq!(
            process::process_count(result, needed, 32).unwrap_err(),
            FAILED
        );
    }
    assert!(process::wait_status(0).unwrap());
    assert!(!process::wait_status(258).unwrap());
    for status in [1, 128, 259, u32::MAX] {
        assert_eq!(process::wait_status(status).unwrap_err(), FAILED);
    }
}

#[cfg(windows)]
#[test]
fn an_owned_live_process_has_a_bounded_wait_and_does_not_become_confirmed_on_timeout() {
    let process = process::Handle::open(std::process::id()).unwrap();
    let started = Instant::now();
    assert_eq!(
        process
            .wait_until(Duration::from_millis(1), || false)
            .unwrap_err(),
        FAILED
    );
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[cfg(windows)]
#[test]
fn failed_installation_notice_preserves_both_languages_and_retained_installer_instructions() {
    struct Sink(std::cell::RefCell<Vec<(String, String, u32)>>);
    impl crate::native_dialog::MessageSink for Sink {
        fn send(&self, text: &[u16], title: &[u16], kind: u32) {
            self.0.borrow_mut().push((
                String::from_utf16(&text[..text.len() - 1]).unwrap(),
                String::from_utf16(&title[..title.len() - 1]).unwrap(),
                kind,
            ));
        }
    }
    let sink = Sink(std::cell::RefCell::new(Vec::new()));
    failure_notice(&sink);
    let notices = sink.0.borrow();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].1, "dant update / 更新");
    assert_eq!(notices[0].2, 0x10);
    assert!(notices[0].0.contains("retained release package"));
    assert!(notices[0].0.contains("更新"));
}
use std::cell::RefCell;
#[cfg(windows)]
#[path = "update_handoff.rs"]
mod handoff;

#[test]
fn installed_layout_and_manifest_checks_use_the_supplied_user_root_and_real_files() {
    let root = tempfile::tempdir().unwrap();
    let local = root.path().join("Local");
    let app = local.join("dant/dant.exe");
    fs::create_dir_all(app.parent().unwrap().join("backend")).unwrap();
    assert!(!default_install_location_at(&app, &local));
    fs::create_dir(&app).unwrap();
    assert!(!default_install_location_at(&app, &local));
    fs::remove_dir(&app).unwrap();
    fs::write(&app, b"synthetic executable, never launched").unwrap();
    assert!(default_install_location_at(&app, &local));
    assert!(!manifest_version(&app, "0.1.0"));
    let manifest = app.parent().unwrap().join("backend/package.json");
    fs::write(&manifest, b"{\"version\":\"0.1.0\"}").unwrap();
    assert!(manifest_version(&app, "0.1.0"));
    assert!(!manifest_version(&app, "0.1.1"));
    fs::write(&manifest, b"{\"version\":42}").unwrap();
    assert!(!manifest_version(&app, "0.1.0"));
    assert!(!default_install_location(Path::new("relative.exe")));
    assert!(!installed_version(Path::new("relative.exe"), "0.1.0"));
}

#[test]
fn handoff_status_is_bounded_and_startup_without_the_exact_mode_does_not_run_an_installer() {
    let root = tempfile::tempdir().unwrap();
    status(root.path(), "waiting", None);
    assert_eq!(
        updates::json_file(&root.path().join("status.json"), 4096).unwrap(),
        serde_json::json!({"status":"waiting", "reason":null})
    );
    status(root.path(), "failed", Some("fixed reason"));
    assert_eq!(
        updates::json_file(&root.path().join("status.json"), 4096).unwrap()["reason"],
        "fixed reason"
    );
    status(&root.path().join("missing"), "failed", None);
    assert!(!run_helper_mode());
    assert!(!startup_fenced());
    assert!(
        !supported_layout(),
        "A test executable is never an installed NSIS app"
    );
    #[cfg(windows)]
    assert!(prepare(
        root.path(),
        &root.path().join("unverified.exe"),
        &super::updates::Asset {
            version: "0.5.0-beta.2".into(),
            channel: "beta".into(),
            url: "https://invalid.example".into(),
            sha256: "a".repeat(64),
            size: 1,
            name: "synthetic.exe".into(),
        },
        std::process::id()
    )
    .is_err());
}

#[cfg(windows)]
#[test]
fn process_waits_require_the_exact_live_identity_and_honor_cancellation() {
    assert!(process::Handle::open(0).is_err());
    assert!(process::app_running(Path::new("relative-missing.exe")).is_err());
    let current = process::Handle::open(std::process::id()).unwrap();
    assert!(current.wait(|| true).is_err());
    let mut child = Command::new(std::env::current_exe().unwrap());
    child
        .arg("--list")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(crate::runtime::CREATE_NO_WINDOW);
    let mut child = child.spawn().unwrap();
    let identity = process::Handle::open(child.id()).unwrap();
    identity.wait(|| false).unwrap();
    assert!(child.wait().unwrap().success());
    assert!(process::Fence::acquire(Path::new("relative-missing.exe")).is_err());
    assert!(!process::fenced(Path::new("relative-missing.exe")));
}
#[test]
fn automatic_install_requires_exact_default_per_user_location_not_portable_or_custom_layout() {
    let base = std::env::temp_dir().join("dant-layout-only");
    let local = base.join("current-user/AppData/Local");
    let app = local.join("dant/dant.exe");
    assert!(default_install_path(&app, &local));
    #[cfg(windows)]
    assert!(default_install_path(
        &PathBuf::from(app.to_string_lossy().to_uppercase()),
        &local
    ));
    for other in [
        base.join("portable/dant.exe"),
        local.join("custom/dant.exe"),
        local.join("dant/nested/dant.exe"),
        base.join("other-user/AppData/Local/dant/dant.exe"),
        local.join("dant2/dant.exe"),
        local.join("dant.exe"),
        local.join("dant/../dant/dant.exe"),
    ] {
        assert!(
            !default_install_path(&other, &local),
            "unsupported location must use manual installation"
        );
    }
    assert!(!default_install_path(Path::new("dant/dant.exe"), &local));
    assert!(!default_install_path(&app, Path::new("relative")));
}
#[cfg(windows)]
#[test]
fn nsis_directory_override_is_last_unquoted_and_keeps_spaces_in_the_fixed_app_path() {
    let root = std::env::temp_dir().join("test user").join("AppData/Local");
    let app = root.join("dant/dant.exe");
    assert!(default_install_path(&app, &root));
    let installer = root.join("verified-setup.exe");
    let directory = app.parent().unwrap();
    let command = installer_command(&installer, directory);
    assert_eq!(command.get_program(), installer.as_os_str());
    let args: Vec<_> = command.get_args().collect();
    let mut target = std::ffi::OsString::from("/D=");
    target.push(directory.as_os_str());
    assert_eq!(
        args,
        vec![
            std::ffi::OsStr::new("/S"),
            std::ffi::OsStr::new("/UPDATE"),
            target.as_os_str()
        ]
    );
    assert!(!args[2].to_string_lossy().contains('"'));
}
#[test]
fn installer_cannot_start_until_both_exact_process_waits_and_hash_verification_succeed() {
    let order = RefCell::new(Vec::new());
    phases(
        || {
            order.borrow_mut().push("parent-exited");
            Ok(())
        },
        || {
            order.borrow_mut().push("controller-exited");
            Ok(())
        },
        || {
            order.borrow_mut().push("hash-rechecked");
            Ok(())
        },
        || {
            order.borrow_mut().push("installer-exited");
            Ok(true)
        },
        || {
            order.borrow_mut().push("restart");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(
        *order.borrow(),
        [
            "parent-exited",
            "controller-exited",
            "hash-rechecked",
            "installer-exited",
            "restart"
        ]
    );
}
#[test]
fn unconfirmed_exit_modified_payload_and_installer_failure_never_restart_or_launch_early() {
    for stage in 0..4 {
        let ran = RefCell::new(Vec::new());
        let result = phases(
            || {
                if stage == 0 {
                    Err(FAILED.into())
                } else {
                    Ok(())
                }
            },
            || {
                if stage == 1 {
                    Err(FAILED.into())
                } else {
                    Ok(())
                }
            },
            || {
                if stage == 2 {
                    Err(FAILED.into())
                } else {
                    Ok(())
                }
            },
            || {
                ran.borrow_mut().push("installer");
                Ok(stage != 3)
            },
            || {
                ran.borrow_mut().push("restart");
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!ran.borrow().contains(&"restart"));
        if stage < 3 {
            assert!(ran.borrow().is_empty());
        }
    }
}
#[test]
fn failed_admission_never_arms_a_waiting_helper_even_if_its_cancel_file_cannot_be_written() {
    let folder = tempfile::tempdir().unwrap();
    let hash = "a".repeat(64);
    assert!(!authorized(folder.path(), &hash));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let mut go = serde_json::json!({"authorized":true,"sha256":hash,"leaseId":"11111111-1111-1111-1111-111111111111","expiresAt":now+30000});
    updates::write_json(&folder.path().join("go.json"), &go).unwrap();
    assert!(authorized(folder.path(), &hash));
    assert!(!authorized(folder.path(), &"b".repeat(64)));
    go["expiresAt"] = serde_json::json!(1);
    updates::write_json(&folder.path().join("go.json"), &go).unwrap();
    assert!(!authorized(folder.path(), &hash));
    go["expiresAt"] = serde_json::json!(now + 30000);
    updates::write_json(&folder.path().join("go.json"), &go).unwrap();
    updates::write_json(&folder.path().join("cancel.json"), &true).unwrap();
    assert!(!authorized(folder.path(), &hash));
}
#[cfg(windows)]
#[test]
fn process_identity_uses_creation_time_not_only_reusable_pid() {
    let current = process::Handle::open(std::process::id()).unwrap();
    let created = current.created().unwrap();
    assert!(process::Handle::exact(std::process::id(), created).is_ok());
    assert!(process::Handle::exact(std::process::id(), created + 1).is_err());
}
#[cfg(windows)]
#[test]
fn startup_fence_is_exact_to_installed_path_and_released_before_restart() {
    let folder = tempfile::tempdir().unwrap();
    let app = folder.path().join("dant.exe");
    let other = folder.path().join("other.exe");
    fs::write(&app, b"fake executable - never launched").unwrap();
    fs::write(&other, b"fake executable - never launched").unwrap();
    assert!(!process::fenced(&app));
    let fence = process::Fence::acquire(&app).unwrap();
    assert!(process::fenced(&app));
    assert!(!process::fenced(&other));
    assert!(process::Fence::acquire(&app).is_err());
    drop(fence);
    assert!(!process::fenced(&app));
}
#[cfg(windows)]
#[test]
fn preexisting_new_app_is_detected_without_terminating_any_process() {
    assert!(process::app_running(&std::env::current_exe().unwrap()).unwrap());
}

#[test]
fn helper_mode_never_executes_when_the_exact_sole_mode_argument_is_absent_duplicated_or_embedded() {
    for (arguments, consumed, execute) in [
        (vec![], false, false),
        (vec!["synthetic.exe"], false, false),
        (
            vec!["synthetic.exe", "--dant-update-helper-extra"],
            false,
            false,
        ),
        (vec!["--dant-update-helper"], false, false),
        (vec!["synthetic.exe", "--dant-update-helper"], true, true),
        (
            vec!["synthetic.exe", "--dant-update-helper", "extra"],
            true,
            false,
        ),
        (
            vec!["synthetic.exe", "extra", "--dant-update-helper"],
            true,
            false,
        ),
        (
            vec![
                "synthetic.exe",
                "--dant-update-helper",
                "--dant-update-helper",
            ],
            true,
            false,
        ),
    ] {
        let ran = std::cell::Cell::new(false);
        assert_eq!(
            helper_mode(arguments.into_iter().map(std::ffi::OsString::from), || {
                assert!(!ran.replace(true));
            }),
            consumed
        );
        assert_eq!(ran.get(), execute);
    }
}
#[cfg(windows)]
#[test]
fn native_helper_spawn_and_restart_refuse_missing_owned_executables_without_other_side_effects() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("never-existing.exe");
    assert!(HelperHost::install(&NativeHelper, &mut Command::new(&missing)).is_err());
    assert!(HelperHost::restart(&NativeHelper, &mut Command::new(&missing)).is_err());
    assert!(PreparationHost::spawn(&NativeHelper, &mut Command::new(&missing)).is_err());
    let app = root.path().join("synthetic-dant.exe");
    fs::write(&app, b"not executed").unwrap();
    assert!(!process::app_running(&app).unwrap());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn native_helper_entry_refuses_a_test_binary_before_accessing_any_handoff_or_install_location() {
    assert_ne!(
        std::env::current_exe().unwrap().file_name().unwrap(),
        "dant-update-helper.exe"
    );
    assert_eq!(run().unwrap_err(), FAILED);
}
