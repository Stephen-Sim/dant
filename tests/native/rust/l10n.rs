use super::*;

#[test]
fn shared_registry_drives_all_native_language_and_speech_validation() {
    assert_eq!(registry().len(), 16);
    for entry in registry() {
        let code = entry["code"].as_str().unwrap();
        assert!(supported(code));
        assert_eq!(speech_locale(code), entry["speech"].as_str());
    }
    assert!(!supported("private input"));
    assert_eq!(speech_locale("unknown"), None);
}

#[test]
fn every_native_catalog_has_real_labels_and_preserves_count_placeholders() {
    for language in catalogs().keys() {
        for english in ["Open dant", "Exit dant", "Show call window"] {
            assert_ne!(text(language, english, "中文"), english);
        }
        assert!(text(language, "{count} queued", "{count} 项排队").contains("{count}"));
    }
    assert_eq!(text("zh", "Open dant", "打开 dant"), "打开 dant");
    assert_eq!(text("invalid", "Open dant", "打开 dant"), "Open dant");
}
