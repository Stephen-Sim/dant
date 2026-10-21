use crate::updates::{self, Asset};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
const HELPER_READY_TIMEOUT: Duration = Duration::from_secs(8);
const HELPER_READY_POLL_INTERVAL: Duration = Duration::from_millis(25);
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(60);
const PROCESS_EXIT_POLL_MILLISECONDS: u32 = 100;
const FAILED: &str =
    "The update handoff could not be prepared. The verified installer remains in the update cache.";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    asset: Asset,
    app: PathBuf,
    previous_version: String,
    parent: u32,
    parent_created: u64,
    controller: u32,
    controller_created: u64,
}
#[cfg(windows)]
mod process {
    use sha2::Digest;
    use std::ffi::c_void;
    const PROCESS_IDS_LIMIT: usize = 8192;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetProcessTimes(
            handle: *mut c_void,
            created: *mut FileTime,
            exited: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attributes: *mut c_void, owner: i32, name: *const u16) -> *mut c_void;
        fn OpenMutexW(access: u32, inherit: i32, name: *const u16) -> *mut c_void;
        fn ReleaseMutex(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
        fn QueryFullProcessImageNameW(
            handle: *mut c_void,
            flags: u32,
            name: *mut u16,
            length: *mut u32,
        ) -> i32;
    }
    #[link(name = "psapi")]
    extern "system" {
        fn EnumProcesses(values: *mut u32, bytes: u32, needed: *mut u32) -> i32;
    }
    fn fence_name(app: &std::path::Path) -> Result<Vec<u16>, String> {
        let canonical = app.canonicalize().map_err(|_| super::FAILED)?;
        let hash = format!(
            "{:x}",
            super::Sha256::digest(
                crate::runtime_path(canonical)
                    .to_string_lossy()
                    .to_lowercase()
                    .as_bytes()
            )
        );
        Ok(format!("Local\\dant-update-{hash}")
            .encode_utf16()
            .chain(Some(0))
            .collect())
    }
    pub struct Fence(*mut c_void);
    impl Drop for Fence {
        fn drop(&mut self) {
            unsafe {
                ReleaseMutex(self.0);
                CloseHandle(self.0);
            }
        }
    }
    impl Fence {
        pub fn acquire(app: &std::path::Path) -> Result<Self, String> {
            let name = fence_name(app)?;
            let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 1, name.as_ptr()) };
            if handle.is_null() {
                return Err(super::FAILED.into());
            }
            if unsafe { GetLastError() } == 183 {
                unsafe {
                    CloseHandle(handle);
                }
                return Err(super::FAILED.into());
            }
            Ok(Self(handle))
        }
    }
    pub fn fenced(app: &std::path::Path) -> bool {
        let Ok(name) = fence_name(app) else {
            return false;
        };
        let handle = unsafe { OpenMutexW(0x00100000, 0, name.as_ptr()) };
        if handle.is_null() {
            return false;
        }
        unsafe {
            CloseHandle(handle);
        }
        true
    }
    pub fn app_running(app: &std::path::Path) -> Result<bool, String> {
        let mut values = [0u32; PROCESS_IDS_LIMIT];
        let mut needed = 0;
        let result = unsafe {
            EnumProcesses(
                values.as_mut_ptr(),
                std::mem::size_of_val(&values) as u32,
                &mut needed,
            )
        };
        let count = process_count(result, needed, std::mem::size_of_val(&values))?;
        let expected = crate::runtime_path(app.canonicalize().map_err(|_| super::FAILED)?)
            .to_string_lossy()
            .to_lowercase();
        for pid in values.into_iter().take(count) {
            if let Ok(handle) = Handle::open(pid) {
                let mut name = [0u16; 32768];
                let mut length = name.len() as u32;
                if unsafe {
                    QueryFullProcessImageNameW(handle.0, 0, name.as_mut_ptr(), &mut length)
                } != 0
                    && crate::runtime_path(std::path::PathBuf::from(String::from_utf16_lossy(
                        &name[..length as usize],
                    )))
                    .to_string_lossy()
                    .to_lowercase()
                        == expected
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    pub(super) fn process_count(
        result: i32,
        needed: u32,
        capacity_bytes: usize,
    ) -> Result<usize, String> {
        if result == 0 || needed as usize >= capacity_bytes {
            return Err(super::FAILED.into());
        }
        Ok(needed as usize / std::mem::size_of::<u32>())
    }
    pub(super) fn wait_status(status: u32) -> Result<bool, String> {
        match status {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(super::FAILED.into()),
        }
    }
    pub struct Handle(*mut c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    impl Handle {
        pub fn open(pid: u32) -> Result<Self, String> {
            let value = unsafe { OpenProcess(0x00100000 | 0x1000, 0, pid) };
            if value.is_null() {
                return Err(super::FAILED.into());
            }
            Ok(Self(value))
        }
        pub fn created(&self) -> Result<u64, String> {
            let (mut created, mut exited, mut kernel, mut user) = (
                FileTime::default(),
                FileTime::default(),
                FileTime::default(),
                FileTime::default(),
            );
            if unsafe { GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user) }
                == 0
            {
                return Err(super::FAILED.into());
            }
            Ok((created.high as u64) << 32 | created.low as u64)
        }
        pub fn exact(pid: u32, created: u64) -> Result<Self, String> {
            let handle = Self::open(pid)?;
            if handle.created()? != created {
                return Err(super::FAILED.into());
            }
            Ok(handle)
        }
        pub fn wait(&self, cancelled: impl Fn() -> bool) -> Result<(), String> {
            self.wait_until(super::PROCESS_EXIT_TIMEOUT, cancelled)
        }
        pub(super) fn wait_until(
            &self,
            timeout: super::Duration,
            cancelled: impl Fn() -> bool,
        ) -> Result<(), String> {
            let started = std::time::Instant::now();
            while started.elapsed() < timeout {
                if cancelled() {
                    return Err(super::FAILED.into());
                }
                if wait_status(unsafe {
                    WaitForSingleObject(self.0, super::PROCESS_EXIT_POLL_MILLISECONDS)
                })? {
                    return Ok(());
                }
            }
            Err(super::FAILED.into())
        }
    }
}
fn status(folder: &Path, value: &str, reason: Option<&str>) {
    let _ = updates::write_json(
        &folder.join("status.json"),
        &serde_json::json!({"status":value,"reason":reason}),
    );
}
fn default_install_path(app: &Path, local: &Path) -> bool {
    if !app.is_absolute() || !local.is_absolute() {
        return false;
    }
    let app = crate::runtime_path(app.to_path_buf());
    let expected = crate::runtime_path(local.join("dant").join("dant.exe"));
    app.components()
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .eq(expected
            .components()
            .map(|part| part.as_os_str().to_string_lossy().to_lowercase()))
}
fn default_install_location(app: &Path) -> bool {
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return false;
    };
    default_install_location_at(app, &local)
}
fn default_install_location_at(app: &Path, local: &Path) -> bool {
    if !default_install_path(app, local)
        || updates::directory(local, false).is_err()
        || updates::directory(app.parent().unwrap_or(Path::new("")), false).is_err()
        || !fs::symlink_metadata(app).is_ok_and(|meta| meta.is_file() && !updates::linked(&meta))
    {
        return false;
    }
    match (app.canonicalize(), local.canonicalize()) {
        (Ok(app), Ok(local)) => default_install_path(&app, &local),
        _ => false,
    }
}
fn installed_version(app: &Path, expected: &str) -> bool {
    default_install_location(app) && manifest_version(app, expected)
}
fn installed_version_at(app: &Path, expected: &str, local: &Path) -> bool {
    default_install_location_at(app, local) && manifest_version(app, expected)
}
fn manifest_version(app: &Path, expected: &str) -> bool {
    updates::json_file(
        &app.parent().unwrap().join("backend/package.json"),
        128 * 1024,
    )
    .is_ok_and(|value| value.get("version").and_then(|v| v.as_str()) == Some(expected))
}
pub fn supported_layout() -> bool {
    tauri::utils::platform::bundle_type() == Some(tauri::utils::config::BundleType::Nsis)
        && std::env::current_exe().is_ok_and(|path| {
            installed_version(&crate::runtime_path(path), env!("CARGO_PKG_VERSION"))
        })
}
fn authorized(folder: &Path, hash: &str) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis() as u64)
        .unwrap_or(u64::MAX);
    !folder.join("cancel.json").exists()
        && updates::json_file(&folder.join("go.json"), 4096).is_ok_and(|value| {
            value.get("authorized").and_then(|v| v.as_bool()) == Some(true)
                && value.get("sha256").and_then(|v| v.as_str()) == Some(hash)
                && value
                    .get("expiresAt")
                    .and_then(|v| v.as_u64())
                    .is_some_and(|value| {
                        value > now
                            && value
                                <= now.saturating_add(updates::EXIT_AUTHORIZATION_MAX_LIFETIME_MS)
                    })
                && value
                    .get("leaseId")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| {
                        v.len() == 36 && v.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
                    })
        })
}
fn phases(
    mut wait_parent: impl FnMut() -> Result<(), String>,
    mut wait_controller: impl FnMut() -> Result<(), String>,
    mut verify: impl FnMut() -> Result<(), String>,
    mut install: impl FnMut() -> Result<bool, String>,
    mut restart: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    wait_parent()?;
    wait_controller()?;
    verify()?;
    if !install()? {
        return Err(FAILED.into());
    }
    restart()
}
#[cfg(windows)]
fn failure_notice(sink: &dyn crate::native_dialog::MessageSink) {
    crate::native_dialog::error(
        sink,
        "dant update / 更新",
        concat!(
            "The dant update was not confirmed. Work and VM suspension records were preserved. ",
            "Open dant to restore its VM connection, or install the retained release package again.\n\n",
            "dant 更新未获确认，已保留任务和虚拟机挂起记录。请打开 dant 恢复虚拟机连接，或重新运行保留的安装包。",
        ),
    );
}
pub fn startup_fenced() -> bool {
    #[cfg(windows)]
    {
        return std::env::current_exe().is_ok_and(|app| process::fenced(&app));
    }
    #[cfg(not(windows))]
    false
}

#[cfg(windows)]
trait PreparedChild {
    fn exited(&mut self) -> Result<bool, String>;
}
#[cfg(windows)]
impl PreparedChild for std::process::Child {
    fn exited(&mut self) -> Result<bool, String> {
        self.try_wait()
            .map(|status| status.is_some())
            .map_err(|_| FAILED.into())
    }
}
#[cfg(windows)]
trait PreparationHost {
    type Child: PreparedChild;
    fn installed_bundle(&self) -> bool;
    fn current_exe(&self) -> Result<PathBuf, String>;
    fn local_data(&self) -> Result<PathBuf, String>;
    fn parent_id(&self) -> u32;
    fn created(&self, pid: u32) -> Result<u64, String>;
    fn spawn(&self, command: &mut Command) -> Result<Self::Child, String>;
    fn now(&self) -> Instant;
    fn wait(&self, duration: Duration);
}
#[cfg(windows)]
impl PreparationHost for NativeHelper {
    type Child = std::process::Child;
    fn installed_bundle(&self) -> bool {
        tauri::utils::platform::bundle_type() == Some(tauri::utils::config::BundleType::Nsis)
    }
    fn current_exe(&self) -> Result<PathBuf, String> {
        HelperHost::current_exe(self)
    }
    fn local_data(&self) -> Result<PathBuf, String> {
        HelperHost::local_data(self)
    }
    fn parent_id(&self) -> u32 {
        std::process::id()
    }
    fn created(&self, pid: u32) -> Result<u64, String> {
        process::Handle::open(pid)?.created()
    }
    fn spawn(&self, command: &mut Command) -> Result<Self::Child, String> {
        command.spawn().map_err(|_| FAILED.into())
    }
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn wait(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}
#[cfg(windows)]
pub fn prepare(
    root: &Path,
    installer: &Path,
    asset: &Asset,
    controller: u32,
) -> Result<PathBuf, String> {
    prepare_with(&NativeHelper, root, installer, asset, controller)
}
#[cfg(windows)]
fn prepare_with(
    host: &impl PreparationHost,
    root: &Path,
    installer: &Path,
    asset: &Asset,
    controller: u32,
) -> Result<PathBuf, String> {
    if !host.installed_bundle() {
        return Err("Automatic installation requires an installed NSIS version of dant.".into());
    }
    updates::verify_file(installer, asset)?;
    let app = crate::runtime_path(host.current_exe()?);
    if !installed_version_at(&app, env!("CARGO_PKG_VERSION"), &host.local_data()?) {
        return Err(FAILED.into());
    }
    let parent = host.parent_id();
    let job = Job {
        asset: asset.clone(),
        app: app.clone(),
        previous_version: env!("CARGO_PKG_VERSION").into(),
        parent,
        parent_created: host.created(parent)?,
        controller,
        controller_created: host.created(controller)?,
    };
    let folder = tempfile::Builder::new()
        .prefix("handoff-")
        .tempdir_in(root)
        .map_err(|_| FAILED)?
        .keep();
    let helper = folder.join("dant-update-helper.exe");
    fs::copy(&app, &helper).map_err(|_| FAILED)?;
    updates::write_json(&folder.join("job.json"), &job)?;
    status(&folder, "waiting", None);
    let mut command = Command::new(helper);
    command
        .arg("--dant-update-helper")
        .current_dir(&folder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(crate::runtime::CREATE_NO_WINDOW);
    let mut child = match host.spawn(&mut command) {
        Ok(child) => child,
        Err(_) => {
            let _ = updates::write_json(&folder.join("cancel.json"), &true);
            return Err(FAILED.into());
        }
    };
    let ready = wait_for_helper_ready(
        &folder,
        parent,
        &asset.sha256,
        &mut child,
        &mut || host.now(),
        &mut |duration| host.wait(duration),
    );
    if matches!(ready, Ok(true)) {
        return Ok(folder);
    }
    let _ = updates::write_json(&folder.join("cancel.json"), &true);
    Err(FAILED.into())
}

#[cfg(windows)]
fn wait_for_helper_ready(
    folder: &Path,
    parent: u32,
    sha256: &str,
    child: &mut dyn PreparedChild,
    now: &mut dyn FnMut() -> Instant,
    wait: &mut dyn FnMut(Duration),
) -> Result<bool, String> {
    let started = now();
    while now().duration_since(started) < HELPER_READY_TIMEOUT {
        if updates::json_file(&folder.join("ready.json"), 1024).is_ok_and(|value| {
            value.get("parent").and_then(|v| v.as_u64()) == Some(parent as u64)
                && value.get("sha256").and_then(|v| v.as_str()) == Some(sha256)
        }) {
            return Ok(true);
        }
        if child.exited()? {
            break;
        }
        wait(HELPER_READY_POLL_INTERVAL);
    }
    Ok(false)
}

#[cfg(not(windows))]
pub fn prepare(_: &Path, _: &Path, _: &Asset, _: u32) -> Result<PathBuf, String> {
    Err(FAILED.into())
}

#[cfg(windows)]
fn installer_command(installer: &Path, directory: &Path) -> Command {
    let mut target = std::ffi::OsString::from("/D=");
    target.push(directory.as_os_str());
    let mut command = Command::new(installer);
    // NSIS consumes an unquoted /D= remainder as its directory override. It must
    // remain the final argument, even when this fixed validated path has spaces.
    command
        .args(["/S", "/UPDATE"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(crate::runtime::CREATE_NO_WINDOW)
        .raw_arg(target);
    command
}
#[cfg(windows)]
trait HelperProcess {
    fn wait(&self, cancelled: &dyn Fn() -> bool) -> Result<(), String>;
}
#[cfg(windows)]
impl HelperProcess for process::Handle {
    fn wait(&self, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
        self.wait(cancelled)
    }
}
#[cfg(windows)]
trait HelperHost {
    type Process: HelperProcess;
    type Fence;
    fn current_exe(&self) -> Result<PathBuf, String>;
    fn local_data(&self) -> Result<PathBuf, String>;
    fn process(&self, pid: u32, created: u64) -> Result<Self::Process, String>;
    fn fence(&self, app: &Path) -> Result<Self::Fence, String>;
    fn app_running(&self, app: &Path) -> Result<bool, String>;
    fn install(&self, command: &mut Command) -> Result<bool, String>;
    fn restart(&self, command: &mut Command) -> Result<(), String>;
    fn failure_notice(&self);
}
#[cfg(windows)]
struct NativeHelper;
#[cfg(windows)]
impl HelperHost for NativeHelper {
    type Process = process::Handle;
    type Fence = process::Fence;
    fn current_exe(&self) -> Result<PathBuf, String> {
        std::env::current_exe().map_err(|_| FAILED.into())
    }
    fn local_data(&self) -> Result<PathBuf, String> {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| FAILED.into())
    }
    fn process(&self, pid: u32, created: u64) -> Result<Self::Process, String> {
        process::Handle::exact(pid, created)
    }
    fn fence(&self, app: &Path) -> Result<Self::Fence, String> {
        process::Fence::acquire(app)
    }
    fn app_running(&self, app: &Path) -> Result<bool, String> {
        process::app_running(app)
    }
    fn install(&self, command: &mut Command) -> Result<bool, String> {
        command
            .status()
            .map(|status| status.success())
            .map_err(|_| FAILED.into())
    }
    fn restart(&self, command: &mut Command) -> Result<(), String> {
        command.spawn().map(|_| ()).map_err(|_| FAILED.into())
    }
    fn failure_notice(&self) {
        failure_notice(&crate::native_dialog::NativeDialog);
    }
}
#[cfg(windows)]
fn run() -> Result<(), String> {
    run_with(&NativeHelper)
}

#[cfg(windows)]
fn run_with(host: &impl HelperHost) -> Result<(), String> {
    let helper = crate::runtime_path(host.current_exe()?);
    let folder = helper.parent().ok_or(FAILED)?;
    if helper.file_name().and_then(|v| v.to_str()) != Some("dant-update-helper.exe")
        || !folder
            .file_name()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.starts_with("handoff-") && v.len() < 80)
    {
        return Err(FAILED.into());
    }
    updates::directory(folder, false)?;
    let root = folder.parent().ok_or(FAILED)?;
    let local = host.local_data()?;
    let expected = local.join("com.dant.desktop/updates");
    if root.canonicalize().map_err(|_| FAILED)? != expected.canonicalize().map_err(|_| FAILED)? {
        return Err(FAILED.into());
    }
    let job: Job = serde_json::from_value(updates::json_file(&folder.join("job.json"), 16384)?)
        .map_err(|_| FAILED)?;
    if !updates::valid_asset(&job.asset)
        || job.parent == 0
        || job.controller == 0
        || job.parent == job.controller
        || !job.app.is_absolute()
        || !installed_version_at(&job.app, &job.previous_version, &local)
    {
        return Err(FAILED.into());
    }
    let mut fence = Some(host.fence(&job.app)?);
    let parent = host.process(job.parent, job.parent_created)?;
    let controller = host.process(job.controller, job.controller_created)?;
    let installer = root.join(&job.asset.sha256).join(&job.asset.name);
    updates::verify_file(&installer, &job.asset)?;
    updates::write_json(
        &folder.join("ready.json"),
        &serde_json::json!({"parent":job.parent,"sha256":job.asset.sha256}),
    )?;
    let originals_exited = std::cell::Cell::new(false);
    let result = phases(
        || parent.wait(&|| folder.join("cancel.json").exists()),
        || {
            controller.wait(&|| folder.join("cancel.json").exists())?;
            originals_exited.set(true);
            Ok(())
        },
        || {
            if !installed_version_at(&job.app, &job.previous_version, &local)
                || !authorized(folder, &job.asset.sha256)
                || host.app_running(&job.app)?
            {
                return Err(FAILED.into());
            }
            updates::verify_file(&installer, &job.asset)
        },
        || {
            if !default_install_location_at(&job.app, &local) {
                return Err(FAILED.into());
            }
            let directory = crate::runtime_path(
                job.app
                    .parent()
                    .ok_or(FAILED)?
                    .canonicalize()
                    .map_err(|_| FAILED)?,
            );
            status(folder, "installing", None);
            host.install(&mut installer_command(&installer, &directory))
        },
        || {
            if !installed_version_at(&job.app, &job.asset.version, &local) {
                return Err(FAILED.into());
            }
            drop(fence.take());
            let mut command = Command::new(&job.app);
            command
                .current_dir(job.app.parent().ok_or(FAILED)?)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(crate::runtime::CREATE_NO_WINDOW);
            host.restart(&mut command)
        },
    );
    match result {
        Ok(()) => {
            status(folder, "installed", None);
            Ok(())
        }
        Err(error) => {
            status(
                folder,
                "failed",
                Some("Installation was not confirmed. The verified installer was retained."),
            );
            drop(fence.take());
            if originals_exited.get() {
                host.failure_notice();
            }
            Err(error)
        }
    }
}
pub fn run_helper_mode() -> bool {
    helper_mode(std::env::args_os(), || {
        #[cfg(windows)]
        {
            let _ = run();
        }
    })
}
fn helper_mode(args: impl IntoIterator<Item = std::ffi::OsString>, execute: impl FnOnce()) -> bool {
    let args: Vec<_> = args.into_iter().collect();
    if !args
        .iter()
        .skip(1)
        .any(|value| value == "--dant-update-helper")
    {
        return false;
    }
    if args.len() == 2 {
        execute();
    }
    true
}

#[cfg(test)]
#[path = "../../tests/native/rust/update_helper.rs"]
mod tests;
