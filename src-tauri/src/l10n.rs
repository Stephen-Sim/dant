use serde_json::Value;
use std::{collections::HashMap, sync::OnceLock};

fn registry() -> &'static Vec<Value> {
    static REGISTRY: OnceLock<Vec<Value>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        serde_json::from_str(include_str!("../../resources/i18n/language-registry.json"))
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
            (
                "zh-TW",
                include_str!("../../resources/i18n/locales/zh-TW.json"),
            ),
            ("ja", include_str!("../../resources/i18n/locales/ja.json")),
            ("ko", include_str!("../../resources/i18n/locales/ko.json")),
            ("es", include_str!("../../resources/i18n/locales/es.json")),
            ("fr", include_str!("../../resources/i18n/locales/fr.json")),
            ("de", include_str!("../../resources/i18n/locales/de.json")),
            ("pt", include_str!("../../resources/i18n/locales/pt.json")),
            ("ru", include_str!("../../resources/i18n/locales/ru.json")),
            ("ar", include_str!("../../resources/i18n/locales/ar.json")),
            ("hi", include_str!("../../resources/i18n/locales/hi.json")),
            ("id", include_str!("../../resources/i18n/locales/id.json")),
            ("ms", include_str!("../../resources/i18n/locales/ms.json")),
            ("it", include_str!("../../resources/i18n/locales/it.json")),
            ("tr", include_str!("../../resources/i18n/locales/tr.json")),
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
#[path = "../../tests/native/rust/l10n.rs"]
mod tests;
