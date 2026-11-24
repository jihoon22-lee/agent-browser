//! `tool.call` → browser command routing and outcome classification.
use super::{conn::ServerState, now_ms, registry::{CommandClass, QueuedCommand}, timeline::TimelineEntry};
use crate::mcp::tools;
use crate::rpc::{ErrorCode, Retry, RpcError};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
const NAVIGATE_TIMEOUT: Duration = Duration::from_secs(35);
/// Each read attached to a result. With the longest tool wait it must stay inside the MCP client's REPLY_WAIT.
const FOLLOW_UP_TIMEOUT: Duration = Duration::from_secs(8);

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
    /// This call created an operation, by explicit or implicit attach/new.
    #[serde(skip)]
    pub created_operation: bool,
}

impl ToolOutcome {
    fn success(tool: &str, operation_id: Option<&str>, delivered: bool, executed: Executed, verified: Value, data: Value) -> Self {
        Self { ok: true, tool: tool.into(), operation_id: operation_id.map(str::to_string), delivered, executed, verified, data, error: None, created_operation: false }
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
            created_operation: false,
        }
    }

    /// A failure before anything was sent to the browser.
    fn rejected(tool: &str, operation_id: Option<&str>, error: RpcError) -> Self {
        Self::failure(tool, operation_id, false, error)
    }

    /// A failed browser command: delivered unless no browser was connected to receive it.
    fn from_browser(tool: &str, operation_id: Option<&str>, error: RpcError) -> Self {
        let delivered = error.code != ErrorCode::BrowserDisconnected;
        Self::failure(tool, operation_id, delivered, error)
    }
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, Retry::Never, message)
}

fn validate_value(key: &str, prop: &Value, value: &Value) -> Result<(), RpcError> {
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
    if let Some(allowed) = prop["enum"].as_array() {
        if !allowed.contains(value) {
            let names: Vec<&str> = allowed.iter().filter_map(Value::as_str).collect();
            return Err(invalid(format!("`{key}` must be one of: {}", names.join(", "))));
        }
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

fn timeout_for(name: &str, args: &Value) -> Duration {
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
fn summarize(name: &str, args: &Value) -> String {
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
    if name == "browser_batch" {
        if let Some(steps) = args.get("steps").and_then(Value::as_array) {
            let names: Vec<&str> = steps.iter().filter_map(|step| step["tool"].as_str()).take(6).collect();
            parts.push(format!("steps={} ({})", steps.len(), names.join(",")));
        }
    }
    for key in ["text", "textGone", "option"] {
        if let Some(s) = args.get(key).and_then(Value::as_str) {
            parts.push(format!("{key}({} chars)", s.chars().count()));
        }
    }
    parts.join(" ")
}

/// Who is calling: a managed runtime's proxy names its launch id and OpenCode directory.
#[derive(Clone, Debug, Default)]
pub struct Caller { pub runtime_id: Option<String>, pub cwd: Option<String>, pub connection_id: Option<String> }

pub async fn call_tool(state: &ServerState, name: &str, args: Value) -> ToolOutcome {
    call_tool_as(state, &Caller::default(), name, args).await
}

/// A null optional argument is an omitted one (free models often send them). Removing it once here
/// keeps every later `get(..).is_some()` and `as_str()` agreeing; a null required argument stays and fails.
fn without_null_options(name: &str, mut args: Value) -> Value {
    let required = tools::find(name).and_then(|t| t.schema["required"].as_array());
    if let Some(map) = args.as_object_mut() { map.retain(|key, value| !value.is_null() || required.is_some_and(|r| r.iter().any(|k| k == key))); }
    args
}

pub async fn call_tool_as(state: &ServerState, caller: &Caller, name: &str, args: Value) -> ToolOutcome {
    let started = std::time::Instant::now();
    let args = without_null_options(name, args);
    let outcome = run(state, caller, name, &args).await;
    tracing::debug!(
        tool = name,
        ok = outcome.ok,
        elapsed_ms = started.elapsed().as_millis() as u64,
        error_code = ?outcome.error.as_ref().map(|e| e.code),
        "tool finished"
    );
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

/// Tools that act inside an operation; in a bound panel request their operationId may be omitted.
pub const OPERATION_TOOLS: [&str; 15] = ["browser_batch","browser_snapshot","browser_navigate","browser_click","browser_fill","browser_select",
    "browser_press","browser_scroll","browser_wait","browser_extract","browser_screenshot","browser_upload","browser_pointer","browser_dialog","browser_downloads"];

/// Fills ids a model omitted when the caller is bound to the open panel request.
/// Returns the arguments to run with and whether an implicit attach created the operation.
async fn bind_arguments(state: &ServerState, caller: &Caller, name: &str, args: &Value) -> Result<(Value, bool), ToolOutcome> {
    let action = args["action"].as_str();
    let tabs = name == "browser_tabs";
    // A null id is an omitted id: free models often send optional fields as null.
    let omitted = |key: &str| args.get(key).is_none_or(Value::is_null);
    let wants_request = tabs && matches!(action, Some("attach" | "new")) && omitted("requestId") && omitted("operationId");
    let page_tool = OPERATION_TOOLS.contains(&name);
    let wants_operation = omitted("operationId") && (page_tool || (tabs && matches!(action, Some("switch" | "close" | "release"))));
    if !wants_request && !wants_operation { return Ok((args.clone(), false)); }
    let Some(bound) = super::binding::resolve(state, caller).await else { return Ok((args.clone(), false)); };
    let mut args = if args.is_object() { args.clone() } else { json!({}) };
    if wants_request {
        // A request that already has an operation adds new tabs to it, as an explicit caller would.
        match (&bound.operation, action) { (Some(operation), Some("new")) => args["operationId"] = json!(operation), _ => args["requestId"] = json!(bound.id) }
        return Ok((args, false));
    }
    let (operation, created) = match bound.operation {
        Some(operation) => (operation, false),
        None if page_tool => {
            let read = tools::class_of(name, &args) == CommandClass::Read;
            let mut attached = Box::pin(run_with(state, caller, "browser_tabs", &json!({"action":"attach","requestId":bound.id}), !read)).await;
            // A concurrent id-less call may have attached first: join the operation it made.
            if attached.error.as_ref().is_some_and(|error| error.code == ErrorCode::BrowserBusy) {
                if let Some(operation) = state.ops.bound_request().filter(|now| now.id == bound.id).and_then(|now| now.operation) {
                    // A write joining it has not seen the page either: hold it like a first write.
                    if tools::class_of(name, &args) == CommandClass::Write {
                        return Err(ToolOutcome::rejected(name, Some(&operation), RpcError::new(ErrorCode::StaleElement, Retry::Safe,
                            "This request's tab was just attached by another call and the action did not run. Take browser_snapshot, then repeat the action.")));
                    }
                    args["operationId"] = json!(operation);
                    return Ok((args, false));
                }
            }
            let Some(id) = attached.operation_id.clone().filter(|_| attached.ok) else { attached.tool = name.to_string(); return Err(attached) };
            // Never write on a page the model has not seen: return the attached page instead.
            if tools::class_of(name, &args) == CommandClass::Write {
                let mut held = ToolOutcome::rejected(name, Some(&id), RpcError::new(ErrorCode::StaleElement, Retry::Safe,
                    "This request's tab was just attached and the action did not run. Review the attached snapshot, then repeat the action."));
                held.data = attached.data; held.created_operation = true;
                return Err(held);
            }
            (id, true)
        }
        None => return Ok((args, false)),
    };
    args["operationId"] = json!(operation);
    Ok((args, created))
}

async fn run(state: &ServerState, caller: &Caller, name: &str, args: &Value) -> ToolOutcome {
    run_with(state, caller, name, args, true).await
}

/// `follow_up=false` skips the attached snapshot and tab list: an implicit attach in front of a
/// read discards them, and the read itself reads the page.
async fn run_with(state: &ServerState, caller: &Caller, name: &str, args: &Value, follow_up: bool) -> ToolOutcome {
    run_with_budget(state, caller, name, args, follow_up, None).await
}

async fn run_with_budget(state: &ServerState, caller: &Caller, name: &str, args: &Value, follow_up: bool, budget: Option<Duration>) -> ToolOutcome {
    let Some(def) = tools::find(name) else {
        return ToolOutcome::rejected(name, None, invalid(format!("unknown tool `{name}`")));
    };
    let empty = json!({});
    let args = if args.is_null() { &empty } else { args };
    let needs_operation = OPERATION_TOOLS.contains(&name);
    // Arguments are checked before binding: a call that cannot run must not attach the request's tab.
    if let Err(e) = validate(&def.schema, args).and_then(|_| validate_action(name, args)) {
        let operation_id = args["operationId"].as_str();
        // A missing operationId is the most actionable mistake: say "attach first" instead of a
        // schema error, unless the panel request would have supplied the operation.
        if needs_operation && operation_id.is_none() {
            return match super::binding::resolve(state, caller).await {
                Some(bound) => ToolOutcome::rejected(name, bound.operation.as_deref(), e),
                None => operation_required(name),
            };
        }
        return ToolOutcome::rejected(name, operation_id, e);
    }
    let (bound_args, implicit) = match bind_arguments(state, caller, name, args).await { Ok(bound) => bound, Err(failed) => return failed };
    let args = &bound_args;
    let operation_id = args["operationId"].as_str();
    if needs_operation && operation_id.is_none() {
        return operation_required(name);
    }
    // An implicitly created operation is released if this call is cancelled while it runs.
    let mut implicit_guard = CreatedOperation { state, id: if implicit { operation_id.map(str::to_string) } else { None } };
    let mut outcome = if name == "browser_bookmarks" {
        // This read belongs to the selected browser profile, not a page operation.
        let properties = def.schema["properties"].as_object().unwrap();
        let params = args.as_object().unwrap().iter().filter(|(key,_)|properties.contains_key(*key)).map(|(k,v)|(k.clone(),v.clone())).collect();
        match state.registry.send_command("browser.bookmarks",Value::Object(params),CommandClass::Read,DEFAULT_TIMEOUT).await {
            Ok(data) => ToolOutcome::success(name,None,true,Executed::No,Value::Null,data),
            Err(error) => ToolOutcome::from_browser(name,None,error),
        }
    } else if name == "browser_tabs" {
        run_tabs(state, args).await
    } else if name == "browser_batch" {
        run_batch(state, caller, args).await
    } else {
        run_operation_tool(state, caller, name, args, &def.schema, budget).await
    };
    let creates = name == "browser_tabs" && (args["action"] == "attach" || (args["action"] == "new" && args.get("operationId").is_none()));
    if creates && outcome.ok {if let (Some(id),Some(conn))=(outcome.operation_id.as_deref(),caller.connection_id.as_deref()){state.ops.pin_input_connection(id,conn);}}
    let mut created = CreatedOperation { state, id: if creates && outcome.ok { outcome.operation_id.clone() } else { None } };
    if follow_up {
        add_follow_up_snapshot(state, name, args, &mut outcome).await;
        if name == "browser_tabs" { add_open_tabs(state, args, &mut outcome).await; }
    }
    created.id = None;
    implicit_guard.id = None;
    outcome.created_operation = implicit || (creates && outcome.ok);
    outcome
}

fn operation_required(name: &str) -> ToolOutcome {
    ToolOutcome::rejected(
        name,
        None,
        RpcError::new(ErrorCode::OperationRequired, Retry::Never, "operationId is required. Call browser_tabs with action=attach first."),
    )
}

/// How long a tool call waits while the user holds the browser; below the MCP reply window.
pub(crate) const HANDOFF_WAIT: Duration = Duration::from_secs(45);

async fn run_operation_tool(state: &ServerState, caller:&Caller, name: &str, args: &Value, schema: &Value, budget: Option<Duration>) -> ToolOutcome {
    let Some(op_id) = args["operationId"].as_str() else { return operation_required(name) };
    if name=="browser_pointer"&&!state.ops.input_connection_matches(op_id,caller.connection_id.as_deref()) {return ToolOutcome::rejected(name,Some(op_id),RpcError::new(ErrorCode::ForbiddenMethod,Retry::Never,"Visual input must use the MCP connection that attached this request. Start a new panel request after reconnecting."));}
    let started = tokio::time::Instant::now();
    let handoff_wait = budget.map_or(HANDOFF_WAIT, |limit| HANDOFF_WAIT.min(limit));
    if let Err(error) = state.ops.wait_until_resumed(op_id, handoff_wait).await { return ToolOutcome::rejected(name, Some(op_id), error); }
    // Forward only what the published schema declares; the gate owns operation, generation and tab.
    let declared = schema["properties"].as_object();
    let mut params: serde_json::Map<String, Value> = args
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, v)| !v.is_null() && declared.is_some_and(|d| d.contains_key(k.as_str())))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    // The extension uploads only the attachments of the panel request that owns this operation; after a
    // Bridge restart or outside a panel request there is none, even if the extension still holds files.
    if matches!(name,"browser_upload"|"browser_pointer") { if let Some(request) = state.ops.panel_request_of(op_id) { params.insert("panelRequestId".into(), json!(request)); } }
    let class = tools::class_of(name, args);
    let method = format!("browser.{}", name.trim_start_matches("browser_"));
    let timeout = match budget {
        Some(limit) => timeout_for(name, args).min(limit.saturating_sub(started.elapsed()).max(Duration::from_millis(500))),
        None => timeout_for(name, args),
    };
    let queued = match queue_operation_tool(state, op_id, &method, params, class, timeout) {
        Ok(queued) => queued,
        Err(error) => return ToolOutcome::rejected(name, Some(op_id), error),
    };
    let origin = queued.origin.clone();
    finish(state, name, op_id, class, &origin, queued.wait().await)
}

struct OperationCommand<'a> { queued: QueuedCommand<'a>, origin: super::operation::Operation, timeout: Duration }
impl OperationCommand<'_> { async fn wait(self) -> Result<Value,RpcError> { self.queued.wait(self.timeout).await } }

/// The extension is told how long this wait is (replyWithinMs), so a page that went silent behind a
/// dialog is reported by the extension, which knows why, before this side gives up.
fn reply_within(params: &mut serde_json::Map<String, Value>, timeout: Duration) {
    params.insert("replyWithinMs".into(), json!(u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX)));
}

fn queue_operation_tool<'a>(state: &'a ServerState, op_id: &str, method: &str, mut params: serde_json::Map<String, Value>, class: CommandClass, timeout: Duration) -> Result<OperationCommand<'a>, RpcError> {
    state.ops.with_checked(op_id, true, |op| {
        ensure_not_held(op)?;
        if class==CommandClass::Write && op.needs_observation {return Err(observation_required(op));}
        params.insert("operationId".into(), json!(op.id));
        params.insert("generation".into(), json!(op.generation));
        params.insert("targetEpoch".into(),json!(op.target_epoch));
        params.insert("tabId".into(), json!(op.current_tab));
        reply_within(&mut params, timeout);
        let queued = state.registry.queue_command_for(&op.client_id, method, Value::Object(params), class)?;
        Ok(OperationCommand {queued,origin:op.clone(),timeout})
    })
}

/// Turns the browser's reply into an outcome, re-checking the gate so a stopped operation's late result
/// is not handed to the model as fresh information.
fn finish(state: &ServerState, name: &str, op_id: &str, class: CommandClass, origin: &super::operation::Operation, result: Result<Value, RpcError>) -> ToolOutcome {
    let cancellation = state.ops.check_active(op_id).err().filter(|e| e.code == ErrorCode::Cancelled);
    let aborted = cancellation.is_some();
    match result {
        _ if aborted && class == CommandClass::Read => ToolOutcome::failure(
            name,
            Some(op_id),
            true,
            cancellation.expect("captured cancellation"),
        ),
        Ok(mut data) => {
            if (name=="browser_snapshot" && data["tabId"].as_i64()==Some(origin.current_tab)) || (name=="browser_screenshot" && data["captureId"].is_string() && data["geometry"]["tabId"].as_i64()==Some(origin.current_tab)) {state.ops.observe_target(origin);}
            if matches!(name,"browser_click"|"browser_press") {
                let mut adopted = None;
                if let Some(children) = data.get_mut("openedTabs").and_then(Value::as_array_mut) {
                    let ids: Vec<_> = children.iter().take(16).filter(|tab| tab["sourceTabId"].as_i64() == Some(origin.current_tab) && tab["sourceFrameId"].as_i64().is_some_and(|frame| frame >= 0) && (tab["url"].as_str().is_some_and(|url| check_url(url).is_ok()) ||
                        (matches!(tab["url"].as_str(),Some(""|"about:blank")) && tab["pendingUrl"].as_str().is_some_and(|url|check_url(url).is_ok())))).filter_map(|tab| tab["tabId"].as_i64()).collect();
                    if !aborted { adopted = state.ops.adopt_children(op_id,origin.generation,&origin.client_id,origin.current_tab,&ids).ok(); }
                    for child in children { if child.is_object() { child["adopted"] = json!(adopted.as_ref().is_some_and(|op| child["tabId"].as_i64().is_some_and(|id| ids.contains(&id) && op.tabs.contains(&id)))); } }
                }
                // Only a tab that actually joined changes the target; otherwise the page and its refs are as they were.
                if let Some(op) = adopted.filter(|_| data["openedTabs"].as_array().is_some_and(|tabs| tabs.iter().any(|tab| tab["adopted"] == true))) { data["currentTab"] = json!(op.current_tab); data["operationTabs"] = json!(op.tabs); data["nextStep"] = json!("Take a fresh browser_snapshot in the current tab before acting; previous-tab refs do not transfer."); }
            }
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
            // A page that cannot be read has nothing unseen to act on: the answer itself is the
            // observation, so a blank or internal tab can still be navigated away from.
            if name=="browser_snapshot" && e.code==ErrorCode::UnsupportedPage {state.ops.observe_target(origin);}
            // If the extension reports the target tab no longer exists, reconcile the gate immediately
            // (matching browser_tabs switch) so the operation is not stranded on a dead tab when
            // Chrome's tab.closed event was missed or delayed.
            if matches!(e.code, ErrorCode::TabNotFound | ErrorCode::TabClosed) {
                state.ops.forget_missing_tab(op_id, origin.current_tab);
            }
            if aborted {
                let mut details = if e.details.is_object() { e.details.clone() } else { json!({}) };
                details["abortedAfter"] = Value::Bool(true);
                e.details = details;
            }
            ToolOutcome::from_browser(name, Some(op_id), e)
        }
    }
}

async fn open_tabs(state: &ServerState, client: &str, window: Option<i64>) -> Value {
    let params = match window { Some(id) => json!({ "windowId": id }), None => json!({}) };
    let Ok(queued) = state.registry.queue_command_for(client, "browser.tabs.list", params, CommandClass::Read) else { return Value::Null };
    let Ok(listed) = queued.wait(FOLLOW_UP_TIMEOUT).await else { return Value::Null };
    let tabs: Vec<Value> = listed["tabs"].as_array().into_iter().flatten().take(20).map(|tab| json!({
        "tabId": tab["tabId"], "active": tab["active"], "attachable": tab["attachable"],
        "title": clip_chars(&tab["title"], TAB_TITLE_CHARS), "url": clip_chars(&tab["url"], TAB_URL_CHARS),
    })).collect();
    json!(tabs)
}

const TAB_TITLE_CHARS: usize = 60;
const TAB_URL_CHARS: usize = 100;
/// The `tabs` array of `browser_tabs list`; with the outcome's own fields it stays under the MCP text limit.
const TAB_LIST_BYTES: usize = 32_000;

fn clip_chars(value: &Value, max: usize) -> String {
    value.as_str().unwrap_or("").chars().take(max).collect()
}

/// A tab list is a menu of ids: titles and URLs are clipped like `openTabs`, and a list that still
/// does not fit keeps its first tabs and says how many were left out.
fn bounded_tab_list(mut data: Value) -> Value {
    let Some(tabs) = data.get_mut("tabs").and_then(Value::as_array_mut) else { return data };
    let (total, mut bytes, mut kept) = (tabs.len(), 0, 0);
    for tab in tabs.iter_mut() {
        for (key, max) in [("title", TAB_TITLE_CHARS), ("url", TAB_URL_CHARS)] {
            if tab[key].is_string() { tab[key] = json!(clip_chars(&tab[key], max)); }
        }
        bytes += tab.to_string().len() + 1;
        if bytes > TAB_LIST_BYTES { break; }
        kept += 1;
    }
    tabs.truncate(kept);
    if kept < total {
        data["omittedTabs"] = json!(total - kept);
        data["note"] = json!(format!("Only the first {kept} of {total} tabs are listed. Use action=windows, then list with windowId to read one window."));
    }
    data
}

/// Tab choices travel with the results that need them, so the model never guesses a tabId.
async fn add_open_tabs(state: &ServerState, args: &Value, outcome: &mut ToolOutcome) {
    let action = args["action"].as_str().unwrap_or_default();
    let failed_switch = action == "switch" && outcome.error.as_ref().is_some_and(|error| matches!(error.code, ErrorCode::TabNotFound | ErrorCode::UnsupportedPage));
    if !((outcome.ok && matches!(action, "attach" | "new")) || failed_switch) { return; }
    let client = outcome.operation_id.as_deref().and_then(|op| state.ops.check_active(op).ok()).map(|op| op.client_id).or_else(|| state.registry.selected_client());
    let Some(client) = client else { return };
    let window = if failed_switch { None } else { outcome.data["tab"]["windowId"].as_i64() };
    let tabs = open_tabs(state, &client, window).await;
    if tabs.is_null() { return; }
    if !outcome.data.is_object() { outcome.data = json!({}); }
    outcome.data["openTabs"] = tabs;
}

/// Page-changing tools return the page they produced, so the model needs no extra snapshot call.
/// Unchanged pages keep their refs, so an unchanged click returns none and saves context.
fn wants_snapshot(name: &str, args: &Value, outcome: &ToolOutcome) -> bool {
    if outcome.verified["dialogPending"] == true { return false; }
    match name {
        "browser_click" | "browser_upload" => outcome.verified["expectationMet"] == true || outcome.verified["urlChanged"] == true || outcome.verified["domChanged"] == true || outcome.data["currentTab"].is_number(),
        "browser_press" | "browser_navigate" => true,
        "browser_batch" => outcome.verified["pageChanged"] == true,
        "browser_tabs" => match args["action"].as_str() {
            Some("attach" | "switch") => true,
            Some("new") => args["url"].as_str().is_some_and(|url| url != "about:blank"),
            _ => false,
        },
        _ => false,
    }
}

const BATCH_TOOLS: [&str; 4] = ["click", "fill", "select", "press"];
/// A batch starts no new step after this, so its reply stays well inside the MCP reply window.
const BATCH_TIME: Duration = Duration::from_secs(20);
/// Hard cap for the entire batch (steps + handoff waits), leaving headroom for follow-up snapshot inside REPLY_WAIT (60s).
const BATCH_BUDGET: Duration = Duration::from_secs(45);

/// Each step runs exactly as its own tool would (checks, handoff wait, gate), without follow-up reads.
/// A step that changed the page ends the batch: later refs may no longer point where the model meant.
async fn run_batch(state: &ServerState, caller: &Caller, args: &Value) -> ToolOutcome {
    const NAME: &str = "browser_batch";
    let op_id = args["operationId"].as_str().unwrap_or_default().to_string();
    let reject = |message: String| ToolOutcome::rejected(NAME, Some(&op_id), invalid(message));
    let steps = args["steps"].as_array().cloned().unwrap_or_default();
    if steps.is_empty() || steps.len() > 6 { return reject("steps must list 1 to 6 actions".into()); }
    let mut planned = vec![];
    // Every step is checked before the first runs: a batch never stops on a typo halfway through.
    for (index, step) in steps.iter().enumerate() {
        let Some(tool) = step["tool"].as_str().filter(|tool| BATCH_TOOLS.contains(tool)) else { return reject(format!("step {} needs tool click, fill, select or press", index + 1)) };
        let name = format!("browser_{tool}");
        let mut step_args = step.clone();
        let Some(fields) = step_args.as_object_mut() else { return reject(format!("step {} must be an object", index + 1)) };
        fields.remove("tool"); fields.insert("operationId".into(), json!(op_id));
        let def = tools::find(&name).expect("batch tools exist");
        if let Err(error) = validate(&def.schema, &step_args).and_then(|_| validate_action(&name, &step_args)) { return reject(format!("step {}: {}", index + 1, error.message)); }
        planned.push((name, step_args));
    }
    let started = tokio::time::Instant::now();
    let (mut ran, mut executed, mut stop, mut last) = (vec![], Executed::No, None::<&str>, None::<ToolOutcome>);
    for (index, (name, step_args)) in planned.iter().enumerate() {
        if index > 0 && started.elapsed() > BATCH_TIME { stop = Some("time"); break; }
        let remaining = BATCH_BUDGET.saturating_sub(started.elapsed());
        if index > 0 && remaining < Duration::from_secs(1) { stop = Some("time"); break; }
        let outcome = Box::pin(run_with_budget(state, caller, name, step_args, false, Some(remaining))).await;
        executed = match (executed, outcome.executed) { (Executed::Unknown, _) | (_, Executed::Unknown) => Executed::Unknown, (Executed::Yes, _) | (_, Executed::Yes) => Executed::Yes, _ => Executed::No };
        let dialog_pending = outcome.verified["dialogPending"] == true;
        let changed = outcome.verified["urlChanged"] == true || outcome.data["currentTab"].is_number()
            || (name != "browser_fill" && name != "browser_select" && (outcome.verified["domChanged"] == true || outcome.verified["expectationMet"] == true));
        ran.push(json!({"step": index + 1, "tool": name, "ok": outcome.ok, "executed": outcome.executed, "verified": outcome.verified, "error": outcome.error}));
        let ok = outcome.ok; last = Some(outcome);
        if !ok { stop = Some("failed"); break; }
        if dialog_pending { stop = Some("dialogPending"); break; }
        if changed { if index + 1 < planned.len() { stop = Some("pageChanged"); } break; }
    }
    let (completed, last) = (ran.len(), last.expect("a batch runs at least one step"));
    let dialog_pending = stop == Some("dialogPending") || last.verified["dialogPending"] == true;
    let page_changed = last.ok && !dialog_pending && (stop == Some("pageChanged") || wants_snapshot(&planned[completed - 1].0, &planned[completed - 1].1, &last));
    let mut data = json!({"steps": ran});
    // Preserve important step data from the terminal step (openedTabs, currentTab, operationTabs, dialog, nextStep, etc.).
    if let (Some(dst), Some(src)) = (data.as_object_mut(), last.data.as_object()) {
        for (k, v) in src {
            if k != "steps" && k != "note" { dst.insert(k.clone(), v.clone()); }
        }
    }
    match stop {
        Some("dialogPending") if completed < planned.len() => data["note"] = json!(format!("Stopped after step {completed}: a dialog opened. Steps {}-{} did not run; handle the dialog with browser_dialog.", completed + 1, planned.len())),
        Some("pageChanged") => data["note"] = json!(format!("Stopped after step {completed}: the page changed. Steps {}-{} did not run; use the returned snapshot.", completed + 1, planned.len())),
        Some("time") => data["note"] = json!(format!("Stopped before step {}: time ran out. Later steps did not run; take browser_snapshot first.", completed + 1)),
        _ => {}
    }
    let mut verified = json!({"completed": completed, "total": planned.len(), "pageChanged": page_changed});
    if dialog_pending { verified["dialogPending"] = json!(true); }
    if let Some(error) = last.error.filter(|_| stop == Some("failed")) {
        let mut failed = ToolOutcome::failure(NAME, Some(&op_id), last.delivered, error);
        failed.executed = executed; failed.verified = verified; failed.data = data;
        return failed;
    }
    ToolOutcome::success(NAME, Some(&op_id), true, executed, verified, data)
}

/// Follow-up snapshots ride on every page-changing action; on busy pages the next step rarely
/// needs more than the first screenful of controls, and elementsNextOffset says how to read on.
pub(crate) const FOLLOW_UP_MAX_ELEMENTS: u64 = 40;

async fn follow_up_snapshot(state: &ServerState, op_id: &str) -> Result<Value, RpcError> {
    // A smaller text budget: the elements are what the next action needs. settleMs lets a
    // link click finish committing the next document before it is read.
    let params = json!({ "maxChars": 1500, "settleMs": 6000, "maxElements": FOLLOW_UP_MAX_ELEMENTS }).as_object().cloned().expect("object");
    let queued = queue_operation_tool(state, op_id, "browser.snapshot", params, CommandClass::Read, FOLLOW_UP_TIMEOUT)?;
    let origin = queued.origin.clone();
    let result = queued.wait().await;
    let outcome = finish(state, "browser_snapshot", op_id, CommandClass::Read, &origin, result);
    match outcome.error { Some(error) => Err(error), None => Ok(outcome.data) }
}

async fn add_follow_up_snapshot(state: &ServerState, name: &str, args: &Value, outcome: &mut ToolOutcome) {
    let stale_write = !outcome.ok && tools::class_of(name, args) == CommandClass::Write
        && (outcome.executed == Executed::No || name == "browser_batch")
        && outcome.verified["dialogPending"] != true
        && outcome.error.as_ref().is_some_and(|error| error.code == ErrorCode::StaleElement);
    if !(outcome.ok && wants_snapshot(name, args, outcome)) && !stale_write { return; }
    let Some(op_id) = outcome.operation_id.clone() else { return };
    if !outcome.data.is_object() {
        outcome.data = if outcome.data.is_null() { json!({}) } else { json!({ "result": outcome.data.take() }) };
    }
    match follow_up_snapshot(state, &op_id).await {
        Ok(snapshot) => outcome.data["snapshot"] = snapshot,
        Err(error) => outcome.data["snapshotError"] = json!({ "code": error.code, "message": error.message }),
    }
}

/// A call cancelled while its follow-up reads are pending must not strand the operation it
/// created: the MCP client never learned its operationId and could not release it.
struct CreatedOperation<'a> { state: &'a ServerState, id: Option<String> }
impl Drop for CreatedOperation<'_> {
    fn drop(&mut self) {
        let Some(id) = self.id.take() else { return };
        if let Some(op) = self.state.ops.abort(Some(&id)) {
            self.state.registry.notify_for(&op.client_id, "browser.cancel", json!({ "operationId": op.id, "generation": op.generation }));
            self.state.broadcast_status();
        }
    }
}

/// The user may take the browser over between the handoff wait and the enqueue.
fn ensure_not_held(op: &super::operation::Operation) -> Result<(), RpcError> {
    if !op.paused { return Ok(()); }
    Err(RpcError::new(ErrorCode::BrowserBusy, Retry::Safe,
        "The user has taken over this tab. Wait, then try again; take a fresh snapshot before acting.").with_details(json!({"handoff": true})))
}

/// Why the next write needs a fresh snapshot: the user handled the browser, or a closed tab sent
/// the operation back to an earlier one.
fn observation_required(op: &super::operation::Operation) -> RpcError {
    if op.handed_back {
        RpcError::new(ErrorCode::StaleElement,Retry::Safe,"The user handled the browser and handed it back. Take browser_snapshot to see the current page before changing it.")
    } else { restored_target_needs_snapshot() }
}

fn restored_target_needs_snapshot() -> RpcError {
    RpcError::new(ErrorCode::StaleElement,Retry::Safe,"The current tab closed and this operation returned to a previously visited tab. Take browser_snapshot to confirm the restored target before changing or closing it.")
}

async fn run_tabs(state: &ServerState, args: &Value) -> ToolOutcome {
    const NAME: &str = "browser_tabs";
    let action = args["action"].as_str().unwrap_or_default();
    let read = |method: &'static str, params: Value| state.registry.send_command(method, params, CommandClass::Read, DEFAULT_TIMEOUT);
    let delivered_failure = |op: Option<&str>, e: RpcError| ToolOutcome::from_browser(NAME, op, e);
    // Tab actions inside an operation wait while the user holds the browser, like page tools.
    if let Some(op_id) = args["operationId"].as_str().filter(|_| matches!(action, "new" | "switch" | "close")) {
        if let Err(error) = state.ops.wait_until_resumed(op_id, HANDOFF_WAIT).await { return ToolOutcome::rejected(NAME, Some(op_id), error); }
    }
    match action {
        "list" | "windows" => match read(if action == "windows" {"browser.windows.list"} else {"browser.tabs.list"}, json!({"windowId":args["windowId"]})).await {
            Ok(data) => ToolOutcome::success(NAME, None, true, Executed::No, Value::Null, if action == "list" { bounded_tab_list(data) } else { data }),
            Err(e) => delivered_failure(None, e),
        },
        "attach" => {
            // Read lock blocks browser.use (write lock) during tabs.get, while allowing concurrent request.begin (try_read).
            let _selection = state.selection.read().await;
            let client = state.registry.selected_client().unwrap_or_default();
            let target=match state.ops.request_target(args["requestId"].as_str(),&client,args["tabId"].as_i64()) {
                Ok(target)=>target,Err(e)=>return ToolOutcome::rejected(NAME,None,e),
            };
            let params = match target {
                Some(id) => json!({ "tabId": id }),
                None => json!({}),
            };
            let queued = match state.registry.queue_command_for(&client, "browser.tabs.get", params, CommandClass::Read) {
                Ok(queued) => queued,
                Err(error) => return delivered_failure(None, error),
            };
            let tab = match queued.wait(DEFAULT_TIMEOUT).await {
                Ok(tab) => tab,
                Err(e) => return delivered_failure(None, e),
            };
            let Some(tab_id) = tab["tabId"].as_i64() else {
                return ToolOutcome::failure(NAME, None, true, RpcError::new(ErrorCode::Internal, Retry::Never, "browser did not report a tab id"));
            };
            match state.ops.attach_request(tab_id, &client,args["requestId"].as_str()) {
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
            // A dropped/cancelled creation must not strand a pending operation.
            struct Reservation<'a> { state: &'a ServerState, id: Option<String> }
            // A cancelled call never reaches call_tool_as's broadcast, so the release announces itself.
            impl Drop for Reservation<'_> { fn drop(&mut self) { if let Some(id) = &self.id && self.state.ops.release(id).is_ok() { self.state.broadcast_status(); } } }
            let selection = state.selection.read().await;
            let mut reservation = Reservation {state, id:None};
            let new_id;
            let explicit_op = args["operationId"].as_str().is_some();
            let op_id = if let Some(id) = args["operationId"].as_str() { id } else {
                let client = state.registry.selected_client().unwrap_or_default();
                match state.ops.reserve_new(&client,args["requestId"].as_str()) {
                    Ok(op) => { new_id = op.id; reservation.id=Some(new_id.clone()); &new_id }
                    Err(error) => return ToolOutcome::rejected(NAME,None,error),
                }
            };
            let fail_op = explicit_op.then_some(op_id);
            let queued = state.ops.with_checked(op_id, false, |op| {
                ensure_not_held(op)?;
                let params = json!({ "url": args["url"].as_str().unwrap_or("about:blank"), "operationId": op.id, "generation": op.generation,
                    "windowId":args["windowId"],"sourceTabId":if op.current_tab_closed {None} else {Some(op.current_tab)} });
                state.registry.queue_command_for(&op.client_id, "browser.tabs.create", params, CommandClass::Write)
            });
            drop(selection);
            let queued = match queued {
                Ok(queued) => queued,
                Err(error) => return ToolOutcome::rejected(NAME, fail_op, error),
            };
            let created = queued.wait(timeout_for(NAME, args)).await;
            let tab = match created {
                Ok(tab) => tab,
                Err(e) => return delivered_failure(fail_op, e),
            };
            let joined = tab["tabId"].as_i64().ok_or_else(|| {
                RpcError::new(ErrorCode::Internal, Retry::Never, "browser did not report the new tab id").with_details(json!({ "executed": true }))
            });
            let joined = joined.and_then(|tab_id| state.ops.add_and_switch_tab(op_id, tab_id));
            match joined {
                Ok(()) => {
                    reservation.id=None;
                    ToolOutcome::success(NAME, Some(op_id), true, Executed::Yes, Value::Null, json!({ "tab": tab, "nextStep":"Use browser_snapshot before page actions; for about:blank first browser_navigate to an HTTP(S) URL." }))
                },
                Err(mut e) => {
                    // The tab exists even though the operation could not take it.
                    e.details = json!({ "executed": true, "tab": tab });
                    ToolOutcome::failure(NAME, fail_op, true, e)
                }
            }
        }
        "switch" => {
            let Some(op_id) = args["operationId"].as_str() else { return operation_required(NAME) };
            let tab_id = args["tabId"].as_i64().unwrap_or_default();
            let queued = state.ops.with_checked(op_id, false, |op| {
                ensure_not_held(op)?;
                state.registry.queue_command_for(&op.client_id, "browser.tabs.get", json!({ "tabId": tab_id }), CommandClass::Read)
            });
            let queued = match queued {
                Ok(queued) => queued,
                Err(error) => return ToolOutcome::rejected(NAME, Some(op_id), error),
            };
            match queued.wait(DEFAULT_TIMEOUT).await {
                Ok(tab) if tab["tabId"].as_i64()==Some(tab_id) && (tab["attachable"]==true || (matches!(tab["url"].as_str(),Some(""|"about:blank")) && state.ops.check_active(op_id).is_ok_and(|op|op.tabs.contains(&tab_id)))) => match state.ops.visit_verified_tab(op_id, tab_id) {
                    Ok(()) => ToolOutcome::success(NAME, Some(op_id), true, Executed::No, Value::Null, json!({ "tab": tab })),
                    Err(e) => ToolOutcome::failure(NAME, Some(op_id), true, e),
                },
                Ok(_) => delivered_failure(Some(op_id),RpcError::new(ErrorCode::UnsupportedPage,Retry::Never,"Select an ordinary HTTP(S) tab from browser_tabs list")),
                Err(e) => {
                    if e.code == ErrorCode::TabNotFound {
                        state.ops.forget_missing_tab(op_id, tab_id);
                    }
                    delivered_failure(Some(op_id), e)
                }
            }
        }
        "close" => {
            let Some(op_id) = args["operationId"].as_str() else { return operation_required(NAME) };
            // Target is the current operation tab; never accept an arbitrary tabId.
            let queued = state.ops.with_checked(op_id, true, |op| {
                ensure_not_held(op)?;
                if op.needs_observation {return Err(observation_required(op));}
                if args.get("tabId").is_some() { return Err(invalid("close targets the current tab; switch first")); }
                let mut params = json!({"operationId":op.id,"generation":op.generation,"tabId":op.current_tab}).as_object().cloned().expect("object");
                reply_within(&mut params, DEFAULT_TIMEOUT);
                let queued = state.registry.queue_command_for(&op.client_id,"browser.tabs.close",Value::Object(params),CommandClass::Write)?;
                Ok((op.current_tab, queued))
            });
            let (tab_id, queued) = match queued {
                Ok(value) => value,
                Err(error) => return ToolOutcome::rejected(NAME,Some(op_id),error),
            };
            match queued.wait(DEFAULT_TIMEOUT).await {
                Ok(data) if data["closed"] == true => {
                    state.ops.remove_tab_for_operation(op_id, tab_id);
                    let remaining = state.ops.check_active(op_id).ok();
                    ToolOutcome::success(NAME,Some(op_id),true,Executed::Yes,json!({"closed":true}),
                        json!({"tabId":tab_id,"operationTabs":remaining.as_ref().map(|op| &op.tabs),
                            "abortedAfter":remaining.is_none(),
                            "currentTab":remaining.as_ref().filter(|op|!op.current_tab_closed).map(|op|op.current_tab),
                            "nextStep":"Snapshot the restored target before continuing; if none remains, switch to an explicit listed HTTP(S) tab or create a new tab with this operationId."}))
                }
                Ok(_) => delivered_failure(Some(op_id),RpcError::new(ErrorCode::ExecutionUnknown,Retry::Unsafe,"Closure was not confirmed. Inspect tabs before retrying.")),
                Err(error) => delivered_failure(Some(op_id),error),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drag_needs_a_target_and_only_drag_takes_one() {
        assert!(validate_action("browser_click", &json!({"ref":"a","mode":"drag"})).is_err());
        assert!(validate_action("browser_click", &json!({"ref":"a","mode":"drag","toRef":"b"})).is_ok());
        assert!(validate_action("browser_click", &json!({"ref":"a","toRef":"b"})).is_err());
    }

    #[test]
    fn null_optional_fields_are_omitted_but_required_ones_still_fail() {
        let click = &tools::find("browser_click").unwrap().schema;
        assert!(validate(click, &json!({"ref":"a","mode":null,"toRef":null,"newTab":null})).is_ok());
        assert!(validate_action("browser_click", &json!({"ref":"a","mode":null,"toRef":null})).is_ok());
        assert!(validate(click, &json!({"ref":null})).is_err());
    }

    #[tokio::test]
    async fn null_optional_fields_are_not_forwarded() {
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        state.registry.register("A", tx);
        let op = state.ops.attach(1, "A").unwrap();
        let mut pending = Box::pin(call_tool(&state, "browser_click", json!({"operationId":op.id,"ref":"s1f0e1","mode":null,"toRef":null})));
        assert!(futures_util::poll!(pending.as_mut()).is_pending());
        let Envelope::Req { params, .. } = parse_envelope(&rx.try_recv().unwrap()).unwrap() else { panic!() };
        assert!(params.get("mode").is_none() && params.get("toRef").is_none(), "{params}");
    }

    /// The extension answers a page that went silent (a dialog) only if it knows when the Bridge stops waiting.
    #[tokio::test]
    async fn each_page_command_carries_the_wait_the_bridge_gives_it() {
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = state.registry.register("A", tx);
        let op = state.ops.attach(1, "A").unwrap();
        // A dropped pending call cancels its command; only the requests matter here.
        let next = |rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>| loop {
            let env = parse_envelope(&rx.try_recv().unwrap()).unwrap();
            if !matches!(&env, Envelope::Req { method, .. } if method == "browser.cancel") { return env; }
        };
        for (name, args) in [
            ("browser_wait", json!({"operationId":op.id,"text":"Ready","timeoutMs":5000})),
            ("browser_click", json!({"operationId":op.id,"ref":"s1f0e1","waitFor":{"text":"Ready","timeoutMs":2000}})),
            ("browser_snapshot", json!({"operationId":op.id})),
        ] {
            let mut pending = Box::pin(call_tool(&state, name, args.clone()));
            assert!(futures_util::poll!(pending.as_mut()).is_pending());
            let Envelope::Req { params, .. } = next(&mut rx) else { panic!() };
            assert_eq!(params["replyWithinMs"].as_u64(), Some(timeout_for(name, &args).as_millis() as u64), "{name}: {params}");
        }
        state.ops.release(&op.id).unwrap();
        let op = state.ops.attach(1, "A").unwrap();
        let mut clicked = Box::pin(call_tool(&state, "browser_click", json!({"operationId":op.id,"ref":"s1f0e1"})));
        assert!(futures_util::poll!(clicked.as_mut()).is_pending());
        let Envelope::Req { id, .. } = next(&mut rx) else { panic!() };
        state.registry.handle_response(conn, Envelope::ok(id, json!({"executed":true,"verified":{"domChanged":true}})));
        assert!(futures_util::poll!(clicked.as_mut()).is_pending());
        let Envelope::Req { method, params, .. } = next(&mut rx) else { panic!() };
        assert_eq!((method.as_str(), params["replyWithinMs"].as_u64()), ("browser.snapshot", Some(FOLLOW_UP_TIMEOUT.as_millis() as u64)));
        state.ops.release(&op.id).unwrap();
        let op = state.ops.attach(1, "A").unwrap();
        let mut closing = Box::pin(call_tool(&state, "browser_tabs", json!({"action":"close","operationId":op.id})));
        assert!(futures_util::poll!(closing.as_mut()).is_pending());
        let Envelope::Req { method, params, .. } = next(&mut rx) else { panic!() };
        assert_eq!((method.as_str(), params["replyWithinMs"].as_u64()), ("browser.tabs.close", Some(DEFAULT_TIMEOUT.as_millis() as u64)));
    }

    #[test]
    fn timeline_names_the_pointer_mode_target_keys_and_file() {
        let line = summarize("browser_click", &json!({"ref":"s1f0e1","mode":"drag","toRef":"s1f0e2"}));
        assert!(line.contains("mode=drag") && line.contains("toRef=s1f0e2"), "{line}");
        assert!(summarize("browser_press", &json!({"key":"a","modifiers":["Control","Shift"]})).contains("modifiers=Control+Shift"));
        assert!(summarize("browser_upload", &json!({"ref":"s1f0e1","file":"a.png"})).contains("file=a.png"));
    }

    #[test]
    fn new_tab_is_only_a_plain_click() {
        for mode in ["hover","double","right"] { assert!(validate_action("browser_click", &json!({"ref":"a","mode":mode,"newTab":true})).is_err(), "{mode}"); }
        assert!(validate_action("browser_click", &json!({"ref":"a","mode":"drag","toRef":"b","newTab":true})).is_err());
        assert!(validate_action("browser_click", &json!({"ref":"a","mode":"click","newTab":true})).is_ok());
        assert!(validate_action("browser_click", &json!({"ref":"a","newTab":true})).is_ok());
    }

    #[test]
    fn a_held_operation_is_not_enqueued() {
        let gate = super::super::operation::OperationGate::default();
        let op = gate.attach(12, "browser").unwrap();
        assert!(ensure_not_held(&op).is_ok());
        let held = gate.pause(&op.id, "browser").unwrap();
        assert_eq!(ensure_not_held(&held).unwrap_err().details["handoff"], true);
    }

    #[tokio::test]
    async fn an_unbound_caller_still_needs_an_operation_id() {
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
        let outcome = call_tool_as(&state, &Caller { runtime_id: Some("rid".into()), cwd: Some("/w".into()), connection_id: None }, "browser_snapshot", json!({})).await;
        assert_eq!(outcome.error.as_ref().map(|e| e.code), Some(ErrorCode::OperationRequired));
        assert!(!outcome.created_operation);
    }

    #[tokio::test]
    async fn a_null_operation_id_is_a_standalone_new_that_is_still_released_when_cancelled() {
        use futures_util::{future::{AbortHandle, Abortable}, stream::FuturesUnordered, StreamExt};
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = state.registry.register("fixture", tx);
        let (abort, registration) = AbortHandle::new_pair();
        let mut pending = FuturesUnordered::new();
        pending.push(Abortable::new(call_tool(&state, "browser_tabs", json!({"action":"new","operationId":null,"url":"https://example.test/"})), registration));
        assert!(futures_util::poll!(pending.next()).is_pending());
        let Envelope::Req { id, .. } = parse_envelope(&rx.try_recv().unwrap()).unwrap() else { panic!("expected tabs.create") };
        state.registry.handle_response(conn, Envelope::ok(id, json!({"tabId":42,"url":"https://example.test/"})));
        assert!(futures_util::poll!(pending.next()).is_pending(), "new now waits for its snapshot");
        assert!(state.ops.current().is_some());
        abort.abort();
        assert!(matches!(futures_util::poll!(pending.next()), std::task::Poll::Ready(Some(Err(_)))));
        assert!(state.ops.current().is_none(), "a reservation made for a null operationId must not outlive its call");
    }

    #[tokio::test]
    async fn cancelled_standalone_new_drops_its_reservation() {
        let home=tempfile::tempdir().unwrap();
        let state=ServerState::new(home.path().into(),crate::config::load_or_init(home.path()).unwrap());
        let (tx,_rx)=tokio::sync::mpsc::unbounded_channel();state.registry.register("fixture",tx);
        let mut pending=Box::pin(call_tool(&state,"browser_tabs",json!({"action":"new"})));
        assert!(futures_util::poll!(pending.as_mut()).is_pending());
        assert!(state.ops.current().unwrap().tabs.is_empty());
        drop(pending);
        assert!(state.ops.current().is_none());
        assert!(state.ops.attach(7,"fixture").is_ok());
    }

    #[tokio::test]
    async fn cancelled_standalone_new_tells_browsers_the_reservation_is_gone() {
        use crate::rpc::{Envelope, parse_envelope};
        let home=tempfile::tempdir().unwrap();
        let state=ServerState::new(home.path().into(),crate::config::load_or_init(home.path()).unwrap());
        let (tx,mut rx)=tokio::sync::mpsc::unbounded_channel();state.registry.register("fixture",tx);
        let mut pending=Box::pin(call_tool(&state,"browser_tabs",json!({"action":"new"})));
        assert!(futures_util::poll!(pending.as_mut()).is_pending());
        while rx.try_recv().is_ok() {}
        drop(pending);
        let mut statuses=Vec::new();
        while let Ok(text)=rx.try_recv() { if let Envelope::Evt{event,data,..}=parse_envelope(&text).unwrap() { assert_eq!(event,"status.changed"); statuses.push(data); } }
        assert!(statuses.last().is_some_and(|status|status["operation"].is_null()),"the panel must not keep showing the cancelled reservation: {statuses:?}");
    }

    #[tokio::test]
    async fn cancelling_attach_while_its_snapshot_is_pending_releases_the_new_operation() {
        use futures_util::{future::{AbortHandle, Abortable}, stream::FuturesUnordered, StreamExt};
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = state.registry.register("fixture", tx);
        let (abort, registration) = AbortHandle::new_pair();
        let mut pending = FuturesUnordered::new();
        pending.push(Abortable::new(call_tool(&state, "browser_tabs", json!({"action":"attach"})), registration));
        assert!(futures_util::poll!(pending.next()).is_pending());
        let Envelope::Req { id, .. } = parse_envelope(&rx.try_recv().unwrap()).unwrap() else { panic!("expected tabs.get") };
        state.registry.handle_response(conn, Envelope::ok(id, json!({"tabId":42})));
        assert!(futures_util::poll!(pending.next()).is_pending(), "attach now waits for its snapshot");
        let Envelope::Req { method, .. } = parse_envelope(&rx.try_recv().unwrap()).unwrap() else { panic!("expected snapshot") };
        assert_eq!(method, "browser.snapshot");
        assert!(state.ops.current().is_some());
        abort.abort();
        assert!(matches!(futures_util::poll!(pending.next()), std::task::Poll::Ready(Some(Err(_)))));
        assert!(state.ops.current().is_none(), "the cancelled attach must not strand its operation");
        assert!(state.ops.attach(43, "replacement").is_ok());
    }

    #[test]
    fn follow_up_reads_fit_inside_the_mcp_reply_window() {
        // A new tab (NAVIGATE_TIMEOUT) plus its snapshot and tab list must answer before the MCP client gives up.
        assert!(NAVIGATE_TIMEOUT + FOLLOW_UP_TIMEOUT * 2 < crate::mcp::client::REPLY_WAIT);
    }

    #[test]
    fn completion_conditions_are_validated_before_dispatch() {
        for conditions in [json!({}),json!({"text":""}),json!({"text":"Ready","timeoutMs":-1}),json!({"text":"Ready","match":"wrong"}),json!({"text":"Ready","selector":"body"}),json!(true)] {
            assert!(validate_action("browser_click",&json!({"ref":"s1f0e1","waitFor":conditions})).is_err(),"{conditions}");
        }
        assert!(validate_action("browser_click",&json!({"ref":"s1f0e1","newTab":true,"waitFor":{"text":"Ready"}})).is_err());
        assert!(validate_action("browser_click",&json!({"ref":"s1f0e1","waitFor":{"text":"Ready","urlIncludes":"/next","timeoutMs":30000}})).is_ok());
    }
    #[test]
    fn completion_wait_gets_its_own_time_budget_and_an_attached_snapshot() {
        let args=json!({"waitFor":{"text":"Ready","timeoutMs":30000}});
        assert!(timeout_for("browser_click",&args)>Duration::from_secs(30));
        assert!(timeout_for("browser_click",&args)+FOLLOW_UP_TIMEOUT<crate::mcp::client::REPLY_WAIT);
        let outcome=ToolOutcome::success("browser_click",Some("op"),true,Executed::Yes,json!({"expectationMet":true}),json!({}));
        assert!(wants_snapshot("browser_click",&args,&outcome));
    }

    #[tokio::test]
    async fn operation_dispatch_uses_its_owner_even_if_registry_selection_changed() {
        use std::sync::Arc;
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = Arc::new(ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap()));
        for client in ["A", "B"] {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let conn = state.registry.register(client, tx);
            let state = state.clone();
            tokio::spawn(async move {
                while let Some(text) = rx.recv().await {
                    if let Ok(Envelope::Req { id, method, params, .. }) = parse_envelope(&text) {
                        let value = match method.as_str() {
                            "browser.tabs.create" => json!({"tabId": 2, "owner": client}),
                            "browser.tabs.get" => json!({"tabId": params["tabId"], "owner": client, "attachable":true}),
                            _ => json!({"owner": client, "tabId": params["tabId"]}),
                        };
                        state.registry.handle_response(conn, Envelope::ok(id, value));
                    }
                }
            });
        }
        let op = state.ops.attach(1, "A").unwrap();
        // A captured operation must never inherit a later profile selection.
        state.registry.use_browser("B");
        let filled = call_tool(&state, "browser_fill", json!({"operationId": op.id, "ref":"s1f0e1", "text":"x"})).await;
        assert_eq!(filled.data["owner"], "A");
        let created = call_tool(&state, "browser_tabs", json!({"action":"new", "operationId":op.id, "url":"http://127.0.0.1/"})).await;
        assert_eq!(created.data["tab"]["owner"], "A");
        let switched = call_tool(&state, "browser_tabs", json!({"action":"switch", "operationId":op.id, "tabId":1})).await;
        assert_eq!(switched.data["tab"]["owner"], "A");
    }

    #[test]
    fn prepared_command_is_not_enqueued_after_abort_or_release() {
        for abort in [true, false] {
            let home = tempfile::tempdir().unwrap();
            let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
            let (a, mut from_a) = tokio::sync::mpsc::unbounded_channel();
            let (b, mut from_b) = tokio::sync::mpsc::unbounded_channel();
            state.registry.register("A", a);
            state.registry.register("B", b);
            let old = state.ops.attach(1, "A").unwrap();
            // Preparation may have observed A before another connection stops it and attaches B.
            let captured = state.ops.check(&old.id).unwrap();
            let params = json!({"text":"prepared", "ref":"s1f0e1", "tabId":captured.current_tab}).as_object().unwrap().clone();
            if abort { state.ops.abort(Some(&old.id)); } else { state.ops.release(&old.id).unwrap(); }
            state.registry.use_browser("B");
            let new = state.ops.attach(1, "B").unwrap();
            let error = queue_operation_tool(&state, &old.id, "browser.fill", params, CommandClass::Write, DEFAULT_TIMEOUT).err().expect("stale work must be rejected before enqueue");
            assert_eq!(error.code, if abort { ErrorCode::Cancelled } else { ErrorCode::OperationInvalid });
            assert!(from_a.try_recv().is_err(), "binding to old owner is insufficient: no stale command may be sent");
            assert!(from_b.try_recv().is_err(), "the replacement profile must not receive old work");
            assert_eq!(state.ops.current().unwrap().id, new.id);
        }
    }

    #[tokio::test]
    async fn an_upload_names_the_panel_request_that_owns_its_operation_and_nothing_else() {
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        state.registry.register("A", tx);
        async fn sent(state: &ServerState, op: String, rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> Value {
            let mut pending = Box::pin(call_tool(state, "browser_upload", json!({"operationId":op,"ref":"s1f0e1","file":"a.png","panelRequestId":"forged"})));
            assert!(futures_util::poll!(pending.as_mut()).is_pending());
            // Skip notifications such as browser.cancel from the previous operation's release.
            loop {
                if let Envelope::Req { method, params, .. } = parse_envelope(&rx.try_recv().unwrap()).unwrap() { if method == "browser.upload" { return params; } }
            }
        }
        let unscoped = state.ops.attach(1, "A").unwrap();
        assert!(sent(&state, unscoped.id.clone(), &mut rx).await.get("panelRequestId").is_none(), "an operation outside a panel request has no attachments, and a caller cannot name one");
        state.ops.release(&unscoped.id).unwrap();
        state.ops.begin_request("turn-a", "A", Some(1)).unwrap();
        let bound = state.ops.attach_request(1, "A", Some("turn-a")).unwrap();
        assert_eq!(state.ops.panel_request_of(&bound.id).as_deref(), Some("turn-a"));
        assert_eq!(sent(&state, bound.id, &mut rx).await["panelRequestId"], "turn-a");
    }

    #[tokio::test]
    async fn concurrent_pending_commands_keep_the_tab_captured_at_each_enqueue() {
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = state.registry.register("A", tx);
        let op = state.ops.attach(1, "A").unwrap();
        state.ops.add_tab(&op.id, 2).unwrap();
        let first = queue_operation_tool(&state, &op.id, "browser.scroll", serde_json::Map::new(), CommandClass::Write, DEFAULT_TIMEOUT).unwrap();
        state.ops.switch_tab(&op.id, 2).unwrap();
        let second = queue_operation_tool(&state, &op.id, "browser.scroll", serde_json::Map::new(), CommandClass::Write, DEFAULT_TIMEOUT).unwrap();
        let Envelope::Req { id: first_id, params: first_params, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        let Envelope::Req { id: second_id, params: second_params, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        assert_eq!(first_params["tabId"], 1);
        assert_eq!(second_params["tabId"], 2);
        state.registry.handle_response(conn, Envelope::ok(second_id, json!({"tabId":2})));
        state.registry.handle_response(conn, Envelope::ok(first_id, json!({"tabId":1})));
        assert_eq!(first.wait().await.unwrap()["tabId"], 1);
        assert_eq!(second.wait().await.unwrap()["tabId"], 2);
    }

    #[tokio::test]
    async fn late_missing_tab_reply_cannot_remove_a_replacement_operations_tab() {
        use std::sync::Arc;
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = Arc::new(ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap()));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = state.registry.register("A", tx);
        let old = state.ops.attach(1, "A").unwrap();
        state.ops.add_tab(&old.id, 2).unwrap();
        let task = {
            let state = state.clone();
            let id = old.id.clone();
            tokio::spawn(async move { call_tool(&state, "browser_tabs", json!({"action":"switch", "operationId":id, "tabId":2})).await })
        };
        let Envelope::Req { id, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        state.ops.release(&old.id).unwrap();
        let replacement = state.ops.attach(2, "B").unwrap();
        state.registry.handle_response(conn, Envelope::err(id, RpcError::new(ErrorCode::TabNotFound, Retry::Never, "closed")));
        assert_eq!(task.await.unwrap().error.unwrap().code, ErrorCode::TabNotFound);
        assert_eq!(state.ops.check(&replacement.id).unwrap().tabs, vec![2]);
    }

    #[test]
    fn an_unreadable_page_answer_counts_as_the_observation_but_other_failures_do_not() {
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
        let op = state.ops.attach(1, "A").unwrap();
        state.ops.pause(&op.id, "A").unwrap();
        let held = state.ops.resume(&op.id, "A").unwrap();
        let failed = |code| finish(&state, "browser_snapshot", &op.id, CommandClass::Read, &held, Err(RpcError::new(code, Retry::Never, "x")));
        failed(ErrorCode::FrameUnavailable);
        assert!(state.ops.check(&op.id).unwrap().needs_observation);
        failed(ErrorCode::UnsupportedPage);
        assert!(!state.ops.check(&op.id).unwrap().needs_observation, "a blank tab must stay navigable after a hand-back");
    }

    #[test]
    fn a_click_whose_opened_tabs_are_not_adopted_does_not_claim_a_tab_change() {
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
        let op = state.ops.attach(1, "A").unwrap();
        let result = finish(&state, "browser_click", &op.id, CommandClass::Write, &op, Ok(json!({"executed":true,"verified":{"urlChanged":false,"domChanged":false},
            "openedTabs":[{"tabId":3,"url":"chrome://settings","sourceTabId":1,"sourceFrameId":0}]})));
        assert_eq!(result.data["openedTabs"][0]["adopted"], false);
        assert!(result.data.get("currentTab").is_none() && result.data.get("nextStep").is_none() && result.data.get("operationTabs").is_none(), "{}", result.data);
        assert!(!wants_snapshot("browser_click", &json!({}), &result), "nothing changed, so the old refs stay valid");
    }

    #[tokio::test]
    async fn delivered_is_false_only_when_no_browser_received_the_command() {
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
        let unreachable = call_tool(&state, "browser_bookmarks", json!({"action":"list"})).await;
        assert_eq!((unreachable.error.as_ref().map(|e| e.code), unreachable.delivered), (Some(ErrorCode::BrowserDisconnected), false));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = state.registry.register("A", tx);
        let op = state.ops.attach(1, "A").unwrap();
        let mut pending = Box::pin(call_tool(&state, "browser_tabs", json!({"action":"switch","operationId":op.id,"tabId":5})));
        let refused = loop {
            if let std::task::Poll::Ready(outcome) = futures_util::poll!(pending.as_mut()) { break outcome; }
            let Envelope::Req { id, method, .. } = parse_envelope(&rx.try_recv().expect("a command is waiting")).unwrap() else { continue };
            let reply = if method == "browser.tabs.get" { json!({"tabId":5,"url":"chrome://settings","attachable":false}) } else { json!({"tabs":[]}) };
            state.registry.handle_response(conn, Envelope::ok(id, reply));
        };
        assert_eq!((refused.error.as_ref().map(|e| e.code), refused.delivered), (Some(ErrorCode::UnsupportedPage), true), "the browser answered this call");
    }

    #[test]
    fn navigation_budget_includes_extension_load_and_response_time() {
        assert_eq!(timeout_for("browser_navigate", &json!({})), Duration::from_secs(35));
        assert_eq!(timeout_for("browser_tabs", &json!({"action":"new"})), Duration::from_secs(35));
        assert_eq!(timeout_for("browser_tabs", &json!({"action":"list"})), Duration::from_secs(15));
    }
}

#[cfg(test)]
mod issue8_tests {
    use super::*;
    #[test]
    fn adopts_an_explicit_new_tab_while_its_http_navigation_is_pending() {
        let home=tempfile::tempdir().unwrap();
        let state=ServerState::new(home.path().into(),crate::config::load_or_init(home.path()).unwrap());
        let op=state.ops.attach(1,"browser").unwrap();
        let result=finish(&state,"browser_click",&op.id,CommandClass::Write,&op,Ok(json!({"executed":true,"openedTabs":[
            {"tabId":2,"url":"","pendingUrl":"https://example.test/heavy","sourceTabId":1,"sourceFrameId":0},
            {"tabId":3,"url":"","pendingUrl":"chrome://settings","sourceTabId":1,"sourceFrameId":0}
        ]})));
        assert_eq!(result.data["openedTabs"][0]["adopted"],true);
        assert_eq!(result.data["openedTabs"][1]["adopted"],false);
        assert_eq!(state.ops.current().unwrap().tabs,vec![1,2]);
    }

    #[test]
    fn validate_checks_nested_objects_arrays_and_max_length() {
        let screenshot = tools::find("browser_screenshot").unwrap();
        assert!(validate(&screenshot.schema, &json!({"scope":"region","region":{}})).is_err(), "empty region misses required fields");
        assert!(validate(&screenshot.schema, &json!({"scope":"region","region":{"x":0,"y":0,"width":0,"height":10}})).is_err(), "zero width violates exclusiveMinimum");
        assert!(validate(&screenshot.schema, &json!({"scope":"region","region":{"x":0,"y":0,"width":10,"height":10}})).is_ok());

        let press = tools::find("browser_press").unwrap();
        assert!(validate(&press.schema, &json!({"key":"a","modifiers":"Control"})).is_err(), "modifiers must be an array");
        assert!(validate(&press.schema, &json!({"key":"a","modifiers":["Bogus"]})).is_err(), "invalid modifier enum");
        assert!(validate(&press.schema, &json!({"key":"Enter","modifiers":["Control","Shift","Alt","Meta","Control"]})).is_err(), "too many modifiers");
        assert!(validate(&press.schema, &json!({"key":"12345678901"})).is_err(), "key exceeds maxLength");

        let snapshot = tools::find("browser_snapshot").unwrap();
        assert!(validate(&snapshot.schema, &json!({"query":"x".repeat(81)})).is_err(), "query exceeds maxLength");
    }

    #[tokio::test]
    async fn batch_propagates_dialog_pending_without_follow_up_snapshot_and_keeps_data() {
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = std::sync::Arc::new(ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap()));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = state.registry.register("A", tx);
        let op = state.ops.attach(1, "A").unwrap();
        let task = {
            let state = state.clone();
            let id = op.id.clone();
            tokio::spawn(async move {
                call_tool(&state, "browser_batch", json!({
                    "operationId": id,
                    "steps": [
                        {"tool":"click","ref":"s1f0e1"},
                        {"tool":"click","ref":"s1f0e2"}
                    ]
                })).await
            })
        };
        let mut methods = Vec::new();
        let mut task = task;
        let outcome = loop {
            tokio::select! {
                res = &mut task => break res.unwrap(),
                msg = rx.recv() => {
                    let Envelope::Req { id, method, .. } = parse_envelope(&msg.unwrap()).unwrap() else { continue };
                    methods.push(method.clone());
                    let reply = json!({
                        "executed": true,
                        "verified": { "dialogPending": true, "urlChanged": false, "domChanged": false },
                        "dialog": { "dialogId": "dlg-1", "type": "confirm", "message": "Proceed?" }
                    });
                    state.registry.handle_response(conn, Envelope::ok(id, reply));
                }
            }
        };
        assert_eq!(methods, vec!["browser.click"], "must not fire follow-up snapshot into modal dialog");
        assert_eq!(outcome.verified["dialogPending"], true, "verified: {}", outcome.verified);
        assert_eq!(outcome.verified["pageChanged"], false, "verified: {}", outcome.verified);
        assert_eq!(outcome.data["dialog"]["dialogId"], "dlg-1", "data: {}", outcome.data);
    }

    #[tokio::test]
    async fn attach_releases_selection_lock_while_waiting_for_tabs_get() {
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = std::sync::Arc::new(ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap()));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = state.registry.register("A", tx);
        let task = {
            let state = state.clone();
            tokio::spawn(async move { call_tool(&state, "browser_tabs", json!({"action":"attach"})).await })
        };
        let Envelope::Req { id, method, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        assert_eq!(method, "browser.tabs.get");
        assert!(state.selection.try_read().is_ok(), "concurrent request.begin (try_read) must not be blocked during browser.tabs.get await");
        assert!(state.selection.try_write().is_err(), "browser.use (try_write) must stay blocked during browser.tabs.get await");
        state.registry.handle_response(conn, Envelope::ok(id, json!({"tabId": 10, "windowId": 1, "url": "https://example.test", "attachable": true})));
        // Drain follow-up snapshot and openTabs
        let mut task = task;
        let outcome = loop {
            tokio::select! {
                res = &mut task => break res.unwrap(),
                msg = rx.recv() => {
                    let Envelope::Req { id, method, .. } = parse_envelope(&msg.unwrap()).unwrap() else { continue };
                    let reply = if method == "browser.snapshot" { json!({"tabId":10,"elements":[],"text":""}) } else { json!({"tabs":[]}) };
                    state.registry.handle_response(conn, Envelope::ok(id, reply));
                }
            }
        };
        assert!(outcome.ok);
    }

    #[tokio::test]
    async fn standalone_new_tab_failure_does_not_return_released_operation_id() {
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = std::sync::Arc::new(ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap()));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = state.registry.register("A", tx);
        let task = {
            let state = state.clone();
            tokio::spawn(async move { call_tool(&state, "browser_tabs", json!({"action":"new","url":"https://example.test"})).await })
        };
        let Envelope::Req { id, method, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        assert_eq!(method, "browser.tabs.create");
        state.registry.handle_response(conn, Envelope::err(id, RpcError::new(ErrorCode::Internal, Retry::Never, "boom")));
        let outcome = task.await.unwrap();
        assert!(!outcome.ok);
        assert_eq!(outcome.operation_id, None, "released temporary reservation must not be leaked in failed outcome");
    }

    #[tokio::test]
    async fn batch_step2_stale_element_attaches_follow_up_snapshot_and_summarizes_steps() {
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = std::sync::Arc::new(ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap()));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = state.registry.register("A", tx);
        let op = state.ops.attach(1, "A").unwrap();
        let task = {
            let state = state.clone();
            let id = op.id.clone();
            tokio::spawn(async move {
                call_tool(&state, "browser_batch", json!({
                    "operationId": id,
                    "steps": [
                        {"tool":"fill","ref":"s1f0e1","text":"abc"},
                        {"tool":"click","ref":"s1f0e2"}
                    ]
                })).await
            })
        };
        let mut methods = Vec::new();
        let mut task = task;
        let outcome = loop {
            tokio::select! {
                res = &mut task => break res.unwrap(),
                msg = rx.recv() => {
                    let Envelope::Req { id, method, .. } = parse_envelope(&msg.unwrap()).unwrap() else { continue };
                    methods.push(method.clone());
                    let reply = match method.as_str() {
                        "browser.fill" => Envelope::ok(id, json!({"executed": true, "verified": {"value": "abc"}})),
                        "browser.click" => Envelope::err(id, RpcError::new(ErrorCode::StaleElement, Retry::Safe, "stale")),
                        "browser.snapshot" => Envelope::ok(id, json!({"tabId": 1, "elements": [], "text": "fresh"})),
                        other => panic!("unexpected method {other}"),
                    };
                    state.registry.handle_response(conn, reply);
                }
            }
        };
        assert!(!outcome.ok);
        assert_eq!(outcome.executed, Executed::Yes);
        assert_eq!(methods, vec!["browser.fill", "browser.click", "browser.snapshot"]);
        assert_eq!(outcome.data["snapshot"]["text"], "fresh");
        let last = state.timeline.entries().into_iter().last().unwrap();
        assert!(last.summary.contains("steps=2 (fill,click)"), "summary: {}", last.summary);
    }

    #[tokio::test]
    async fn tab_not_found_on_page_tool_reconciles_operation_gate() {
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = std::sync::Arc::new(ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap()));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = state.registry.register("A", tx);
        let op = state.ops.attach(10, "A").unwrap();
        state.ops.add_and_switch_tab(&op.id, 20).unwrap();
        let task = {
            let state = state.clone();
            let id = op.id.clone();
            tokio::spawn(async move {
                call_tool(&state, "browser_snapshot", json!({"operationId": id})).await
            })
        };
        let Envelope::Req { id, method, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        assert_eq!(method, "browser.snapshot");
        state.registry.handle_response(conn, Envelope::err(id, RpcError::new(ErrorCode::TabNotFound, Retry::Never, "gone")));
        let outcome = task.await.unwrap();
        assert!(!outcome.ok);
        let active = state.ops.check_active(&op.id).unwrap();
        assert_eq!(active.current_tab, 10, "gate must fall back to prior tab when current tab vanishes");
        assert!(active.needs_observation);
    }
}
