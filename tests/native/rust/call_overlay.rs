use super::*;

#[test]
fn navigation_only_accepts_the_overlay_at_packaged_or_canonical_development_origins() {
    for origin in [
        "tauri://localhost".to_string(),
        "http://tauri.localhost".to_string(),
        crate::protocol::dev_origin().to_string(),
    ] {
        assert!(allowed_navigation(
            &tauri::Url::parse(&format!("{origin}/call-overlay.html")).unwrap()
        ));
        assert!(!allowed_navigation(
            &tauri::Url::parse(&format!("{origin}/other.html")).unwrap()
        ));
    }

    for url in [
        "https://127.0.0.1:4318/call-overlay.html",
        "http://localhost:4318/call-overlay.html",
        "http://127.0.0.1:4317/call-overlay.html",
        "http://127.0.0.1:4319/call-overlay.html",
        "https://tauri.localhost/call-overlay.html",
        "tauri://external.invalid/call-overlay.html",
        "http://external.invalid:4318/call-overlay.html",
        "file:///call-overlay.html",
    ] {
        assert!(
            !allowed_navigation(&tauri::Url::parse(url).unwrap()),
            "{url}"
        );
    }
}

fn call(id: &str) -> CallState {
    CallState {
        call_id: id.into(),
        status: "talking".into(),
        connected_at: Some(123),
        seconds: 10,
        confirmed: true,
        running: true,
        muted: false,
        can_mute: true,
        language: "en".into(),
        theme: "dark".into(),
    }
}
#[test]
fn hidden_call_survives_metadata_refresh_without_changing_media_state() {
    let mut inner = Inner::default();
    inner.update(Some(call("call-a")));
    inner.hide("call-a").unwrap();
    assert!(inner.visible_call().is_none());
    assert_eq!(inner.call, Some(call("call-a")));
    let mut refreshed = call("call-a");
    refreshed.seconds = 25;
    refreshed.muted = true;
    refreshed.language = "zh".into();
    inner.update(Some(refreshed.clone()));
    assert!(inner.visible_call().is_none());
    assert!(inner.show("call-a"));
    assert_eq!(inner.visible_call(), Some(refreshed));
}
#[test]
fn new_call_is_visible_and_stale_hide_or_show_cannot_affect_it() {
    let mut inner = Inner::default();
    inner.update(Some(call("call-a")));
    inner.hide("call-a").unwrap();
    inner.update(Some(call("call-b")));
    assert_eq!(inner.visible_call(), Some(call("call-b")));
    assert!(inner.hide("call-a").is_err());
    assert_eq!(inner.visible_call(), Some(call("call-b")));
    inner.hide("call-b").unwrap();
    assert!(!inner.show("call-a"));
    assert!(inner.visible_call().is_none());
    assert!(inner.show("call-b"));
    assert_eq!(inner.visible_call(), Some(call("call-b")));
}
#[test]
fn ended_or_closing_calls_cannot_be_restored_or_hidden_by_late_controls() {
    let mut inner = Inner::default();
    inner.update(Some(call("call-a")));
    inner.hide("call-a").unwrap();
    inner.update(None);
    assert!(inner.hidden_for.is_none());
    assert!(!inner.show("call-a"));
    assert!(inner.hide("call-a").is_err());
    assert!(inner.call.is_none());
    inner.update(Some(call("call-b")));
    inner.closing = true;
    assert!(!inner.show("call-b"));
    assert!(inner.hide("call-b").is_err());
    assert!(inner.visible_call().is_none());
}
#[test]
fn work_area_placement_respects_taskbars_negative_monitors_and_dpi() {
    let area = Area {
        x: -1920,
        y: -80,
        width: 1920,
        height: 1040,
        scale: 1.5,
    };
    assert_eq!(
        position(area, 540, 114, None),
        PhysicalPosition::new(-564, 822)
    );
    assert_eq!(
        position(area, 540, 114, Some((-4000, 4000))),
        PhysicalPosition::new(-1896, 822)
    );
    assert_eq!(
        position(area, 540, 114, Some((-1000, 200))),
        PhysicalPosition::new(-1000, 200)
    );
}
#[test]
fn oversized_or_tiny_work_areas_never_panic_or_place_the_origin_outside() {
    let area = Area {
        x: 10,
        y: 20,
        width: 100,
        height: 40,
        scale: 2.0,
    };
    assert_eq!(position(area, 360, 76, None), PhysicalPosition::new(10, 20));
    assert!(!identifier("call\nprivate"));
    assert!(!identifier(""));
    assert!(identifier("call-a:1"));
}
#[test]
fn metadata_validation_rejects_unbounded_or_unknown_context() {
    let mut value = CallState {
        call_id: "call-a".into(),
        status: "talking".into(),
        connected_at: Some(123),
        seconds: 10,
        confirmed: true,
        running: true,
        muted: false,
        can_mute: true,
        language: "en".into(),
        theme: "dark".into(),
    };
    assert!(valid(&value));
    value.status = "private transcript".into();
    assert!(!valid(&value));
    value.status = "talking".into();
    value.connected_at = Some(u64::MAX);
    assert!(!valid(&value));
    assert!(serde_json::from_value::<CallState>(
        serde_json::json!({"callId":"a","token":"secret"})
    )
    .is_err());
}
