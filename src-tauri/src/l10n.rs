use serde_json::Value;
use std::{collections::HashMap, sync::OnceLock};

fn registry() -> &'static Vec<Value> {
    static REGISTRY: OnceLock<Vec<Value>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/language-registry.json"))
            .expect("The bundled language registry must be valid")
    })
}

pub fn speech_locale(language: &str) -> Option<&'static str> {
    registry()
        .iter()
        .find(|entry| entry["code"].as_str() == Some(language))?
        .get("speech")?
        .as_str()
}

pub fn supported(language: &str) -> bool {
    speech_locale(language).is_some()
}

fn catalogs() -> &'static HashMap<&'static str, Value> {
    static CATALOGS: OnceLock<HashMap<&'static str, Value>> = OnceLock::new();
    CATALOGS.get_or_init(|| {
        [
            ("zh-TW", include_str!("../../src/locales/zh-TW.json")),
            ("ja", include_str!("../../src/locales/ja.json")),
            ("ko", include_str!("../../src/locales/ko.json")),
            ("es", include_str!("../../src/locales/es.json")),
            ("fr", include_str!("../../src/locales/fr.json")),
            ("de", include_str!("../../src/locales/de.json")),
            ("pt", include_str!("../../src/locales/pt.json")),
            ("ru", include_str!("../../src/locales/ru.json")),
            ("ar", include_str!("../../src/locales/ar.json")),
            ("hi", include_str!("../../src/locales/hi.json")),
            ("id", include_str!("../../src/locales/id.json")),
            ("ms", include_str!("../../src/locales/ms.json")),
            ("it", include_str!("../../src/locales/it.json")),
            ("tr", include_str!("../../src/locales/tr.json")),
        ]
        .into_iter()
        .map(|(language, source)| {
            (
                language,
                serde_json::from_str(source).expect("Bundled language catalogs must be valid"),
            )
        })
        .collect()
    })
}

// Only application-owned text is passed here. Notification previews and other
// user content never enter the translation catalogs.
pub fn text(language: &str, english: &str, chinese: &str) -> String {
    if language == "zh" {
        return chinese.into();
    }
    if language == "en" {
        return english.into();
    }
    catalogs()
        .get(language)
        .and_then(|catalog| catalog.get(english))
        .and_then(Value::as_str)
        .unwrap_or(english)
        .into()
}

#[cfg(test)]
mod tests {
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
}
