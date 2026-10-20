use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    time::Duration,
};

// Matches the Controller and Worker JSON parser limit in core/internal/config.
const API_JSON_BODY_BYTES: usize = crate::protocol::JSON_BODY_MAX_BYTES;
const API_RESPONSE_BYTES: usize = crate::protocol::API_RESPONSE_MAX_BYTES;
const LOCAL_JSON_RESPONSE_BYTES: u64 = 256 * 1024;
const ROUTE_MAX_BYTES: usize = 2048;
const LOCAL_CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
const LOCAL_IO_TIMEOUT: Duration = Duration::from_secs(2);
const API_REQUEST_TIMEOUT: Duration = Duration::from_secs(180);
const WORKER_DEPLOYMENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(48 * 60);

fn api_request_timeout(method: &str, route: &str) -> Duration {
    let action = route.strip_prefix(crate::protocol::api_prefix());
    if method == "POST" && matches!(action, Some("/connect" | "/prepare" | "/service-update")) {
        WORKER_DEPLOYMENT_REQUEST_TIMEOUT
    } else {
        API_REQUEST_TIMEOUT
    }
}

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

struct LocalRequest<'a> {
    route: &'a str,
    method: &'a str,
    body: Option<&'a str>,
    token: &'a str,
}

fn local_endpoint() -> SocketAddr {
    crate::protocol::controller_endpoint()
}

fn validate_request<'a>(
    window: &str,
    route: &'a str,
    method: Option<&'a str>,
    body: Option<&'a str>,
    token: Option<&'a str>,
) -> Result<LocalRequest<'a>, &'static str> {
    if window != "main" {
        return Err("Local API requests require the main window");
    }
    if !route.starts_with(&format!("{}/", crate::protocol::api_prefix()))
        || route.len() > ROUTE_MAX_BYTES
        || route.contains(['\r', '\n', '#', '\\'])
    {
        return Err("Invalid local API route");
    }
    let method = method.unwrap_or("GET");
    if !matches!(method, "GET" | "POST" | "PATCH" | "DELETE") {
        return Err("Unsupported local API method");
    }
    validate_json_body(body)?;
    let token = token.unwrap_or_default();
    if token.len() > crate::protocol::SESSION_TOKEN_MAX_BYTES
        || !token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Invalid local API session");
    }
    Ok(LocalRequest {
        route,
        method,
        body,
        token,
    })
}

#[tauri::command]
pub async fn api_request(
    window: tauri::WebviewWindow,
    route: String,
    method: Option<String>,
    body: Option<String>,
    token: Option<String>,
) -> Result<ApiResponse, String> {
    let request = validate_request(
        window.label(),
        &route,
        method.as_deref(),
        body.as_deref(),
        token.as_deref(),
    )?;
    request_at(local_endpoint(), request).await
}

// Only the native wrapper chooses the production address. Tests supply their
// own bound loopback socket; no caller-controlled endpoint crosses IPC.
async fn request_at(endpoint: SocketAddr, input: LocalRequest<'_>) -> Result<ApiResponse, String> {
    let LocalRequest {
        route,
        method,
        body,
        token,
    } = input;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(api_request_timeout(method, route))
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| "Local API transport is unavailable")?;
    let mut request = client.request(
        method.parse().map_err(|_| "Invalid method")?,
        format!("http://{endpoint}{route}"),
    );
    if !token.is_empty() {
        request = request.header("X-Dant-Token", token);
    }
    if let Some(body) = body {
        request = request
            .header("Content-Type", "application/json")
            .body(body.to_owned());
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
        if bytes.len() + chunk.len() > API_RESPONSE_BYTES {
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
    local_json_at(local_endpoint(), route, token, body)
}

fn local_json_at(
    endpoint: SocketAddr,
    route: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> Option<serde_json::Value> {
    let mut stream = TcpStream::connect_timeout(&endpoint, LOCAL_CONNECT_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(LOCAL_IO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(LOCAL_IO_TIMEOUT)).ok()?;
    let method = if body.is_some() { "POST" } else { "GET" };
    let body = body.unwrap_or("");
    let header = token
        .map(|value| format!("X-Dant-Token: {value}\r\n"))
        .unwrap_or_default();
    write!(stream, "{method} {route} HTTP/1.0\r\nHost: {endpoint}\r\nConnection: close\r\nContent-Type: application/json\r\n{header}Content-Length: {}\r\n\r\n{body}", body.len()).ok()?;
    let mut response = Vec::new();
    stream
        .take(LOCAL_JSON_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
        .ok()?;
    if response.len() as u64 > LOCAL_JSON_RESPONSE_BYTES {
        return None;
    }
    let text = String::from_utf8(response).ok()?;
    let (headers, body) = text.split_once("\r\n\r\n")?;
    let mut status = headers.lines().next()?.split_whitespace();
    if !matches!(status.next(), Some("HTTP/1.0" | "HTTP/1.1")) || status.next() != Some("200") {
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

fn unidentified_controller_error() -> &'static str {
    static MESSAGE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    MESSAGE.get_or_init(|| format!("The local service could not be identified. Close the application using port {} before starting dant.", crate::protocol::controller_endpoint().port()))
}

pub fn existing_controller(source: &str) -> Result<bool, &'static str> {
    existing_controller_at(local_endpoint(), source)
}

fn existing_controller_at(endpoint: SocketAddr, source: &str) -> Result<bool, &'static str> {
    if let Some(value) = local_json_at(endpoint, crate::protocol::session_path(), None, None) {
        if compatible_controller(&value, source) {
            return Ok(true);
        }
        return Err("A different dant service is running. Close the old dant application before starting this version.");
    }
    if TcpStream::connect_timeout(&endpoint, LOCAL_CONNECT_TIMEOUT).is_ok() {
        return Err(unidentified_controller_error());
    }
    Ok(false)
}

#[cfg(test)]
#[path = "../../tests/native/rust/transport.rs"]
mod tests;
