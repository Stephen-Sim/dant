use super::*;
use std::cell::RefCell;
#[derive(Default)]
struct Recorded(RefCell<Vec<(Vec<u16>, Vec<u16>, u32)>>);
impl MessageSink for Recorded {
    fn send(&self, text: &[u16], title: &[u16], kind: u32) {
        assert_eq!(text.last(), Some(&0));
        assert_eq!(title.last(), Some(&0));
        self.0
            .borrow_mut()
            .push((text.to_owned(), title.to_owned(), kind));
    }
}
#[test]
fn native_error_and_warning_entries_preserve_unicode_newlines_titles_and_fixed_flags_without_showing_ui(
) {
    let sink = Recorded::default();
    error(
        &sink,
        "dant update / 更新",
        "保留记录\n\nRestart after verification 🧭",
    );
    warning(&sink, "dant", "退出结果待确认");
    error(&sink, "", "");
    let rows = sink.0.borrow();
    assert_eq!(rows.len(), 3);
    for (index, (title, message, kind)) in [
        (
            "dant update / 更新",
            "保留记录\n\nRestart after verification 🧭",
            ERROR_ICON,
        ),
        ("dant", "退出结果待确认", WARNING_ICON),
        ("", "", ERROR_ICON),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            String::from_utf16(&rows[index].0[..rows[index].0.len() - 1]).unwrap(),
            message
        );
        assert_eq!(
            String::from_utf16(&rows[index].1[..rows[index].1.len() - 1]).unwrap(),
            title
        );
        assert_eq!(rows[index].2, kind);
    }
}
