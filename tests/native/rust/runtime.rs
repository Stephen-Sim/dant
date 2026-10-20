use super::*;

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
