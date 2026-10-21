use super::super::*;
use sha2::Digest;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
#[path = "update_preparation.rs"]
mod preparation;

struct ProcessFixture {
    phase: &'static str,
    failure: &'static str,
    events: Rc<RefCell<Vec<String>>>,
    folder: PathBuf,
    manifest: PathBuf,
    installer: PathBuf,
}
impl HelperProcess for ProcessFixture {
    fn wait(&self, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
        self.events.borrow_mut().push(self.phase.into());
        if cancelled() || self.failure == self.phase {
            return Err(FAILED.into());
        }
        if self.phase == "wait-controller" {
            match self.failure {
                "changed-version" => fs::write(&self.manifest, b"{\"version\":\"0.1.0\"}").unwrap(),
                "corrupt-installer" => fs::write(&self.installer, b"changed payload").unwrap(),
                "late-cancel" => fs::write(self.folder.join("cancel.json"), b"true").unwrap(),
                _ => {}
            }
        }
        Ok(())
    }
}
struct FenceFixture(Rc<RefCell<Vec<String>>>);
impl Drop for FenceFixture {
    fn drop(&mut self) {
        self.0.borrow_mut().push("fence-released".into());
    }
}
struct HandoffFixture {
    _root: tempfile::TempDir,
    local: PathBuf,
    helper: PathBuf,
    folder: PathBuf,
    app: PathBuf,
    installer: PathBuf,
    asset: Asset,
    events: Rc<RefCell<Vec<String>>>,
    failure: &'static str,
    clock: Cell<Instant>,
    prepared_folder: RefCell<Option<PathBuf>>,
}
impl HandoffFixture {
    fn new(failure: &'static str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let local = root.path().join("Synthetic Local");
        let cache = local.join("com.dant.desktop/updates");
        let folder = cache.join("handoff-fixture");
        let helper = folder.join("dant-update-helper.exe");
        let app = local.join("dant/dant.exe");
        fs::create_dir_all(app.parent().unwrap().join("backend")).unwrap();
        fs::create_dir_all(&folder).unwrap();
        fs::write(&helper, b"synthetic helper, never launched").unwrap();
        fs::write(&app, b"synthetic app, never launched").unwrap();
        let payload = b"verified synthetic installer";
        let asset = Asset {
            version: "0.5.0-beta.2".into(), channel: "beta".into(),
            url: "https://github.com/Stephen-Sim/dant/releases/download/v0.5.0-beta.2/dant_0.5.0-beta.2_windows_x64_setup.exe".into(),
            sha256: format!("{:x}", Sha256::digest(payload)), size: payload.len() as u64,
            name: "dant_0.5.0-beta.2_windows_x64_setup.exe".into(),
        };
        let installer = cache.join(&asset.sha256).join(&asset.name);
        fs::create_dir_all(installer.parent().unwrap()).unwrap();
        fs::write(&installer, payload).unwrap();
        updates::write_json(
            &app.parent().unwrap().join("backend/package.json"),
            &serde_json::json!({"version":env!("CARGO_PKG_VERSION")}),
        )
        .unwrap();
        updates::write_json(
            &folder.join("job.json"),
            &Job {
                asset: asset.clone(),
                app: app.clone(),
                previous_version: env!("CARGO_PKG_VERSION").into(),
                parent: 11,
                parent_created: 111,
                controller: 22,
                controller_created: 222,
            },
        )
        .unwrap();
        let expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 30_000;
        updates::write_json(&folder.join("go.json"), &serde_json::json!({"authorized":true,"sha256":asset.sha256,"leaseId":"11111111-1111-1111-1111-111111111111","expiresAt":expires})).unwrap();
        Self {
            _root: root,
            local,
            helper,
            folder,
            app,
            installer,
            asset,
            events: Rc::default(),
            failure,
            clock: Cell::new(Instant::now()),
            prepared_folder: RefCell::new(None),
        }
    }
    fn manifest(&self) -> PathBuf {
        self.app.parent().unwrap().join("backend/package.json")
    }
    fn status(&self) -> serde_json::Value {
        updates::json_file(&self.folder.join("status.json"), 4096).unwrap()
    }
}
impl HelperHost for HandoffFixture {
    type Process = ProcessFixture;
    type Fence = FenceFixture;
    fn current_exe(&self) -> Result<PathBuf, String> {
        Ok(self.helper.clone())
    }
    fn local_data(&self) -> Result<PathBuf, String> {
        Ok(self.local.clone())
    }
    fn process(&self, pid: u32, created: u64) -> Result<Self::Process, String> {
        let phase = match (pid, created) {
            (11, 111) => "wait-parent",
            (22, 222) => "wait-controller",
            _ => return Err(FAILED.into()),
        };
        self.events.borrow_mut().push(format!("identity-{pid}"));
        Ok(ProcessFixture {
            phase,
            failure: self.failure,
            events: Rc::clone(&self.events),
            folder: self.folder.clone(),
            manifest: self.manifest(),
            installer: self.installer.clone(),
        })
    }
    fn fence(&self, app: &Path) -> Result<Self::Fence, String> {
        assert_eq!(app, self.app);
        self.events.borrow_mut().push("fence".into());
        if self.failure == "fence" {
            return Err(FAILED.into());
        }
        Ok(FenceFixture(Rc::clone(&self.events)))
    }
    fn app_running(&self, app: &Path) -> Result<bool, String> {
        assert_eq!(app, self.app);
        self.events.borrow_mut().push("running".into());
        if self.failure == "running-unknown" {
            return Err(FAILED.into());
        }
        if self.failure == "late-layout" {
            fs::remove_file(app).unwrap();
            fs::create_dir(app).unwrap();
        }
        Ok(self.failure == "running")
    }
    fn install(&self, command: &mut Command) -> Result<bool, String> {
        assert_eq!(self.status()["status"], "installing");
        assert_eq!(command.get_program(), self.installer.as_os_str());
        let args: Vec<_> = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[..2], ["/S", "/UPDATE"]);
        assert_eq!(
            args[2],
            format!(
                "/D={}",
                crate::runtime_path(self.app.parent().unwrap().canonicalize().unwrap()).display()
            )
        );
        assert_eq!(args.len(), 3);
        self.events.borrow_mut().push("install".into());
        match self.failure {
            "install-unknown" => Err(FAILED.into()),
            "install-refused" => Ok(false),
            other => {
                if other != "version-unconfirmed" {
                    updates::write_json(
                        &self.manifest(),
                        &serde_json::json!({"version":self.asset.version}),
                    )
                    .unwrap();
                }
                Ok(true)
            }
        }
    }
    fn restart(&self, command: &mut Command) -> Result<(), String> {
        assert_eq!(command.get_program(), self.app.as_os_str());
        assert_eq!(command.get_current_dir(), self.app.parent());
        assert_eq!(command.get_args().count(), 0);
        assert_eq!(self.events.borrow().last().unwrap(), "fence-released");
        self.events.borrow_mut().push("restart".into());
        if self.failure == "restart-unknown" {
            Err(FAILED.into())
        } else {
            Ok(())
        }
    }
    fn failure_notice(&self) {
        self.events.borrow_mut().push("notice".into());
    }
}

#[test]
fn verified_handoff_waits_for_exact_originals_checks_the_payload_and_releases_fence_before_restart()
{
    let fixture = HandoffFixture::new("");
    let job = fs::read(fixture.folder.join("job.json")).unwrap();
    run_with(&fixture).unwrap();
    assert_eq!(fixture.status()["status"], "installed");
    assert_eq!(
        *fixture.events.borrow(),
        [
            "fence",
            "identity-11",
            "identity-22",
            "wait-parent",
            "wait-controller",
            "running",
            "install",
            "fence-released",
            "restart"
        ]
    );
    assert_eq!(fs::read(fixture.folder.join("job.json")).unwrap(), job);
    assert_eq!(
        updates::json_file(&fixture.folder.join("ready.json"), 1024).unwrap(),
        serde_json::json!({"parent":11,"sha256":fixture.asset.sha256})
    );
    updates::verify_file(&fixture.installer, &fixture.asset).unwrap();
}

#[test]
fn failed_or_uncertain_handoff_phases_never_replay_installation_or_claim_a_restart() {
    for failure in [
        "wait-parent",
        "wait-controller",
        "changed-version",
        "corrupt-installer",
        "late-cancel",
        "running",
        "running-unknown",
        "late-layout",
        "install-refused",
        "install-unknown",
        "version-unconfirmed",
        "restart-unknown",
    ] {
        let fixture = HandoffFixture::new(failure);
        assert!(run_with(&fixture).is_err(), "{failure}");
        assert_eq!(fixture.status()["status"], "failed", "{failure}");
        let events = fixture.events.borrow();
        let installs = events
            .iter()
            .filter(|event| event.as_str() == "install")
            .count();
        assert_eq!(
            installs,
            usize::from(matches!(
                failure,
                "install-refused" | "install-unknown" | "version-unconfirmed" | "restart-unknown"
            )),
            "{failure}"
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.as_str() == "restart")
                .count(),
            usize::from(failure == "restart-unknown")
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.as_str() == "fence-released")
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.as_str() == "notice")
                .count(),
            usize::from(!matches!(failure, "wait-parent" | "wait-controller"))
        );
        assert!(
            fixture.installer.exists(),
            "Unconfirmed handoff must retain the downloaded payload"
        );
    }
}

#[test]
fn helper_rejects_changed_layout_job_identity_and_authorization_before_installation() {
    for field in [
        "parent",
        "controller",
        "parentCreated",
        "controllerCreated",
        "app",
        "asset",
        "previousVersion",
    ] {
        let fixture = HandoffFixture::new("");
        let mut job = updates::json_file(&fixture.folder.join("job.json"), 16384).unwrap();
        job[field] = match field {
            "app" => serde_json::json!("relative.exe"),
            "asset" => serde_json::json!({}),
            "previousVersion" => serde_json::json!("0.1.0"),
            _ => serde_json::json!(0),
        };
        updates::write_json(&fixture.folder.join("job.json"), &job).unwrap();
        assert!(run_with(&fixture).is_err(), "{field}");
        assert!(!fixture
            .events
            .borrow()
            .iter()
            .any(|event| event == "install"));
    }
    let fixture = HandoffFixture::new("fence");
    assert!(run_with(&fixture).is_err());
    assert_eq!(*fixture.events.borrow(), ["fence"]);
    for path in ["cancel.json", "go.json"] {
        let fixture = HandoffFixture::new("");
        if path == "cancel.json" {
            fs::write(fixture.folder.join(path), b"true").unwrap();
        } else {
            fs::remove_file(fixture.folder.join(path)).unwrap();
        }
        assert!(run_with(&fixture).is_err());
        assert!(!fixture
            .events
            .borrow()
            .iter()
            .any(|event| event == "install"));
    }
    let mut fixture = HandoffFixture::new("");
    fixture.helper = fixture.folder.join("renamed-helper.exe");
    assert!(run_with(&fixture).is_err());
    assert!(fixture.events.borrow().is_empty());
}

#[test]
fn handoff_refuses_a_foreign_valid_cache_root_and_unwritable_readiness_before_wait_or_install() {
    let mut fixture = HandoffFixture::new("");
    fixture.local = fixture._root.path().join("other-local");
    fs::create_dir_all(fixture.local.join("com.dant.desktop/updates")).unwrap();
    assert_eq!(run_with(&fixture).unwrap_err(), FAILED);
    assert!(fixture.events.borrow().is_empty());
    let fixture = HandoffFixture::new("");
    fs::create_dir(fixture.folder.join("ready.json")).unwrap();
    assert!(run_with(&fixture).is_err());
    assert!(!fixture
        .events
        .borrow()
        .iter()
        .any(|event| event.starts_with("wait") || event == "install" || event == "restart"));
    assert!(fixture.folder.join("ready.json").is_dir());
    updates::verify_file(&fixture.installer, &fixture.asset).unwrap();
}
