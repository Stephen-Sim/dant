use std::{sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;
use crate::transport::local_json;

pub struct NotificationPump(pub Arc<AtomicBool>);

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
                                // Task text, filenames and prompts never enter system banners.
                                let body=if notification.get("language").and_then(|value|value.as_str())==Some("en"){ "You have an unread message from dant." }else{ "你有来自 dant 的未读消息。" };
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
