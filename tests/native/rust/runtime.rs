use super::*;

#[test]
fn native_runtime_configuration_is_captured_once_and_managed_without_creating_data() {
    let app = tauri::test::mock_app();
    assert!(data_directory(app.handle()).is_none());
    let captured = RuntimeConfig::capture(app.handle()).unwrap();
    let expected = captured.data_directory.clone();
    app.manage(captured);
    assert_eq!(data_directory(app.handle()), Some(expected));
}

#[test]
fn data_configuration_has_one_precedence_without_resolving_unused_default_directories() {
    let configured = PathBuf::from("relative/自选数据");
    assert_eq!(
        select_data_directory(Some(configured.clone()), Some(Path::new("project")), || {
            panic!("A configured directory must not consult the application location")
        })
        .unwrap_or_else(|_: ()| panic!("Unexpected failure")),
        configured,
    );
    assert_eq!(
        select_data_directory(None, Some(Path::new("project")), || {
            panic!("Development data must remain under its project")
        })
        .unwrap_or_else(|_: ()| panic!("Unexpected failure")),
        Path::new("project").join("data"),
    );
    assert_eq!(
        select_data_directory(None, None, || Ok::<_, ()>(PathBuf::from("application"))).unwrap(),
        Path::new("application").join("data"),
    );
    assert_eq!(
        select_data_directory(None, None, || Err("unavailable")),
        Err("unavailable")
    );
}

#[test]
fn ordinary_relative_and_unicode_runtime_paths_keep_their_exact_identity() {
    for value in [
        "relative/data",
        "C:\\synthetic\\桌面",
        r"\\server\share\data",
    ] {
        let path = PathBuf::from(value);
        assert_eq!(runtime_path(path.clone()), path);
    }
}

#[cfg(windows)]
#[test]
fn windows_verbatim_drive_and_unc_paths_keep_the_same_filesystem_target() {
    assert_eq!(
        runtime_path(PathBuf::from(r"\\?\C:\fixture\data")),
        PathBuf::from(r"C:\fixture\data")
    );
    assert_eq!(
        runtime_path(PathBuf::from(r"\\?\UNC\fixture\share\data")),
        PathBuf::from(r"\\fixture\share\data")
    );
}

#[test]
fn packaged_data_capture_uses_the_current_sdk_application_directory_and_explicit_paths_keep_precedence(
) {
    let root = tempfile::tempdir().unwrap();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("test.dant.runtimefixture.p{}", std::process::id());
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(root.path().to_owned()),
    );
    let app = tauri::test::mock_builder().build(context).unwrap();
    let captured = RuntimeConfig::capture_from(app.handle(), None, None).unwrap();
    assert_eq!(
        captured.data_directory,
        runtime_path(app.path().app_data_dir().unwrap().join("data"))
    );
    assert!(captured.data_directory.starts_with(root.path()));
    assert!(!captured.data_directory.exists());
    let configured = root.path().join("custom/data");
    assert_eq!(
        RuntimeConfig::capture_from(app.handle(), Some(configured.clone()), None)
            .unwrap()
            .data_directory,
        configured
    );
    assert_eq!(
        RuntimeConfig::capture_from(app.handle(), None, Some(root.path()))
            .unwrap()
            .data_directory,
        root.path().join("data")
    );
}
