const ERROR_ICON: u32 = 0x10;
const WARNING_ICON: u32 = 0x30;

pub(crate) trait MessageSink {
    fn send(&self, text: &[u16], title: &[u16], kind: u32);
}
pub(crate) struct NativeDialog;
impl MessageSink for NativeDialog {
    fn send(&self, text: &[u16], title: &[u16], kind: u32) {
        #[cfg(windows)]
        {
            #[link(name = "user32")]
            extern "system" {
                fn MessageBoxW(
                    window: *mut std::ffi::c_void,
                    text: *const u16,
                    title: *const u16,
                    kind: u32,
                ) -> i32;
            }
            unsafe {
                MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), kind);
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (title, kind);
            eprintln!(
                "{}",
                String::from_utf16_lossy(text.strip_suffix(&[0]).unwrap_or(text))
            );
        }
    }
}
pub(crate) fn error(sink: &dyn MessageSink, title: &str, message: &str) {
    show(sink, title, message, ERROR_ICON);
}
pub(crate) fn warning(sink: &dyn MessageSink, title: &str, message: &str) {
    show(sink, title, message, WARNING_ICON);
}
fn show(sink: &dyn MessageSink, title: &str, message: &str, kind: u32) {
    let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    sink.send(&text, &title, kind);
}
#[cfg(test)]
#[path = "../../tests/native/rust/native_dialog.rs"]
mod tests;
