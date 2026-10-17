use std::{fs, io::Write, path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, SystemTime}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: usize = 10 * 1024 * 1024;
const FAILED: &str = "The text editor operation could not be completed. Check the file, connection and chosen editor.";
const EDITORS: &[&str] = &["notepad.exe", "notepad++.exe", "notepad3.exe", "notepad4.exe", "code.exe", "code-insiders.exe", "sublime_text.exe", "zed.exe", "cursor.exe"];
#[derive(Default, Serialize, Deserialize)]
struct Preference { executable: Option<PathBuf> }
#[derive(Serialize)]
pub struct EditorPreference { editor: &'static str, name: String }

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> { if window.label() == "main" { Ok(()) } else { Err(FAILED.into()) } }
fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { meta.file_type().is_symlink() }
}
fn ordinary_directory(path: &Path, create: bool) -> Result<(), String> {
    if !path.is_absolute() { return Err(FAILED.into()) }
    let mut chain: Vec<_> = path.ancestors().collect(); chain.reverse();
    for directory in chain {
        if !directory.exists() && create { fs::create_dir(directory).map_err(|_| FAILED)?; }
        let meta = fs::symlink_metadata(directory).map_err(|_| FAILED)?;
        if !meta.is_dir() || linked(&meta) { return Err(FAILED.into()) }
    }
    Ok(())
}
fn bounded_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    ordinary_directory(path.parent().ok_or(FAILED)?, false)?;
    let meta = fs::symlink_metadata(path).map_err(|_| FAILED)?;
    if !meta.is_file() || linked(&meta) || meta.len() > limit as u64 { return Err(FAILED.into()) }
    use std::io::Read; let mut data = Vec::new(); fs::File::open(path).map_err(|_| FAILED)?.take(limit as u64 + 1).read_to_end(&mut data).map_err(|_| FAILED)?;
    if data.len() > limit { return Err(FAILED.into()) } Ok(data)
}
fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> { Ok(app.path().app_config_dir().map_err(|_| FAILED)?.join("text-editor.json")) }
fn read_preference(path: &Path) -> Result<Preference, String> {
    if !path.exists() { return Ok(Preference::default()) }
    serde_json::from_slice(&bounded_file(path, 8192)?).map_err(|_| FAILED.into())
}
fn write_preference(path: &Path, value: &Preference) -> Result<(), String> {
    let parent = path.parent().ok_or(FAILED)?; ordinary_directory(parent, true)?;
    if let Ok(meta) = fs::symlink_metadata(path) { if !meta.is_file() || linked(&meta) { return Err(FAILED.into()) } }
    let mut temporary = tempfile::Builder::new().prefix(".text-editor-").tempfile_in(parent).map_err(|_| FAILED)?;
    temporary.write_all(&serde_json::to_vec(value).map_err(|_| FAILED)?).map_err(|_| FAILED)?; temporary.as_file().sync_all().map_err(|_| FAILED)?;
    temporary.persist(path).map_err(|_| FAILED)?; Ok(())
}
fn preference_view(value: &Preference) -> EditorPreference {
    EditorPreference { editor: if value.executable.is_some() { "custom" } else { "notepad" }, name: value.executable.as_ref().and_then(|path| path.file_name()).map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "Notepad".into()) }
}
fn valid_editor(path: &Path) -> bool {
    if !path.is_absolute() || !path.file_name().is_some_and(|name| EDITORS.iter().any(|allowed| name.to_string_lossy().eq_ignore_ascii_case(allowed))) { return false }
    if !path.parent().is_some_and(|parent| ordinary_directory(parent, false).is_ok()) { return false }
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && !linked(&meta) && meta.len() > 0 && meta.len() <= 512 * 1024 * 1024)
}
fn default_editor() -> Result<PathBuf, String> {
    #[cfg(windows)] { let path = PathBuf::from(std::env::var_os("SystemRoot").ok_or(FAILED)?).join("System32").join("notepad.exe"); if valid_editor(&path) { Ok(path) } else { Err(FAILED.into()) } }
    #[cfg(not(windows))] { Err("The built-in text editor is available on Windows.".into()) }
}
fn valid_id(value: &str) -> bool { value.len() == 36 && value.bytes().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() }) }
fn known_text(name: &str) -> bool { Path::new(name).extension().is_some_and(|extension| ["json","txt","md","csv","tsv","log","yaml","yml","xml","svg","toml","ini","conf","cfg","py","js","mjs","cjs","jsx","ts","tsx","css","htm","html","sh","bash","ps1","bat","cmd","sql","rs","go","java","c","h","cpp","hpp"].iter().any(|allowed| extension.to_string_lossy().eq_ignore_ascii_case(allowed))) }
fn text_payload(bytes: &[u8], name: &str, mime: &str) -> bool {
    if bytes.len() > MAX_BYTES || Path::new(name).extension().is_some_and(|extension| ["exe","com","msi","dll","scr"].iter().any(|value| extension.to_string_lossy().eq_ignore_ascii_case(value))) { return false }
    let mime = mime.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    let textual = ["application/xml","application/javascript","application/x-javascript","application/typescript","application/x-typescript","application/yaml","application/x-yaml","application/toml","application/sql","application/graphql","application/x-sh","application/x-shellscript"].contains(&mime.as_str());
    if !(mime.starts_with("text/") || textual || mime == "application/json" || mime.starts_with("application/") && mime.ends_with("+json") || mime == "application/octet-stream" && known_text(name)) { return false }
    std::str::from_utf8(bytes).is_ok_and(|text| !text.chars().any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t')))
}
fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default(); let mut value: String = last.chars().filter(|ch| !ch.is_control() && !"<>:\"|?*".contains(*ch)).collect();
    value = value.trim().trim_matches('.').trim().to_string(); if value.is_empty() { value = "attachment.txt".into() }
    if value.chars().count() > 140 { let extension = value.rsplit_once('.').filter(|(_, extension)| !extension.is_empty() && extension.len() <= 16 && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())).map(|(_, extension)| format!(".{extension}")).unwrap_or_default(); value = value.chars().take(140 - extension.len()).collect::<String>() + &extension; }
    if ["CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"].contains(&value.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase().as_str()) { value.insert(0, '_'); } value
}
fn cache_copy(root: &Path, id: &str, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if !valid_id(id) || bytes.len() > MAX_BYTES { return Err(FAILED.into()) } ordinary_directory(root, true)?;
    let hash = format!("{:x}", Sha256::digest(bytes)); let directory = root.join(format!("{id}-{hash}")); ordinary_directory(&directory, true)?;
    let mut target = directory.join(safe_name(name));
    if target.exists() {
        if bounded_file(&target, MAX_BYTES)? == bytes { return Ok(target) }
        // Preserve a user's edits to an earlier cache copy; never overwrite it.
        let fresh = tempfile::Builder::new().prefix(&format!("{id}-{hash}-")).tempdir_in(root).map_err(|_| FAILED)?.keep(); target = fresh.join(safe_name(name));
    }
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|_| FAILED)?;
    output.write_all(bytes).map_err(|_| FAILED)?; output.sync_all().map_err(|_| FAILED)?; Ok(target)
}
fn expire_cache(root: &Path) {
    if ordinary_directory(root, false).is_err() { return }
    let Ok(entries) = fs::read_dir(root) else { return }; let now = SystemTime::now();
    for entry in entries.take(128).flatten() {
        let directory = entry.path(); if ordinary_directory(&directory, false).is_err() { continue }
        let name = entry.file_name().to_string_lossy().into_owned(); if !name.is_ascii() || name.len() < 101 || !valid_id(&name[..36]) || name.as_bytes()[36] != b'-' || !name.as_bytes()[37..101].iter().all(|b| b.is_ascii_hexdigit()) { continue }
        let Ok(children) = fs::read_dir(&directory) else { continue }; let children: Vec<_> = children.take(2).flatten().collect(); if children.len() != 1 { continue }
        let target = children[0].path(); let Ok(meta) = fs::symlink_metadata(&target) else { continue };
        if !meta.is_file() || linked(&meta) || !meta.modified().ok().and_then(|time| now.duration_since(time).ok()).is_some_and(|age| age > Duration::from_secs(3 * 24 * 60 * 60)) { continue }
        if let Ok(bytes) = bounded_file(&target, MAX_BYTES) { if format!("{:x}", Sha256::digest(&bytes)) == name[37..101] && fs::remove_file(target).is_ok() { let _ = fs::remove_dir(directory); } }
    }
}

#[tauri::command]
pub fn editor_preferences(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<EditorPreference, String> { main_only(&window)?; Ok(preference_view(&read_preference(&preferences_path(&app)?)?)) }
#[tauri::command]
pub fn reset_text_editor(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<EditorPreference, String> { main_only(&window)?; let value = Preference::default(); write_preference(&preferences_path(&app)?, &value)?; Ok(preference_view(&value)) }
#[tauri::command]
pub async fn choose_text_editor(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<EditorPreference>, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || { let chosen = app.dialog().file().set_parent(&window).add_filter("Text editor", &["exe"]).blocking_pick_file(); let Some(chosen) = chosen else { return Ok(None) }; let path = chosen.into_path().map_err(|_| FAILED)?; if !valid_editor(&path) { return Err("Choose a supported text editor executable, such as Code.exe, notepad++.exe or sublime_text.exe.".into()) } let value = Preference { executable: Some(path) }; write_preference(&preferences_path(&app)?, &value)?; Ok(Some(preference_view(&value))) }).await.map_err(|_| FAILED.to_string())?
}
#[tauri::command]
pub async fn open_attachment_in_editor(app: tauri::AppHandle, window: tauri::WebviewWindow, file_id: String, token: String, file_name: String) -> Result<serde_json::Value, String> {
    main_only(&window)?; if !valid_id(&file_id) || token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) || file_name.len() > 1024 { return Err(FAILED.into()) }
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(60)).build().map_err(|_| FAILED)?;
    let mut response = client.get(format!("http://127.0.0.1:4317/api/files/{file_id}")).header("X-Dant-Token", token).send().await.map_err(|_| FAILED)?;
    if !response.status().is_success() || response.content_length().is_some_and(|size| size > MAX_BYTES as u64) { return Err(FAILED.into()) }
    let mime = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or_default().to_string(); let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| FAILED)? { if bytes.len() + chunk.len() > MAX_BYTES { return Err(FAILED.into()) } bytes.extend_from_slice(&chunk); }
    if !text_payload(&bytes, &file_name, &mime) { return Err(FAILED.into()) }
    tauri::async_runtime::spawn_blocking(move || {
        let preference = read_preference(&preferences_path(&app)?)?; let executable = match preference.executable { Some(path) if valid_editor(&path) => path, Some(_) => return Err(FAILED.into()), None => default_editor()? };
        let root = app.path().app_cache_dir().map_err(|_| FAILED)?.join("text-editor"); expire_cache(&root); let target = cache_copy(&root, &file_id, &file_name, &bytes)?;
        Command::new(executable).arg(target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| FAILED)?;
        Ok(serde_json::json!({"opened":true}))
    }).await.map_err(|_| FAILED.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn only_plain_utf8_text_uses_a_text_editor_without_file_associations() {
        assert!(text_payload("中文\nEnglish".as_bytes(), "note.txt", "text/plain")); assert!(text_payload(b"<script>not executed</script>", "page.html", "application/octet-stream"));
        assert!(text_payload(b"<xml/>", "source.xml", "application/xml")); assert!(text_payload(b"console.log('read only')", "source.js", "application/javascript")); assert!(text_payload(b"name: fixture", "source.yaml", "application/yaml"));
        assert!(!text_payload(&[255], "bad.txt", "text/plain")); assert!(!text_payload(b"x\0", "bad.txt", "text/plain")); assert!(!text_payload(b"text", "bad.exe", "text/plain")); assert!(!text_payload(b"text", "bad.zip", "application/octet-stream")); assert!(!text_payload(b"{}", "bad.json", "image/png"));
        assert_eq!(safe_name("../../CON.txt"), "_CON.txt"); assert_eq!(safe_name("\0<>:*"), "attachment.txt"); assert!(!valid_editor(Path::new("cmd.exe"))); assert!(!valid_editor(Path::new("C:\\Windows\\System32\\cmd.exe")));
    }
    #[test] fn stable_cache_preserves_original_bytes_and_user_edits_without_changing_the_attachment() {
        let directory = tempfile::tempdir().unwrap(); let root = directory.path().join("cache"); let id = "10b72b2a-346f-48c0-a243-1cb22871d91d";
        let first = cache_copy(&root, id, "result.json", b"{\"ok\":true}").unwrap(); assert_eq!(cache_copy(&root, id, "result.json", b"{\"ok\":true}").unwrap(), first);
        fs::write(&first, b"user edit").unwrap(); let next = cache_copy(&root, id, "result.json", b"{\"ok\":true}").unwrap(); assert_ne!(next, first); assert_eq!(fs::read(first).unwrap(), b"user edit"); assert_eq!(fs::read(next).unwrap(), b"{\"ok\":true}");
        assert!(cache_copy(&root, "../outside", "result.json", b"x").is_err()); assert!(cache_copy(&root, id, "result.json", &vec![0; MAX_BYTES + 1]).is_err());
    }
    #[test] fn preferences_are_atomic_and_return_only_the_editor_basename() {
        let directory = tempfile::tempdir().unwrap(); let file = directory.path().join("settings").join("text-editor.json"); assert_eq!(preference_view(&read_preference(&file).unwrap()).editor, "notepad");
        let preference = Preference { executable: Some(directory.path().join("Code.exe")) }; write_preference(&file, &preference).unwrap(); let loaded = read_preference(&file).unwrap(); assert_eq!(preference_view(&loaded).name, "Code.exe"); assert_eq!(preference_view(&loaded).editor, "custom"); write_preference(&file, &Preference::default()).unwrap(); assert_eq!(preference_view(&read_preference(&file).unwrap()).name, "Notepad");
        fs::write(&file, b"malformed").unwrap(); assert!(read_preference(&file).is_err()); assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
    }
    #[test] fn expiry_removes_only_old_unchanged_owned_copies_and_preserves_edits_and_unrelated_paths() {
        let directory = tempfile::tempdir().unwrap(); let root = directory.path().join("cache"); let id = "10b72b2a-346f-48c0-a243-1cb22871d91d";
        let unchanged = cache_copy(&root, id, "old.txt", b"original").unwrap(); let edited = cache_copy(&root, id, "edited.txt", b"different").unwrap(); fs::write(&edited, b"user edit").unwrap();
        let old = SystemTime::now() - Duration::from_secs(4 * 24 * 60 * 60); for path in [&unchanged, &edited] { fs::File::options().write(true).open(path).unwrap().set_times(fs::FileTimes::new().set_modified(old)).unwrap(); }
        let unrelated = root.join("中文目录".repeat(20)); fs::create_dir(&unrelated).unwrap(); fs::write(unrelated.join("keep.txt"), b"keep").unwrap(); expire_cache(&root);
        assert!(!unchanged.exists()); assert!(!unchanged.parent().unwrap().exists()); assert_eq!(fs::read(edited).unwrap(), b"user edit"); assert_eq!(fs::read(unrelated.join("keep.txt")).unwrap(), b"keep");
    }
}
