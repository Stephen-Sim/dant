use super::*;
#[test]
fn arguments_and_default_names_cannot_escape_or_change_file_types() {
    assert!(valid_id("10b72b2a-346f-48c0-a243-1cb22871d91d"));
    assert!(!valid_id("../private"));
    assert!(!valid_id("10b72b2a-346f-48c0-a243-1cb22871d91z"));
    assert!(valid_token(&"a".repeat(64)));
    assert!(!valid_token(""));
    assert!(!valid_token(&"g".repeat(64)));
    assert!(!valid_token(&"a".repeat(65)));
    assert_eq!(safe_name(r"C:\private\tetrio-live.png"), "tetrio-live.png");
    assert_eq!(safe_name("../tetrio-run.json"), "tetrio-run.json");
    assert_eq!(safe_name("\0<>:\"|?*"), "download");
    assert_eq!(safe_name("CON.txt"), "_CON.txt");
    assert_eq!(safe_name("LPT9.json"), "_LPT9.json");
    assert_eq!(safe_name("中文截图.png"), "中文截图.png");
}
#[test]
fn complete_bytes_replace_only_the_selected_destination_and_tempfiles_are_removed() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("chosen.json");
    std::fs::write(&destination, b"old data").unwrap();
    atomic_save(&destination, b"{\"result\":true}").unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"{\"result\":true}");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    assert!(atomic_save(&directory.path().join("missing").join("failed"), b"new").is_err());
    assert!(atomic_save(&destination, &vec![0; MAX_BYTES + 1]).is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"{\"result\":true}");
    assert!(atomic_save(Path::new("relative.txt"), b"x").is_err());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}
