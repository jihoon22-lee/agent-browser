//! Tool argument validation, URL allowlisting, timeouts, and timeline summaries.
use super::{DEFAULT_TIMEOUT, NAVIGATE_TIMEOUT};
use crate::mcp::tools;
use crate::rpc::{ErrorCode, Retry, RpcError};
use serde_json::Value;
use std::time::Duration;

pub(super) fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, Retry::Never, message)
}

pub(super) fn validate_value(key: &str, prop: &Value, value: &Value) -> Result<(), RpcError> {
    match prop["type"].as_str() {
        Some("string") => {
            let Some(s) = value.as_str() else { return Err(invalid(format!("`{key}` must be a string"))); };
            if prop["minLength"].as_u64().is_some_and(|min| (s.chars().count() as u64) < min) {
                return Err(invalid(format!("`{key}` is too short")));
            }
            if prop["maxLength"].as_u64().is_some_and(|max| (s.chars().count() as u64) > max) {
                return Err(invalid(format!("`{key}` exceeds maximum length")));
            }
        }
        Some("boolean") if !value.is_boolean() => return Err(invalid(format!("`{key}` must be a boolean"))),
        Some("number") => {
            let Some(n) = value.as_f64() else { return Err(invalid(format!("`{key}` must be a number"))) };
            if !n.is_finite()
                || prop["minimum"].as_f64().is_some_and(|min| n < min)
                || prop["exclusiveMinimum"].as_f64().is_some_and(|min| n <= min)
                || prop["maximum"].as_f64().is_some_and(|max| n > max)
                || prop["exclusiveMaximum"].as_f64().is_some_and(|max| n >= max)
            {
                return Err(invalid(format!("`{key}` is out of range")));
            }
        }
        Some("integer") => {
            let Some(n) = value.as_i64() else { return Err(invalid(format!("`{key}` must be an integer"))) };
            if prop["minimum"].as_i64().is_some_and(|min| n < min) || prop["maximum"].as_i64().is_some_and(|max| n > max) {
                return Err(invalid(format!(
                    "`{key}` must be between {} and {}",
                    prop["minimum"].as_i64().map_or("-inf".into(), |v| v.to_string()),
                    prop["maximum"].as_i64().map_or("inf".into(), |v| v.to_string()),
                )));
            }
        }
        Some("array") => {
            let Some(items) = value.as_array() else { return Err(invalid(format!("`{key}` must be an array"))); };
            if prop["minItems"].as_u64().is_some_and(|min| (items.len() as u64) < min) {
                return Err(invalid(format!("`{key}` has too few items")));
            }
            if prop["maxItems"].as_u64().is_some_and(|max| (items.len() as u64) > max) {
                return Err(invalid(format!("`{key}` has too many items")));
            }
            if let Some(item_schema) = prop.get("items").filter(|s| s.is_object()) {
                for (idx, item) in items.iter().enumerate() {
                    validate_value(&format!("{key}[{idx}]"), item_schema, item)?;
                }
            }
        }
        Some("object") => {
            if !value.is_object() { return Err(invalid(format!("`{key}` must be an object"))); }
            if prop.get("properties").is_some() || prop.get("required").is_some() {
                validate(prop, value)?;
            }
        }
        _ => {}
    }
    if let Some(allowed) = prop["enum"].as_array() && !allowed.contains(value) {
        let names: Vec<&str> = allowed.iter().filter_map(Value::as_str).collect();
        return Err(invalid(format!("`{key}` must be one of: {}", names.join(", "))));
    }
    Ok(())
}

/// Hand-rolled check of the parts of the tool schema that matter: required, type, enum, integer range, nested object/array, string length.
pub fn validate(schema: &Value, args: &Value) -> Result<(), RpcError> {
    let obj = args.as_object().ok_or_else(|| invalid("arguments must be an object"))?;
    if let Some(required) = schema["required"].as_array() {
        for key in required.iter().filter_map(Value::as_str) {
            if obj.get(key).is_none_or(Value::is_null) {
                return Err(invalid(format!("missing required argument `{key}`")));
            }
        }
    }
    let props = schema["properties"].as_object();
    for (key, value) in obj {
        // A null optional field is an omitted one (free models often send them); it is never forwarded.
        if value.is_null() { continue; }
        let Some(prop) = props.and_then(|p| p.get(key)) else { continue };
        validate_value(key, prop, value)?;
    }
    Ok(())
}

/// Only http(s) pages are operated on. The extension enforces this too; checking here keeps
/// `javascript:`, `file:` and browser-internal URLs from ever being sent.
pub(super) fn check_url(url: &str) -> Result<(), RpcError> {
    let lower = url.trim().to_ascii_lowercase();
    if (lower.starts_with("http://") || lower.starts_with("https://")) && !url.chars().any(char::is_control) {
        return Ok(());
    }
    Err(RpcError::new(
        ErrorCode::UnsupportedPage,
        Retry::Never,
        "Only http: and https: URLs can be opened. chrome:, file:, javascript: and other schemes are not supported.",
    ))
}

/// Checks that depend on which action was asked for.
pub(super) fn validate_action(name: &str, args: &Value) -> Result<(), RpcError> {
    if name=="browser_pointer" {
        let drag=args["mode"]=="drag";
        if drag != (args["toX"].is_number() && args["toY"].is_number()) || (!drag && (args["toX"].is_number() || args["toY"].is_number())) { return Err(invalid("drag requires toX and toY; other modes do not use them")); }
        if args["mode"]!="wheel" && (args["deltaX"].is_number() || args["deltaY"].is_number()) { return Err(invalid("wheel deltas are only for wheel mode")); }
    }
    if name=="browser_dialog" && args["action"]=="respond" && (!args["dialogId"].is_string() || !args["accept"].is_boolean()) {return Err(invalid("respond requires dialogId and accept"));}
    if name=="browser_downloads" && args["action"]!="list" && !args["downloadId"].is_i64() {return Err(invalid("status/wait requires downloadId"));}
    if name=="browser_screenshot" && ((args["scope"]=="region") != args["region"].is_object()) {return Err(invalid("region is required only for scope=region"));}
    if let Some(wait) = args.get("waitFor").filter(|v| !v.is_null()) {
        if !matches!(name,"browser_click"|"browser_press") || args["newTab"]==true {
            return Err(invalid("waitFor is only for click/press in the same tab, without newTab"));
        }
        let fields=wait.as_object().ok_or_else(||invalid("waitFor must be an object"))?;
        if fields.keys().any(|k| !["text","textGone","urlIncludes","match","timeoutMs"].contains(&k.as_str())) {
            return Err(invalid("Unknown waitFor condition"));
        }
        let mut count=0;
        for key in ["text","textGone","urlIncludes"] {
            if let Some(value)=fields.get(key).filter(|v|!v.is_null()) {
                let text=value.as_str().ok_or_else(||invalid("waitFor conditions must be text"))?;
                if text.trim().is_empty()||text.encode_utf16().count()>2000 {return Err(invalid("waitFor conditions need 1..2000 characters"));}
                count+=1;
            }
        }
        if count==0 {return Err(invalid("waitFor needs text, textGone or urlIncludes"));}
        if fields.get("match").is_some_and(|v|!v.is_null() && !matches!(v.as_str(),Some("all"|"any"))) {return Err(invalid("waitFor match must be all or any"));}
        if fields.get("timeoutMs").is_some_and(|v|!v.is_null() && !v.as_u64().is_some_and(|ms|(100..=30000).contains(&ms))) {return Err(invalid("waitFor timeoutMs must be 100..30000"));}
    }
    if name=="browser_wait" && args["match"]=="all" && args.get("refGone").is_some_and(|v|!v.is_null()) {
        return Err(invalid("match=all combines text and URL conditions; wait for refGone separately"));
    }
    match name {
        "browser_tabs" => match args["action"].as_str() {
            Some("new") if args["url"].as_str().is_some_and(|url| url != "about:blank") => check_url(args["url"].as_str().unwrap()),
            Some("switch") if args["tabId"].as_i64().is_none() => Err(invalid("action=switch requires `tabId`")),
            _ => Ok(()),
        },
        "browser_click" if args["newTab"] == true && args["mode"].as_str().is_some_and(|mode| mode != "click") => Err(invalid("`newTab` opens a link with a plain click; omit `mode`")),
        "browser_click" => match (args["mode"].as_str(), args.get("toRef").is_some_and(|v| !v.is_null())) {
            (Some("drag"), false) => Err(invalid("mode=drag requires `toRef`")),
            (mode, true) if mode != Some("drag") => Err(invalid("`toRef` is only for mode=drag")),
            _ => Ok(()),
        },
        "browser_navigate" if args["action"].as_str().unwrap_or("goto") == "goto" => {
            check_url(args["url"].as_str().ok_or_else(|| invalid("action=goto requires `url`"))?)
        }
        _ => Ok(()),
    }
}

pub(super) fn timeout_for(name: &str, args: &Value) -> Duration {
    if matches!(name,"browser_click"|"browser_press") && args.get("waitFor").is_some_and(|v|!v.is_null()) {
        return DEFAULT_TIMEOUT+Duration::from_millis(args["waitFor"]["timeoutMs"].as_u64().unwrap_or(5000))+Duration::from_secs(3);
    }
    match name {
        "browser_wait" | "browser_downloads" => Duration::from_millis(args["timeoutMs"].as_u64().unwrap_or(5000)) + Duration::from_secs(3),
        "browser_navigate" => NAVIGATE_TIMEOUT,
        "browser_tabs" if args["action"] == "new" => NAVIGATE_TIMEOUT,
        _ => DEFAULT_TIMEOUT,
    }
}

/// One line for the timeline: tool, selectors and URLs, never typed or page text (only its length).
pub(super) fn summarize(name: &str, args: &Value) -> String {
    let mut parts = vec![name.to_string()];
    for key in ["action", "kind", "key", "mode", "direction", "ref", "toRef", "file", "tabId", "url", "urlIncludes", "refGone"] {
        match args.get(key) {
            Some(Value::String(s)) => parts.push(format!("{key}={}", s.chars().take(200).collect::<String>())),
            Some(v @ (Value::Number(_) | Value::Bool(_))) => parts.push(format!("{key}={v}")),
            _ => {}
        }
    }
    if let Some(keys) = args.get("modifiers").and_then(Value::as_array) {
        let names: Vec<&str> = keys.iter().filter_map(Value::as_str).take(4).collect();
        if !names.is_empty() { parts.push(format!("modifiers={}", names.join("+"))); }
    }
    if name == "browser_batch" && let Some(steps) = args.get("steps").and_then(Value::as_array) {
        let names: Vec<&str> = steps.iter().filter_map(|step| step["tool"].as_str()).take(6).collect();
        parts.push(format!("steps={} ({})", steps.len(), names.join(",")));
    }
    for key in ["text", "textGone", "option"] {
        if let Some(s) = args.get(key).and_then(Value::as_str) {
            parts.push(format!("{key}({} chars)", s.chars().count()));
        }
    }
    parts.join(" ")
}

/// A null optional argument is an omitted one (free models often send them). Removing it once here
/// keeps every later `get(..).is_some()` and `as_str()` agreeing; a null required argument stays and fails.
pub(super) fn without_null_options(name: &str, mut args: Value) -> Value {
    let required = tools::find(name).and_then(|t| t.schema["required"].as_array());
    if let Some(map) = args.as_object_mut() { map.retain(|key, value| !value.is_null() || required.is_some_and(|r| r.iter().any(|k| k == key))); }
    args
}

