use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::Path,
    time::Duration,
};

// Matches the Controller and Worker JSON parser limit in config/network.mts.
const API_JSON_BODY_BYTES: usize = 3 * 1024 * 1024;

fn validate_json_body(body: Option<&str>) -> Result<(), &'static str> {
    if body.is_some_and(|value| value.len() > API_JSON_BODY_BYTES) {
        return Err("Local API request is too large");
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    status: u16,
    content_type: String,
    body: String,
}

#[tauri::command]
pub async fn api_request(
    window: tauri::WebviewWindow,
    route: String,
    method: Option<String>,
    body: Option<String>,
    token: Option<String>,
) -> Result<ApiResponse, String> {
    if window.label() != "main" {
        return Err("Local API requests require the main window".into());
    }
    if !route.starts_with("/api/") || route.len() > 2048 || route.contains(['\r', '\n', '#', '\\'])
    {
        return Err("Invalid local API route".into());
    }
    let method = method.unwrap_or_else(|| "GET".into());
    if !matches!(method.as_str(), "GET" | "POST" | "PATCH" | "DELETE") {
        return Err("Unsupported local API method".into());
    }
    validate_json_body(body.as_deref())?;
    let token = token.unwrap_or_default();
    if token.len() > 256 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid local API session".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "Local API transport is unavailable")?;
    let mut request = client.request(
        method.parse().map_err(|_| "Invalid method")?,
        format!("http://127.0.0.1:4317{route}"),
    );
    if !token.is_empty() {
        request = request.header("X-Dant-Token", token);
    }
    if let Some(body) = body {
        request = request
            .header("Content-Type", "application/json")
            .body(body);
    }
    let mut response = request.send().await.map_err(|_| {
        if method == "GET" {
            "The local controller is disconnected"
        } else {
            "The request outcome is unconfirmed. It has not been resent."
        }
    })?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local API response was interrupted")?
    {
        if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
            return Err("Local API response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "Local API response is not UTF-8 text")?;
    Ok(ApiResponse {
        status,
        content_type,
        body,
    })
}

pub fn local_json(
    route: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> Option<serde_json::Value> {
    let mut stream =
        TcpStream::connect_timeout(&"127.0.0.1:4317".parse().ok()?, Duration::from_millis(400))
            .ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    let method = if body.is_some() { "POST" } else { "GET" };
    let body = body.unwrap_or("");
    let header = token
        .map(|value| format!("X-Dant-Token: {value}\r\n"))
        .unwrap_or_default();
    write!(stream, "{method} {route} HTTP/1.0\r\nHost: 127.0.0.1:4317\r\nConnection: close\r\nContent-Type: application/json\r\n{header}Content-Length: {}\r\n\r\n{body}", body.len()).ok()?;
    let mut response = Vec::new();
    stream.take(256 * 1024).read_to_end(&mut response).ok()?;
    let text = String::from_utf8(response).ok()?;
    let (headers, body) = text.split_once("\r\n\r\n")?;
    if !headers.lines().next()?.contains(" 200 ") {
        return None;
    }
    serde_json::from_str(body).ok()
}

const CORE_PROTOCOL_VERSION: u64 = 1;
const RESOURCE_MANIFEST_BYTES: u64 = 64 * 1024;

pub fn bundled_source(root: &Path) -> Result<String, &'static str> {
    let path = root.join("resource-manifest.json");
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "The Go core resource manifest is missing")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > RESOURCE_MANIFEST_BYTES
    {
        return Err("The Go core resource manifest is invalid");
    }
    let bytes = fs::read(path).map_err(|_| "The Go core resource manifest could not be read")?;
    if bytes.len() as u64 > RESOURCE_MANIFEST_BYTES {
        return Err("The Go core resource manifest is invalid");
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "The Go core resource manifest is invalid")?;
    let source = value
        .get("sourceCommit")
        .and_then(|value| value.as_str())
        .ok_or("The Go core source is missing")?;
    if source.len() != 40
        || !source
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("The Go core source is invalid");
    }
    Ok(source.to_owned())
}

fn compatible_controller(value: &serde_json::Value, source: &str) -> bool {
    value.get("product").and_then(|value| value.as_str()) == Some("dant")
        && value.get("mode").and_then(|value| value.as_str()) == Some("controller")
        && value.get("runtime").and_then(|value| value.as_str()) == Some("go")
        && value.get("protocol").and_then(|value| value.as_u64()) == Some(CORE_PROTOCOL_VERSION)
        && value.get("version").and_then(|value| value.as_str()) == Some(env!("CARGO_PKG_VERSION"))
        && value.get("source").and_then(|value| value.as_str()) == Some(source)
}

pub fn existing_controller(source: &str) -> Result<bool, &'static str> {
    if let Some(value) = local_json("/api/session", None, None) {
        if compatible_controller(&value, source) {
            return Ok(true);
        }
        return Err("A different dant service is running. Close the old dant application before starting this version.");
    }
    if TcpStream::connect_timeout(
        &"127.0.0.1:4317".parse().unwrap(),
        Duration::from_millis(400),
    )
    .is_ok()
    {
        return Err("The local service could not be identified. Close the application using port 4317 before starting dant.");
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::{
        compatible_controller, validate_json_body, API_JSON_BODY_BYTES, CORE_PROTOCOL_VERSION,
    };

    #[test]
    fn controller_reuse_requires_the_same_go_build_and_role() {
        let source = "a".repeat(40);
        let session = serde_json::json!({
            "product": "dant", "mode": "controller", "runtime": "go",
            "protocol": CORE_PROTOCOL_VERSION, "version": env!("CARGO_PKG_VERSION"),
            "source": source
        });
        assert!(compatible_controller(&session, &source));
        for (key, value) in [
            ("product", serde_json::json!("other")),
            ("mode", serde_json::json!("worker")),
            ("runtime", serde_json::json!("node")),
            ("protocol", serde_json::json!(0)),
            ("version", serde_json::json!("0.0.0")),
            ("source", serde_json::json!("b".repeat(40))),
        ] {
            let mut changed = session.clone();
            changed[key] = value;
            assert!(!compatible_controller(&changed, &source), "{key}");
        }
        assert!(!compatible_controller(
            &serde_json::json!({"product":"dant"}),
            &source
        ));
    }

    #[test]
    fn json_body_accepts_absence_and_the_exact_byte_limit() {
        assert_eq!(validate_json_body(None), Ok(()));
        assert_eq!(validate_json_body(Some("")), Ok(()));
        let maximum = "x".repeat(API_JSON_BODY_BYTES);
        assert_eq!(validate_json_body(Some(&maximum)), Ok(()));
        let unicode_maximum = "é".repeat(API_JSON_BODY_BYTES / 2);
        assert_eq!(validate_json_body(Some(&unicode_maximum)), Ok(()));
    }

    #[test]
    fn json_body_rejects_overflow_by_bytes_including_multibyte_text() {
        let oversized = "x".repeat(API_JSON_BODY_BYTES + 1);
        assert_eq!(
            validate_json_body(Some(&oversized)),
            Err("Local API request is too large")
        );
        let unicode_oversized = "é".repeat(API_JSON_BODY_BYTES / 2 + 1);
        assert_eq!(
            validate_json_body(Some(&unicode_oversized)),
            Err("Local API request is too large")
        );
    }
}
