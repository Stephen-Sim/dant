use super::*;
use crate::native_http::Server;
use std::net::TcpListener;

#[test]
fn attachment_transport_preserves_binary_bytes_and_only_sends_the_bound_file_identity() {
    let server = Server::new(
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\0\xffab".to_vec(),
    );
    let bytes = tauri::async_runtime::block_on(attachment_at(
        server.address,
        "10b72b2a-346f-48c0-a243-1cb22871d91d",
        &"a".repeat(64),
    ))
    .unwrap();
    assert_eq!(bytes, b"\0\xffab");
    let request = String::from_utf8(server.request())
        .unwrap()
        .to_ascii_lowercase();
    assert!(request.starts_with(
        "get /api/files/10b72b2a-346f-48c0-a243-1cb22871d91d?download=1 http/1.1\r\n"
    ));
    assert!(request.contains(&format!("x-dant-token: {}\r\n", "a".repeat(64))));
}

#[test]
fn attachment_transport_rejects_errors_redirects_oversized_and_interrupted_streams() {
    let mut oversized = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
    oversized.resize(oversized.len() + MAX_BYTES + 1, b'x');
    for response in [
        b"HTTP/1.1 500 Error\r\nContent-Length: 0\r\n\r\n".to_vec(),
        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Length: 0\r\n\r\n".to_vec(),
        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_BYTES + 1).into_bytes(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx".to_vec(),
        oversized,
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\ninvalid\r\n".to_vec(),
    ] {
        let server = Server::new(response);
        assert_eq!(tauri::async_runtime::block_on(attachment_at(server.address, "synthetic", &"a".repeat(64))).unwrap_err(), FAILED);
        assert!(!server.request().is_empty());
    }
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = closed.local_addr().unwrap();
    drop(closed);
    assert_eq!(
        tauri::async_runtime::block_on(attachment_at(address, "synthetic", &"a".repeat(64)))
            .unwrap_err(),
        FAILED
    );
}

#[test]
fn long_attachment_names_preserve_only_a_short_safe_extension() {
    let name = safe_name(&("中".repeat(200) + ".png"));
    assert_eq!(name.chars().count(), 180);
    assert!(name.ends_with(".png"));
    for suffix in [".", ".a_b", ".abcdefghijklmnopq"] {
        assert_eq!(safe_name(&("x".repeat(200) + suffix)), "x".repeat(180));
    }
    assert_eq!(safe_name("COM0.txt"), "COM0.txt");
    assert_eq!(safe_name("com1.txt"), "_com1.txt");
}
#[test]
fn arguments_and_default_names_cannot_escape_or_change_file_types() {
    assert!(valid_id("10b72b2a-346f-48c0-a243-1cb22871d91d"));
    assert!(!valid_id("../private"));
    assert!(!valid_id("10b72b2a-346f-48c0-a243-1cb22871d91z"));
    assert!(valid_token(&"a".repeat(64)));
    assert!(!valid_token(""));
    assert!(!valid_token(&"g".repeat(64)));
    assert!(!valid_token(&"a".repeat(65)));
    assert_eq!(safe_name(r"C:\private\tetrio-live.png"), "tetrio-live.png");
    assert_eq!(safe_name("../tetrio-run.json"), "tetrio-run.json");
    assert_eq!(safe_name("\0<>:\"|?*"), "download");
    assert_eq!(safe_name("CON.txt"), "_CON.txt");
    assert_eq!(safe_name("LPT9.json"), "_LPT9.json");
    assert_eq!(safe_name("中文截图.png"), "中文截图.png");
}
#[test]
fn complete_bytes_replace_only_the_selected_destination_and_tempfiles_are_removed() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("chosen.json");
    std::fs::write(&destination, b"old data").unwrap();
    atomic_save(&destination, b"{\"result\":true}").unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"{\"result\":true}");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    assert!(atomic_save(&directory.path().join("missing").join("failed"), b"new").is_err());
    assert!(atomic_save(&destination, &vec![0; MAX_BYTES + 1]).is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"{\"result\":true}");
    assert!(atomic_save(Path::new("relative.txt"), b"x").is_err());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn save_command_uses_the_main_window_dialog_result_and_commits_only_complete_bytes() {
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_dialog::init())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let main =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let root = tempfile::tempdir().unwrap();
    for choice in ["save", "cancel", "invalid", "unavailable", "panic"] {
        let server = Server::new(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\0\xffab".to_vec(),
        );
        let target = root.path().join(choice);
        let chosen = target.clone();
        let result = tauri::async_runtime::block_on(save_attachment_using(
            app.handle().clone(),
            main.clone(),
            "10b72b2a-346f-48c0-a243-1cb22871d91d".into(),
            "a".repeat(64),
            "../unicode-file.png".into(),
            server.address,
            move |_| match choice {
                "cancel" => None,
                "invalid" => Some(tauri_plugin_dialog::FilePath::Url(
                    "https://invalid.example/no-file".parse().unwrap(),
                )),
                "unavailable" => Some(tauri_plugin_dialog::FilePath::Path(
                    chosen.join("missing/target"),
                )),
                "panic" => std::panic::resume_unwind(Box::new(())),
                _ => Some(tauri_plugin_dialog::FilePath::Path(chosen)),
            },
        ));
        match choice {
            "save" => {
                assert_eq!(result.unwrap(), true);
                assert_eq!(std::fs::read(&target).unwrap(), b"\0\xffab");
            }
            "cancel" => assert_eq!(result.unwrap(), false),
            _ => assert_eq!(result.unwrap_err(), FAILED),
        }
        assert!(!server.request().is_empty());
        if choice != "save" {
            assert!(!target.exists());
        }
    }
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
}
