use super::*;

pub(super) struct PreparedChildFixture {
    failure: &'static str,
    events: Rc<RefCell<Vec<String>>>,
    folder: PathBuf,
}
impl PreparedChild for PreparedChildFixture {
    fn exited(&mut self) -> Result<bool, String> {
        self.events.borrow_mut().push("poll-helper".into());
        if self.failure == "helper-unknown" {
            return Err(FAILED.into());
        }
        if self.failure == "late-ready" {
            let job = updates::json_file(&self.folder.join("job.json"), 16384).unwrap();
            updates::write_json(
                &self.folder.join("ready.json"),
                &serde_json::json!({"parent":job["parent"],"sha256":job["asset"]["sha256"]}),
            )
            .unwrap();
        }
        Ok(self.failure == "helper-exited")
    }
}
impl PreparationHost for HandoffFixture {
    type Child = PreparedChildFixture;
    fn installed_bundle(&self) -> bool {
        self.failure != "portable"
    }
    fn current_exe(&self) -> Result<PathBuf, String> {
        Ok(self.app.clone())
    }
    fn local_data(&self) -> Result<PathBuf, String> {
        Ok(self.local.clone())
    }
    fn parent_id(&self) -> u32 {
        11
    }
    fn created(&self, pid: u32) -> Result<u64, String> {
        match pid {
            11 => Ok(111),
            22 => Ok(222),
            _ => Err(FAILED.into()),
        }
    }
    fn spawn(&self, command: &mut Command) -> Result<Self::Child, String> {
        self.events.borrow_mut().push("spawn-helper".into());
        let folder = command.get_current_dir().unwrap().to_path_buf();
        *self.prepared_folder.borrow_mut() = Some(folder.clone());
        assert_eq!(command.get_program(), folder.join("dant-update-helper.exe"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [std::ffi::OsStr::new("--dant-update-helper")]
        );
        assert_eq!(
            fs::read(command.get_program()).unwrap(),
            fs::read(&self.app).unwrap()
        );
        let job = updates::json_file(&folder.join("job.json"), 16384).unwrap();
        assert_eq!(job["parent"], 11);
        assert_eq!(job["parentCreated"], 111);
        assert_eq!(job["controller"], 22);
        assert_eq!(job["controllerCreated"], 222);
        assert_eq!(job["asset"]["sha256"], self.asset.sha256);
        assert_eq!(
            updates::json_file(&folder.join("status.json"), 1024).unwrap()["status"],
            "waiting"
        );
        if self.failure == "helper-spawn" {
            return Err(FAILED.into());
        }
        if matches!(self.failure, "" | "ready-parent" | "ready-hash") {
            updates::write_json(&folder.join("ready.json"), &serde_json::json!({"parent": if self.failure == "ready-parent" { 12 } else { 11 },"sha256": if self.failure == "ready-hash" { "b".repeat(64) } else { self.asset.sha256.clone() }})).unwrap();
        }
        Ok(PreparedChildFixture {
            failure: self.failure,
            events: Rc::clone(&self.events),
            folder,
        })
    }
    fn now(&self) -> Instant {
        self.clock.get()
    }
    fn wait(&self, duration: Duration) {
        assert_eq!(duration, HELPER_READY_POLL_INTERVAL);
        self.events.borrow_mut().push("wait-helper".into());
        self.clock.set(self.clock.get() + Duration::from_secs(4));
    }
}

#[test]
fn preparing_a_helper_captures_exact_process_creation_times_and_requires_its_matching_readiness() {
    for failure in ["", "late-ready"] {
        let fixture = HandoffFixture::new(failure);
        let root = fixture.installer.parent().unwrap().parent().unwrap();
        let folder = prepare_with(&fixture, root, &fixture.installer, &fixture.asset, 22).unwrap();
        assert_eq!(folder, fixture.prepared_folder.borrow().clone().unwrap());
        assert!(!folder.join("cancel.json").exists());
        assert!(
            !folder.join("go.json").exists(),
            "Readiness never grants installation authorization"
        );
        assert!(!fixture
            .events
            .borrow()
            .iter()
            .any(|event| event == "install" || event == "restart"));
        assert_eq!(fixture.events.borrow()[0], "spawn-helper");
    }
}

#[test]
fn uncertain_or_wrong_helper_readiness_retains_the_job_and_writes_cancellation_without_replaying_spawn(
) {
    for failure in [
        "ready-parent",
        "ready-hash",
        "timeout",
        "helper-exited",
        "helper-unknown",
        "helper-spawn",
    ] {
        let fixture = HandoffFixture::new(failure);
        let root = fixture.installer.parent().unwrap().parent().unwrap();
        assert!(
            prepare_with(&fixture, root, &fixture.installer, &fixture.asset, 22).is_err(),
            "{failure}"
        );
        let folder = fixture.prepared_folder.borrow().clone().unwrap();
        assert_eq!(
            updates::json_file(&folder.join("cancel.json"), 1024).unwrap(),
            true
        );
        assert!(folder.join("job.json").is_file());
        assert!(!folder.join("go.json").exists());
        assert_eq!(
            fixture
                .events
                .borrow()
                .iter()
                .filter(|event| event.as_str() == "spawn-helper")
                .count(),
            1
        );
    }
}

#[test]
fn helper_preparation_rejects_portable_layout_bad_payload_missing_process_and_missing_destination_before_spawn(
) {
    for failure in [
        "portable",
        "bad-payload",
        "bad-version",
        "bad-process",
        "missing-root",
    ] {
        let fixture = HandoffFixture::new(failure);
        let root = fixture.installer.parent().unwrap().parent().unwrap();
        if failure == "bad-payload" {
            fs::write(&fixture.installer, b"changed").unwrap();
        }
        if failure == "bad-version" {
            fs::write(fixture.manifest(), b"{\"version\":\"0.1.0\"}").unwrap();
        }
        let destination = if failure == "missing-root" {
            root.join("missing")
        } else {
            root.to_path_buf()
        };
        assert!(
            prepare_with(
                &fixture,
                &destination,
                &fixture.installer,
                &fixture.asset,
                if failure == "bad-process" { 0 } else { 22 }
            )
            .is_err(),
            "{failure}"
        );
        assert!(fixture.prepared_folder.borrow().is_none());
        assert!(fixture.events.borrow().is_empty());
    }
}

#[test]
fn native_helper_boundaries_capture_process_identity_and_run_only_the_joined_synthetic_marker() {
    let native = NativeHelper;
    assert!(HelperHost::current_exe(&native).unwrap().is_absolute());
    assert!(HelperHost::local_data(&native).unwrap().is_absolute());
    assert!(PreparationHost::current_exe(&native).unwrap().is_absolute());
    assert!(PreparationHost::local_data(&native).unwrap().is_absolute());
    assert_eq!(PreparationHost::parent_id(&native), std::process::id());
    let created = PreparationHost::created(&native, std::process::id()).unwrap();
    let identity = HelperHost::process(&native, std::process::id(), created).unwrap();
    assert!(HelperProcess::wait(&identity, &|| true).is_err());
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("synthetic.exe");
    fs::write(&app, b"synthetic fence target, never launched").unwrap();
    let fence = HelperHost::fence(&native, &app).unwrap();
    assert!(process::fenced(&app));
    drop(fence);
    assert!(!process::fenced(&app));
    assert!(HelperHost::app_running(&native, &std::env::current_exe().unwrap()).unwrap());
    let before = Instant::now();
    assert!(PreparationHost::now(&native) >= before);
    PreparationHost::wait(&native, Duration::ZERO);
    let marker = || {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .arg("--list")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(crate::runtime::CREATE_NO_WINDOW);
        command
    };
    assert!(HelperHost::install(&native, &mut marker()).unwrap());
    let mut child = PreparationHost::spawn(&native, &mut marker()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !PreparedChild::exited(&mut child).unwrap() {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert!(child.wait().unwrap().success());
}
