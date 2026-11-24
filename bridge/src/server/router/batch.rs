//! Batched multi-step browser tool execution (`browser_batch`).
use super::{validate::{invalid, validate, validate_action}, wants_snapshot, run_with_budget, Caller, Executed, ToolOutcome};
use crate::mcp::tools;
use crate::server::conn::ServerState;
use serde_json::{json, Value};
use std::time::Duration;

const BATCH_TOOLS: [&str; 4] = ["click", "fill", "select", "press"];
/// A batch starts no new step after this, so its reply stays well inside the MCP reply window.
const BATCH_TIME: Duration = Duration::from_secs(20);
/// Hard cap for the entire batch (steps + handoff waits), leaving headroom for follow-up snapshot inside REPLY_WAIT (60s).
const BATCH_BUDGET: Duration = Duration::from_secs(45);

/// Each step runs exactly as its own tool would (checks, handoff wait, gate), without follow-up reads.
/// A step that changed the page ends the batch: later refs may no longer point where the model meant.
pub(super) async fn run_batch(state: &ServerState, caller: &Caller, args: &Value) -> ToolOutcome {
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

