use std::{io::Write, path::Path};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: usize = crate::protocol::ATTACHMENT_MAX_BYTES;
const FAILED: &str =
    "The attachment could not be saved. Check the connection and destination, then try again.";

fn valid_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}
fn valid_token(value: &str) -> bool {
    value.len() == crate::protocol::CONTROLLER_TOKEN_HEX_CHARS
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn safe_name(value: &str) -> String {
    let last = value.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut name: String = last
        .chars()
        .filter(|character| !character.is_control() && !"<>:\"|?*".contains(*character))
        .collect();
    name = name.trim().trim_matches('.').trim().to_string();
    if name.is_empty() {
        return "download".into();
    }
    if name.chars().count() > 180 {
        let extension = name
            .rsplit_once('.')
            .filter(|(_, extension)| {
                !extension.is_empty()
                    && extension.len() <= 16
                    && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
            .map(|(_, extension)| format!(".{extension}"))
            .unwrap_or_default();
        name = name.chars().take(180 - extension.len()).collect::<String>() + &extension;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        name.insert(0, '_');
    }
    name
}
fn atomic_save(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    if !destination.is_absolute() || destination.file_name().is_none() || bytes.len() > MAX_BYTES {
        return Err(FAILED.into());
    }
    let parent = destination.parent().ok_or(FAILED)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".dant-download-")
        .tempfile_in(parent)
        .map_err(|_| FAILED)?;
    temporary.write_all(bytes).map_err(|_| FAILED)?;
    temporary.flush().map_err(|_| FAILED)?;
    temporary.as_file().sync_all().map_err(|_| FAILED)?;
    temporary.persist(destination).map_err(|_| FAILED)?;
    Ok(())
}

// The main renderer owns authentication and the user's click. Neither remote
// URLs nor filesystem destinations can be supplied through this command.
#[tauri::command]
pub async fn save_attachment(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    file_id: String,
    token: String,
    file_name: String,
) -> Result<bool, String> {
    if window.label() != "main"
        || !valid_id(&file_id)
        || !valid_token(&token)
        || file_name.len() > 1024
    {
        return Err("Invalid attachment download".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(crate::protocol::ATTACHMENT_REQUEST_TIMEOUT)
        .build()
        .map_err(|_| FAILED)?;
    let mut response = client
        .get(crate::protocol::api_url(&format!(
            "files/{file_id}?download=1"
        )))
        .header("X-Dant-Token", token)
        .send()
        .await
        .map_err(|_| FAILED)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_BYTES as u64)
    {
        return Err(FAILED.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| FAILED)? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(FAILED.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if app.get_webview_window("main").is_none() {
        return Err(FAILED.into());
    }
    let name = safe_name(&file_name);
    // The dialog and atomic filesystem write run outside both the UI thread and
    // the serialized JSON API transport, so call controls remain responsive.
    tauri::async_runtime::spawn_blocking(move || {
        let chosen = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(&name)
            .blocking_save_file();
        let Some(chosen) = chosen else {
            return Ok(false);
        };
        let destination = chosen.into_path().map_err(|_| FAILED)?;
        atomic_save(&destination, &bytes)?;
        Ok(true)
    })
    .await
    .map_err(|_| FAILED.to_string())?
}

#[cfg(test)]
#[path = "../../tests/native/rust/downloads.rs"]
mod tests;
