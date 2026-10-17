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
            Some("new") if args["url"].as_str().is_some_and(|url| url != "about:blank") => check_url(args["url"].as_str().unwrap()),
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
        "browser_tabs" if args["action"] == "new" => NAVIGATE_TIMEOUT,
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

/// Who is calling: a managed runtime's proxy names its launch id and OpenCode directory.
#[derive(Clone, Debug, Default)]
pub struct Caller { pub runtime_id: Option<String>, pub cwd: Option<String> }

pub async fn call_tool(state: &ServerState, name: &str, args: Value) -> ToolOutcome {
    call_tool_as(state, &Caller::default(), name, args).await
}

pub async fn call_tool_as(state: &ServerState, caller: &Caller, name: &str, args: Value) -> ToolOutcome {
    let outcome = run(state, caller, name, &args).await;
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
pub const OPERATION_TOOLS: [&str; 10] = ["browser_snapshot","browser_navigate","browser_click","browser_fill","browser_select",
    "browser_press","browser_scroll","browser_wait","browser_extract","browser_screenshot"];

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
    let (bound_args, implicit) = match bind_arguments(state, caller, name, args).await { Ok(bound) => bound, Err(failed) => return failed };
    let args = &bound_args;
    let Some(def) = tools::all().into_iter().find(|t| t.name == name) else {
        return ToolOutcome::rejected(name, None, invalid(format!("unknown tool `{name}`")));
    };
    let empty = json!({});
    let args = if args.is_null() { &empty } else { args };
    let operation_id = args["operationId"].as_str();
    // A missing operationId is the most actionable mistake: say "attach first" instead of a schema error.
    let needs_operation = OPERATION_TOOLS.contains(&name);
    if needs_operation && operation_id.is_none() {
        return operation_required(name);
    }
    if let Err(e) = validate(&def.schema, args).and_then(|_| validate_action(name, args)) {
        return ToolOutcome::rejected(name, operation_id, e);
    }
    // An implicitly created operation is released if this call is cancelled while it runs.
    let mut implicit_guard = CreatedOperation { state, id: if implicit { operation_id.map(str::to_string) } else { None } };
    let mut outcome = if name == "browser_bookmarks" {
        // This read belongs to the selected browser profile, not a page operation.
        let properties = def.schema["properties"].as_object().unwrap();
        let params = args.as_object().unwrap().iter().filter(|(key,_)|properties.contains_key(*key)).map(|(k,v)|(k.clone(),v.clone())).collect();
        match state.registry.send_command("browser.bookmarks",Value::Object(params),CommandClass::Read,DEFAULT_TIMEOUT).await {
            Ok(data) => ToolOutcome::success(name,None,true,Executed::No,Value::Null,data),
            Err(error) => ToolOutcome::failure(name,None,true,error),
        }
    } else if name == "browser_tabs" {
        run_tabs(state, args).await
    } else {
        run_operation_tool(state, name, args, &def.schema).await
    };
    let creates = name == "browser_tabs" && (args["action"] == "attach" || (args["action"] == "new" && args.get("operationId").is_none()));
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

async fn run_operation_tool(state: &ServerState, name: &str, args: &Value, schema: &Value) -> ToolOutcome {
    let Some(op_id) = args["operationId"].as_str() else { return operation_required(name) };
    if let Err(error) = state.ops.wait_until_resumed(op_id, HANDOFF_WAIT).await { return ToolOutcome::rejected(name, Some(op_id), error); }
    // Forward only what the published schema declares; the gate owns operation, generation and tab.
    let declared = schema["properties"].as_object();
    let params: serde_json::Map<String, Value> = args
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, _)| declared.is_some_and(|d| d.contains_key(k.as_str())))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let class = tools::class_of(name, args);
    let method = format!("browser.{}", name.trim_start_matches("browser_"));
    let queued = match queue_operation_tool(state, op_id, &method, params, class) {
        Ok(queued) => queued,
        Err(error) => return ToolOutcome::rejected(name, Some(op_id), error),
    };
    let origin = queued.origin.clone();
    finish(state, name, op_id, class, &origin, queued.wait(timeout_for(name, args)).await)
}

struct OperationCommand<'a> { queued: QueuedCommand<'a>, origin: super::operation::Operation }
impl OperationCommand<'_> { async fn wait(self, timeout: Duration) -> Result<Value,RpcError> { self.queued.wait(timeout).await } }

fn queue_operation_tool<'a>(state: &'a ServerState, op_id: &str, method: &str, mut params: serde_json::Map<String, Value>, class: CommandClass) -> Result<OperationCommand<'a>, RpcError> {
    state.ops.with_checked(op_id, true, |op| {
        ensure_not_held(op)?;
        if class==CommandClass::Write && op.needs_observation {return Err(observation_required(op));}
        params.insert("operationId".into(), json!(op.id));
        params.insert("generation".into(), json!(op.generation));
        params.insert("tabId".into(), json!(op.current_tab));
        let queued = state.registry.queue_command_for(&op.client_id, method, Value::Object(params), class)?;
        Ok(OperationCommand {queued,origin:op.clone()})
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
            if name=="browser_snapshot" && data["tabId"].as_i64()==Some(origin.current_tab) {state.ops.observe_target(origin);}
            if matches!(name,"browser_click"|"browser_press") {
                let mut adopted = None;
                if let Some(children) = data.get_mut("openedTabs").and_then(Value::as_array_mut) {
                    let ids: Vec<_> = children.iter().take(16).filter(|tab| tab["sourceTabId"].as_i64() == Some(origin.current_tab) && tab["sourceFrameId"].as_i64().is_some_and(|frame| frame >= 0) && (tab["url"].as_str().is_some_and(|url| check_url(url).is_ok()) ||
                        (matches!(tab["url"].as_str(),Some(""|"about:blank")) && tab["pendingUrl"].as_str().is_some_and(|url|check_url(url).is_ok())))).filter_map(|tab| tab["tabId"].as_i64()).collect();
                    if !aborted { adopted = state.ops.adopt_children(op_id,origin.generation,&origin.client_id,origin.current_tab,&ids).ok(); }
                    for child in children { if child.is_object() { child["adopted"] = json!(adopted.as_ref().is_some_and(|op| child["tabId"].as_i64().is_some_and(|id| ids.contains(&id) && op.tabs.contains(&id)))); } }
                }
                if let Some(op) = adopted { data["currentTab"] = json!(op.current_tab); data["operationTabs"] = json!(op.tabs); data["nextStep"] = json!("Take a fresh browser_snapshot in the current tab before acting; previous-tab refs do not transfer."); }
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

async fn open_tabs(state: &ServerState, client: &str, window: Option<i64>) -> Value {
    let params = match window { Some(id) => json!({ "windowId": id }), None => json!({}) };
    let Ok(queued) = state.registry.queue_command_for(client, "browser.tabs.list", params, CommandClass::Read) else { return Value::Null };
    let Ok(listed) = queued.wait(FOLLOW_UP_TIMEOUT).await else { return Value::Null };
    let tabs: Vec<Value> = listed["tabs"].as_array().into_iter().flatten().take(20).map(|tab| json!({
        "tabId": tab["tabId"], "active": tab["active"], "attachable": tab["attachable"],
        "title": tab["title"].as_str().unwrap_or("").chars().take(60).collect::<String>(),
        "url": tab["url"].as_str().unwrap_or("").chars().take(100).collect::<String>(),
    })).collect();
    json!(tabs)
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
    match name {
        "browser_click" => outcome.verified["urlChanged"] == true || outcome.verified["domChanged"] == true || outcome.data["currentTab"].is_number(),
        "browser_press" | "browser_navigate" => true,
        "browser_tabs" => match args["action"].as_str() {
            Some("attach" | "switch") => true,
            Some("new") => args["url"].as_str().is_some_and(|url| url != "about:blank"),
            _ => false,
        },
        _ => false,
    }
}

/// Follow-up snapshots ride on every page-changing action; on busy pages the next step rarely
/// needs more than the first screenful of controls, and elementsNextOffset says how to read on.
pub(crate) const FOLLOW_UP_MAX_ELEMENTS: u64 = 40;

async fn follow_up_snapshot(state: &ServerState, op_id: &str) -> Result<Value, RpcError> {
    // A smaller text budget: the elements are what the next action needs. settleMs lets a
    // link click finish committing the next document before it is read.
    let params = json!({ "maxChars": 1500, "settleMs": 6000, "maxElements": FOLLOW_UP_MAX_ELEMENTS }).as_object().cloned().expect("object");
    let queued = queue_operation_tool(state, op_id, "browser.snapshot", params, CommandClass::Read)?;
    let origin = queued.origin.clone();
    let result = queued.wait(FOLLOW_UP_TIMEOUT).await;
    let outcome = finish(state, "browser_snapshot", op_id, CommandClass::Read, &origin, result);
    match outcome.error { Some(error) => Err(error), None => Ok(outcome.data) }
}

async fn add_follow_up_snapshot(state: &ServerState, name: &str, args: &Value, outcome: &mut ToolOutcome) {
    let stale_write = !outcome.ok && tools::class_of(name, args) == CommandClass::Write && outcome.executed == Executed::No
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

/// Why the next write needs a fresh snapshot: the user handled the browser, or a closed tab sent
/// the operation back to an earlier one.
/// The user may take the browser over between the handoff wait and the enqueue.
fn ensure_not_held(op: &super::operation::Operation) -> Result<(), RpcError> {
    if !op.paused { return Ok(()); }
    Err(RpcError::new(ErrorCode::BrowserBusy, Retry::Safe,
        "The user has taken over this tab. Wait, then try again; take a fresh snapshot before acting.").with_details(json!({"handoff": true})))
}

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
    let delivered_failure = |op: Option<&str>, e: RpcError| {
        let delivered = e.code != ErrorCode::BrowserDisconnected;
        ToolOutcome::failure(NAME, op, delivered, e)
    };
    // Tab actions inside an operation wait while the user holds the browser, like page tools.
    if let Some(op_id) = args["operationId"].as_str().filter(|_| matches!(action, "new" | "switch" | "close")) {
        if let Err(error) = state.ops.wait_until_resumed(op_id, HANDOFF_WAIT).await { return ToolOutcome::rejected(NAME, Some(op_id), error); }
    }
    match action {
        "list" | "windows" => match read(if action == "windows" {"browser.windows.list"} else {"browser.tabs.list"}, json!({"windowId":args["windowId"]})).await {
            Ok(data) => ToolOutcome::success(NAME, None, true, Executed::No, Value::Null, data),
            Err(e) => delivered_failure(None, e),
        },
        "attach" => {
            let _selection = state.selection.lock().await;
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
            impl Drop for Reservation<'_> { fn drop(&mut self) { if let Some(id) = &self.id { let _ = self.state.ops.release(id); } } }
            let selection = state.selection.lock().await;
            let mut reservation = Reservation {state, id:None};
            let new_id;
            let op_id = if let Some(id) = args["operationId"].as_str() { id } else {
                let client = state.registry.selected_client().unwrap_or_default();
                match state.ops.reserve_new(&client,args["requestId"].as_str()) {
                    Ok(op) => { new_id = op.id; reservation.id=Some(new_id.clone()); &new_id }
                    Err(error) => return ToolOutcome::rejected(NAME,None,error),
                }
            };
            let queued = state.ops.with_checked(op_id, false, |op| {
                ensure_not_held(op)?;
                let params = json!({ "url": args["url"].as_str().unwrap_or("about:blank"), "operationId": op.id, "generation": op.generation,
                    "windowId":args["windowId"],"sourceTabId":if op.current_tab_closed {None} else {Some(op.current_tab)} });
                state.registry.queue_command_for(&op.client_id, "browser.tabs.create", params, CommandClass::Write)
            });
            drop(selection);
            let queued = match queued {
                Ok(queued) => queued,
                Err(error) => return ToolOutcome::rejected(NAME, Some(op_id), error),
            };
            let created = queued.wait(timeout_for(NAME, args)).await;
            let tab = match created {
                Ok(tab) => tab,
                Err(e) => return delivered_failure(Some(op_id), e),
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
                    ToolOutcome::failure(NAME, Some(op_id), true, e)
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
                Ok(_) => ToolOutcome::rejected(NAME,Some(op_id),RpcError::new(ErrorCode::UnsupportedPage,Retry::Never,"Select an ordinary HTTP(S) tab from browser_tabs list")),
                Err(e) => {
                    if e.code == ErrorCode::TabNotFound {
                        state.ops.remove_tab_for_operation(op_id, tab_id);
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
                let params = json!({"operationId":op.id,"generation":op.generation,"tabId":op.current_tab});
                let queued = state.registry.queue_command_for(&op.client_id,"browser.tabs.close",params,CommandClass::Write)?;
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
        let outcome = call_tool_as(&state, &Caller { runtime_id: Some("rid".into()), cwd: Some("/w".into()) }, "browser_snapshot", json!({})).await;
        assert_eq!(outcome.error.as_ref().map(|e| e.code), Some(ErrorCode::OperationRequired));
        assert!(!outcome.created_operation);
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
            let error = queue_operation_tool(&state, &old.id, "browser.fill", params, CommandClass::Write).err().expect("stale work must be rejected before enqueue");
            assert_eq!(error.code, if abort { ErrorCode::Cancelled } else { ErrorCode::OperationInvalid });
            assert!(from_a.try_recv().is_err(), "binding to old owner is insufficient: no stale command may be sent");
            assert!(from_b.try_recv().is_err(), "the replacement profile must not receive old work");
            assert_eq!(state.ops.current().unwrap().id, new.id);
        }
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
        let first = queue_operation_tool(&state, &op.id, "browser.scroll", serde_json::Map::new(), CommandClass::Write).unwrap();
        state.ops.switch_tab(&op.id, 2).unwrap();
        let second = queue_operation_tool(&state, &op.id, "browser.scroll", serde_json::Map::new(), CommandClass::Write).unwrap();
        let Envelope::Req { id: first_id, params: first_params, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        let Envelope::Req { id: second_id, params: second_params, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        assert_eq!(first_params["tabId"], 1);
        assert_eq!(second_params["tabId"], 2);
        state.registry.handle_response(conn, Envelope::ok(second_id, json!({"tabId":2})));
        state.registry.handle_response(conn, Envelope::ok(first_id, json!({"tabId":1})));
        assert_eq!(first.wait(DEFAULT_TIMEOUT).await.unwrap()["tabId"], 1);
        assert_eq!(second.wait(DEFAULT_TIMEOUT).await.unwrap()["tabId"], 2);
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
}
