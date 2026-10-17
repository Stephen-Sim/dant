use std::{sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;
use crate::transport::local_json;

pub struct NotificationPump(pub Arc<AtomicBool>);

fn notification_body(notification: &serde_json::Value) -> String {
    let preview = notification.get("body").and_then(|value| value.as_str()).unwrap_or("");
    let plain: String = preview.chars().filter(|value| !value.is_control() && !matches!(*value, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')).take(240).collect();
    if !plain.trim().is_empty() { return plain; }
    if notification.get("language").and_then(|value| value.as_str()) == Some("en") {
        "You have an unread message from dant.".into()
    } else {
        "你有来自 dant 的未读消息。".into()
    }
}

pub fn start(app: &tauri::App) {
    let running = Arc::new(AtomicBool::new(true));
    app.manage(NotificationPump(running.clone()));
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        while running.load(Ordering::Relaxed) {
            if let Some(session) = local_json("/api/session", None, None) {
                if let Some(token) = session.get("token").and_then(|value| value.as_str()) {
                    if let Some(pending) = local_json("/api/notifications/pending", Some(token), None) {
                        if let Some(notifications) = pending.get("notifications").and_then(|value| value.as_array()) {
                            for notification in notifications {
                                let Some(id) = notification.get("id").and_then(|value| value.as_str()) else { continue; };
                                if id.len() > 128 || !id.bytes().all(|value| value.is_ascii_alphanumeric() || value == b'-') { continue; }
                                let body = notification_body(notification);
                                if handle.notification().builder().title("dant").body(body).show().is_ok() {
                                    let _ = local_json(&format!("/api/notifications/{id}/ack"), Some(token), Some("{}"));
                                }
                            }
                        }
                    }
                }
            }
            for _ in 0..40 { if !running.load(Ordering::Relaxed) { return; } std::thread::sleep(Duration::from_millis(100)); }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::notification_body;
    use serde_json::json;

    #[test]
    fn banners_use_the_delivered_message_and_keep_localized_fallbacks() {
        assert_eq!(notification_body(&json!({"body":"请在电脑上输入验证码。","language":"zh"})), "请在电脑上输入验证码。");
        assert_eq!(notification_body(&json!({"body":"","language":"en"})), "You have an unread message from dant.");
        assert_eq!(notification_body(&json!({"body":42})), "你有来自 dant 的未读消息。");
    }

    #[test]
    fn banners_strip_controls_and_bound_unicode_without_splitting_it() {
        assert_eq!(notification_body(&json!({"body":"Done\u{0}\u{202e}!"})), "Done!");
        let body = notification_body(&json!({"body":"😀".repeat(300)}));
        assert_eq!(body.chars().count(), 240);
    }
}
