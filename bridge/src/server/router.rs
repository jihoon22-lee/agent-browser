//! `tool.call` → browser command routing and outcome classification.
use super::{conn::ServerState, now_ms, registry::{CommandClass, QueuedCommand}, timeline::TimelineEntry};
use crate::mcp::tools;
use crate::rpc::{ErrorCode, Retry, RpcError};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
const NAVIGATE_TIMEOUT: Duration = Duration::from_secs(35);

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
    if name == "browser_bookmarks" {
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
        if class==CommandClass::Write && op.needs_observation {return Err(restored_target_needs_snapshot());}
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
                if op.needs_observation {return Err(restored_target_needs_snapshot());}
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
    async fn review_attach_creation_and_outcome_complete_in_the_same_poll() {
        use futures_util::{future::{AbortHandle, Abortable}, stream::FuturesUnordered, StreamExt};
        use crate::rpc::{Envelope, parse_envelope};
        for cancel_before_poll in [true, false] {
            let home = tempfile::tempdir().unwrap();
            let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
            let (tx,mut rx) = tokio::sync::mpsc::unbounded_channel();
            state.registry.register("fixture",tx);
            let (abort,registration) = AbortHandle::new_pair();
            let mut pending = FuturesUnordered::new();
            pending.push(Abortable::new(call_tool(&state,"browser_tabs",json!({"action":"attach"})),registration));
            assert!(futures_util::poll!(pending.next()).is_pending());
            let Envelope::Req {id,method,..} = parse_envelope(&rx.try_recv().unwrap()).unwrap() else {panic!("expected browser request")};
            assert_eq!(method,"browser.tabs.get");
            state.registry.handle_response(Envelope::ok(id,json!({"tabId":42})));
            assert!(state.ops.current().is_none(),"An unpolled ready reply cannot execute attach in the background");
            if cancel_before_poll { abort.abort(); }
            let std::task::Poll::Ready(Some(result)) = futures_util::poll!(pending.next()) else {panic!("Attach must finish in this poll without suspending after creation")};
            if cancel_before_poll {
                assert!(result.is_err()); assert!(state.ops.current().is_none());
            } else {
                let outcome = result.unwrap(); assert!(outcome.ok);
                assert_eq!(Some(state.ops.current().unwrap().id),outcome.operation_id);
                state.ops.abort(outcome.operation_id.as_deref());
            }
            assert!(state.ops.attach(43,"replacement").is_ok());
        }
    }

    #[tokio::test]
    async fn operation_dispatch_uses_its_owner_even_if_registry_selection_changed() {
        use std::sync::Arc;
        use crate::rpc::{Envelope, parse_envelope};
        let home = tempfile::tempdir().unwrap();
        let state = Arc::new(ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap()));
        for client in ["A", "B"] {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            state.registry.register(client, tx);
            let state = state.clone();
            tokio::spawn(async move {
                while let Some(text) = rx.recv().await {
                    if let Ok(Envelope::Req { id, method, params, .. }) = parse_envelope(&text) {
                        let value = match method.as_str() {
                            "browser.tabs.create" => json!({"tabId": 2, "owner": client}),
                            "browser.tabs.get" => json!({"tabId": params["tabId"], "owner": client, "attachable":true}),
                            _ => json!({"owner": client, "tabId": params["tabId"]}),
                        };
                        state.registry.handle_response(Envelope::ok(id, value));
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
        state.registry.register("A", tx);
        let op = state.ops.attach(1, "A").unwrap();
        state.ops.add_tab(&op.id, 2).unwrap();
        let first = queue_operation_tool(&state, &op.id, "browser.scroll", serde_json::Map::new(), CommandClass::Write).unwrap();
        state.ops.switch_tab(&op.id, 2).unwrap();
        let second = queue_operation_tool(&state, &op.id, "browser.scroll", serde_json::Map::new(), CommandClass::Write).unwrap();
        let Envelope::Req { id: first_id, params: first_params, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        let Envelope::Req { id: second_id, params: second_params, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        assert_eq!(first_params["tabId"], 1);
        assert_eq!(second_params["tabId"], 2);
        state.registry.handle_response(Envelope::ok(second_id, json!({"tabId":2})));
        state.registry.handle_response(Envelope::ok(first_id, json!({"tabId":1})));
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
        state.registry.register("A", tx);
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
        state.registry.handle_response(Envelope::err(id, RpcError::new(ErrorCode::TabNotFound, Retry::Never, "closed")));
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
