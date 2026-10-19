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

const MAX_BYTES: usize = 10 * 1024 * 1024;
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

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
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
    ordinary_directory(path.parent().ok_or(FAILED)?, false)?;
    let meta = fs::symlink_metadata(path).map_err(|_| FAILED)?;
    if !meta.is_file() || linked(&meta) || meta.len() > limit as u64 {
        return Err(FAILED.into());
    }
    use std::io::Read;
    let mut data = Vec::new();
    fs::File::open(path)
        .map_err(|_| FAILED)?
        .take(limit as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|_| FAILED)?;
    if data.len() > limit {
        return Err(FAILED.into());
    }
    Ok(data)
}
fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
    serde_json::from_slice(&bounded_file(path, 8192)?).map_err(|_| FAILED.into())
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
        meta.is_file() && !linked(&meta) && meta.len() > 0 && meta.len() <= 512 * 1024 * 1024
    })
}
fn default_editor() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let path = PathBuf::from(std::env::var_os("SystemRoot").ok_or(FAILED)?)
            .join("System32")
            .join("notepad.exe");
        if valid_editor(&path) {
            Ok(path)
        } else {
            Err(FAILED.into())
        }
    }
    #[cfg(not(windows))]
    {
        Err("The built-in text editor is available on Windows.".into())
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
mod registry {
    use super::*;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    type Hkey = isize;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            key: Hkey,
            name: *const u16,
            options: u32,
            access: u32,
            result: *mut Hkey,
        ) -> i32;
        fn RegQueryValueExW(
            key: Hkey,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            length: *mut u32,
        ) -> i32;
        fn RegEnumKeyExW(
            key: Hkey,
            index: u32,
            name: *mut u16,
            length: *mut u32,
            reserved: *mut u32,
            class: *mut u16,
            class_length: *mut u32,
            modified: *mut core::ffi::c_void,
        ) -> i32;
        fn RegCloseKey(key: Hkey) -> i32;
    }
    struct Key(Hkey);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(Some(0))
            .collect()
    }
    fn open(parent: Hkey, name: &str, view: u32) -> Option<Key> {
        let mut key = 0;
        if unsafe { RegOpenKeyExW(parent, wide(name).as_ptr(), 0, 0x20019 | view, &mut key) } == 0 {
            Some(Key(key))
        } else {
            None
        }
    }
    fn value(key: &Key, name: &str) -> Option<String> {
        let mut kind = 0;
        let mut data = [0u16; 4096];
        let mut length = (data.len() * 2) as u32;
        if unsafe {
            RegQueryValueExW(
                key.0,
                wide(name).as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                data.as_mut_ptr().cast(),
                &mut length,
            )
        } != 0
            || !matches!(kind, 1 | 2)
            || length % 2 != 0
            || length as usize > data.len() * 2
        {
            return None;
        }
        let units = &data[..length as usize / 2];
        let end = units
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(units.len());
        let result = std::ffi::OsString::from_wide(&units[..end])
            .into_string()
            .ok()?;
        if result.contains('%') || result.contains('\0') {
            None
        } else {
            Some(result)
        }
    }
    pub(super) fn candidates() -> Vec<(String, PathBuf)> {
        let mut result = Vec::new();
        for hive in [0x80000001u32 as i32 as isize, 0x80000002u32 as i32 as isize] {
            for view in [0x100, 0x200] {
                // Shared JetBrains executable names do not identify the installed edition.
                for spec in EDITORS.iter().filter(|spec| {
                    ![
                        "notepad",
                        "intellij",
                        "intellij-community",
                        "pycharm",
                        "pycharm-community",
                    ]
                    .contains(&spec.id)
                }) {
                    for executable in spec.executables {
                        if let Some(path) = open(hive, &format!("Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{executable}"), view).and_then(|key| value(&key, "")) { result.push((spec.id.into(), PathBuf::from(path.trim_matches('"')))); }
                    }
                }
                if let Some(parent) = open(
                    hive,
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                    view,
                ) {
                    for index in 0..512 {
                        let mut name = [0u16; 512];
                        let mut length = name.len() as u32;
                        let status = unsafe {
                            RegEnumKeyExW(
                                parent.0,
                                index,
                                name.as_mut_ptr(),
                                &mut length,
                                std::ptr::null_mut(),
                                std::ptr::null_mut(),
                                std::ptr::null_mut(),
                                std::ptr::null_mut(),
                            )
                        };
                        if status == 259 {
                            break;
                        }
                        if status != 0 {
                            continue;
                        }
                        let Some(name) = String::from_utf16(&name[..length as usize]).ok() else {
                            continue;
                        };
                        let Some(key) = open(parent.0, &name, 0) else {
                            continue;
                        };
                        let (Some(display), Some(location)) =
                            (value(&key, "DisplayName"), value(&key, "InstallLocation"))
                        else {
                            continue;
                        };
                        let Some(id) = jetbrains_id(&display) else {
                            continue;
                        };
                        add_install(&mut result, id, Path::new(&location));
                    }
                }
            }
        }
        result
    }
}
fn detected_editors() -> Vec<InstalledEditor> {
    let system = std::env::var_os("SystemRoot").map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let roots: Vec<_> = ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect();
    let mut candidates = common_candidates(system.as_deref(), local.as_deref(), &roots);
    #[cfg(windows)]
    candidates.extend(registry::candidates());
    installed_from_candidates(&candidates)
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
    for entry in entries.take(128).flatten() {
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
                .is_some_and(|age| age > Duration::from_secs(3 * 24 * 60 * 60))
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
pub fn editor_preferences(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<EditorPreference, String> {
    main_only(&window)?;
    Ok(preference_view(&read_preference(&preferences_path(&app)?)?))
}
#[tauri::command]
pub async fn installed_text_editors(
    window: tauri::WebviewWindow,
) -> Result<InstalledTextEditors, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(|| Ok(inventory_view(&detected_editors())))
        .await
        .map_err(|_| FAILED.to_string())?
}
#[tauri::command]
pub async fn select_text_editor(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    editor_id: String,
) -> Result<EditorPreference, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if editor_spec(&editor_id).is_none() {
            return Err(FAILED.into());
        }
        let value = selected_preference(&editor_id, &detected_editors())?;
        write_preference(&preferences_path(&app)?, &value)?;
        Ok(preference_view(&value))
    })
    .await
    .map_err(|_| FAILED.to_string())?
}
#[tauri::command]
pub fn reset_text_editor(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<EditorPreference, String> {
    main_only(&window)?;
    let value = Preference::default();
    write_preference(&preferences_path(&app)?, &value)?;
    Ok(preference_view(&value))
}
#[tauri::command]
pub async fn choose_text_editor(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<EditorPreference>, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || { let chosen = app.dialog().file().set_parent(&window).add_filter("Text editor", &["exe"]).blocking_pick_file(); let Some(chosen) = chosen else { return Ok(None) }; let path = chosen.into_path().map_err(|_| FAILED)?; if !valid_editor(&path) { return Err("Choose a supported text editor executable, such as Code.exe, notepad++.exe or sublime_text.exe.".into()) } let value = Preference { executable: Some(path), editor_id: None }; write_preference(&preferences_path(&app)?, &value)?; Ok(Some(preference_view(&value))) }).await.map_err(|_| FAILED.to_string())?
}
#[tauri::command]
pub async fn open_attachment_in_editor(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    file_id: String,
    token: String,
    file_name: String,
) -> Result<serde_json::Value, String> {
    main_only(&window)?;
    if !valid_id(&file_id)
        || token.len() != 64
        || !token.bytes().all(|b| b.is_ascii_hexdigit())
        || file_name.len() > 1024
    {
        return Err(FAILED.into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| FAILED)?;
    let mut response = client
        .get(format!("http://127.0.0.1:4317/api/files/{file_id}"))
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
    if !text_payload(&bytes, &file_name, &mime) {
        return Err(FAILED.into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let preference = read_preference(&preferences_path(&app)?)?;
        let executable = resolve_preference(&preference, &detected_editors())?;
        let root = editor_cache_root(std::env::temp_dir());
        expire_cache(&root);
        let target = cache_copy(&root, &file_id, &file_name, &bytes)?;
        editor_command(&executable, &target)
            .spawn()
            .map_err(|_| FAILED)?;
        Ok(serde_json::json!({"opened":true}))
    })
    .await
    .map_err(|_| FAILED.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn installed_fixture(path: &Path) -> PathBuf {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"MZ isolated test fixture, never executed").unwrap();
        path.to_path_buf()
    }
    #[test]
    fn discovery_lists_real_supported_editors_once_without_exposing_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let system = root.join("Windows");
        let local = root.join("AppData/Local");
        let programs = root.join("Program Files");
        installed_fixture(&system.join("System32/notepad.exe"));
        installed_fixture(&local.join("Programs/Microsoft VS Code/Code.exe"));
        installed_fixture(&programs.join("Microsoft VS Code/Code.exe"));
        installed_fixture(&programs.join("Microsoft VS Code Insiders/Code - Insiders.exe"));
        installed_fixture(&programs.join("Notepad++/notepad++.exe"));
        installed_fixture(&programs.join("Android/Android Studio/bin/studio64.exe"));
        installed_fixture(
            &programs.join("JetBrains/IntelliJ IDEA Community Edition 2026.2/bin/idea64.exe"),
        );
        installed_fixture(
            &local.join("JetBrains/Toolbox/apps/PyCharm-C/ch-0/2026.2/bin/pycharm64.exe"),
        );
        installed_fixture(
            &programs.join("Microsoft Visual Studio/2026/Community/Common7/IDE/devenv.exe"),
        );
        let detected =
            installed_from_candidates(&common_candidates(Some(&system), Some(&local), &[programs]));
        let ids: Vec<_> = detected.iter().map(|item| item.spec.id).collect();
        assert_eq!(
            ids,
            [
                "notepad",
                "vscode",
                "vscode-insiders",
                "notepadpp",
                "visualstudio",
                "androidstudio",
                "intellij-community",
                "pycharm-community"
            ]
        );
        assert_eq!(
            detected
                .iter()
                .find(|item| item.spec.id == "vscode")
                .unwrap()
                .executable,
            local.join("Programs/Microsoft VS Code/code.exe")
        );
        let view = serde_json::to_value(inventory_view(&detected)).unwrap();
        assert_eq!(
            view["editors"][1],
            serde_json::json!({"id":"vscode","name":"Visual Studio Code"})
        );
        let encoded = view.to_string();
        assert!(!encoded.contains("executable"));
        assert!(!encoded.contains(root.to_str().unwrap()));
        assert!(!encoded.contains("path"));
    }
    #[test]
    fn discovery_rejects_missing_non_executable_wrong_app_and_shell_candidates() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let code = installed_fixture(&root.join("Code.exe"));
        let command = installed_fixture(&root.join("cmd.exe"));
        let text = root.join("cursor.exe");
        fs::write(&text, b"not a Windows executable").unwrap();
        let empty = root.join("zed.exe");
        fs::write(&empty, b"").unwrap();
        let candidates = vec![
            ("vscode".into(), root.join("missing/Code.exe")),
            ("vscode".into(), root.to_path_buf()),
            ("vscode".into(), PathBuf::from("Code.exe")),
            ("vscode".into(), command),
            ("cursor".into(), code.clone()),
            ("cursor".into(), text),
            ("zed".into(), empty),
            ("custom".into(), code.clone()),
            ("vscode".into(), code),
        ];
        let inventory = installed_from_candidates(&candidates);
        assert_eq!(inventory.len(), 1);
        assert_eq!(inventory[0].spec.id, "vscode");
        for invalid in [
            "custom",
            "cmd",
            "C:\\Windows\\System32\\cmd.exe",
            "vscode --wait",
            "../vscode",
            "cursor",
        ] {
            assert!(selected_preference(invalid, &inventory).is_err());
        }
    }
    #[test]
    fn fixed_id_selection_preserves_legacy_preferences_and_re_resolves_updated_installations() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let file = root.join("preference.json");
        let previous = installed_fixture(&root.join("old/Code.exe"));
        let next = installed_fixture(&root.join("new/Code.exe"));
        let inventory = installed_from_candidates(&[("vscode".into(), previous.clone())]);
        let selected = selected_preference("vscode", &inventory).unwrap();
        write_preference(&file, &selected).unwrap();
        let saved = fs::read(&file).unwrap();
        let view = preference_view(&read_preference(&file).unwrap());
        assert_eq!(view.id, "vscode");
        assert_eq!(view.name, "Visual Studio Code");
        assert_eq!(view.editor, "custom");
        assert!(selected_preference("cursor", &inventory).is_err());
        assert_eq!(fs::read(&file).unwrap(), saved);
        fs::remove_file(previous).unwrap();
        let updated = installed_from_candidates(&[("vscode".into(), next.clone())]);
        assert_eq!(resolve_preference(&selected, &updated).unwrap(), next);
        assert!(resolve_preference(&selected, &[]).is_err());
        // Files saved by older versions have no editor_id and keep their chosen executable.
        let legacy: Preference =
            serde_json::from_value(serde_json::json!({"executable":next})).unwrap();
        assert_eq!(preference_view(&legacy).id, "custom");
        assert_eq!(resolve_preference(&legacy, &[]).unwrap(), next);
        let default_view = preference_view(&Preference::default());
        assert_eq!(default_view.id, "notepad");
        assert_eq!(default_view.editor, "notepad");
    }
    #[test]
    fn launch_arguments_are_fixed_single_file_arguments_without_a_shell() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let target = root.join("hello & $(whoami) \"file\".txt");
        for executable in [
            "Code.exe",
            "notepad++.exe",
            "studio64.exe",
            "idea64.exe",
            "pycharm64.exe",
            "devenv.exe",
        ] {
            let executable = root.join(executable);
            let command = editor_command(&executable, &target);
            assert_eq!(command.get_program(), executable.as_os_str());
            let args: Vec<_> = command.get_args().collect();
            if executable.ends_with("devenv.exe") {
                assert_eq!(
                    args,
                    vec![std::ffi::OsStr::new("/Edit"), target.as_os_str()]
                );
            } else {
                assert_eq!(args, vec![target.as_os_str()]);
            }
        }
    }
    #[cfg(windows)]
    #[test]
    fn cached_unicode_text_is_closed_and_launches_with_normal_windows_paths() {
        use std::os::windows::fs::OpenOptionsExt;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("编辑器 cache with spaces");
        let bytes = "中文原文\r\nAn exact downloaded UTF-8 attachment\n".as_bytes();
        let target = cache_copy(
            &root,
            "10b72b2a-346f-48c0-a243-1cb22871d91d",
            "项目 notes & results.txt",
            bytes,
        )
        .unwrap();
        let executable =
            installed_fixture(&directory.path().join("editor app").join("notepad.exe"));
        let canonical_target = target.canonicalize().unwrap();
        let canonical_executable = executable.canonicalize().unwrap();
        assert!(canonical_target.to_string_lossy().starts_with(r"\\?\"));
        let command = editor_command(&canonical_executable, &canonical_target);
        assert_eq!(command.get_program(), executable.as_os_str());
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, vec![target.as_os_str()]);
        assert_eq!(fs::read(Path::new(args[0])).unwrap(), bytes);
        // An exclusive reader proves the cache writer has flushed and closed
        // before the external process receives the persistent file path.
        let mut reader = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        let mut observed = Vec::new();
        std::io::Read::read_to_end(&mut reader, &mut observed).unwrap();
        assert_eq!(observed, bytes);
        drop(reader);
        assert_eq!(
            cache_copy(
                &root,
                "10b72b2a-346f-48c0-a243-1cb22871d91d",
                "项目 notes & results.txt",
                bytes
            )
            .unwrap(),
            target
        );
    }
    #[cfg(windows)]
    #[test]
    fn editor_launch_preserves_unc_paths_as_one_literal_argument() {
        let executable = Path::new(r"\\?\UNC\server\share\editor app\devenv.exe");
        let target = Path::new(r"\\?\UNC\server\share\中文 & notes\result.txt");
        let command = editor_command(executable, target);
        assert_eq!(
            command.get_program(),
            std::ffi::OsStr::new(r"\\server\share\editor app\devenv.exe")
        );
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![
                std::ffi::OsStr::new("/Edit"),
                std::ffi::OsStr::new(r"\\server\share\中文 & notes\result.txt")
            ]
        );
    }
    #[test]
    fn only_plain_utf8_text_uses_a_text_editor_without_file_associations() {
        assert!(text_payload(
            "中文\nEnglish".as_bytes(),
            "note.txt",
            "text/plain"
        ));
        assert!(text_payload(
            b"<script>not executed</script>",
            "page.html",
            "application/octet-stream"
        ));
        assert!(text_payload(b"<xml/>", "source.xml", "application/xml"));
        assert!(text_payload(
            b"console.log('read only')",
            "source.js",
            "application/javascript"
        ));
        assert!(text_payload(
            b"name: fixture",
            "source.yaml",
            "application/yaml"
        ));
        assert!(!text_payload(&[255], "bad.txt", "text/plain"));
        assert!(!text_payload(b"x\0", "bad.txt", "text/plain"));
        assert!(!text_payload(b"text", "bad.exe", "text/plain"));
        assert!(!text_payload(
            b"text",
            "bad.zip",
            "application/octet-stream"
        ));
        assert!(!text_payload(b"{}", "bad.json", "image/png"));
        assert_eq!(safe_name("../../CON.txt"), "_CON.txt");
        assert_eq!(safe_name("\0<>:*"), "attachment.txt");
        assert!(!valid_editor(Path::new("cmd.exe")));
        assert!(!valid_editor(Path::new("C:\\Windows\\System32\\cmd.exe")));
    }
    #[test]
    fn stable_cache_preserves_original_bytes_and_user_edits_without_changing_the_attachment() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("cache");
        let id = "10b72b2a-346f-48c0-a243-1cb22871d91d";
        let first = cache_copy(&root, id, "result.json", b"{\"ok\":true}").unwrap();
        assert_eq!(
            cache_copy(&root, id, "result.json", b"{\"ok\":true}").unwrap(),
            first
        );
        fs::write(&first, b"user edit").unwrap();
        let next = cache_copy(&root, id, "result.json", b"{\"ok\":true}").unwrap();
        assert_ne!(next, first);
        assert_eq!(fs::read(first).unwrap(), b"user edit");
        assert_eq!(fs::read(next).unwrap(), b"{\"ok\":true}");
        assert!(cache_copy(&root, "../outside", "result.json", b"x").is_err());
        assert!(cache_copy(&root, id, "result.json", &vec![0; MAX_BYTES + 1]).is_err());
    }
    #[test]
    fn shared_temporary_cache_keeps_old_appdata_edits_and_reuses_exact_copies() {
        let directory = tempfile::tempdir().unwrap();
        let id = "10b72b2a-346f-48c0-a243-1cb22871d91d";
        let legacy_root = directory
            .path()
            .join("AppData/Local/com.dant.desktop/text-editor");
        let legacy = cache_copy(&legacy_root, id, "notes.md", b"original").unwrap();
        fs::write(&legacy, b"user's existing edit").unwrap();
        let temporary = directory.path().join("shared temporary");
        let root = editor_cache_root(temporary.clone());
        assert_eq!(root, temporary.join(EDITOR_CACHE_DIRECTORY));
        assert!(!root.starts_with(&legacy_root));
        let copied = cache_copy(&root, id, "notes.md", b"original").unwrap();
        assert_eq!(fs::read(&copied).unwrap(), b"original");
        assert_eq!(
            cache_copy(&root, id, "notes.md", b"original").unwrap(),
            copied
        );
        fs::write(&copied, b"new user edit").unwrap();
        let next = cache_copy(&root, id, "notes.md", b"original").unwrap();
        assert_ne!(next, copied);
        expire_cache(&root);
        assert_eq!(fs::read(next).unwrap(), b"original");
        assert_eq!(fs::read(copied).unwrap(), b"new user edit");
        assert_eq!(fs::read(legacy).unwrap(), b"user's existing edit");
    }
    #[test]
    fn preferences_are_atomic_and_return_only_the_editor_basename() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("settings").join("text-editor.json");
        assert_eq!(
            preference_view(&read_preference(&file).unwrap()).editor,
            "notepad"
        );
        let preference = Preference {
            executable: Some(directory.path().join("Code.exe")),
            editor_id: None,
        };
        write_preference(&file, &preference).unwrap();
        let loaded = read_preference(&file).unwrap();
        assert_eq!(preference_view(&loaded).name, "Code.exe");
        assert_eq!(preference_view(&loaded).editor, "custom");
        assert_eq!(preference_view(&loaded).id, "custom");
        write_preference(&file, &Preference::default()).unwrap();
        assert_eq!(
            preference_view(&read_preference(&file).unwrap()).name,
            "Notepad"
        );
        fs::write(&file, b"malformed").unwrap();
        assert!(read_preference(&file).is_err());
        assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
    }
    #[test]
    fn expiry_removes_only_old_unchanged_owned_copies_and_preserves_edits_and_unrelated_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("cache");
        let id = "10b72b2a-346f-48c0-a243-1cb22871d91d";
        let unchanged = cache_copy(&root, id, "old.txt", b"original").unwrap();
        let edited = cache_copy(&root, id, "edited.txt", b"different").unwrap();
        fs::write(&edited, b"user edit").unwrap();
        let old = SystemTime::now() - Duration::from_secs(4 * 24 * 60 * 60);
        for path in [&unchanged, &edited] {
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(old))
                .unwrap();
        }
        let unrelated = root.join("中文目录".repeat(20));
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("keep.txt"), b"keep").unwrap();
        expire_cache(&root);
        assert!(!unchanged.exists());
        assert!(!unchanged.parent().unwrap().exists());
        assert_eq!(fs::read(edited).unwrap(), b"user edit");
        assert_eq!(fs::read(unrelated.join("keep.txt")).unwrap(), b"keep");
    }
}
