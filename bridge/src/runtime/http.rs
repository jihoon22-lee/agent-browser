//! HTTP health, OpenAPI discovery, MCP readiness, and session-status queries for OpenCode v1.
use super::{profile::{self, invalid, Profile}, storage::failure, RuntimeRecord};
use crate::rpc::RpcError;
use serde_json::Value;
use std::time::Duration;

pub(super) type DocCache = std::sync::Mutex<std::collections::HashSet<String>>;

/// Every session that is not idle counts as working, so an unknown new state never reads as free;
/// a reply that is not a map is an error, never "no busy sessions".
pub(super) fn busy_from(statuses: &Value) -> Result<Vec<String>, RpcError> {
    let map = statuses.as_object().ok_or_else(|| failure("The runtime's session status is not a map"))?;
    Ok(map.iter().filter(|(_, status)| status["type"].as_str() != Some("idle")).map(|(id, _)| id.clone()).collect())
}

pub(super) const UNREACHABLE: &str = "OpenCode is not reachable";
pub(super) const MCP_UNFINISHED: &str = "OpenCode HTTP is available but browser MCP initialization did not finish";

pub(super) async fn health(base: &str, username: Option<&str>, password: Option<&str>, managed: bool, verified: &DocCache) -> Result<String,RpcError> {
    let client = http_client(base)?;
    let endpoint = |path: &str| format!("{}/{}",base.trim_end_matches('/'),path);
    if managed {
        let response = client.get(endpoint("global/health")).send().await.map_err(|_| failure(UNREACHABLE))?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED { return Err(failure("Managed OpenCode must require Basic authentication")); }
    }
    let request = |path: &str| { let request = client.get(endpoint(path)); if let Some(password) = password.filter(|value| !value.is_empty()) { request.basic_auth(username.unwrap_or("opencode"),Some(password)) } else { request } };
    let response = request("global/health").send().await.map_err(|_| failure("OpenCode connection failed; verify URL, system proxy, and trusted certificates"))?;
    if !response.status().is_success() { return Err(failure(format!("OpenCode health returned HTTP {}",response.status().as_u16()))); }
    let value = limited_json(response,64 * 1024).await?;
    let version = value["version"].as_str().filter(|version| version.starts_with("1.")).ok_or_else(|| failure("Only OpenCode v1 is supported"))?;
    if value["healthy"] != true { return Err(failure("OpenCode reported unhealthy")); }
    // The ~825 KB API document only changes with the server version; status polls run every 15 s.
    let key = format!("{}#{version}", base.trim_end_matches('/'));
    if verified.lock().unwrap().contains(&key) { return Ok(version.into()); }
    let doc_response = request("doc").timeout(Duration::from_secs(10)).send().await.map_err(|_| failure("OpenCode v1 API discovery failed"))?;
    if !doc_response.status().is_success() { return Err(failure(format!("OpenCode v1 API discovery returned HTTP {}", doc_response.status().as_u16()))); }
    let doc = limited_json(doc_response,4 * 1024 * 1024).await?;
    if !["/session","/provider","/event","/mcp"].iter().all(|path| doc["paths"].get(*path).is_some()) { return Err(failure("The server does not expose the required OpenCode v1 APIs")); }
    verified.lock().unwrap().insert(key);
    Ok(version.into())
}
pub(super) async fn browser_mcp(profile: &Profile, record: &RuntimeRecord) -> Result<(),RpcError> {
    let mut url = reqwest::Url::parse(&format!("{}/mcp",record.base_url)).map_err(|_| failure("Invalid managed runtime URL"))?;
    url.query_pairs_mut().append_pair("directory",&profile.directory);
    let response = http_client(&record.base_url)?.get(url).basic_auth(&record.username,Some(&record.password))
        .timeout(Duration::from_secs(35)).send().await.map_err(|_| failure(MCP_UNFINISHED))?;
    if !response.status().is_success() { return Err(failure("Browser MCP status returned an error")); }
    let value = limited_json(response,1024 * 1024).await?;
    if value["browser"]["status"] != "connected" { return Err(failure("OpenCode HTTP is available but browser MCP is not connected; inspect WSL interop and the Bridge executable")); }
    Ok(())
}
pub(super) fn http_client(base: &str) -> Result<reqwest::Client,RpcError> {
    static LOOPBACK: std::sync::OnceLock<Result<reqwest::Client, String>> = std::sync::OnceLock::new();
    static PROXY: std::sync::OnceLock<Result<reqwest::Client, String>> = std::sync::OnceLock::new();
    let url = reqwest::Url::parse(base).map_err(|_| invalid("Invalid OpenCode URL"))?;
    let is_loopback = profile::is_loopback_host(url.host_str());
    let slot = if is_loopback { &LOOPBACK } else { &PROXY };
    slot.get_or_init(|| {
        let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(3));
        if is_loopback { builder = builder.no_proxy(); }
        builder.build().map_err(|_| "Cannot initialize the system TLS client".to_string())
    })
    .as_ref()
    .cloned()
    .map_err(|msg| failure(msg.as_str()))
}

pub(super) async fn limited_json(mut response: reqwest::Response, limit: usize) -> Result<Value,RpcError> {
    if response.content_length().is_some_and(|length| length > limit as u64) { return Err(failure("OpenCode response exceeded the diagnostic size limit")); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failure("Cannot read OpenCode response"))? {
        if bytes.len() + chunk.len() > limit { return Err(failure("OpenCode response exceeded the diagnostic size limit")); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| failure("OpenCode returned invalid JSON"))
}

