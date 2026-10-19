use crate::transport::local_json;
use std::{
    collections::{HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

pub struct NotificationPump(pub Arc<AtomicBool>);

// notify-rust maps a missing Windows sound to an explicitly silent toast.
// The fixed Default name requests the ordinary system sound, so Windows still
// controls notification permission, volume and Do not disturb behavior.
fn system_sound() -> Option<&'static str> {
    #[cfg(windows)]
    {
        Some("Default")
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[derive(Default)]
struct NotificationDelivery {
    submitted: HashSet<String>,
    order: VecDeque<String>,
}

impl NotificationDelivery {
    fn dispatch<'a>(
        &mut self,
        notification: &'a serde_json::Value,
        show: impl FnOnce(String, Option<&'static str>) -> bool,
    ) -> Option<&'a str> {
        let id = notification.get("id").and_then(|value| value.as_str())?;
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || value == b'-')
        {
            return None;
        }
        if !self.submitted.contains(id) {
            if !show(notification_body(notification), system_sound()) {
                return None;
            }
            self.submitted.insert(id.into());
            self.order.push_back(id.into());
            // The Controller retains 1,000 notification receipts. Bound this
            // additional session cache without storing their message contents.
            if self.order.len() > 1024 {
                if let Some(old) = self.order.pop_front() {
                    self.submitted.remove(&old);
                }
            }
        }
        // A lost acknowledgement retries only the receipt, never the sound.
        Some(id)
    }
}

fn notification_body(notification: &serde_json::Value) -> String {
    let preview = notification
        .get("body")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let plain: String = preview.chars().filter(|value| !value.is_control() && !matches!(*value, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')).take(240).collect();
    if !plain.trim().is_empty() {
        return plain;
    }
    let language = notification
        .get("language")
        .and_then(|value| value.as_str())
        .unwrap_or("zh");
    crate::l10n::text(
        language,
        "You have an unread message from dant.",
        "你有来自 dant 的未读消息。",
    )
}

pub fn start(app: &tauri::App) {
    let running = Arc::new(AtomicBool::new(true));
    app.manage(NotificationPump(running.clone()));
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let mut delivery = NotificationDelivery::default();
        while running.load(Ordering::Relaxed) {
            if let Some(session) = local_json("/api/session", None, None) {
                if let Some(token) = session.get("token").and_then(|value| value.as_str()) {
                    if let Some(pending) =
                        local_json("/api/notifications/pending", Some(token), None)
                    {
                        if let Some(notifications) = pending
                            .get("notifications")
                            .and_then(|value| value.as_array())
                        {
                            for notification in notifications {
                                if let Some(id) = delivery.dispatch(notification, |body, sound| {
                                    let mut banner =
                                        handle.notification().builder().title("dant").body(body);
                                    if let Some(sound) = sound {
                                        banner = banner.sound(sound);
                                    }
                                    banner.show().is_ok()
                                }) {
                                    let _ = local_json(
                                        &format!("/api/notifications/{id}/ack"),
                                        Some(token),
                                        Some("{}"),
                                    );
                                }
                            }
                        }
                    }
                }
            }
            for _ in 0..40 {
                if !running.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    });
}

#[cfg(test)]
mod tests {
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
}
