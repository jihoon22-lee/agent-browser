use crate::rpc::RpcError;
use serde_json::{json, Value};

pub(super) fn mcp_check(profile_id: &str, managed: bool, result: Result<&Value, &RpcError>) -> Value {
    let (reason, message) = match result {
        Err(error) if error.details["reason"] == "timeout" => ("query_timeout", "OpenCode MCP status request timed out; registration state is unknown."),
        Err(error) if matches!(error.details["httpStatus"].as_u64(), Some(401 | 403)) => ("query_authentication_failed", "OpenCode rejected the MCP status request credentials; registration state is unknown."),
        Err(_) => ("query_failed", "OpenCode MCP status could not be read; registration state is unknown."),
        Ok(value) if !value.is_object() => ("invalid_response", "OpenCode returned an invalid MCP status response; registration state is unknown."),
        Ok(value) if value.get("browser").is_none() => ("registration_missing", if managed {"This managed OpenCode instance has no browser MCP registration. Inspect this profile's runtime overlay; a missing global mcp block is not itself an error."} else {"This external OpenCode instance has no browser MCP registration. Check the configuration used by this instance."}),
        Ok(value) => match value["browser"]["status"].as_str() {
            Some("connected") => ("connected", "browser MCP is connected to OpenCode."),
            Some("disabled") => ("disabled", "OpenCode reports browser MCP disabled in this instance's effective configuration."),
            Some("needs_auth" | "needs_client_registration") => ("authentication_required", "OpenCode reports that browser MCP needs authentication or client registration."),
            Some("failed") => {
                // Never expose the raw error: OpenCode may include a command,
                // environment values, credentials or arbitrary subprocess output.
                let error=value["browser"]["error"].as_str().unwrap_or("").to_ascii_lowercase();
                if error.contains("enoent") || error.contains("file not found") || error.contains("no such file") {
                    ("executable_missing", "OpenCode reports that the browser MCP executable or working directory was not found (ENOENT). Check the effective Bridge path for this Windows/WSL profile.")
                } else if error.contains("eacces") || error.contains("eperm") || error.contains("access is denied") || error.contains("permission denied") {
                    ("permission_denied", "OpenCode reports access denied while starting browser MCP. Check the selected file's permissions and applicable company policy; no policy was changed.")
                } else if error.contains("timeout") || error.contains("timed out") || error.contains("-32001") {
                    ("connection_timeout", "OpenCode reports a browser MCP connection timeout. Check this profile's Bridge executable, data home and port.")
                } else { ("connection_failed", "OpenCode reports browser MCP connection failure. Its raw error was withheld because it may contain credentials; check this profile's effective Bridge executable, data home and port.") }
            }
            _ => ("unknown_status", "OpenCode returned an unrecognized browser MCP status; no registration change was made."),
        },
    };
    json!({"id":"mcp","profileId":profile_id,"status":if reason=="connected" {"ok"} else {"warning"},"reason":reason,"scope":if managed {"managed_runtime"} else {"external_instance"},"message":message})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{ErrorCode, Retry};
    #[test]
    fn mcp_diagnostic_distinguishes_missing_disabled_failed_and_query_failure() {
        let cases = [
            (json!({}), "registration_missing"),
            (json!({"browser":{"status":"connected"}}), "connected"),
            (json!({"browser":{"status":"disabled"}}), "disabled"),
            (json!({"browser":{"status":"failed","error":"spawn C:\\private\\secret.exe ENOENT token=do-not-print"}}), "executable_missing"),
            (json!({"browser":{"status":"failed","error":"MCP error -32001: Request timed out; password=do-not-print"}}), "connection_timeout"),
            (json!({"browser":{"status":"failed","error":"EACCES secret-path"}}), "permission_denied"),
            (json!({"browser":{"status":"failed","error":"Connection closed: private detail"}}), "connection_failed"),
            (json!({"browser":{"status":"needs_auth"}}), "authentication_required"),
            (json!({"browser":{"status":"future-state","environment":{"TOKEN":"do-not-print"}}}), "unknown_status"),
            (json!([]), "invalid_response"),
        ];
        for (value, expected) in cases {
            let check=mcp_check("fixture",true,Ok(&value));
            assert_eq!(check["reason"],expected);
            let text=check.to_string();
            for private in ["do-not-print","secret-path","private detail","secret.exe","future-state"] { assert!(!text.contains(private)); }
        }
        let query=RpcError::new(ErrorCode::Internal,Retry::Never,"private token=do-not-print").with_details(json!({"reason":"timeout"}));
        let check=mcp_check("fixture",true,Err(&query));
        assert_eq!(check["reason"],"query_timeout");
        assert!(!check.to_string().contains("do-not-print"));
        assert!(!check.to_string().contains("registration_missing"));
        let unauthorized=RpcError::new(ErrorCode::Internal,Retry::Never,"private").with_details(json!({"httpStatus":401}));
        assert_eq!(mcp_check("fixture",false,Err(&unauthorized))["reason"],"query_authentication_failed");
    }
}

