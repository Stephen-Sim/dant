use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, SystemTime},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: usize = crate::protocol::ATTACHMENT_MAX_BYTES;
const EDITOR_PREFERENCES_MAX_BYTES: usize = 8192;
const EXECUTABLE_MAX_BYTES: u64 = 512 * 1024 * 1024;
const CACHE_SCAN_LIMIT: usize = 128;
const CACHE_RETENTION: Duration = Duration::from_secs(3 * 24 * 60 * 60);
const EDITOR_CACHE_DIRECTORY: &str = "dant-text-editor";
const FAILED: &str = "The text editor operation could not be completed. Check the file, connection and chosen editor.";
struct EditorSpec {
    id: &'static str,
    name: &'static str,
    executables: &'static [&'static str],
}
const EDITORS: &[EditorSpec] = &[
    EditorSpec {
        id: "notepad",
        name: "Notepad",
        executables: &["notepad.exe"],
    },
    EditorSpec {
        id: "vscode",
        name: "Visual Studio Code",
        executables: &["code.exe"],
    },
    EditorSpec {
        id: "vscode-insiders",
        name: "Visual Studio Code Insiders",
        executables: &["code-insiders.exe", "code - insiders.exe"],
    },
    EditorSpec {
        id: "notepadpp",
        name: "Notepad++",
        executables: &["notepad++.exe"],
    },
    EditorSpec {
        id: "notepad3",
        name: "Notepad3",
        executables: &["notepad3.exe"],
    },
    EditorSpec {
        id: "notepad4",
        name: "Notepad4",
        executables: &["notepad4.exe"],
    },
    EditorSpec {
        id: "sublime",
        name: "Sublime Text",
        executables: &["sublime_text.exe"],
    },
    EditorSpec {
        id: "zed",
        name: "Zed",
        executables: &["zed.exe"],
    },
    EditorSpec {
        id: "cursor",
        name: "Cursor",
        executables: &["cursor.exe"],
    },
    EditorSpec {
        id: "visualstudio",
        name: "Visual Studio",
        executables: &["devenv.exe"],
    },
    EditorSpec {
        id: "androidstudio",
        name: "Android Studio",
        executables: &["studio64.exe", "studio.exe"],
    },
    EditorSpec {
        id: "intellij",
        name: "IntelliJ IDEA",
        executables: &["idea64.exe", "idea.exe"],
    },
    EditorSpec {
        id: "intellij-community",
        name: "IntelliJ IDEA Community",
        executables: &["idea64.exe", "idea.exe"],
    },
    EditorSpec {
        id: "pycharm",
        name: "PyCharm",
        executables: &["pycharm64.exe", "pycharm.exe"],
    },
    EditorSpec {
        id: "pycharm-community",
        name: "PyCharm Community",
        executables: &["pycharm64.exe", "pycharm.exe"],
    },
];
#[derive(Default, Serialize, Deserialize)]
struct Preference {
    executable: Option<PathBuf>,
    #[serde(default)]
    editor_id: Option<String>,
}
#[derive(Serialize)]
pub struct EditorPreference {
    editor: &'static str,
    name: String,
    id: String,
}
#[derive(Serialize)]
pub struct EditorChoice {
    id: &'static str,
    name: &'static str,
}
#[derive(Serialize)]
pub struct InstalledTextEditors {
    editors: Vec<EditorChoice>,
}
// The native host owns discovery, file selection and process launch. Commands
// consume these capabilities without exposing executable paths or addresses to IPC.
trait EditorPlatform<R: tauri::Runtime>: Send + Sync {
    fn preference_path(&self, app: &tauri::AppHandle<R>) -> Result<PathBuf, String>;
    fn installed(&self) -> Vec<InstalledEditor>;
    fn cache_root(&self) -> PathBuf;
    fn choose(
        &self,
        dialog: tauri_plugin_dialog::FileDialogBuilder<R>,
    ) -> Option<tauri_plugin_dialog::FilePath>;
    fn launch(&self, command: &mut Command) -> Result<(), String>;
    fn attachment_endpoint(&self) -> std::net::SocketAddr;
}
struct NativeEditors;
impl<R: tauri::Runtime> EditorPlatform<R> for NativeEditors {
    fn preference_path(&self, app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
        preferences_path(app)
    }
    fn installed(&self) -> Vec<InstalledEditor> {
        detected_editors()
    }
    fn cache_root(&self) -> PathBuf {
        editor_cache_root(std::env::temp_dir())
    }
    fn choose(
        &self,
        dialog: tauri_plugin_dialog::FileDialogBuilder<R>,
    ) -> Option<tauri_plugin_dialog::FilePath> {
        dialog.blocking_pick_file()
    }
    fn launch(&self, command: &mut Command) -> Result<(), String> {
        command.spawn().map(|_| ()).map_err(|_| FAILED.into())
    }
    fn attachment_endpoint(&self) -> std::net::SocketAddr {
        crate::protocol::controller_endpoint()
    }
}
pub struct TextEditors<R: tauri::Runtime>(std::sync::Arc<dyn EditorPlatform<R>>);
impl<R: tauri::Runtime> Default for TextEditors<R> {
    fn default() -> Self {
        Self(std::sync::Arc::new(NativeEditors))
    }
}
fn platform<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> std::sync::Arc<dyn EditorPlatform<R>> {
    std::sync::Arc::clone(&app.state::<TextEditors<R>>().0)
}

struct InstalledEditor {
    spec: &'static EditorSpec,
    executable: PathBuf,
}
fn editor_spec(id: &str) -> Option<&'static EditorSpec> {
    EDITORS.iter().find(|spec| spec.id == id)
}
fn editor_basename(path: &Path, spec: &EditorSpec) -> bool {
    path.file_name().is_some_and(|name| {
        spec.executables
            .iter()
            .any(|allowed| name.to_string_lossy().eq_ignore_ascii_case(allowed))
    })
}

fn main_only<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(FAILED.into())
    }
}
fn linked(meta: &fs::Metadata) -> bool {
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
fn ordinary_directory(path: &Path, create: bool) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(FAILED.into());
    }
    let mut chain: Vec<_> = path.ancestors().collect();
    chain.reverse();
    for directory in chain {
        if !directory.exists() && create {
            fs::create_dir(directory).map_err(|_| FAILED)?;
        }
        let meta = fs::symlink_metadata(directory).map_err(|_| FAILED)?;
        if !meta.is_dir() || linked(&meta) {
            return Err(FAILED.into());
        }
    }
    Ok(())
}
fn bounded_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    bounded_file_using(path, limit, |selected| fs::File::open(selected))
}
fn bounded_file_using(
    path: &Path,
    limit: usize,
    open: impl FnOnce(&Path) -> std::io::Result<fs::File>,
) -> Result<Vec<u8>, String> {
    ordinary_directory(path.parent().ok_or(FAILED)?, false)?;
    let meta = fs::symlink_metadata(path).map_err(|_| FAILED)?;
    if !meta.is_file() || linked(&meta) || meta.len() > limit as u64 {
        return Err(FAILED.into());
    }
    use std::io::Read;
    let mut data = Vec::new();
    open(path)
        .map_err(|_| FAILED)?
        .take(limit as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|_| FAILED)?;
    if data.len() > limit {
        return Err(FAILED.into());
    }
    Ok(data)
}
fn preferences_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| FAILED)?
        .join("text-editor.json"))
}
fn read_preference(path: &Path) -> Result<Preference, String> {
    if !path.exists() {
        return Ok(Preference::default());
    }
    serde_json::from_slice(&bounded_file(path, EDITOR_PREFERENCES_MAX_BYTES)?)
        .map_err(|_| FAILED.into())
}
fn write_preference(path: &Path, value: &Preference) -> Result<(), String> {
    let parent = path.parent().ok_or(FAILED)?;
    ordinary_directory(parent, true)?;
    if let Ok(meta) = fs::symlink_metadata(path) {
        if !meta.is_file() || linked(&meta) {
            return Err(FAILED.into());
        }
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".text-editor-")
        .tempfile_in(parent)
        .map_err(|_| FAILED)?;
    temporary
        .write_all(&serde_json::to_vec(value).map_err(|_| FAILED)?)
        .map_err(|_| FAILED)?;
    temporary.as_file().sync_all().map_err(|_| FAILED)?;
    temporary.persist(path).map_err(|_| FAILED)?;
    Ok(())
}
fn preference_view(value: &Preference) -> EditorPreference {
    if value.executable.is_none() {
        return EditorPreference {
            editor: "notepad",
            name: "Notepad".into(),
            id: "notepad".into(),
        };
    }
    if let Some(spec) = value.editor_id.as_deref().and_then(editor_spec) {
        return EditorPreference {
            editor: "custom",
            name: spec.name.into(),
            id: spec.id.into(),
        };
    }
    EditorPreference {
        editor: "custom",
        id: "custom".into(),
        name: value
            .executable
            .as_ref()
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}
fn valid_editor(path: &Path) -> bool {
    if !path.is_absolute() || !EDITORS.iter().any(|spec| editor_basename(path, spec)) {
        return false;
    }
    if !path
        .parent()
        .is_some_and(|parent| ordinary_directory(parent, false).is_ok())
    {
        return false;
    }
    fs::symlink_metadata(path).is_ok_and(|meta| {
        meta.is_file() && !linked(&meta) && meta.len() > 0 && meta.len() <= EXECUTABLE_MAX_BYTES
    })
}
fn default_editor() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        default_editor_from(std::env::var_os("SystemRoot").map(PathBuf::from))
    }
    #[cfg(not(windows))]
    {
        Err("The built-in text editor is available on Windows.".into())
    }
}

fn default_editor_from(system_root: Option<PathBuf>) -> Result<PathBuf, String> {
    let path = system_root
        .ok_or(FAILED)?
        .join("System32")
        .join("notepad.exe");
    if valid_editor(&path) {
        Ok(path)
    } else {
        Err(FAILED.into())
    }
}

// Discovery never runs an executable or reads shell-open commands. Paths remain native-only.
fn installed_from_candidates(candidates: &[(String, PathBuf)]) -> Vec<InstalledEditor> {
    EDITORS
        .iter()
        .filter_map(|spec| {
            candidates
                .iter()
                .find(|(id, path)| {
                    if id != spec.id || !editor_basename(path, spec) || !valid_editor(path) {
                        return false;
                    }
                    use std::io::Read;
                    let mut magic = [0; 2];
                    fs::File::open(path).is_ok_and(|mut file| {
                        file.read_exact(&mut magic).is_ok() && magic == *b"MZ"
                    })
                })
                .map(|(_, path)| InstalledEditor {
                    spec,
                    executable: path.clone(),
                })
        })
        .collect()
}
fn inventory_view(installed: &[InstalledEditor]) -> InstalledTextEditors {
    InstalledTextEditors {
        editors: installed
            .iter()
            .map(|item| EditorChoice {
                id: item.spec.id,
                name: item.spec.name,
            })
            .collect(),
    }
}
fn selected_preference(id: &str, installed: &[InstalledEditor]) -> Result<Preference, String> {
    let item = installed
        .iter()
        .find(|item| item.spec.id == id)
        .ok_or("This editor is no longer installed. Choose another editor.")?;
    if id == "notepad" {
        return Ok(Preference::default());
    }
    Ok(Preference {
        executable: Some(item.executable.clone()),
        editor_id: Some(item.spec.id.into()),
    })
}
fn child_directories(root: &Path, budget: &mut usize) -> Vec<PathBuf> {
    if *budget == 0 || ordinary_directory(root, false).is_err() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for entry in entries.take(*budget).flatten() {
        *budget -= 1;
        let path = entry.path();
        if fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir() && !linked(&meta)) {
            result.push(path);
        }
    }
    result.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    result
}
fn jetbrains_id(name: &str) -> Option<&'static str> {
    let name = name.to_ascii_lowercase();
    if name.starts_with("intellij") || name == "idea-u" || name == "idea-c" {
        Some(if name.contains("community") || name == "idea-c" {
            "intellij-community"
        } else {
            "intellij"
        })
    } else if name.starts_with("pycharm") {
        Some(if name.contains("community") || name.contains("-c") {
            "pycharm-community"
        } else {
            "pycharm"
        })
    } else if name.starts_with("android studio") {
        Some("androidstudio")
    } else {
        None
    }
}
fn add_install(candidates: &mut Vec<(String, PathBuf)>, id: &str, root: &Path) {
    let Some(spec) = editor_spec(id) else { return };
    for filename in spec.executables {
        candidates.push((id.into(), root.join(filename)));
        candidates.push((id.into(), root.join("bin").join(filename)));
    }
    if id == "visualstudio" {
        candidates.push((
            id.into(),
            root.join("Common7").join("IDE").join("devenv.exe"),
        ));
    }
}
fn common_candidates(
    system_root: Option<&Path>,
    local: Option<&Path>,
    program_roots: &[PathBuf],
) -> Vec<(String, PathBuf)> {
    let mut candidates = Vec::new();
    if let Some(root) = system_root {
        candidates.push(("notepad".into(), root.join("System32").join("notepad.exe")));
    }
    let mut roots = Vec::new();
    if let Some(local) = local {
        roots.push(local.join("Programs"));
    }
    roots.extend_from_slice(program_roots);
    for root in &roots {
        for (id, folder) in [
            ("vscode", "Microsoft VS Code"),
            ("vscode-insiders", "Microsoft VS Code Insiders"),
            ("notepadpp", "Notepad++"),
            ("notepad3", "Notepad3"),
            ("notepad4", "Notepad4"),
            ("sublime", "Sublime Text"),
            ("sublime", "Sublime Text 3"),
            ("zed", "Zed"),
            ("cursor", "Cursor"),
            ("androidstudio", "Android/Android Studio"),
        ] {
            add_install(&mut candidates, id, &root.join(folder));
        }
        let mut budget = 128;
        for directory in child_directories(&root.join("JetBrains"), &mut budget) {
            if let Some(id) = directory
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(jetbrains_id)
            {
                add_install(&mut candidates, id, &directory);
            }
        }
        let mut budget = 128;
        for version in child_directories(&root.join("Microsoft Visual Studio"), &mut budget) {
            for edition in child_directories(&version, &mut budget) {
                add_install(&mut candidates, "visualstudio", &edition);
            }
        }
    }
    if let Some(local) = local {
        add_install(&mut candidates, "zed", &local.join("Zed"));
        // Toolbox has both old <product>/ch-0/<version> and new <product> layouts.
        let mut budget = 256;
        for product in child_directories(&local.join("JetBrains/Toolbox/apps"), &mut budget) {
            let Some(id) = product
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(jetbrains_id)
            else {
                continue;
            };
            let mut pending = vec![(product, 0)];
            while let Some((directory, depth)) = pending.pop() {
                add_install(&mut candidates, id, &directory);
                if depth < 3 {
                    pending.extend(
                        child_directories(&directory, &mut budget)
                            .into_iter()
                            .map(|child| (child, depth + 1)),
                    );
                }
            }
        }
    }
    candidates
}

#[cfg(windows)]
#[path = "text_editor/registry.rs"]
mod registry;

struct EditorRoots {
    system: Option<PathBuf>,
    local: Option<PathBuf>,
    programs: Vec<PathBuf>,
}
impl EditorRoots {
    fn capture() -> Self {
        Self {
            system: std::env::var_os("SystemRoot").map(PathBuf::from),
            local: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
            programs: ["ProgramFiles", "ProgramFiles(x86)"]
                .iter()
                .filter_map(std::env::var_os)
                .map(PathBuf::from)
                .collect(),
        }
    }
}
fn detected_with(
    roots: &EditorRoots,
    registered: impl IntoIterator<Item = (String, PathBuf)>,
) -> Vec<InstalledEditor> {
    let mut candidates = common_candidates(
        roots.system.as_deref(),
        roots.local.as_deref(),
        &roots.programs,
    );
    candidates.extend(registered);
    installed_from_candidates(&candidates)
}
fn detected_editors() -> Vec<InstalledEditor> {
    let roots = EditorRoots::capture();
    #[cfg(windows)]
    let registered = registry::candidates();
    #[cfg(not(windows))]
    let registered = Vec::new();
    detected_with(&roots, registered)
}
fn resolve_preference(
    value: &Preference,
    installed: &[InstalledEditor],
) -> Result<PathBuf, String> {
    if let Some(id) = value.editor_id.as_deref() {
        if id != "custom" {
            return installed
                .iter()
                .find(|item| item.spec.id == id)
                .map(|item| item.executable.clone())
                .ok_or_else(|| FAILED.into());
        }
    }
    match value.executable.as_ref() {
        Some(path) if valid_editor(path) => Ok(path.clone()),
        Some(_) => Err(FAILED.into()),
        None => default_editor(),
    }
}
fn editor_command(executable: &Path, target: &Path) -> Command {
    // External editors do not uniformly accept the Windows verbatim namespace
    // returned by native path APIs. Keep each path as one native argument.
    let target = crate::runtime_path(target.to_path_buf());
    let mut command = Command::new(crate::runtime_path(executable.to_path_buf()));
    if executable
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("devenv.exe"))
    {
        command.arg("/Edit");
    }
    command
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}
fn valid_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn known_text(name: &str) -> bool {
    Path::new(name).extension().is_some_and(|extension| {
        [
            "json", "txt", "md", "csv", "tsv", "log", "yaml", "yml", "xml", "svg", "toml", "ini",
            "conf", "cfg", "py", "js", "mjs", "cjs", "jsx", "ts", "tsx", "css", "htm", "html",
            "sh", "bash", "ps1", "bat", "cmd", "sql", "rs", "go", "java", "c", "h", "cpp", "hpp",
        ]
        .iter()
        .any(|allowed| extension.to_string_lossy().eq_ignore_ascii_case(allowed))
    })
}
fn text_payload(bytes: &[u8], name: &str, mime: &str) -> bool {
    if bytes.len() > MAX_BYTES
        || Path::new(name).extension().is_some_and(|extension| {
            ["exe", "com", "msi", "dll", "scr"]
                .iter()
                .any(|value| extension.to_string_lossy().eq_ignore_ascii_case(value))
        })
    {
        return false;
    }
    let mime = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let textual = [
        "application/xml",
        "application/javascript",
        "application/x-javascript",
        "application/typescript",
        "application/x-typescript",
        "application/yaml",
        "application/x-yaml",
        "application/toml",
        "application/sql",
        "application/graphql",
        "application/x-sh",
        "application/x-shellscript",
    ]
    .contains(&mime.as_str());
    if !(mime.starts_with("text/")
        || textual
        || mime == "application/json"
        || mime.starts_with("application/") && mime.ends_with("+json")
        || mime == "application/octet-stream" && known_text(name))
    {
        return false;
    }
    std::str::from_utf8(bytes).is_ok_and(|text| {
        !text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    })
}
fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut value: String = last
        .chars()
        .filter(|ch| !ch.is_control() && !"<>:\"|?*".contains(*ch))
        .collect();
    value = value.trim().trim_matches('.').trim().to_string();
    if value.is_empty() {
        value = "attachment.txt".into()
    }
    if value.chars().count() > 140 {
        let extension = value
            .rsplit_once('.')
            .filter(|(_, extension)| {
                !extension.is_empty()
                    && extension.len() <= 16
                    && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
            .map(|(_, extension)| format!(".{extension}"))
            .unwrap_or_default();
        value = value
            .chars()
            .take(140 - extension.len())
            .collect::<String>()
            + &extension;
    }
    if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(
        &value
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end()
            .to_ascii_uppercase()
            .as_str(),
    ) {
        value.insert(0, '_');
    }
    value
}
fn editor_cache_root(temporary: PathBuf) -> PathBuf {
    // Packaged Windows editors can observe a different AppData view. Exchange
    // files through the user's shared temporary directory, outside app caches.
    crate::runtime_path(temporary).join(EDITOR_CACHE_DIRECTORY)
}
fn cache_copy(root: &Path, id: &str, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if !valid_id(id) || bytes.len() > MAX_BYTES {
        return Err(FAILED.into());
    }
    ordinary_directory(root, true)?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    let directory = root.join(format!("{id}-{hash}"));
    ordinary_directory(&directory, true)?;
    let mut target = directory.join(safe_name(name));
    if target.exists() {
        if bounded_file(&target, MAX_BYTES)? == bytes {
            return Ok(target);
        }
        // Preserve a user's edits to an earlier cache copy; never overwrite it.
        let fresh = tempfile::Builder::new()
            .prefix(&format!("{id}-{hash}-"))
            .tempdir_in(root)
            .map_err(|_| FAILED)?
            .keep();
        target = fresh.join(safe_name(name));
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|_| FAILED)?;
    output.write_all(bytes).map_err(|_| FAILED)?;
    output.sync_all().map_err(|_| FAILED)?;
    Ok(target)
}
fn expire_cache(root: &Path) {
    if ordinary_directory(root, false).is_err() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.take(CACHE_SCAN_LIMIT).flatten() {
        let directory = entry.path();
        if ordinary_directory(&directory, false).is_err() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.is_ascii()
            || name.len() < 101
            || !valid_id(&name[..36])
            || name.as_bytes()[36] != b'-'
            || !name.as_bytes()[37..101]
                .iter()
                .all(|b| b.is_ascii_hexdigit())
        {
            continue;
        }
        let Ok(children) = fs::read_dir(&directory) else {
            continue;
        };
        let children: Vec<_> = children.take(2).flatten().collect();
        if children.len() != 1 {
            continue;
        }
        let target = children[0].path();
        let Ok(meta) = fs::symlink_metadata(&target) else {
            continue;
        };
        if !meta.is_file()
            || linked(&meta)
            || !meta
                .modified()
                .ok()
                .and_then(|time| now.duration_since(time).ok())
                .is_some_and(|age| age > CACHE_RETENTION)
        {
            continue;
        }
        if let Ok(bytes) = bounded_file(&target, MAX_BYTES) {
            if format!("{:x}", Sha256::digest(&bytes)) == name[37..101]
                && fs::remove_file(target).is_ok()
            {
                let _ = fs::remove_dir(directory);
            }
        }
    }
}

#[tauri::command]
pub fn editor_preferences<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
) -> Result<EditorPreference, String> {
    main_only(&window)?;
    Ok(preference_view(&read_preference(
        &platform(&app).preference_path(&app)?,
    )?))
}
#[tauri::command]
pub async fn installed_text_editors<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
) -> Result<InstalledTextEditors, String> {
    main_only(&window)?;
    let host = platform(&app);
    tauri::async_runtime::spawn_blocking(move || Ok(inventory_view(&host.installed())))
        .await
        .map_err(|_| FAILED.to_string())?
}
#[tauri::command]
pub async fn select_text_editor<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    editor_id: String,
) -> Result<EditorPreference, String> {
    main_only(&window)?;
    let host = platform(&app);
    tauri::async_runtime::spawn_blocking(move || {
        if editor_spec(&editor_id).is_none() {
            return Err(FAILED.into());
        }
        let value = selected_preference(&editor_id, &host.installed())?;
        write_preference(&host.preference_path(&app)?, &value)?;
        Ok(preference_view(&value))
    })
    .await
    .map_err(|_| FAILED.to_string())?
}
#[tauri::command]
pub fn reset_text_editor<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
) -> Result<EditorPreference, String> {
    main_only(&window)?;
    let value = Preference::default();
    write_preference(&platform(&app).preference_path(&app)?, &value)?;
    Ok(preference_view(&value))
}
#[tauri::command]
pub async fn choose_text_editor<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
) -> Result<Option<EditorPreference>, String> {
    main_only(&window)?;
    let host = platform(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let chosen = host.choose(app.dialog().file().set_parent(&window).add_filter("Text editor", &["exe"]));
        let Some(chosen) = chosen else { return Ok(None) };
        let path = chosen.into_path().map_err(|_| FAILED)?;
        if !valid_editor(&path) {
            return Err("Choose a supported text editor executable, such as Code.exe, notepad++.exe or sublime_text.exe.".into());
        }
        let value = Preference { executable: Some(path), editor_id: None };
        write_preference(&host.preference_path(&app)?, &value)?;
        Ok(Some(preference_view(&value)))
    }).await.map_err(|_| FAILED.to_string())?
}
async fn attachment_text_at(
    endpoint: std::net::SocketAddr,
    file_id: &str,
    token: &str,
    file_name: &str,
) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(crate::protocol::ATTACHMENT_REQUEST_TIMEOUT)
        .build()
        .map_err(|_| FAILED)?;
    let mut response = client
        .get(format!(
            "http://{endpoint}{}/files/{file_id}",
            crate::protocol::api_prefix()
        ))
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
    let mime = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| FAILED)? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(FAILED.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !text_payload(&bytes, file_name, &mime) {
        return Err(FAILED.into());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn open_attachment_in_editor<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    file_id: String,
    token: String,
    file_name: String,
) -> Result<serde_json::Value, String> {
    main_only(&window)?;
    if !valid_id(&file_id)
        || token.len() != crate::protocol::CONTROLLER_TOKEN_HEX_CHARS
        || !token.bytes().all(|b| b.is_ascii_hexdigit())
        || file_name.len() > 1024
    {
        return Err(FAILED.into());
    }
    let host = platform(&app);
    let bytes =
        attachment_text_at(host.attachment_endpoint(), &file_id, &token, &file_name).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let preference = read_preference(&host.preference_path(&app)?)?;
        let executable = resolve_preference(&preference, &host.installed())?;
        let root = host.cache_root();
        expire_cache(&root);
        let target = cache_copy(&root, &file_id, &file_name, &bytes)?;
        host.launch(&mut editor_command(&executable, &target))?;
        Ok(serde_json::json!({"opened":true}))
    })
    .await
    .map_err(|_| FAILED.to_string())?
}

#[cfg(test)]
#[path = "../../tests/native/rust/text_editor.rs"]
mod tests;
