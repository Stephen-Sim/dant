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
    let executable = installed_fixture(&directory.path().join("editor app").join("notepad.exe"));
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
