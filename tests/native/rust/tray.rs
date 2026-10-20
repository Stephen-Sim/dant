use super::*;
fn status() -> Status {
    Status {
        language: "en".into(),
        connection: "online".into(),
        task: "background".into(),
        queued: 2,
    }
}
#[test]
fn call_window_restore_labels_are_localized_and_separate_from_exit() {
    assert_eq!(call_window_label("en"), "Show call window");
    assert_eq!(call_window_label("zh"), "显示通话窗口");
    assert_ne!(call_window_label("en"), labels(&status()).2);
}
#[test]
fn close_hides_only_with_a_working_tray_and_never_during_explicit_exit() {
    assert!(should_hide(true, false, true));
    for values in [
        (false, false, true),
        (true, true, true),
        (true, false, false),
    ] {
        assert!(!should_hide(values.0, values.1, values.2));
    }
}
#[test]
fn statuses_are_bounded_metadata_and_never_arbitrary_text() {
    let mut value = status();
    assert!(valid(&value));
    value.task = "private task title".into();
    assert!(!valid(&value));
    value.task = "running".into();
    value.queued = 1000;
    assert!(!valid(&value));
    value.queued = 0;
    value.connection = "private exception".into();
    assert!(!valid(&value));
    assert!(serde_json::from_value::<Status>(serde_json::json!({"language":"en","connection":"online","task":"idle","queued":0,"token":"secret"})).is_err());
}
#[test]
fn tray_separates_background_waiting_and_unconfirmed_connection_states() {
    let mut value = status();
    assert_eq!(labels(&value).3, "Working in background · 2 queued");
    value.task = "waiting_user".into();
    value.queued = 0;
    assert_eq!(labels(&value).3, "Waiting for your reply");
    value.connection = "offline".into();
    assert_eq!(labels(&value).3, "Work status unconfirmed");
    value.language = "zh".into();
    assert_eq!(labels(&value).0, "打开 dant");
    assert_eq!(labels(&value).3, "任务状态待确认");
    value.task = "idle".into();
    assert_eq!(labels(&value).3, "离线");
}
