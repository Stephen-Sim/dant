use crate::transport::ControllerLink;
use std::{
    collections::{HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::Manager;

const NOTIFICATION_ID_MAX_BYTES: usize = 128;
const SUBMITTED_RECEIPT_LIMIT: usize = 1024;
const PREVIEW_MAX_CHARACTERS: usize = 240;
const POLL_INTERVAL_STEPS: usize = 40;
const POLL_SLEEP: Duration = Duration::from_millis(100);

pub struct NotificationPump {
    running: Arc<AtomicBool>,
    thread_id: std::thread::ThreadId,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

type NotificationRequest =
    Arc<dyn Fn(&str, Option<&str>, Option<&str>) -> Option<serde_json::Value> + Send + Sync>;
type NotificationBanner<R> =
    Arc<dyn Fn(&tauri::AppHandle<R>, String, Option<&'static str>) -> bool + Send + Sync>;
pub struct NotificationControl<R: tauri::Runtime> {
    request: NotificationRequest,
    banner: NotificationBanner<R>,
    wait: Arc<dyn Fn(Duration) + Send + Sync>,
}
impl<R: tauri::Runtime> Default for NotificationControl<R> {
    fn default() -> Self {
        Self::with_link(ControllerLink::default())
    }
}
impl<R: tauri::Runtime> NotificationControl<R> {
    fn with_link(link: ControllerLink) -> Self {
        Self {
            request: Arc::new(move |route, token, body| link.json(route, token, body)),
            banner: Arc::new(|app, body, sound| {
                banner_using(app, body, sound, |banner| banner.show().is_ok())
            }),
            wait: Arc::new(std::thread::sleep),
        }
    }
}
impl NotificationPump {
    pub fn stop(&self) {
        self.running.store(false, Ordering::Release);
        // A delivery callback may initiate shutdown. It can cancel its owner,
        // while a later external stop still joins the retained handle.
        if std::thread::current().id() == self.thread_id {
            return;
        }
        let mut owner = self
            .thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(thread) = owner.take() {
            let _ = thread.join();
        }
    }
}
impl Drop for NotificationPump {
    fn drop(&mut self) {
        self.stop();
    }
}

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
    let plain: String = preview
        .chars()
        .filter(|value| {
            !value.is_control()
                && !matches!(
                    *value,
                    '\u{200b}'..='\u{200f}'
                        | '\u{202a}'..='\u{202e}'
                        | '\u{2060}'..='\u{206f}'
                        | '\u{feff}'
                )
        })
        .take(PREVIEW_MAX_CHARACTERS)
        .collect();
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

fn poll_active(
    delivery: &mut NotificationDelivery,
    mut request: impl FnMut(&str, Option<&str>, Option<&str>) -> Option<serde_json::Value>,
    mut show: impl FnMut(String, Option<&'static str>) -> bool,
    mut active: impl FnMut() -> bool,
) {
    if !active() {
        return;
    }
    let Some(session) = request(crate::protocol::session_path(), None, None) else {
        return;
    };
    let Some(token) = session.get("token").and_then(|value| value.as_str()) else {
        return;
    };
    if !active() {
        return;
    }
    let Some(pending) = request(
        &format!("{}/notifications/pending", crate::protocol::api_prefix()),
        Some(token),
        None,
    ) else {
        return;
    };
    let Some(notifications) = pending
        .get("notifications")
        .and_then(|value| value.as_array())
    else {
        return;
    };
    for notification in notifications {
        if !active() {
            return;
        }
        if let Some(id) = delivery.dispatch(notification, &mut show) {
            let _ = request(
                &format!("{}/notifications/{id}/ack", crate::protocol::api_prefix()),
                Some(token),
                Some("{}"),
            );
        }
    }
}

fn spawn_pump(
    running: Arc<AtomicBool>,
    mut poll: impl FnMut() + Send + 'static,
    mut wait: impl FnMut(Duration) + Send + 'static,
) -> NotificationPump {
    let active = Arc::clone(&running);
    struct RunningGuard(Arc<AtomicBool>);
    impl Drop for RunningGuard {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    let thread = std::thread::spawn(move || {
        let _guard = RunningGuard(Arc::clone(&active));
        run(&active, &mut poll, &mut wait);
    });
    let thread_id = thread.thread().id();
    NotificationPump {
        running,
        thread_id,
        thread: Mutex::new(Some(thread)),
    }
}

fn run(running: &AtomicBool, mut poll: impl FnMut(), mut wait: impl FnMut(Duration)) {
    while running.load(Ordering::Relaxed) {
        poll();
        for _ in 0..POLL_INTERVAL_STEPS {
            if !running.load(Ordering::Relaxed) {
                return;
            }
            wait(POLL_SLEEP);
        }
    }
}

fn banner_using<R: tauri::Runtime>(
    handle: &tauri::AppHandle<R>,
    body: String,
    sound: Option<&'static str>,
    show: fn(tauri_plugin_notification::NotificationBuilder<R>) -> bool,
) -> bool {
    let Some(notification) = handle.try_state::<tauri_plugin_notification::Notification<R>>()
    else {
        return false;
    };
    let mut banner = notification.builder().title("dant").body(body);
    if let Some(sound) = sound {
        banner = banner.sound(sound);
    }
    show(banner)
}
fn start_using<R: tauri::Runtime>(
    app: &tauri::App<R>,
    mut request: impl FnMut(&str, Option<&str>, Option<&str>) -> Option<serde_json::Value>
        + Send
        + 'static,
    mut show: impl FnMut(String, Option<&'static str>) -> bool + Send + 'static,
    wait: impl FnMut(Duration) + Send + 'static,
) {
    let running = Arc::new(AtomicBool::new(true));
    let active = Arc::clone(&running);
    let mut delivery = NotificationDelivery::default();
    app.manage(spawn_pump(
        running,
        move || {
            poll_active(&mut delivery, &mut request, &mut show, || {
                active.load(Ordering::Acquire)
            });
        },
        wait,
    ));
}
pub fn start<R: tauri::Runtime>(app: &tauri::App<R>) {
    let handle = app.handle().clone();
    let platform = app
        .try_state::<NotificationControl<R>>()
        .map(|state| NotificationControl {
            request: Arc::clone(&state.request),
            banner: Arc::clone(&state.banner),
            wait: Arc::clone(&state.wait),
        })
        .unwrap_or_default();
    start_using(
        app,
        move |route, token, body| (platform.request)(route, token, body),
        move |body, sound| (platform.banner)(&handle, body, sound),
        move |duration| (platform.wait)(duration),
    );
}

#[cfg(test)]
#[path = "../../tests/native/rust/notifications.rs"]
mod tests;
