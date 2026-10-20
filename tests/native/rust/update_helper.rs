use super::*;
use std::cell::RefCell;
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
