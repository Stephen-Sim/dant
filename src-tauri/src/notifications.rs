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

const NOTIFICATION_ID_MAX_BYTES: usize = 128;
const SUBMITTED_RECEIPT_LIMIT: usize = 1024;
const PREVIEW_MAX_CHARACTERS: usize = 240;
const POLL_INTERVAL_STEPS: usize = 40;
const POLL_SLEEP: Duration = Duration::from_millis(100);

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
            || id.len() > NOTIFICATION_ID_MAX_BYTES
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
            if self.order.len() > SUBMITTED_RECEIPT_LIMIT {
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
    let plain: String = preview.chars().filter(|value| !value.is_control() && !matches!(*value, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')).take(PREVIEW_MAX_CHARACTERS).collect();
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
            if let Some(session) = local_json(crate::protocol::session_path(), None, None) {
                if let Some(token) = session.get("token").and_then(|value| value.as_str()) {
                    if let Some(pending) = local_json(
                        &format!("{}/notifications/pending", crate::protocol::api_prefix()),
                        Some(token),
                        None,
                    ) {
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
                                        &format!(
                                            "{}/notifications/{id}/ack",
                                            crate::protocol::api_prefix()
                                        ),
                                        Some(token),
                                        Some("{}"),
                                    );
                                }
                            }
                        }
                    }
                }
            }
            for _ in 0..POLL_INTERVAL_STEPS {
                if !running.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(POLL_SLEEP);
            }
        }
    });
}

#[cfg(test)]
#[path = "../../tests/native/rust/notifications.rs"]
mod tests;
