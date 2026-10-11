//! `tool.call` → browser command routing and outcome classification.
use super::{conn::ServerState, now_ms, registry::CommandClass, timeline::TimelineEntry};
use crate::mcp::tools;
use crate::rpc::{ErrorCode, Retry, RpcError};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
const NAVIGATE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Executed { Yes, No, Unknown }

/// What the model sees after a tool call. `tool.call` itself always succeeds at the RPC level.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutcome {
    pub ok: bool,
    pub tool: String,
    pub operation_id: Option<String>,
    pub delivered: bool,
    pub executed: Executed,
    pub verified: Value,
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl ToolOutcome {
    fn success(tool: &str, operation_id: Option<&str>, delivered: bool, executed: Executed, verified: Value, data: Value) -> Self {
        Self { ok: true, tool: tool.into(), operation_id: operation_id.map(str::to_string), delivered, executed, verified, data, error: None }
    }

    fn failure(tool: &str, operation_id: Option<&str>, delivered: bool, error: RpcError) -> Self {
        let executed = if error.code == ErrorCode::ExecutionUnknown {
            Executed::Unknown
        } else if error.details.get("executed") == Some(&Value::Bool(true)) {
            Executed::Yes
        } else {
            Executed::No
        };
        Self {
            ok: false,
            tool: tool.into(),
            operation_id: operation_id.map(str::to_string),
            delivered,
            executed,
            verified: Value::Null,
            data: Value::Null,
            error: Some(error),
        }
    }

    /// A failure before anything was sent to the browser.
    fn rejected(tool: &str, operation_id: Option<&str>, error: RpcError) -> Self {
        Self::failure(tool, operation_id, false, error)
    }
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, Retry::Never, message)
}

/// Hand-rolled check of the parts of the tool schema that matter: required, type, enum, integer range.
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
        let Some(prop) = props.and_then(|p| p.get(key)) else { continue };
        match prop["type"].as_str() {
            Some("string") if !value.is_string() => return Err(invalid(format!("`{key}` must be a string"))),
            Some("boolean") if !value.is_boolean() => return Err(invalid(format!("`{key}` must be a boolean"))),
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
            _ => {}
        }
        if let Some(allowed) = prop["enum"].as_array() {
            if !allowed.contains(value) {
                let names: Vec<&str> = allowed.iter().filter_map(Value::as_str).collect();
                return Err(invalid(format!("`{key}` must be one of: {}", names.join(", "))));
            }
        }
    }
    Ok(())
}

/// Only http(s) pages are operated on. The extension enforces this too; checking here keeps
/// `javascript:`, `file:` and browser-internal URLs from ever being sent.
fn check_url(url: &str) -> Result<(), RpcError> {
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
fn validate_action(name: &str, args: &Value) -> Result<(), RpcError> {
    match name {
        "browser_tabs" => match args["action"].as_str() {
            Some("new") => check_url(args["url"].as_str().ok_or_else(|| invalid("action=new requires `url`"))?),
            Some("switch") if args["tabId"].as_i64().is_none() => Err(invalid("action=switch requires `tabId`")),
            _ => Ok(()),
        },
        "browser_navigate" if args["action"].as_str().unwrap_or("goto") == "goto" => {
            check_url(args["url"].as_str().ok_or_else(|| invalid("action=goto requires `url`"))?)
        }
        _ => Ok(()),
    }
}

fn timeout_for(name: &str, args: &Value) -> Duration {
    match name {
        "browser_wait" => Duration::from_millis(args["timeoutMs"].as_u64().unwrap_or(5000)) + Duration::from_secs(3),
        "browser_navigate" => NAVIGATE_TIMEOUT,
        _ => DEFAULT_TIMEOUT,
    }
}

/// One line for the timeline: tool, selectors and URLs, never typed or page text (only its length).
fn summarize(name: &str, args: &Value) -> String {
    let mut parts = vec![name.to_string()];
    for key in ["action", "kind", "key", "direction", "ref", "tabId", "url", "urlIncludes", "refGone"] {
        match args.get(key) {
            Some(Value::String(s)) => parts.push(format!("{key}={}", s.chars().take(200).collect::<String>())),
            Some(v @ (Value::Number(_) | Value::Bool(_))) => parts.push(format!("{key}={v}")),
            _ => {}
        }
    }
    for key in ["text", "textGone", "option"] {
        if let Some(s) = args.get(key).and_then(Value::as_str) {
            parts.push(format!("{key}({} chars)", s.chars().count()));
        }
    }
    parts.join(" ")
}

pub async fn call_tool(state: &ServerState, name: &str, args: Value) -> ToolOutcome {
    let outcome = run(state, name, &args).await;
    state.timeline.push(TimelineEntry {
        at_ms: now_ms(),
        operation_id: outcome.operation_id.clone(),
        tool: name.to_string(),
        summary: summarize(name, &args),
        outcome: match &outcome.error {
            None => "ok".to_string(),
            Some(e) => serde_json::to_value(e.code).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
        },
    });
    state.broadcast_status();
    outcome
}

async fn run(state: &ServerState, name: &str, args: &Value) -> ToolOutcome {
    let Some(def) = tools::all().into_iter().find(|t| t.name == name) else {
        return ToolOutcome::rejected(name, None, invalid(format!("unknown tool `{name}`")));
    };
    let empty = json!({});
    let args = if args.is_null() { &empty } else { args };
    let operation_id = args["operationId"].as_str();
    // A missing operationId is the most actionable mistake: say "attach first" instead of a schema error.
    let needs_operation = def.schema["required"].as_array().is_some_and(|r| r.iter().any(|k| k == "operationId"));
    if needs_operation && operation_id.is_none() {
        return operation_required(name);
    }
    if let Err(e) = validate(&def.schema, args).and_then(|_| validate_action(name, args)) {
        return ToolOutcome::rejected(name, operation_id, e);
    }
    if name == "browser_tabs" {
        run_tabs(state, args).await
    } else {
        run_operation_tool(state, name, args, &def.schema).await
    }
}

fn operation_required(name: &str) -> ToolOutcome {
    ToolOutcome::rejected(
        name,
        None,
        RpcError::new(ErrorCode::OperationRequired, Retry::Never, "operationId is required. Call browser_tabs with action=attach first."),
    )
}

async fn run_operation_tool(state: &ServerState, name: &str, args: &Value, schema: &Value) -> ToolOutcome {
    let Some(op_id) = args["operationId"].as_str() else { return operation_required(name) };
    let op = match state.ops.check(op_id) {
        Ok(op) => op,
        Err(e) => return ToolOutcome::rejected(name, Some(op_id), e),
    };
    // Forward only what the published schema declares; the gate owns operation, generation and tab.
    let declared = schema["properties"].as_object();
    let mut params: serde_json::Map<String, Value> = args
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, _)| declared.is_some_and(|d| d.contains_key(k.as_str())))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    params.insert("operationId".into(), json!(op.id));
    params.insert("generation".into(), json!(op.generation));
    params.insert("tabId".into(), json!(op.current_tab));
    let class = tools::class_of(name, args);
    let method = format!("browser.{}", name.trim_start_matches("browser_"));
    let result = state.registry.send_command(&method, Value::Object(params), class, timeout_for(name, args)).await;
    finish(state, name, op_id, class, result)
}

/// Turns the browser's reply into an outcome, re-checking the gate so a stopped operation's late result
/// is not handed to the model as fresh information.
fn finish(state: &ServerState, name: &str, op_id: &str, class: CommandClass, result: Result<Value, RpcError>) -> ToolOutcome {
    let aborted = matches!(state.ops.check(op_id), Err(e) if e.code == ErrorCode::Cancelled);
    match result {
        _ if aborted && class == CommandClass::Read => ToolOutcome::failure(
            name,
            Some(op_id),
            true,
            state.ops.check(op_id).err().expect("aborted operation reports CANCELLED"),
        ),
        Ok(mut data) => {
            let verified = data.as_object_mut().and_then(|o| o.remove("verified")).unwrap_or(Value::Null);
            if aborted {
                data = match data {
                    Value::Object(mut o) => {
                        o.insert("abortedAfter".into(), Value::Bool(true));
                        Value::Object(o)
                    }
                    other => json!({ "result": other, "abortedAfter": true }),
                };
            }
            let executed = if class == CommandClass::Write { Executed::Yes } else { Executed::No };
            ToolOutcome::success(name, Some(op_id), true, executed, verified, data)
        }
        Err(mut e) => {
            if aborted {
                let mut details = if e.details.is_object() { e.details.clone() } else { json!({}) };
                details["abortedAfter"] = Value::Bool(true);
                e.details = details;
            }
            let delivered = e.code != ErrorCode::BrowserDisconnected;
            ToolOutcome::failure(name, Some(op_id), delivered, e)
        }
    }
}

async fn run_tabs(state: &ServerState, args: &Value) -> ToolOutcome {
    const NAME: &str = "browser_tabs";
    let action = args["action"].as_str().unwrap_or_default();
    let read = |method: &'static str, params: Value| state.registry.send_command(method, params, CommandClass::Read, DEFAULT_TIMEOUT);
    let delivered_failure = |op: Option<&str>, e: RpcError| {
        let delivered = e.code != ErrorCode::BrowserDisconnected;
        ToolOutcome::failure(NAME, op, delivered, e)
    };
    match action {
        "list" => match read("browser.tabs.list", json!({})).await {
            Ok(data) => ToolOutcome::success(NAME, None, true, Executed::No, Value::Null, data),
            Err(e) => delivered_failure(None, e),
        },
        "attach" => {
            let params = match args["tabId"].as_i64() {
                Some(id) => json!({ "tabId": id }),
                None => json!({}),
            };
            let tab = match read("browser.tabs.get", params).await {
                Ok(tab) => tab,
                Err(e) => return delivered_failure(None, e),
            };
            let Some(tab_id) = tab["tabId"].as_i64() else {
                return ToolOutcome::failure(NAME, None, true, RpcError::new(ErrorCode::Internal, Retry::Never, "browser did not report a tab id"));
            };
            let client = state.registry.selected_client().unwrap_or_default();
            match state.ops.attach(tab_id, &client) {
                Ok(op) => ToolOutcome::success(
                    NAME,
                    Some(&op.id),
                    true,
                    Executed::No,
                    Value::Null,
                    json!({ "operationId": op.id, "generation": op.generation, "tab": tab }),
                ),
                Err(e) => ToolOutcome::failure(NAME, None, true, e),
            }
        }
        "new" => {
            let Some(op_id) = args["operationId"].as_str() else { return operation_required(NAME) };
            let op = match state.ops.check(op_id) {
                Ok(op) => op,
                Err(e) => return ToolOutcome::rejected(NAME, Some(op_id), e),
            };
            let params = json!({ "url": args["url"], "operationId": op.id, "generation": op.generation });
            let created = state.registry.send_command("browser.tabs.create", params, CommandClass::Write, DEFAULT_TIMEOUT).await;
            let tab = match created {
                Ok(tab) => tab,
                Err(e) => return delivered_failure(Some(op_id), e),
            };
            let joined = tab["tabId"].as_i64().ok_or_else(|| {
                RpcError::new(ErrorCode::Internal, Retry::Never, "browser did not report the new tab id").with_details(json!({ "executed": true }))
            });
            let joined = joined.and_then(|tab_id| {
                state.ops.add_tab(op_id, tab_id)?;
                state.ops.switch_tab(op_id, tab_id)
            });
            match joined {
                Ok(()) => ToolOutcome::success(NAME, Some(op_id), true, Executed::Yes, Value::Null, json!({ "tab": tab })),
                Err(mut e) => {
                    // The tab exists even though the operation could not take it.
                    e.details = json!({ "executed": true, "tab": tab });
                    ToolOutcome::failure(NAME, Some(op_id), true, e)
                }
            }
        }
        "switch" => {
            let Some(op_id) = args["operationId"].as_str() else { return operation_required(NAME) };
            let tab_id = args["tabId"].as_i64().unwrap_or_default();
            let op = match state.ops.check(op_id) {
                Ok(op) => op,
                Err(e) => return ToolOutcome::rejected(NAME, Some(op_id), e),
            };
            if !op.tabs.contains(&tab_id) {
                // The gate produces the standard TAB_NOT_FOUND error for tabs outside the operation.
                let e = state.ops.switch_tab(op_id, tab_id).expect_err("tab is outside the operation");
                return ToolOutcome::rejected(NAME, Some(op_id), e);
            }
            match read("browser.tabs.get", json!({ "tabId": tab_id })).await {
                Ok(tab) => match state.ops.switch_tab(op_id, tab_id) {
                    Ok(()) => ToolOutcome::success(NAME, Some(op_id), true, Executed::No, Value::Null, json!({ "tab": tab })),
                    Err(e) => ToolOutcome::failure(NAME, Some(op_id), true, e),
                },
                Err(e) => {
                    if e.code == ErrorCode::TabNotFound {
                        state.ops.remove_tab(tab_id);
                    }
                    delivered_failure(Some(op_id), e)
                }
            }
        }
        "release" => {
            let Some(op_id) = args["operationId"].as_str() else { return operation_required(NAME) };
            match state.ops.release(op_id) {
                Ok(()) => ToolOutcome::success(NAME, Some(op_id), false, Executed::No, Value::Null, json!({ "released": true })),
                Err(e) => ToolOutcome::rejected(NAME, Some(op_id), e),
            }
        }
        other => ToolOutcome::rejected(NAME, None, invalid(format!("unknown action `{other}`"))),
    }
}
