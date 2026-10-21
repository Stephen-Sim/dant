use super::*;

use crate::native_http::Server;

#[cfg(windows)]
#[test]
fn exclusive_directory_sharing_locks_keep_discovery_bounded_and_preserve_cached_files() {
    use std::os::windows::fs::OpenOptionsExt;
    const DIRECTORY_AND_REPARSE_POINT: u32 = 0x02000000 | 0x00200000;
    let root = tempfile::tempdir().unwrap();
    let inventory = root.path().join("inventory");
    fs::create_dir_all(inventory.join("owned-editor")).unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .custom_flags(DIRECTORY_AND_REPARSE_POINT)
        .open(&inventory)
        .unwrap();
    assert!(ordinary_directory(&inventory, false).is_ok());
    assert!(fs::read_dir(&inventory).is_err());
    let mut budget = 4;
    assert!(child_directories(&inventory, &mut budget).is_empty());
    assert_eq!(budget, 4);
    expire_cache(&inventory);
    drop(lock);
    assert!(inventory.join("owned-editor").is_dir());

    let cache = root.path().join("cache");
    let target = cache_copy(
        &cache,
        "10b72b2a-346f-48c0-a243-1cb22871d91d",
        "owned-note.txt",
        b"cached note",
    )
    .unwrap();
    fs::File::options()
        .write(true)
        .open(&target)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(SystemTime::now() - CACHE_RETENTION - Duration::from_secs(60)),
        )
        .unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .custom_flags(DIRECTORY_AND_REPARSE_POINT)
        .open(target.parent().unwrap())
        .unwrap();
    assert!(fs::read_dir(target.parent().unwrap()).is_err());
    expire_cache(&cache);
    drop(lock);
    assert_eq!(fs::read(&target).unwrap(), b"cached note");
    expire_cache(&cache);
    assert!(!target.exists());
}

#[test]
fn bounded_editor_read_refuses_a_file_that_grows_after_metadata_and_sanitizes_open_failures() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("owned-note.md");
    fs::write(&path, b"short").unwrap();
    assert_eq!(
        bounded_file_using(&path, 8, |selected| {
            assert_eq!(selected, path);
            fs::write(selected, b"became larger than the permitted limit").unwrap();
            fs::File::open(selected)
        })
        .unwrap_err(),
        FAILED
    );
    fs::write(&path, b"short").unwrap();
    assert_eq!(
        bounded_file_using(&path, 8, |_| Err(std::io::Error::other(
            "private OS failure"
        )))
        .unwrap_err(),
        FAILED
    );
}

#[test]
fn editor_attachment_transport_accepts_only_bounded_text_and_preserves_exact_unicode_bytes() {
    let bytes = "中文\nUTF-8 note".as_bytes();
    let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).into_bytes();
    response.extend_from_slice(bytes);
    let server = Server::new(response);
    let actual = tauri::async_runtime::block_on(attachment_text_at(
        server.address,
        "10b72b2a-346f-48c0-a243-1cb22871d91d",
        &"a".repeat(64),
        "note.md",
    ))
    .unwrap();
    assert_eq!(actual, bytes);
    let request = String::from_utf8(server.request())
        .unwrap()
        .to_ascii_lowercase();
    assert!(request.starts_with("get /api/files/10b72b2a-346f-48c0-a243-1cb22871d91d http/1.1\r\n"));
    assert!(request.contains(&format!("x-dant-token: {}\r\n", "a".repeat(64))));
}

#[test]
fn editor_attachment_transport_never_opens_binary_redirected_oversized_or_interrupted_data() {
    let mut oversized =
        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n".to_vec();
    oversized.resize(oversized.len() + MAX_BYTES + 1, b'x');
    for response in [
        b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n".to_vec(),
        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Length: 0\r\n\r\n".to_vec(),
        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_BYTES + 1).into_bytes(),
        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\na".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\na".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 1\r\n\r\n\xff".to_vec(),
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\ninvalid\r\n".to_vec(),
        oversized,
    ] {
        let server = Server::new(response);
        assert_eq!(tauri::async_runtime::block_on(attachment_text_at(server.address, "synthetic", &"a".repeat(64), "note.md")).unwrap_err(), FAILED);
        assert!(!server.request().is_empty());
    }
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = closed.local_addr().unwrap();
    drop(closed);
    assert_eq!(
        tauri::async_runtime::block_on(attachment_text_at(
            endpoint,
            "synthetic",
            &"a".repeat(64),
            "note.md"
        ))
        .unwrap_err(),
        FAILED
    );
}
fn installed_fixture(path: &Path) -> PathBuf {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, b"MZ isolated test fixture, never executed").unwrap();
    path.to_path_buf()
}

#[test]
fn editor_names_and_discovery_budgets_keep_product_editions_and_safe_long_extensions() {
    for (name, expected) in [
        ("IntelliJ IDEA Ultimate", Some("intellij")),
        ("idea-u", Some("intellij")),
        ("idea-c", Some("intellij-community")),
        ("PyCharm Professional", Some("pycharm")),
        ("Android Studio", Some("androidstudio")),
        ("Unrelated", None),
    ] {
        assert_eq!(jetbrains_id(name), expected);
    }
    let root = tempfile::tempdir().unwrap();
    let mut exhausted = 0;
    assert!(child_directories(root.path(), &mut exhausted).is_empty());
    assert_eq!(safe_name(&("中".repeat(170) + ".md")).chars().count(), 140);
    assert!(safe_name(&("中".repeat(170) + ".md")).ends_with(".md"));
    for extension in [".", ".a_b", ".abcdefghijklmnopq"] {
        assert_eq!(safe_name(&("x".repeat(170) + extension)), "x".repeat(140));
    }
    let notepad = installed_fixture(&root.path().join("notepad.exe"));
    let inventory = installed_from_candidates(&[("notepad".into(), notepad)]);
    assert!(selected_preference("notepad", &inventory)
        .unwrap()
        .executable
        .is_none());
    let invalid = Preference {
        executable: Some(root.path().join("removed.exe")),
        editor_id: Some("custom".into()),
    };
    assert!(resolve_preference(&invalid, &[]).is_err());
    assert!(ordinary_directory(Path::new("relative"), true).is_err());
    assert!(bounded_file(root.path(), 4096).is_err());
    assert!(write_preference(root.path(), &Preference::default()).is_err());
    expire_cache(&root.path().join("missing"));
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
fn windows_short_alias(path: &Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetShortPathNameW(source: *const u16, target: *mut u16, capacity: u32) -> u32;
    }

    let source: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut target = vec![0; 32768];
    let length =
        unsafe { GetShortPathNameW(source.as_ptr(), target.as_mut_ptr(), target.len() as u32) }
            as usize;
    assert!(length > 0 && length < target.len());
    PathBuf::from(std::ffi::OsString::from_wide(&target[..length]))
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
    let executable = installed_fixture(&directory.path().join("editor app").join("notepad.exe"));
    let canonical_target = target.canonicalize().unwrap();
    let canonical_executable = executable.canonicalize().unwrap();
    assert!(canonical_target.to_string_lossy().starts_with(r"\\?\"));
    let short_target = windows_short_alias(&target);
    let short_executable = windows_short_alias(&executable);
    // TEMP may already contain an 8.3 ancestor. Every accepted spelling must
    // address the exact same files; normalization need not retain that alias.
    // Volumes without short names may return the original spelling instead.
    for (program, file) in [
        (&executable, &target),
        (&canonical_executable, &canonical_target),
        (&short_executable, &short_target),
    ] {
        let command = editor_command(program, file);
        let launched = Path::new(command.get_program());
        assert!(!launched.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(launched.canonicalize().unwrap(), canonical_executable);
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args.len(), 1);
        let opened = Path::new(args[0]);
        assert!(!opened.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(opened.canonicalize().unwrap(), canonical_target);
        assert_eq!(fs::read(opened).unwrap(), bytes);
    }
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

struct EditorDesktopFixture {
    root: PathBuf,
    candidates: std::sync::Mutex<Vec<(String, PathBuf)>>,
    chosen: std::sync::Mutex<Option<tauri_plugin_dialog::FilePath>>,
    endpoint: std::sync::Mutex<std::net::SocketAddr>,
    launches: std::sync::Mutex<Vec<(PathBuf, PathBuf)>>,
    launch_fails: std::sync::atomic::AtomicBool,
    panic: std::sync::atomic::AtomicBool,
}
impl EditorPlatform<tauri::test::MockRuntime> for EditorDesktopFixture {
    fn preference_path(
        &self,
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
    ) -> Result<PathBuf, String> {
        let path = preferences_path(app)?;
        assert!(path.starts_with(&self.root));
        Ok(path)
    }
    fn installed(&self) -> Vec<InstalledEditor> {
        if self.panic.load(std::sync::atomic::Ordering::Acquire) {
            std::panic::resume_unwind(Box::new(()));
        }
        installed_from_candidates(&self.candidates.lock().unwrap())
    }
    fn cache_root(&self) -> PathBuf {
        self.root.join("editor-cache")
    }
    fn choose(
        &self,
        _: tauri_plugin_dialog::FileDialogBuilder<tauri::test::MockRuntime>,
    ) -> Option<tauri_plugin_dialog::FilePath> {
        if self.panic.load(std::sync::atomic::Ordering::Acquire) {
            std::panic::resume_unwind(Box::new(()));
        }
        self.chosen.lock().unwrap().take()
    }
    fn launch(&self, command: &mut Command) -> Result<(), String> {
        let executable = PathBuf::from(command.get_program());
        let arguments: Vec<_> = command.get_args().map(PathBuf::from).collect();
        assert_eq!(
            arguments.len(),
            1,
            "A file remains exactly one native argument"
        );
        assert!(arguments[0].starts_with(self.root.join("editor-cache")));
        assert!(arguments[0].is_file());
        self.launches
            .lock()
            .unwrap()
            .push((executable, arguments[0].clone()));
        if self.launch_fails.load(std::sync::atomic::Ordering::Acquire) {
            Err(FAILED.into())
        } else {
            Ok(())
        }
    }
    fn attachment_endpoint(&self) -> std::net::SocketAddr {
        *self.endpoint.lock().unwrap()
    }
}
fn editor_desktop(
    root: &Path,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
    std::sync::Arc<EditorDesktopFixture>,
) {
    let host = std::sync::Arc::new(EditorDesktopFixture {
        root: root.to_owned(),
        candidates: Default::default(),
        chosen: Default::default(),
        endpoint: std::sync::Mutex::new("127.0.0.1:1".parse().unwrap()),
        launches: Default::default(),
        launch_fails: Default::default(),
        panic: Default::default(),
    });
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("com.dant.native-test-{}", std::process::id());
    assert_ne!(context.config().identifier, "com.dant.desktop");
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.to_owned()),
    );
    let app = crate::application_commands(
        tauri::test::mock_builder()
            .plugin(tauri_plugin_dialog::init())
            .manage(TextEditors::<tauri::test::MockRuntime>(host.clone())),
    )
    .build(context)
    .unwrap();
    let main =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    (app, main, host)
}
#[test]
fn the_production_ipc_table_preserves_editor_choice_inventory_and_preferences() {
    use crate::command_tests::invoke;
    let root = tempfile::tempdir().unwrap();
    let (app, main, host) = editor_desktop(root.path());
    let executable = installed_fixture(&root.path().join("installed/Code.exe"));
    host.candidates
        .lock()
        .unwrap()
        .push(("vscode".into(), executable.clone()));
    assert_eq!(
        invoke(&main, "editor_preferences", serde_json::json!({})).unwrap()["id"],
        "notepad"
    );
    let inventory = invoke(&main, "installed_text_editors", serde_json::json!({})).unwrap();
    assert_eq!(inventory["editors"][0]["id"], "vscode");
    assert_eq!(
        invoke(
            &main,
            "select_text_editor",
            serde_json::json!({"editorId":"vscode"})
        )
        .unwrap()["id"],
        "vscode"
    );
    assert_eq!(
        read_preference(&preferences_path(app.handle()).unwrap())
            .unwrap()
            .editor_id
            .as_deref(),
        Some("vscode")
    );
    assert_eq!(
        invoke(&main, "reset_text_editor", serde_json::json!({})).unwrap()["id"],
        "notepad"
    );
    assert!(invoke(&main, "choose_text_editor", serde_json::json!({}))
        .unwrap()
        .is_null());
    *host.chosen.lock().unwrap() = Some(tauri_plugin_dialog::FilePath::Path(executable));
    assert_eq!(
        invoke(&main, "choose_text_editor", serde_json::json!({})).unwrap()["id"],
        "custom"
    );
    fs::write(
        preferences_path(app.handle()).unwrap(),
        b"malformed private preference contents",
    )
    .unwrap();
    assert_eq!(
        invoke(&main, "editor_preferences", serde_json::json!({})).unwrap_err(),
        serde_json::json!(FAILED)
    );
    assert!(host.launches.lock().unwrap().is_empty());
}

#[test]
fn native_editor_commands_preserve_preferences_and_only_choose_supported_owned_executables() {
    let root = tempfile::tempdir().unwrap();
    let (app, main, host) = editor_desktop(root.path());
    let path = preferences_path(app.handle()).unwrap();
    assert!(path.starts_with(root.path()));
    assert_eq!(
        editor_preferences(app.handle().clone(), main.clone())
            .unwrap()
            .id,
        "notepad"
    );
    let executable = installed_fixture(&root.path().join("installed/Code.exe"));
    host.candidates
        .lock()
        .unwrap()
        .push(("vscode".into(), executable.clone()));
    let installed =
        tauri::async_runtime::block_on(installed_text_editors(app.handle().clone(), main.clone()))
            .unwrap();
    assert_eq!(installed.editors.len(), 1);
    assert_eq!(installed.editors[0].id, "vscode");
    assert_eq!(
        tauri::async_runtime::block_on(select_text_editor(
            app.handle().clone(),
            main.clone(),
            "vscode".into()
        ))
        .unwrap()
        .id,
        "vscode"
    );
    assert_eq!(
        editor_preferences(app.handle().clone(), main.clone())
            .unwrap()
            .id,
        "vscode"
    );
    for id in ["invalid", "pycharm"] {
        assert!(tauri::async_runtime::block_on(select_text_editor(
            app.handle().clone(),
            main.clone(),
            id.into()
        ))
        .is_err());
        assert_eq!(
            read_preference(&path).unwrap().editor_id.as_deref(),
            Some("vscode")
        );
    }
    assert!(
        tauri::async_runtime::block_on(choose_text_editor(app.handle().clone(), main.clone()))
            .unwrap()
            .is_none()
    );
    for chosen in [
        tauri_plugin_dialog::FilePath::Url("https://invalid.example/no-file".parse().unwrap()),
        tauri_plugin_dialog::FilePath::Path(root.path().join("unsupported.exe")),
    ] {
        *host.chosen.lock().unwrap() = Some(chosen);
        assert!(tauri::async_runtime::block_on(choose_text_editor(
            app.handle().clone(),
            main.clone()
        ))
        .is_err());
    }
    *host.chosen.lock().unwrap() = Some(tauri_plugin_dialog::FilePath::Path(executable.clone()));
    let custom =
        tauri::async_runtime::block_on(choose_text_editor(app.handle().clone(), main.clone()))
            .unwrap()
            .unwrap();
    assert_eq!(custom.id, "custom");
    assert_eq!(read_preference(&path).unwrap().executable, Some(executable));
    assert_eq!(
        reset_text_editor(app.handle().clone(), main.clone())
            .unwrap()
            .id,
        "notepad"
    );
    assert!(read_preference(&path).unwrap().executable.is_none());
    host.panic.store(true, std::sync::atomic::Ordering::Release);
    assert!(tauri::async_runtime::block_on(installed_text_editors(
        app.handle().clone(),
        main.clone()
    ))
    .is_err());
    assert!(
        tauri::async_runtime::block_on(choose_text_editor(app.handle().clone(), main.clone()))
            .is_err()
    );
    assert!(tauri::async_runtime::block_on(select_text_editor(
        app.handle().clone(),
        main,
        "vscode".into()
    ))
    .is_err());
    assert!(host.launches.lock().unwrap().is_empty());
}
#[test]
fn open_editor_command_downloads_valid_text_and_launches_only_the_verified_cache_copy() {
    let root = tempfile::tempdir().unwrap();
    let (app, main, host) = editor_desktop(root.path());
    let executable = installed_fixture(&root.path().join("installed/Code.exe"));
    host.candidates
        .lock()
        .unwrap()
        .push(("vscode".into(), executable.clone()));
    tauri::async_runtime::block_on(select_text_editor(
        app.handle().clone(),
        main.clone(),
        "vscode".into(),
    ))
    .unwrap();
    let id = "10b72b2a-346f-48c0-a243-1cb22871d91d";
    for fails in [false, true] {
        let bytes = "编辑器正文\ncontent".as_bytes();
        let mut response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()).into_bytes();
        response.extend_from_slice(bytes);
        let server = Server::new(response);
        *host.endpoint.lock().unwrap() = server.address;
        host.launch_fails
            .store(fails, std::sync::atomic::Ordering::Release);
        let result = crate::command_tests::invoke(
            &main,
            "open_attachment_in_editor",
            serde_json::json!({"fileId":id,"token":"a".repeat(64),"fileName":"../a space 中文.md"}),
        );
        if fails {
            assert_eq!(result.unwrap_err(), serde_json::json!(FAILED));
        } else {
            assert_eq!(result.unwrap(), serde_json::json!({"opened":true}));
        }
        let launches = host.launches.lock().unwrap();
        assert_eq!(launches.last().unwrap().0, executable);
        assert_eq!(fs::read(&launches.last().unwrap().1).unwrap(), bytes);
        assert!(!server.request().is_empty());
    }
    assert_eq!(host.launches.lock().unwrap().len(), 2);
    let server=Server::new(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 1\r\nConnection: close\r\n\r\n\xff".to_vec());
    *host.endpoint.lock().unwrap() = server.address;
    assert!(tauri::async_runtime::block_on(open_attachment_in_editor(
        app.handle().clone(),
        main,
        id.into(),
        "a".repeat(64),
        "binary.md".into()
    ))
    .is_err());
    assert_eq!(host.launches.lock().unwrap().len(), 2);
    assert!(!server.request().is_empty());
}

#[test]
fn native_editor_paths_follow_the_runtime_and_discovery_combines_only_verified_candidates() {
    let root = tempfile::tempdir().unwrap();
    let (app, _, _) = editor_desktop(root.path());
    let native = NativeEditors;
    assert_eq!(
        <NativeEditors as EditorPlatform<tauri::test::MockRuntime>>::preference_path(
            &native,
            app.handle()
        )
        .unwrap(),
        preferences_path(app.handle()).unwrap()
    );
    assert_eq!(
        <NativeEditors as EditorPlatform<tauri::test::MockRuntime>>::cache_root(&native),
        editor_cache_root(std::env::temp_dir())
    );
    assert_eq!(
        <NativeEditors as EditorPlatform<tauri::test::MockRuntime>>::attachment_endpoint(&native),
        crate::protocol::controller_endpoint()
    );
    assert!(
        <NativeEditors as EditorPlatform<tauri::test::MockRuntime>>::launch(
            &native,
            &mut Command::new(root.path().join("never-existing-editor.exe"))
        )
        .is_err()
    );
    let captured = EditorRoots::capture();
    assert_eq!(
        captured.system,
        std::env::var_os("SystemRoot").map(PathBuf::from)
    );
    assert_eq!(
        captured.local,
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    );
    let system = root.path().join("System");
    let local = root.path().join("Local");
    let programs = root.path().join("Programs");
    let code = installed_fixture(&programs.join("Microsoft VS Code/Code.exe"));
    let registered = installed_fixture(&root.path().join("registered/notepad++.exe"));
    installed_fixture(
        &local.join("JetBrains/Toolbox/apps/unrecognized-product/ch-0/1/bin/pycharm64.exe"),
    );
    assert!(common_candidates(None, None, &[]).is_empty());
    let editors = detected_with(
        &EditorRoots {
            system: Some(system),
            local: Some(local),
            programs: vec![programs],
        },
        [("notepadpp".into(), registered.clone())],
    );
    assert_eq!(editors.len(), 2);
    assert_eq!(editors[0].spec.id, "vscode");
    assert_eq!(
        editors[0].executable.canonicalize().unwrap(),
        code.canonicalize().unwrap()
    );
    assert_eq!(editors[1].spec.id, "notepadpp");
    assert_eq!(editors[1].executable, registered);
}

#[test]
fn default_editor_uses_the_supplied_system_root_and_cache_cleanup_preserves_unrelated_shapes() {
    let root = tempfile::tempdir().unwrap();
    assert!(default_editor_from(None).is_err());
    assert!(default_editor_from(Some(root.path().to_owned())).is_err());
    let expected = installed_fixture(&root.path().join("System32/notepad.exe"));
    assert_eq!(
        default_editor_from(Some(root.path().to_owned())).unwrap(),
        expected
    );
    assert!(default_editor_from(Some(PathBuf::from("relative"))).is_err());
    // Capturing the actual built-in path only inspects its metadata; no editor runs.
    if let Ok(actual) = resolve_preference(&Preference::default(), &[]) {
        assert_eq!(
            actual.file_name().unwrap().to_string_lossy().to_lowercase(),
            "notepad.exe"
        );
        assert!(actual.is_absolute());
    }
    let ordinary_file = root.path().join("ordinary-file");
    fs::write(&ordinary_file, b"keep").unwrap();
    assert!(ordinary_directory(&ordinary_file, false).is_err());
    expire_cache(&ordinary_file);
    let cache = root.path().join("cleanup");
    fs::create_dir(&cache).unwrap();
    fs::write(cache.join("plain-file"), b"keep").unwrap();
    let id = "10b72b2a-346f-48c0-a243-1cb22871d91d";
    for suffix in ["empty", "multiple"] {
        let folder = cache.join(format!("{id}-{}-{suffix}", "a".repeat(64)));
        fs::create_dir(&folder).unwrap();
        if suffix == "multiple" {
            fs::write(folder.join("one"), b"keep").unwrap();
            fs::write(folder.join("two"), b"keep").unwrap();
        }
    }
    expire_cache(&cache);
    assert_eq!(fs::read_dir(&cache).unwrap().count(), 3);
    assert_eq!(fs::read(ordinary_file).unwrap(), b"keep");
}
