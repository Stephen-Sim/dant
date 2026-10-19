use serde::Serialize;
use std::{
    io::{Read, Write},
    net::TcpStream,
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

pub fn existing_controller() -> bool {
    local_json("/api/session", None, None)
        .is_some_and(|value| value.get("product").and_then(|v| v.as_str()) == Some("dant"))
}

#[cfg(test)]
mod tests {
    use super::{validate_json_body, API_JSON_BODY_BYTES};

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
