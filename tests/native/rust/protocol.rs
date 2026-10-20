use super::*;

#[test]
fn all_native_addresses_paths_and_readiness_use_the_validated_canonical_resource() {
    let raw: serde_json::Value = serde_json::from_str(SOURCE).unwrap();
    let host = raw["loopbackHost"].as_str().unwrap();
    assert_eq!(controller_endpoint().ip(), Ipv4Addr::LOCALHOST);
    assert_eq!(
        controller_endpoint().port(),
        raw["apiPort"].as_u64().unwrap() as u16
    );
    assert_eq!(
        dev_endpoint().port(),
        raw["devPort"].as_u64().unwrap() as u16
    );
    assert_eq!(
        controller_origin(),
        format!("http://{host}:{}", raw["apiPort"])
    );
    assert_eq!(dev_origin(), format!("http://{host}:{}", raw["devPort"]));
    assert_eq!(api_prefix(), raw["paths"]["api"]);
    assert_eq!(session_path(), raw["paths"]["session"]);
    assert_eq!(state_path(), raw["paths"]["state"]);
    assert_eq!(
        controller_url(session_path()),
        format!("{}{session}", controller_origin(), session = session_path())
    );
    assert_eq!(
        api_url("files/fixture?download=1"),
        format!(
            "{}{}/files/fixture?download=1",
            controller_origin(),
            api_prefix()
        )
    );
    assert_eq!(
        readiness_line(),
        format!("dant listening at {}", controller_origin())
    );
    assert_eq!(JSON_BODY_MAX_BYTES, 3 * 1024 * 1024);
    assert_eq!(API_RESPONSE_MAX_BYTES, 16 * 1024 * 1024);
    assert_eq!(ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024);
}

#[test]
fn invalid_or_ambiguous_bundled_protocol_never_uses_fallbacks_or_accepts_nonloopback_hosts() {
    for (path, bad) in [
        ("/loopbackHost", serde_json::json!("0.0.0.0")),
        ("/loopbackHost", serde_json::json!("localhost")),
        (
            "/loopbackHosts",
            serde_json::json!(["127.0.0.1", "external.invalid"]),
        ),
        (
            "/loopbackHosts",
            serde_json::json!(["127.0.0.1", "localhost", "localhost"]),
        ),
        ("/apiPort", serde_json::json!(0)),
        ("/apiPort", serde_json::json!(65536)),
        ("/apiPort", serde_json::json!(1.5)),
        ("/apiPort", serde_json::json!("4317")),
        ("/paths/api", serde_json::json!("//external.invalid")),
        ("/paths/session", serde_json::json!("/other/session")),
        ("/paths/state", serde_json::json!("/api/../state")),
        ("/paths/health", serde_json::json!("/api?secret=value")),
        ("/paths/screen", serde_json::json!("/screen\nprivate")),
    ] {
        let mut value: serde_json::Value = serde_json::from_str(SOURCE).unwrap();
        *value.pointer_mut(path).unwrap() = bad;
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID), "{path}");
    }
    for field in [
        "apiPort",
        "devPort",
        "bootstrapGuestPort",
        "guestPort",
        "paths",
        "loopbackHost",
        "loopbackHosts",
    ] {
        let mut value: serde_json::Value = serde_json::from_str(SOURCE).unwrap();
        value.as_object_mut().unwrap().remove(field);
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID));
    }
    let mut collision: serde_json::Value = serde_json::from_str(SOURCE).unwrap();
    collision["devPort"] = collision["apiPort"].clone();
    assert!(parse(&collision.to_string()).is_err());
    let mut duplicate: serde_json::Value = serde_json::from_str(SOURCE).unwrap();
    duplicate["paths"]["health"] = duplicate["paths"]["screen"].clone();
    assert!(parse(&duplicate.to_string()).is_err());
    for raw in [
        "",
        "{}",
        "null",
        "[]",
        "{\"apiPort\":4317,\"apiPort\":4317}",
    ] {
        assert_eq!(parse(raw).err(), Some(INVALID));
    }
}

#[test]
fn strict_consumed_schema_rejects_unknown_duplicate_or_null_fields() {
    for raw in [
        SOURCE.replacen("\"apiPort\":", "\"apiPort\": 4317, \"apiPort\":", 1),
        SOURCE.replacen(
            "\"bootstrapGuestPort\":",
            "\"bootstrapGuestPort\": 4319, \"bootstrapGuestPort\":",
            1,
        ),
        SOURCE.replacen(
            "\"session\":",
            "\"session\": \"/api/session\", \"session\":",
            1,
        ),
    ] {
        assert_eq!(parse(&raw).err(), Some(INVALID));
    }
    for (pointer, key) in [("", "endpointOverride"), ("/paths", "secretRoute")] {
        let mut value: serde_json::Value = serde_json::from_str(SOURCE).unwrap();
        value
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert(key.into(), serde_json::json!("external.invalid"));
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID));
    }
    for pointer in [
        "/apiPort",
        "/bootstrapGuestPort",
        "/loopbackHost",
        "/paths/session",
        "/paths",
    ] {
        let mut value: serde_json::Value = serde_json::from_str(SOURCE).unwrap();
        *value.pointer_mut(pointer).unwrap() = serde_json::Value::Null;
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID));
    }
}

#[test]
fn bootstrap_and_worker_ports_are_required_and_distinct_from_every_managed_endpoint() {
    let ports = ["apiPort", "devPort", "bootstrapGuestPort", "guestPort"];
    for (index, left) in ports.iter().enumerate() {
        for right in &ports[index + 1..] {
            let mut value: serde_json::Value = serde_json::from_str(SOURCE).unwrap();
            value[*left] = value[*right].clone();
            assert_eq!(
                parse(&value.to_string()).err(),
                Some(INVALID),
                "{left}/{right}"
            );
        }
    }
    for invalid in [
        serde_json::json!(0),
        serde_json::json!(65536),
        serde_json::json!(1.5),
        serde_json::json!("4319"),
        serde_json::json!(true),
    ] {
        let mut value: serde_json::Value = serde_json::from_str(SOURCE).unwrap();
        value["bootstrapGuestPort"] = invalid;
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID));
    }
    let mut value: serde_json::Value = serde_json::from_str(SOURCE).unwrap();
    value["bootstrapGuestPort"] = serde_json::json!(5219);
    value["guestPort"] = serde_json::json!(5220);
    let parsed = parse(&value.to_string()).unwrap();
    assert_eq!(parsed.controller, controller_endpoint());
    assert_eq!(parsed.development, dev_endpoint());
}

#[test]
fn a_valid_resource_change_drives_addresses_readiness_and_paths_without_hidden_defaults() {
    let mut value: serde_json::Value = serde_json::from_str(SOURCE).unwrap();
    value["apiPort"] = serde_json::json!(4871);
    value["devPort"] = serde_json::json!(4872);
    value["paths"]["api"] = serde_json::json!("/local-api");
    for name in ["session", "version", "state"] {
        value["paths"][name] = serde_json::json!(format!("/local-api/{name}"));
    }
    let parsed = parse(&value.to_string()).unwrap();
    assert_eq!(parsed.controller.to_string(), "127.0.0.1:4871");
    assert_eq!(parsed.development.to_string(), "127.0.0.1:4872");
    assert_eq!(parsed.readiness, "dant listening at http://127.0.0.1:4871");
    assert_eq!(parsed.paths.state, "/local-api/state");
}

#[test]
fn tauri_static_security_and_development_origins_match_the_canonical_protocol() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../src-tauri/tauri.conf.json")).unwrap();
    assert_eq!(config["build"]["devUrl"].as_str(), Some(dev_origin()));
    let before_dev = config["build"]["beforeDevCommand"].as_str().unwrap();
    assert!(before_dev.contains(&format!(
        "--host {} --port {}",
        dev_endpoint().ip(),
        dev_endpoint().port()
    )));
    let csp = config["app"]["security"]["csp"].as_str().unwrap();
    let connect = csp
        .split(';')
        .find(|entry| entry.trim_start().starts_with("connect-src "))
        .unwrap();
    assert!(connect
        .split_whitespace()
        .any(|entry| entry == controller_origin()));
    let socket_origin = controller_origin().replacen("http://", "ws://", 1);
    assert!(connect
        .split_whitespace()
        .any(|entry| entry == socket_origin));
    for directive in ["img-src ", "media-src "] {
        assert!(csp
            .split(';')
            .find(|entry| entry.trim_start().starts_with(directive))
            .unwrap()
            .split_whitespace()
            .any(|entry| entry == controller_origin()));
    }
}
