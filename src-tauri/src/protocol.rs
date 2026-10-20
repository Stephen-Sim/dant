use serde::Deserialize;
use std::{
    collections::HashSet,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::OnceLock,
    time::Duration,
};

// Wire limits shared by the native API bridge and its attachment consumers.
// These are protocol invariants, never environment or UI settings.
pub(crate) const JSON_BODY_MAX_BYTES: usize = 3 * 1024 * 1024;
pub(crate) const API_RESPONSE_MAX_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const ATTACHMENT_MAX_BYTES: usize = 10 * 1024 * 1024;
pub(crate) const CONTROLLER_TOKEN_HEX_CHARS: usize = 64;
pub(crate) const SESSION_TOKEN_MAX_BYTES: usize = 256;
pub(crate) const ATTACHMENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

const INVALID: &str = "The bundled native protocol is invalid.";
const SOURCE: &str = include_str!("../../resources/config/protocol.json");
const PATH_MAX_BYTES: usize = 128;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawProtocol {
    loopback_host: String,
    loopback_hosts: Vec<String>,
    api_port: u16,
    dev_port: u16,
    bootstrap_guest_port: u16,
    guest_port: u16,
    paths: Paths,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Paths {
    api: String,
    events: String,
    session: String,
    version: String,
    state: String,
    health: String,
    screen: String,
    input: String,
    control: String,
    file: String,
    read_file: String,
}

struct Protocol {
    host: String,
    controller: SocketAddr,
    development: SocketAddr,
    paths: Paths,
    controller_origin: String,
    development_origin: String,
    readiness: String,
}

fn parse(source: &str) -> Result<Protocol, &'static str> {
    let value: RawProtocol = serde_json::from_str(source).map_err(|_| INVALID)?;
    let host: Ipv4Addr = value.loopback_host.parse().map_err(|_| INVALID)?;
    let ports = [
        value.api_port,
        value.dev_port,
        value.bootstrap_guest_port,
        value.guest_port,
    ];
    if host != Ipv4Addr::LOCALHOST
        || value.loopback_hosts.len() != 2
        || value
            .loopback_hosts
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>()
            != HashSet::from([value.loopback_host.as_str(), "localhost"])
        || ports.contains(&0)
        || HashSet::from(ports).len() != ports.len()
    {
        return Err(INVALID);
    }
    let paths = &value.paths;
    let names = [
        &paths.api,
        &paths.events,
        &paths.session,
        &paths.version,
        &paths.state,
        &paths.health,
        &paths.screen,
        &paths.input,
        &paths.control,
        &paths.file,
        &paths.read_file,
    ];
    if names.iter().any(|path| {
        path.len() < 2
            || path.len() > PATH_MAX_BYTES
            || !path.starts_with('/')
            || path[1..].split('/').any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
            })
    }) || names.iter().collect::<HashSet<_>>().len() != names.len()
        || [&paths.session, &paths.version, &paths.state]
            .iter()
            .any(|path| !path.starts_with(&format!("{}/", paths.api)))
    {
        return Err(INVALID);
    }
    let controller_origin = format!("http://{}", SocketAddrV4::new(host, value.api_port));
    let development_origin = format!("http://{}", SocketAddrV4::new(host, value.dev_port));
    let readiness = format!("dant listening at {controller_origin}");
    Ok(Protocol {
        host: value.loopback_host,
        controller: SocketAddrV4::new(host, value.api_port).into(),
        development: SocketAddrV4::new(host, value.dev_port).into(),
        paths: value.paths,
        controller_origin,
        development_origin,
        readiness,
    })
}

fn defaults() -> &'static Protocol {
    static PROTOCOL: OnceLock<Protocol> = OnceLock::new();
    PROTOCOL.get_or_init(|| parse(SOURCE).unwrap_or_else(|_| panic!("{INVALID}")))
}

pub(crate) fn controller_endpoint() -> SocketAddr {
    defaults().controller
}
pub(crate) fn loopback_host() -> &'static str {
    &defaults().host
}
pub(crate) fn dev_endpoint() -> SocketAddr {
    defaults().development
}
pub(crate) fn api_prefix() -> &'static str {
    &defaults().paths.api
}
pub(crate) fn session_path() -> &'static str {
    &defaults().paths.session
}
pub(crate) fn state_path() -> &'static str {
    &defaults().paths.state
}
pub(crate) fn state_route() -> &'static str {
    &state_path()[api_prefix().len() + 1..]
}
pub(crate) fn controller_origin() -> &'static str {
    &defaults().controller_origin
}
pub(crate) fn dev_origin() -> &'static str {
    &defaults().development_origin
}
pub(crate) fn controller_url(rooted_path: &str) -> String {
    format!("{}{rooted_path}", controller_origin())
}
pub(crate) fn api_url(relative_path: &str) -> String {
    controller_url(&format!("{}/{relative_path}", api_prefix()))
}
pub(crate) fn readiness_line() -> &'static str {
    &defaults().readiness
}

#[cfg(test)]
#[path = "../../tests/native/rust/protocol.rs"]
mod tests;
