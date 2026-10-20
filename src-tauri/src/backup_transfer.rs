use base64::Engine;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::io;
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    time::Duration,
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// Matches PORTABLE_MAX_FILE_BYTES in the portable backup protocol; tested by the contract suite.
const MAX_PORTABLE_BYTES: u64 = 16_173_244_459;
const JSON_LIMIT: u64 = 64 * 1024;
const BUFFER_BYTES: usize = 64 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_FILES: u64 = 100_000;
const MAX_CREATED_AT: u64 = 9_007_199_254_740_991;
const SOURCE_PREFIX_HEX_CHARS: usize = 12;
const APP_VERSION_MAX_BYTES: usize = 64;
const PASSPHRASE_MIN_BYTES: usize = 12;
const PASSPHRASE_MAX_BYTES: usize = 1024;
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const TRANSFER_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const FAILED: &str = "backup_transfer_failed";
const INTERRUPTED: &str = "backup_transfer_unconfirmed";
const TOO_LARGE: &str = "backup_size_limit";
const PASSWORD: &str = "backup_passphrase_invalid";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupMetadata {
    id: String,
    created_at: u64,
    app_version: String,
    bytes: u64,
    files: u64,
    source: String,
}
#[derive(Deserialize)]
struct Imported {
    backup: BackupMetadata,
}
fn valid_id(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes()[14] == b'4'
        && matches!(value.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}
fn arguments(window: &str, token: &str, passphrase: &str) -> Result<(), String> {
    if window != "main"
        || token.len() != crate::protocol::CONTROLLER_TOKEN_HEX_CHARS
        || !token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(FAILED.into());
    }
    if !(PASSPHRASE_MIN_BYTES..=PASSPHRASE_MAX_BYTES).contains(&passphrase.len()) {
        return Err(PASSWORD.into());
    }
    Ok(())
}
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(TRANSFER_TIMEOUT)
        .connect_timeout(TRANSFER_CONNECT_TIMEOUT)
        .build()
        .map_err(|_| FAILED.into())
}
fn response_error(response: reqwest::blocking::Response) -> String {
    let mut bytes = Vec::new();
    if response
        .take(JSON_LIMIT + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > JSON_LIMIT
    {
        return FAILED.into();
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    match value.get("code").and_then(|v| v.as_str()) {
        Some(
            code @ ("backup_passphrase_invalid"
            | "backup_invalid"
            | "backup_size_limit"
            | "backup_exists"
            | "backup_busy"),
        ) => code.into(),
        _ => FAILED.into(),
    }
}
fn selected_file(path: &Path) -> Result<fs::File, String> {
    crate::updates::directory(path.parent().ok_or(FAILED)?, false)?;
    let meta = fs::symlink_metadata(path).map_err(|_| FAILED)?;
    if !meta.is_file() || crate::updates::linked(&meta) {
        return Err(FAILED.into());
    }
    if meta.len() == 0 {
        return Err("backup_invalid".into());
    }
    if meta.len() > MAX_PORTABLE_BYTES {
        return Err(TOO_LARGE.into());
    }
    let file = fs::File::open(path).map_err(|_| FAILED)?;
    let opened = file.metadata().map_err(|_| FAILED)?;
    if !opened.is_file()
        || opened.len() != meta.len()
        || opened.modified().ok() != meta.modified().ok()
    {
        return Err(FAILED.into());
    }
    Ok(file)
}
fn save_stream(
    input: &mut impl Read,
    destination: &Path,
    declared: Option<u64>,
    maximum: u64,
    mut active: impl FnMut() -> bool,
) -> Result<(), String> {
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err(FAILED.into());
    }
    if declared.is_some_and(|n| n == 0 || n > maximum) {
        return Err(TOO_LARGE.into());
    }
    let parent = destination.parent().ok_or(FAILED)?;
    crate::updates::directory(parent, false)?;
    if let Ok(meta) = fs::symlink_metadata(destination) {
        if !meta.is_file() || crate::updates::linked(&meta) {
            return Err(FAILED.into());
        }
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".dant-backup-")
        .tempfile_in(parent)
        .map_err(|_| FAILED)?;
    let mut buffer = [0; BUFFER_BYTES];
    let mut received = 0u64;
    loop {
        if !active() {
            return Err(INTERRUPTED.into());
        }
        let count = input.read(&mut buffer).map_err(|_| INTERRUPTED)?;
        if count == 0 {
            break;
        }
        received = received.checked_add(count as u64).ok_or(TOO_LARGE)?;
        if received > maximum {
            return Err(TOO_LARGE.into());
        }
        temporary.write_all(&buffer[..count]).map_err(|_| FAILED)?;
    }
    if received == 0 || declared.is_some_and(|n| n != received) {
        return Err(INTERRUPTED.into());
    }
    if !active() {
        return Err(INTERRUPTED.into());
    }
    temporary.flush().map_err(|_| FAILED)?;
    temporary.as_file().sync_all().map_err(|_| FAILED)?;
    crate::updates::directory(parent, false)?;
    temporary.persist(destination).map_err(|_| FAILED)?;
    Ok(())
}

#[tauri::command]
pub async fn export_dant_backup(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    backup_id: String,
    token: String,
    passphrase: String,
) -> Result<bool, String> {
    arguments(window.label(), &token, &passphrase)?;
    if !valid_id(&backup_id) {
        return Err(FAILED.into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let chosen = app
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("dant backup", &["dant"])
            .set_file_name(format!("dant-backup-{backup_id}.dant"))
            .blocking_save_file();
        let Some(chosen) = chosen else {
            return Ok(false);
        };
        let destination = chosen.into_path().map_err(|_| FAILED)?;
        export_to(
            controller_endpoint(),
            &backup_id,
            &token,
            &passphrase,
            &destination,
            || app.get_webview_window("main").is_some(),
        )
    })
    .await
    .map_err(|_| FAILED.to_string())?
}

fn controller_endpoint() -> std::net::SocketAddr {
    crate::protocol::controller_endpoint()
}

fn export_to(
    endpoint: std::net::SocketAddr,
    backup_id: &str,
    token: &str,
    passphrase: &str,
    destination: &Path,
    mut active: impl FnMut() -> bool,
) -> Result<bool, String> {
    arguments("main", token, passphrase)?;
    if !valid_id(backup_id) {
        return Err(FAILED.into());
    }
    if !active() {
        return Err(INTERRUPTED.into());
    }
    let encoded =
        serde_json::to_vec(&serde_json::json!({"passphrase":passphrase})).map_err(|_| FAILED)?;
    let mut response = client()?
        .post(format!(
            "http://{endpoint}{}/backups/{backup_id}/export",
            crate::protocol::api_prefix()
        ))
        .header("X-Dant-Token", token)
        .header("Content-Type", "application/json")
        .body(encoded)
        .send()
        .map_err(|_| INTERRUPTED)?;
    if !response.status().is_success() {
        return Err(response_error(response));
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next() == Some("application/octet-stream"))
    {
        return Err(FAILED.into());
    }
    let declared = response.content_length();
    save_stream(
        &mut response,
        destination,
        declared,
        MAX_PORTABLE_BYTES,
        || active(),
    )?;
    Ok(true)
}

#[tauri::command]
pub async fn import_dant_backup(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    passphrase: String,
) -> Result<Option<BackupMetadata>, String> {
    arguments(window.label(), &token, &passphrase)?;
    tauri::async_runtime::spawn_blocking(move || {
        let chosen = app
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("dant backup", &["dant"])
            .blocking_pick_file();
        let Some(chosen) = chosen else {
            return Ok(None);
        };
        let source = chosen.into_path().map_err(|_| FAILED)?;
        import_from(controller_endpoint(), &source, &token, &passphrase, || {
            app.get_webview_window("main").is_some()
        })
    })
    .await
    .map_err(|_| FAILED.to_string())?
}

fn import_from(
    endpoint: std::net::SocketAddr,
    source: &Path,
    token: &str,
    passphrase: &str,
    mut active: impl FnMut() -> bool,
) -> Result<Option<BackupMetadata>, String> {
    arguments("main", token, passphrase)?;
    if !active() {
        return Err(INTERRUPTED.into());
    }
    let file = selected_file(source)?;
    let size = file.metadata().map_err(|_| FAILED)?.len();
    let password = base64::engine::general_purpose::STANDARD.encode(passphrase.as_bytes());
    let mut response = client()?
        .post(format!(
            "http://{endpoint}{}/backups/import",
            crate::protocol::api_prefix()
        ))
        .header("X-Dant-Token", token)
        .header("Content-Type", "application/octet-stream")
        .header("X-Dant-Backup-Passphrase", password)
        .body(reqwest::blocking::Body::sized(file.take(size), size))
        .send()
        .map_err(|_| INTERRUPTED)?;
    if !response.status().is_success() {
        return Err(response_error(response));
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(JSON_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| INTERRUPTED)?;
    if bytes.len() as u64 > JSON_LIMIT {
        return Err(FAILED.into());
    }
    let value: Imported = serde_json::from_slice(&bytes).map_err(|_| INTERRUPTED)?;
    let backup = value.backup;
    if !valid_id(&backup.id)
        || backup.created_at == 0
        || backup.created_at > MAX_CREATED_AT
        || backup.bytes > MAX_ARCHIVE_BYTES
        || backup.files > MAX_ARCHIVE_FILES
        || backup.source.len() != SOURCE_PREFIX_HEX_CHARS
        || !backup.source.bytes().all(|b| b.is_ascii_hexdigit())
        || backup.app_version.is_empty()
        || backup.app_version.len() > APP_VERSION_MAX_BYTES
    {
        return Err(INTERRUPTED.into());
    }
    Ok(Some(backup))
}

#[cfg(test)]
#[path = "../../tests/native/rust/backup_transfer.rs"]
mod tests;
