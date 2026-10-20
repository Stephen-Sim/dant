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
        let mut values = [0u32; 8192];
        let mut needed = 0;
        if unsafe {
            EnumProcesses(
                values.as_mut_ptr(),
                std::mem::size_of_val(&values) as u32,
                &mut needed,
            )
        } == 0
            || needed as usize >= std::mem::size_of_val(&values)
        {
            return Err(super::FAILED.into());
        }
        let expected = crate::runtime_path(app.canonicalize().map_err(|_| super::FAILED)?)
            .to_string_lossy()
            .to_lowercase();
        for pid in values.into_iter().take(needed as usize / 4) {
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
            let started = std::time::Instant::now();
            while started.elapsed() < std::time::Duration::from_secs(60) {
                if cancelled() {
                    return Err(super::FAILED.into());
                }
                match unsafe { WaitForSingleObject(self.0, 100) } {
                    0 => return Ok(()),
                    258 => {}
                    _ => return Err(super::FAILED.into()),
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
    if !default_install_path(app, &local)
        || updates::directory(&local, false).is_err()
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
    default_install_location(app)
        && updates::json_file(
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
fn failure_notice() {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            window: *mut std::ffi::c_void,
            text: *const u16,
            title: *const u16,
            kind: u32,
        ) -> i32;
    }
    let text:Vec<u16>="The dant update was not confirmed. Work and VM suspension records were preserved. Open dant to restore its VM connection, or install the retained release package again.\n\ndant 更新未获确认，已保留任务和虚拟机挂起记录。请打开 dant 恢复虚拟机连接，或重新运行保留的安装包。".encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "dant update / 更新".encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
    }
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
pub fn prepare(
    root: &Path,
    installer: &Path,
    asset: &Asset,
    controller: u32,
) -> Result<PathBuf, String> {
    if tauri::utils::platform::bundle_type() != Some(tauri::utils::config::BundleType::Nsis) {
        return Err("Automatic installation requires an installed NSIS version of dant.".into());
    }
    updates::verify_file(installer, asset)?;
    let app = crate::runtime_path(std::env::current_exe().map_err(|_| FAILED)?);
    if !installed_version(&app, env!("CARGO_PKG_VERSION")) {
        return Err(FAILED.into());
    }
    let parent = std::process::id();
    let job = Job {
        asset: asset.clone(),
        app: app.clone(),
        previous_version: env!("CARGO_PKG_VERSION").into(),
        parent,
        parent_created: process::Handle::open(parent)?.created()?,
        controller,
        controller_created: process::Handle::open(controller)?.created()?,
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
    let mut child = command.spawn().map_err(|_| FAILED)?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(8) {
        if updates::json_file(&folder.join("ready.json"), 1024).is_ok_and(|value| {
            value.get("parent").and_then(|v| v.as_u64()) == Some(parent as u64)
                && value.get("sha256").and_then(|v| v.as_str()) == Some(asset.sha256.as_str())
        }) {
            return Ok(folder);
        }
        if child.try_wait().map_err(|_| FAILED)?.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = updates::write_json(&folder.join("cancel.json"), &true);
    Err(FAILED.into())
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
fn run() -> Result<(), String> {
    let helper = crate::runtime_path(std::env::current_exe().map_err(|_| FAILED)?);
    let folder = helper.parent().ok_or(FAILED)?;
    updates::directory(folder, false)?;
    let root = folder.parent().ok_or(FAILED)?;
    let expected = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or(FAILED)?)
        .join("com.dant.desktop/updates");
    if root.canonicalize().map_err(|_| FAILED)? != expected.canonicalize().map_err(|_| FAILED)?
        || helper.file_name().and_then(|v| v.to_str()) != Some("dant-update-helper.exe")
        || !folder
            .file_name()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.starts_with("handoff-") && v.len() < 80)
    {
        return Err(FAILED.into());
    }
    let job: Job = serde_json::from_value(updates::json_file(&folder.join("job.json"), 16384)?)
        .map_err(|_| FAILED)?;
    if !updates::valid_asset(&job.asset)
        || job.parent == 0
        || job.controller == 0
        || job.parent == job.controller
        || !job.app.is_absolute()
        || !installed_version(&job.app, &job.previous_version)
    {
        return Err(FAILED.into());
    }
    let mut fence = Some(process::Fence::acquire(&job.app)?);
    let parent = process::Handle::exact(job.parent, job.parent_created)?;
    let controller = process::Handle::exact(job.controller, job.controller_created)?;
    let installer = root.join(&job.asset.sha256).join(&job.asset.name);
    updates::verify_file(&installer, &job.asset)?;
    updates::write_json(
        &folder.join("ready.json"),
        &serde_json::json!({"parent":job.parent,"sha256":job.asset.sha256}),
    )?;
    let originals_exited = std::cell::Cell::new(false);
    let result = phases(
        || parent.wait(|| folder.join("cancel.json").exists()),
        || {
            controller.wait(|| folder.join("cancel.json").exists())?;
            originals_exited.set(true);
            Ok(())
        },
        || {
            if !installed_version(&job.app, &job.previous_version)
                || !authorized(folder, &job.asset.sha256)
                || process::app_running(&job.app)?
            {
                return Err(FAILED.into());
            }
            updates::verify_file(&installer, &job.asset)
        },
        || {
            if !default_install_location(&job.app) {
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
            Ok(installer_command(&installer, &directory)
                .status()
                .map_err(|_| FAILED)?
                .success())
        },
        || {
            if !installed_version(&job.app, &job.asset.version) {
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
            command.spawn().map_err(|_| FAILED)?;
            Ok(())
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
                failure_notice();
            }
            Err(error)
        }
    }
}
pub fn run_helper_mode() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    if !args
        .iter()
        .skip(1)
        .any(|value| value == "--dant-update-helper")
    {
        return false;
    }
    if args.len() != 2 {
        return true;
    }
    #[cfg(windows)]
    {
        let _ = run();
    }
    true
}
#[cfg(test)]
#[path = "../../tests/native/rust/update_helper.rs"]
mod tests;
