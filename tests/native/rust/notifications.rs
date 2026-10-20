use super::{notification_body, NotificationDelivery};
use serde_json::json;

#[test]
fn banners_use_the_delivered_message_and_keep_localized_fallbacks() {
    assert_eq!(
        notification_body(&json!({"body":"请在电脑上输入验证码。","language":"zh"})),
        "请在电脑上输入验证码。"
    );
    assert_eq!(
        notification_body(&json!({"body":"","language":"en"})),
        "You have an unread message from dant."
    );
    assert_eq!(
        notification_body(&json!({"body":42})),
        "你有来自 dant 的未读消息。"
    );
}

#[test]
fn banners_strip_controls_and_bound_unicode_without_splitting_it() {
    assert_eq!(
        notification_body(&json!({"body":"Done\u{0}\u{202e}!"})),
        "Done!"
    );
    let body = notification_body(&json!({"body":"😀".repeat(300)}));
    assert_eq!(body.chars().count(), 240);
}

#[test]
fn a_lost_ack_retries_the_receipt_without_replaying_the_system_sound() {
    let mut delivery = NotificationDelivery::default();
    let first = json!({"id":"completion-a", "body":"Your result is ready.", "language":"en"});
    let mut shown = Vec::new();
    let id = delivery.dispatch(&first, |body, sound| {
        shown.push((body, sound));
        true
    });
    assert_eq!(id, Some("completion-a"));
    // The Controller may return this same ID again if its ACK was lost.
    let repeat = json!({"id":"completion-a", "body":"An edited preview."});
    assert_eq!(
        delivery.dispatch(&repeat, |_, _| panic!(
            "must only retry the acknowledgement"
        )),
        id
    );
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].0, "Your result is ready.");
    #[cfg(windows)]
    assert_eq!(shown[0].1, Some("Default"));
    #[cfg(not(windows))]
    assert_eq!(shown[0].1, None);
    let second = json!({"id":"completion-b", "body":"Another task needs your reply."});
    assert_eq!(
        delivery.dispatch(&second, |_, _| {
            shown.push((String::new(), None));
            true
        }),
        Some("completion-b")
    );
    assert_eq!(
        shown.len(),
        2,
        "different completion IDs remain separate notifications"
    );
}

#[test]
fn failed_submissions_retry_and_malformed_ids_never_show_or_ack() {
    let mut delivery = NotificationDelivery::default();
    let message = json!({"id":"retry-a", "body":"Done"});
    assert_eq!(delivery.dispatch(&message, |_, _| false), None);
    assert_eq!(delivery.dispatch(&message, |_, _| true), Some("retry-a"));
    for id in ["", "../private", "a/b", "two words", &"a".repeat(129)] {
        assert_eq!(
            delivery.dispatch(&json!({"id":id}), |_, _| panic!("invalid notification ID")),
            None
        );
    }
    assert_eq!(
        delivery.dispatch(&json!({"id":42}), |_, _| panic!("invalid notification ID")),
        None
    );
}

#[test]
fn the_session_receipt_cache_is_bounded_and_keeps_only_ids() {
    let mut delivery = NotificationDelivery::default();
    for number in 0..1030 {
        delivery.dispatch(
            &json!({"id":format!("receipt-{number}"),"body":"not retained"}),
            |_, _| true,
        );
    }
    assert_eq!(delivery.submitted.len(), 1024);
    assert_eq!(delivery.order.len(), 1024);
    assert!(!delivery.submitted.contains("receipt-0"));
    assert!(delivery.submitted.contains("receipt-1029"));
}
