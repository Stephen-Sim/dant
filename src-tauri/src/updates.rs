use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

const FAILED: &str = "The update could not be verified. Check for updates and try again.";
const BLOCKED:&str="Installation could not confirm paused work and VM suspension. dant remains open; check Work computer and try again.";
const MAX_INSTALLER: u64 = 512 * 1024 * 1024;
const DOWNLOAD_BUFFER_BYTES: usize = 64 * 1024;
const UPDATE_METADATA_MAX_BYTES: usize = 64 * 1024;
const UPDATE_ACTION_RESPONSE_MAX_BYTES: usize = 4096;
const UPDATE_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const DOWNLOAD_PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const PREPARED_EXIT_DELAY: Duration = Duration::from_millis(150);
pub(crate) const EXIT_AUTHORIZATION_MAX_LIFETIME_MS: u64 = 35_000;
const EXIT_AUTHORIZATION_MIN_LIFETIME_MS: u64 = 5_000;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub version: String,
    pub channel: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub name: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    ready: bool,
    package_id: String,
    version: String,
    channel: String,
    sha256: String,
    size: u64,
    name: String,
}
#[derive(Default)]
pub struct Updates {
    busy: Mutex<HashSet<String>>,
    packages: Mutex<HashMap<String, Asset>>,
    installing: Mutex<bool>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    version: &'a str,
    channel: &'a str,
    sha256: &'a str,
    received: u64,
    total: u64,
    status: &'a str,
}
fn progress<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    asset: &Asset,
    received: u64,
    status: &str,
) {
    let _ = app.emit_to(
        "main",
        "dant-update-progress",
        Progress {
            version: &asset.version,
            channel: &asset.channel,
            sha256: &asset.sha256,
            received,
            total: asset.size,
            status,
        },
    );
}
pub(crate) fn version(value: &str) -> Option<((u64, u64, u64), Option<Vec<&str>>)> {
    if value.is_empty() || value.len() > 80 || !value.is_ascii() {
        return None;
    }
    let (core, pre) = value
        .split_once('-')
        .map_or((value, None), |(core, pre)| (core, Some(pre)));
    let parts: Vec<_> = core.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|v| {
            v.is_empty()
                || v.len() > 1 && v.starts_with('0')
                || !v.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return None;
    }
    let numbers = (
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    );
    let pre = if let Some(pre) = pre {
        let parts: Vec<_> = pre.split('.').collect();
        if parts.iter().any(|v| {
            v.is_empty()
                || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || v.bytes().all(|b| b.is_ascii_digit()) && v.len() > 1 && v.starts_with('0')
        }) {
            return None;
        }
        Some(parts)
    } else {
        None
    };
    Some((numbers, pre))
}
fn newer(candidate: &str, current: &str) -> bool {
    let (Some((a, ap)), Some((b, bp))) = (version(candidate), version(current)) else {
        return false;
    };
    if a != b {
        return a > b;
    }
    match (ap, bp) {
        (None, Some(_)) => true,
        (Some(_), None) | (None, None) => false,
        (Some(a), Some(b)) => {
            for (x, y) in a.iter().zip(&b) {
                if x == y {
                    continue;
                }
                let (xn, yn) = (
                    x.bytes().all(|v| v.is_ascii_digit()),
                    y.bytes().all(|v| v.is_ascii_digit()),
                );
                return match (xn, yn) {
                    (true, true) => x.len() > y.len() || x.len() == y.len() && x > y,
                    (true, false) => false,
                    (false, true) => true,
                    (false, false) => x > y,
                };
            }
            a.len() > b.len()
        }
    }
}
pub(crate) fn valid_asset(asset: &Asset) -> bool {
    let Some((_, pre)) = version(&asset.version) else {
        return false;
    };
    if !matches!(asset.channel.as_str(), "stable" | "beta")
        || asset.channel == "stable" && pre.is_some()
        || asset.size == 0
        || asset.size > MAX_INSTALLER
        || asset.sha256.len() != 64
        || !asset
            .sha256
            .bytes()
            .all(|v| v.is_ascii_digit() || matches!(v, b'a'..=b'f'))
        || asset.name != format!("dant_{}_windows_x64_setup.exe", asset.version)
    {
        return false;
    }
    [
        format!(
            "https://github.com/Stephen-Sim/dant/releases/download/v{}/{}",
            asset.version, asset.name
        ),
        format!(
            "https://github.com/Stephen-Sim/dant/releases/download/{}/{}",
            asset.version, asset.name
        ),
    ]
    .contains(&asset.url)
}
pub(crate) fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
pub(crate) fn directory(path: &Path, create: bool) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(FAILED.into());
    }
    let mut parents: Vec<_> = path.ancestors().collect();
    parents.reverse();
    for parent in parents {
        if !parent.exists() && create {
            fs::create_dir(parent).map_err(|_| FAILED)?
        }
        let meta = fs::symlink_metadata(parent).map_err(|_| FAILED)?;
        if !meta.is_dir() || linked(&meta) {
            return Err(FAILED.into());
        }
    }
    Ok(())
}
pub(crate) fn json_file(path: &Path, max: usize) -> Result<serde_json::Value, String> {
    json_file_using(path, max, |selected| fs::File::open(selected))
}

fn json_file_using(
    path: &Path,
    max: usize,
    open: impl FnOnce(&Path) -> std::io::Result<fs::File>,
) -> Result<serde_json::Value, String> {
    directory(path.parent().ok_or(FAILED)?, false)?;
    let meta = fs::symlink_metadata(path).map_err(|_| FAILED)?;
    if !meta.is_file() || linked(&meta) || meta.len() > max as u64 {
        return Err(FAILED.into());
    }
    let mut bytes = Vec::new();
    open(path)
        .map_err(|_| FAILED)?
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| FAILED)?;
    if bytes.len() > max {
        return Err(FAILED.into());
    }
    serde_json::from_slice(&bytes).map_err(|_| FAILED.into())
}
pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or(FAILED)?;
    directory(parent, true)?;
    if let Ok(meta) = fs::symlink_metadata(path) {
        if !meta.is_file() || linked(&meta) {
            return Err(FAILED.into());
        }
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".update-")
        .tempfile_in(parent)
        .map_err(|_| FAILED)?;
    temp.write_all(&serde_json::to_vec(value).map_err(|_| FAILED)?)
        .map_err(|_| FAILED)?;
    crate::atomic_file::publish(temp, path, crate::atomic_file::FlushPolicy::SyncOnly)
        .map_err(|_| FAILED)?;
    Ok(())
}
pub(crate) fn verify_file(path: &Path, asset: &Asset) -> Result<(), String> {
    verify_file_using(path, asset, |selected| fs::File::open(selected))
}

fn verify_file_using(
    path: &Path,
    asset: &Asset,
    open: impl FnOnce(&Path) -> std::io::Result<fs::File>,
) -> Result<(), String> {
    if !valid_asset(asset) {
        return Err(FAILED.into());
    }
    directory(path.parent().ok_or(FAILED)?, false)?;
    let meta = fs::symlink_metadata(path).map_err(|_| FAILED)?;
    if !meta.is_file() || linked(&meta) || meta.len() != asset.size {
        return Err(FAILED.into());
    }
    let mut file = open(path).map_err(|_| FAILED)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; DOWNLOAD_BUFFER_BYTES];
    let mut total = 0;
    loop {
        let count = file.read(&mut buffer).map_err(|_| FAILED)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > asset.size {
            return Err(FAILED.into());
        }
        hash.update(&buffer[..count]);
    }
    if total != asset.size || format!("{:x}", hash.finalize()) != asset.sha256 {
        return Err(FAILED.into());
    }
    Ok(())
}
fn cache<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let root = crate::runtime_path(app.path().app_cache_dir().map_err(|_| FAILED)?).join("updates");
    directory(&root, true)?;
    Ok(root)
}
fn package(root: &Path, asset: &Asset) -> Result<PathBuf, String> {
    let folder = root.join(&asset.sha256);
    directory(&folder, true)?;
    Ok(folder.join(&asset.name))
}
fn ready(asset: &Asset) -> Ready {
    Ready {
        ready: true,
        package_id: asset.sha256.clone(),
        version: asset.version.clone(),
        channel: asset.channel.clone(),
        sha256: asset.sha256.clone(),
        size: asset.size,
        name: asset.name.clone(),
    }
}
fn token(value: &str) -> bool {
    value.len() == crate::protocol::CONTROLLER_TOKEN_HEX_CHARS
        && value.bytes().all(|v| v.is_ascii_hexdigit())
}
async fn controller_request(
    route: &str,
    token: &str,
    max: usize,
    method: reqwest::Method,
    body: Option<&str>,
) -> Result<serde_json::Value, String> {
    controller_request_at(
        crate::protocol::controller_endpoint(),
        route,
        token,
        max,
        method,
        body,
    )
    .await
}

// The public native boundary never accepts an endpoint. Isolated tests supply
// an exclusively bound loopback socket to exercise the same HTTP behavior.
async fn controller_request_at(
    endpoint: std::net::SocketAddr,
    route: &str,
    token: &str,
    max: usize,
    method: reqwest::Method,
    body: Option<&str>,
) -> Result<serde_json::Value, String> {
    if !self::token(token) {
        return Err(FAILED.into());
    }
    let timeout = if route.starts_with("desktop/") {
        crate::lifecycle::DESKTOP_TRANSITION_TIMEOUT
    } else {
        UPDATE_REQUEST_TIMEOUT
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| FAILED)?;
    let mut request = client
        .request(
            method,
            format!("http://{endpoint}{}/{route}", crate::protocol::api_prefix()),
        )
        .header("X-Dant-Token", token);
    if let Some(body) = body {
        request = request
            .header("Content-Type", "application/json")
            .body(body.to_string());
    }
    let mut response = request.send().await.map_err(|_| FAILED)?;
    if !response.status().is_success() {
        return Err(FAILED.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| FAILED)? {
        if bytes.len() + chunk.len() > max {
            return Err(FAILED.into());
        }
        bytes.extend_from_slice(&chunk)
    }
    serde_json::from_slice(&bytes).map_err(|_| FAILED.into())
}
async fn controller(route: &str, token: &str, max: usize) -> Result<serde_json::Value, String> {
    controller_request(route, token, max, reqwest::Method::GET, None).await
}
fn stream_payload(
    input: &mut impl Read,
    output: &mut impl Write,
    asset: &Asset,
    mut report: impl FnMut(u64),
) -> Result<(), String> {
    let mut hash = Sha256::new();
    let mut total = 0;
    let mut buffer = [0; DOWNLOAD_BUFFER_BYTES];
    let mut last = Instant::now();
    loop {
        let count = input.read(&mut buffer).map_err(|_| FAILED)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > asset.size || total > MAX_INSTALLER {
            return Err(FAILED.into());
        }
        output.write_all(&buffer[..count]).map_err(|_| FAILED)?;
        hash.update(&buffer[..count]);
        if last.elapsed() > DOWNLOAD_PROGRESS_INTERVAL {
            report(total);
            last = Instant::now();
        }
    }
    if total != asset.size || format!("{:x}", hash.finalize()) != asset.sha256 {
        return Err(FAILED.into());
    }
    Ok(())
}
fn download<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
    asset: &Asset,
) -> Result<(), String> {
    download_using(
        root,
        asset,
        || {
            let system_root = PathBuf::from(std::env::var_os("SystemRoot").ok_or(FAILED)?);
            downloader_command(&system_root, asset)
        },
        |received| progress(app, asset, received, "downloading"),
    )
}

fn downloader_command(system_root: &Path, asset: &Asset) -> Result<Command, String> {
    let executable = system_root.join("System32/curl.exe");
    let meta = fs::symlink_metadata(&executable)
        .map_err(|_| "The Windows HTTPS downloader is unavailable.")?;
    if !meta.is_file() || linked(&meta) {
        return Err(FAILED.into());
    }
    let mut command = Command::new(executable);
    command
        .args([
            "-q",
            "--noproxy",
            "*",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--location",
            "--max-redirs",
            "3",
            "--fail",
            "--silent",
            "--show-error",
            "--connect-timeout",
            "20",
            "--max-time",
            "900",
            "--max-filesize",
        ])
        .arg(asset.size.to_string())
        .arg(&asset.url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(crate::runtime::CREATE_NO_WINDOW);
    Ok(command)
}

fn download_using(
    root: &Path,
    asset: &Asset,
    command: impl FnOnce() -> Result<Command, String>,
    mut report: impl FnMut(u64),
) -> Result<(), String> {
    let target = package(root, asset)?;
    if verify_file(&target, asset).is_ok() {
        return Ok(());
    }
    if target.exists() {
        let meta = fs::symlink_metadata(&target).map_err(|_| FAILED)?;
        if !meta.is_file() || linked(&meta) {
            return Err(FAILED.into());
        }
    }
    let mut command = command()?;
    let mut child = command.spawn().map_err(|_| FAILED)?;
    let result = (|| {
        let mut input = child.stdout.take().ok_or(FAILED)?;
        let mut output = tempfile::Builder::new()
            .prefix(".installer-")
            .tempfile_in(target.parent().ok_or(FAILED)?)
            .map_err(|_| FAILED)?;
        report(0);
        stream_payload(&mut input, &mut output, asset, &mut report)?;
        if !child.wait().map_err(|_| FAILED)?.success() {
            return Err(FAILED.into());
        }
        crate::atomic_file::publish(output, &target, crate::atomic_file::FlushPolicy::SyncOnly)
            .map_err(|_| FAILED)?;
        write_json(&target.parent().ok_or(FAILED)?.join("asset.json"), asset)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}
#[tauri::command]
pub async fn download_update<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    channel: String,
    token: String,
    expected_version: String,
) -> Result<Ready, String> {
    download_selected(
        &NativeDownloadEffects {
            app: &app,
            token: &token,
        },
        &app.state::<Updates>(),
        window.label(),
        channel,
        expected_version,
    )
    .await
}

trait DownloadEffects {
    async fn metadata(&self, channel: &str) -> Result<serde_json::Value, String>;
    fn cache(&self) -> Result<PathBuf, String>;
    async fn download(&self, root: &Path, asset: &Asset) -> Result<(), String>;
    fn progress(&self, asset: &Asset, received: u64, status: &str);
}

struct NativeDownloadEffects<'a, R: tauri::Runtime> {
    app: &'a tauri::AppHandle<R>,
    token: &'a str,
}

impl<R: tauri::Runtime> DownloadEffects for NativeDownloadEffects<'_, R> {
    async fn metadata(&self, channel: &str) -> Result<serde_json::Value, String> {
        controller(
            &format!("updates?channel={channel}"),
            self.token,
            UPDATE_METADATA_MAX_BYTES,
        )
        .await
    }
    fn cache(&self) -> Result<PathBuf, String> {
        cache(self.app)
    }
    async fn download(&self, root: &Path, asset: &Asset) -> Result<(), String> {
        let app = self.app.clone();
        let root = root.to_owned();
        let selected = asset.clone();
        tauri::async_runtime::spawn_blocking(move || download(&app, &root, &selected))
            .await
            .map_err(|_| FAILED.to_string())
            .and_then(|value| value)
    }
    fn progress(&self, asset: &Asset, received: u64, status: &str) {
        progress(self.app, asset, received, status);
    }
}

async fn download_selected(
    host: &impl DownloadEffects,
    state: &Updates,
    window: &str,
    channel: String,
    expected_version: String,
) -> Result<Ready, String> {
    if window != "main"
        || !matches!(channel.as_str(), "stable" | "beta")
        || version(&expected_version).is_none()
    {
        return Err(FAILED.into());
    }
    let metadata = host.metadata(&channel).await?;
    let asset: Asset = serde_json::from_value(metadata.get("asset").cloned().ok_or(FAILED)?)
        .map_err(|_| FAILED)?;
    if !valid_asset(&asset)
        || asset.version != expected_version
        || asset.channel != channel
        || metadata.get("channel").and_then(|v| v.as_str()) != Some(channel.as_str())
        || metadata.get("updateAvailable").and_then(|v| v.as_bool()) != Some(true)
        || !newer(&asset.version, env!("CARGO_PKG_VERSION"))
    {
        return Err(FAILED.into());
    }
    let root = host.cache()?;
    if !state
        .busy
        .lock()
        .map_err(|_| FAILED)?
        .insert(channel.clone())
    {
        return Err("This update is already downloading.".into());
    }
    let outcome = host.download(&root, &asset).await;
    state.busy.lock().map_err(|_| FAILED)?.remove(&channel);
    if let Err(error) = outcome {
        host.progress(&asset, 0, "failed");
        return Err(error);
    }
    state
        .packages
        .lock()
        .map_err(|_| FAILED)?
        .insert(asset.sha256.clone(), asset.clone());
    host.progress(&asset, asset.size, "ready");
    Ok(ready(&asset))
}
pub(crate) fn install_allowed(state: &serde_json::Value) -> bool {
    // This is admission to the Controller's pause-and-confirm transaction, not
    // proof that execution has stopped. The authenticated backend lease performs
    // that final check, including fresh VM reads and offline executor witnesses.
    let status = state
        .pointer("/controller/status")
        .and_then(|value| value.as_str());
    let cached = state
        .pointer("/controller/cached")
        .and_then(|value| value.as_bool());
    let transport = match (status, cached) {
        (Some("online"), Some(false)) | (Some("offline" | "connecting"), Some(true)) => true,
        _ => false,
    };
    state.get("mode").and_then(|v| v.as_str()) == Some("vm-controller")
        && state
            .pointer("/controller/authority")
            .and_then(|v| v.as_str())
            == Some("vm")
        && state
            .pointer("/controller/vmConfigured")
            .and_then(|v| v.as_bool())
            .is_some()
        && transport
        && state
            .pointer("/controller/desktopTransition")
            .and_then(|v| v.as_str())
            .is_some_and(|v| matches!(v, "idle" | "paused"))
        && state
            .pointer("/controller/serviceUpdateBusy")
            .and_then(|v| v.as_bool())
            == Some(false)
        && state
            .pointer("/provisioning/running")
            .and_then(|v| v.as_bool())
            == Some(false)
        && state
            .pointer("/provisioning/status")
            .and_then(|v| v.as_str())
            .is_some_and(|v| matches!(v, "idle" | "ready" | "failed"))
}
#[derive(Serialize)]
pub struct InstallResult {
    launched: bool,
}
#[derive(Serialize)]
pub struct Capabilities {
    download: bool,
    install: bool,
    reason: Option<&'static str>,
}
fn owns_controller<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(state) = app.try_state::<crate::Backend>() else {
        return false;
    };
    let Ok(mut locked) = state.0.lock() else {
        return false;
    };
    locked
        .as_mut()
        .is_some_and(|child| child.try_wait().is_ok_and(|status| status.is_none()))
}
#[tauri::command]
pub fn update_capabilities<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
) -> Result<Capabilities, String> {
    if window.label() != "main" {
        return Err(FAILED.into());
    }
    let installed = !cfg!(debug_assertions) && crate::update_helper::supported_layout();
    let own = owns_controller(&app);
    Ok(capabilities(installed, own))
}
fn capabilities(installed: bool, own: bool) -> Capabilities {
    Capabilities {
        download: cfg!(windows),
        install: installed && own,
        reason: if !installed {
            Some("installed-app-required")
        } else if !own {
            Some("owned-controller-required")
        } else {
            None
        },
    }
}

#[tauri::command]
pub async fn install_update<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    package_id: String,
    token: String,
) -> Result<InstallResult, String> {
    let state = app.try_state::<Updates>();
    install_selected(
        &NativeInstallEffects {
            app: &app,
            token: &token,
        },
        state.as_deref(),
        InstallRequest {
            window: window.label(),
            packaged: !cfg!(debug_assertions),
            package_id: &package_id,
        },
        || cache(&app),
        || owned_controller_id(&app),
    )
    .await
}
struct InstallRequest<'a> {
    window: &'a str,
    packaged: bool,
    package_id: &'a str,
}
fn owned_controller_id<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<u32, String> {
    let state = app.try_state::<crate::Backend>().ok_or(BLOCKED)?;
    let mut locked = state.0.lock().map_err(|_| BLOCKED)?;
    let child = locked.as_mut().ok_or(BLOCKED)?;
    if child.try_wait().map_err(|_| BLOCKED)?.is_some() {
        return Err(BLOCKED.into());
    }
    Ok(child.id())
}
async fn install_selected(
    host: &impl InstallEffects,
    state: Option<&Updates>,
    request: InstallRequest<'_>,
    cache_root: impl FnOnce() -> Result<PathBuf, String>,
    controller_id: impl FnOnce() -> Result<u32, String>,
) -> Result<InstallResult, String> {
    if request.window != "main" || !request.packaged || request.package_id.len() != 64 {
        return Err(BLOCKED.into());
    }
    let state = state.ok_or(BLOCKED)?;
    let asset = state
        .packages
        .lock()
        .map_err(|_| FAILED)?
        .get(request.package_id)
        .cloned()
        .ok_or(FAILED)?;
    if !install_allowed(
        &host
            .request(crate::protocol::state_route(), reqwest::Method::GET, None)
            .await?,
    ) {
        return Err(BLOCKED.into());
    }
    let controller_id = controller_id()?;
    let root = cache_root()?;
    let installer = package(&root, &asset)?;
    verify_file(&installer, &asset)?;
    install_verified(host, state, asset, root, installer, controller_id).await
}

// Installation owns one narrow set of effects. The state machine still performs
// real private-cache writes; synthetic tests replace only Controller/helper/app
// boundaries, never the authorization decisions or their durable receipts.
trait InstallEffects {
    async fn request(
        &self,
        route: &str,
        method: reqwest::Method,
        body: Option<&str>,
    ) -> Result<serde_json::Value, String>;
    async fn prepare(
        &self,
        root: &Path,
        installer: &Path,
        asset: &Asset,
        controller_id: u32,
    ) -> Result<PathBuf, String>;
    fn owns_controller(&self) -> bool;
    fn now_ms(&self) -> u64;
    fn schedule_exit(&self);
}

struct NativeInstallEffects<'a, R: tauri::Runtime> {
    app: &'a tauri::AppHandle<R>,
    token: &'a str,
}

fn install_response_limit(route: &str, method: &reqwest::Method) -> usize {
    if route == crate::protocol::state_route() && *method == reqwest::Method::GET {
        crate::protocol::API_RESPONSE_MAX_BYTES
    } else {
        UPDATE_ACTION_RESPONSE_MAX_BYTES
    }
}

impl<R: tauri::Runtime> InstallEffects for NativeInstallEffects<'_, R> {
    async fn request(
        &self,
        route: &str,
        method: reqwest::Method,
        body: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        controller_request(
            route,
            self.token,
            install_response_limit(route, &method),
            method,
            body,
        )
        .await
    }

    async fn prepare(
        &self,
        root: &Path,
        installer: &Path,
        asset: &Asset,
        controller_id: u32,
    ) -> Result<PathBuf, String> {
        let root = root.to_owned();
        let installer = installer.to_owned();
        let selected = asset.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::update_helper::prepare(&root, &installer, &selected, controller_id)
        })
        .await
        .map_err(|_| FAILED.to_string())
        .and_then(|value| value)
    }

    fn owns_controller(&self) -> bool {
        owns_controller(self.app)
    }

    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis() as u64)
            .unwrap_or(u64::MAX)
    }

    fn schedule_exit(&self) {
        let _ = spawn_prepared_exit(self.app.clone());
    }
}

fn spawn_prepared_exit<R: tauri::Runtime>(
    handle: tauri::AppHandle<R>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        std::thread::sleep(PREPARED_EXIT_DELAY);
        crate::lifecycle::prepared_update_exit(&handle);
    })
}

async fn install_verified(
    host: &impl InstallEffects,
    state: &Updates,
    asset: Asset,
    root: PathBuf,
    installer: PathBuf,
    controller_id: u32,
) -> Result<InstallResult, String> {
    {
        let mut installing = state.installing.lock().map_err(|_| FAILED)?;
        if *installing {
            return Err("An update installation is already pending.".into());
        }
        *installing = true;
    }
    let lease = host
        .request("updates/install-lease", reqwest::Method::POST, Some("{}"))
        .await;
    let lease_id = lease
        .as_ref()
        .ok()
        .and_then(|value| value.get("leaseId"))
        .and_then(|value| value.as_str())
        .filter(|value| {
            value.len() == 36
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        })
        .map(str::to_string);
    let Some(lease_id) = lease_id else {
        *state.installing.lock().map_err(|_| FAILED)? = false;
        return Err(BLOCKED.into());
    };
    let body = serde_json::json!({"reason":"install","leaseId":lease_id}).to_string();
    let suspension = host
        .request("desktop/exit", reqwest::Method::POST, Some(&body))
        .await;
    let suspended = suspension.as_ref().is_ok_and(crate::lifecycle::confirmed)
        && suspension
            .as_ref()
            .ok()
            .and_then(|value| value.get("leaseId"))
            .and_then(|value| value.as_str())
            == Some(lease_id.as_str());
    if !suspended {
        let _ = host
            .request("desktop/cancel-exit", reqwest::Method::POST, Some(&body))
            .await;
        let _ = host
            .request(
                &format!("updates/install-lease/{lease_id}"),
                reqwest::Method::DELETE,
                None,
            )
            .await;
        *state.installing.lock().map_err(|_| FAILED)? = false;
        return Err(BLOCKED.into());
    }
    let job = host.prepare(&root, &installer, &asset, controller_id).await;
    let folder = match job {
        Ok(folder) => folder,
        Err(error) => {
            let _ = host
                .request("desktop/cancel-exit", reqwest::Method::POST, Some(&body))
                .await;
            let _ = host
                .request(
                    &format!("updates/install-lease/{lease_id}"),
                    reqwest::Method::DELETE,
                    None,
                )
                .await;
            *state.installing.lock().map_err(|_| FAILED)? = false;
            return Err(error);
        }
    };
    let now = host.now_ms();
    let lease_fresh = suspension
        .as_ref()
        .ok()
        .and_then(|value| value.get("expiresAt"))
        .and_then(|value| value.as_u64())
        .is_some_and(|value| {
            value > now.saturating_add(EXIT_AUTHORIZATION_MIN_LIFETIME_MS)
                && value <= now.saturating_add(EXIT_AUTHORIZATION_MAX_LIFETIME_MS)
        });
    let authorization = serde_json::json!({
        "authorized": true,
        "sha256": asset.sha256,
        "leaseId": lease_id,
        "expiresAt": suspension.as_ref().ok().and_then(|value| value.get("expiresAt")),
    });
    let authorized = lease_fresh
        && host.owns_controller()
        && write_json(&folder.join("go.json"), &authorization).is_ok();
    if !authorized {
        let _ = write_json(&folder.join("cancel.json"), &true);
        let _ = host
            .request("desktop/cancel-exit", reqwest::Method::POST, Some(&body))
            .await;
        let _ = host
            .request(
                &format!("updates/install-lease/{lease_id}"),
                reqwest::Method::DELETE,
                None,
            )
            .await;
        *state.installing.lock().map_err(|_| FAILED)? = false;
        return Err(BLOCKED.into());
    }
    // The install lease already paused work and suspended the VM. The helper owns
    // the exact process handles; do not issue a second suspend during handoff.
    host.schedule_exit();
    Ok(InstallResult { launched: true })
}

#[cfg(test)]
#[path = "../../tests/native/rust/updates.rs"]
mod tests;
