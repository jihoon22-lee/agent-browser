//! Tab list/attach/new/switch/close/release routing (`browser_tabs`).
use super::{validate::{invalid, timeout_for}, ensure_not_held, observation_required, operation_required, reply_within, DEFAULT_TIMEOUT, FOLLOW_UP_TIMEOUT, HANDOFF_WAIT, Executed, ToolOutcome};
use crate::rpc::{ErrorCode, Retry, RpcError};
use crate::server::{conn::ServerState, registry::CommandClass};
use serde_json::{json, Value};

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
pub(super) fn bounded_tab_list(mut data: Value) -> Value {
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
pub(super) async fn add_open_tabs(state: &ServerState, args: &Value, outcome: &mut ToolOutcome) {
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


pub(super) async fn run_tabs(state: &ServerState, args: &Value) -> ToolOutcome {
    const NAME: &str = "browser_tabs";
    let action = args["action"].as_str().unwrap_or_default();
    let read = |method: &'static str, params: Value| state.registry.send_command(method, params, CommandClass::Read, DEFAULT_TIMEOUT);
    let delivered_failure = |op: Option<&str>, e: RpcError| ToolOutcome::from_browser(NAME, op, e);
    // Tab actions inside an operation wait while the user holds the browser, like page tools.
    if let Some(op_id) = args["operationId"].as_str().filter(|_| matches!(action, "new" | "switch" | "close"))
        && let Err(error) = state.ops.wait_until_resumed(op_id, HANDOFF_WAIT).await
    {
        return ToolOutcome::rejected(NAME, Some(op_id), error);
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
