use crate::rpc::{ErrorCode, Retry, RpcError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind { Windows, Wsl, External }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub directory: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distribution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

pub fn invalid(message: impl Into<String>) -> RpcError { RpcError::new(ErrorCode::InvalidParams, Retry::Never, message) }

impl Profile {
    pub fn validate(&self) -> Result<(), RpcError> {
        if self.id.is_empty() || self.id.len() > 64 || !self.id.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)) {
            return Err(invalid("Profile id must contain 1–64 ASCII letters, digits, _ or -"));
        }
        if self.name.trim().is_empty() || self.name.len() > 200 { return Err(invalid("A profile name of at most 200 bytes is required")); }
        if self.directory.trim().is_empty() || self.directory.contains(['\0', '\r', '\n']) { return Err(invalid("An explicit working directory is required")); }
        for value in [&self.executable, &self.distribution, &self.user, &self.username] {
            if value.as_ref().is_some_and(|value| value.is_empty() || value.contains(['\0', '\r', '\n'])) { return Err(invalid("Profile fields must not be empty or contain control characters")); }
        }
        if self.password.as_ref().is_some_and(|value| value.contains(['\0', '\r', '\n'])) { return Err(invalid("The server password must not contain control characters")); }
        if let Some(env) = &self.env {
            for (key, value) in env {
                if key.is_empty() || !key.bytes().enumerate().all(|(index, c)| c.is_ascii_alphabetic() || c == b'_' || (index > 0 && c.is_ascii_digit())) || value.contains('\0') {
                    return Err(invalid("Environment keys must be variable names and values must not contain NUL"));
                }
                if ["AGENT_BROWSER_RUNTIME_ID", "AGENT_BROWSER_RUNTIME_OWNER", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "WSLENV"].contains(&key.to_ascii_uppercase().as_str()) {
                    return Err(invalid("Runtime ownership and server credentials are managed by the Bridge; use external profile authentication fields for an existing server"));
                }
                if key.eq_ignore_ascii_case("OPENCODE_CONFIG_CONTENT") && key != "OPENCODE_CONFIG_CONTENT" { return Err(invalid("Use the canonical OPENCODE_CONFIG_CONTENT environment key")); }
            }
        }
        if self.port == Some(0) { return Err(invalid("Port must be 1–65535, or omitted for automatic selection")); }
        match self.kind {
            Kind::External => { self.external_url()?; }
            Kind::Windows => {
                let executable = self.executable.as_deref().ok_or_else(|| invalid("A Windows OpenCode executable or .cmd launcher path is required"))?;
                #[cfg(windows)]
                if !std::path::Path::new(executable).is_absolute() || !std::path::Path::new(&self.directory).is_absolute() { return Err(invalid("Windows executable and working directory must be absolute paths")); }
                #[cfg(not(windows))]
                if !std::path::Path::new(executable).is_absolute() { return Err(invalid("An absolute executable path is required")); }
                if executable.to_ascii_lowercase().ends_with(".cmd") && executable.contains(['%', '!', '&', '|', '<', '>', '^', '"']) {
                    return Err(invalid("A .cmd launcher path cannot contain cmd metacharacters; select its underlying .exe instead"));
                }
            }
            Kind::Wsl => {
                if !self.executable.as_deref().is_some_and(|path| path.starts_with('/')) || !self.directory.starts_with('/') { return Err(invalid("WSL executable and working directory must be absolute Linux paths")); }
                if self.distribution.is_none() { return Err(invalid("An explicit WSL distribution is required")); }
            }
        }
        Ok(())
    }

    pub fn external_url(&self) -> Result<reqwest::Url, RpcError> {
        let url = reqwest::Url::parse(self.base_url.as_deref().ok_or_else(|| invalid("An external server URL is required"))?).map_err(|_| invalid("Invalid external server URL"))?;
        let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]" | "::1"));
        if !matches!(url.scheme(), "http" | "https") || (url.scheme() == "http" && !loopback) || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
            return Err(invalid("External servers require HTTPS, or loopback HTTP; credentials belong in the authentication fields, not the URL"));
        }
        if url.path() != "/" { return Err(invalid("External server URLs must use the origin root; path prefixes are not supported")); }
        Ok(url)
    }

    pub fn summary(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).expect("profile serializes");
        let object = value.as_object_mut().unwrap();
        object.remove("password");
        object.remove("env");
        object.insert("hasPassword".into(), serde_json::json!(self.password.as_ref().is_some_and(|value| !value.is_empty())));
        object.insert("envKeys".into(), serde_json::json!(self.env.as_ref().map(|env| env.keys().collect::<Vec<_>>()).unwrap_or_default()));
        value
    }

    pub fn preserve_secrets(&mut self, old: &Profile) {
        if self.password.is_none() { self.password = old.password.clone(); }
        if self.env.is_none() { self.env = old.env.clone(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn profile_summary_never_contains_secret_values_and_partial_save_keeps_them() {
        let old: Profile = serde_json::from_value(json!({"id":"work", "name":"Work", "kind":"external", "directory":"/work", "baseUrl":"https://example.test", "password":"server-secret", "env":{"PRIVATE_KEY":"env-secret"}})).unwrap();
        old.validate().unwrap();
        let text = old.summary().to_string();
        assert!(!text.contains("server-secret") && !text.contains("env-secret"));
        assert_eq!(old.summary()["envKeys"], json!(["PRIVATE_KEY"]));
        let mut edited: Profile = serde_json::from_value(json!({"id":"work", "name":"Renamed", "kind":"external", "directory":"/work", "baseUrl":"https://example.test"})).unwrap();
        edited.preserve_secrets(&old);
        assert_eq!(edited.password, old.password);
        assert_eq!(edited.env, old.env);
    }

    #[test]
    fn profile_rejects_path_traversal_ids_remote_plaintext_and_url_credentials() {
        for patch in [json!({"id":"../x"}), json!({"baseUrl":"http://example.test"}), json!({"baseUrl":"https://user:secret@example.test"})] {
            let mut value = json!({"id":"ok","name":"Okay","kind":"external","directory":"/work","baseUrl":"https://example.test"});
            for (key, value_patch) in patch.as_object().unwrap() { value[key] = value_patch.clone(); }
            assert!(serde_json::from_value::<Profile>(value).unwrap().validate().is_err());
        }
    }
}
