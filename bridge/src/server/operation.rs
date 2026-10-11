use crate::rpc::{ErrorCode, Retry, RpcError};
use serde_json::json;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OpState { Active, Aborted, Released }

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub generation: u64,
    pub tabs: Vec<i64>,
    pub current_tab: i64,
    pub client_id: String,
    pub state: OpState,
    pub current_tab_closed: bool,
}

#[derive(Debug)]
pub struct AbortedOperation {
    pub id: String,
    pub generation: u64,
    pub client_id: String,
}

#[derive(Default)]
pub struct OperationGate {
    inner: Mutex<GateInner>,
}

#[derive(Default)]
struct GateInner {
    generation: u64,
    current: Option<Operation>,
    finished: Vec<(String, OpState)>, // last 50 ended operations, to answer CANCELLED vs OPERATION_INVALID
}

impl OperationGate {
    pub fn attach(&self, tab_id: i64, client_id: &str) -> Result<Operation, RpcError> {
        let mut g = self.inner.lock().unwrap();
        if let Some(op) = g.current.as_ref().filter(|o| o.state == OpState::Active) {
            return Err(RpcError::new(ErrorCode::BrowserBusy, Retry::Never,
                "Another browser operation is running. Wait for it to finish or ask the user to press Stop.")
                .with_details(json!({ "operationId": op.id })));
        }
        g.generation += 1;
        let op = Operation {
            id: format!("op-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
            generation: g.generation,
            tabs: vec![tab_id],
            current_tab: tab_id,
            client_id: client_id.to_string(),
            state: OpState::Active,
            current_tab_closed: false,
        };
        g.current = Some(op.clone());
        Ok(op)
    }

    /// Validates operation identity/state, even when its current tab has closed.
    pub fn check_active(&self, id: &str) -> Result<Operation, RpcError> {
        let g = self.inner.lock().unwrap();
        Self::active(&g, id).cloned()
    }

    pub fn check(&self, id: &str) -> Result<Operation, RpcError> {
        self.with_checked(id, true, |op| Ok(op.clone()))
    }

    /// The callback is synchronous: validation and command enqueue share this lock with
    /// abort/release/switch. Never wait for a browser response while holding the gate.
    pub fn with_checked<T>(&self, id: &str, require_open_tab: bool, f: impl FnOnce(&Operation) -> Result<T, RpcError>) -> Result<T, RpcError> {
        let g = self.inner.lock().unwrap();
        let op = Self::active(&g, id)?;
        if require_open_tab && op.current_tab_closed {
            return Err(RpcError::new(ErrorCode::TabClosed, Retry::Never,
                "The operation's current tab was closed. Use browser_tabs action=switch or release.")
                .with_details(json!({ "tabId": op.current_tab })));
        }
        f(op)
    }

    pub fn select_browser<T>(&self, client_id: &str, select: impl FnOnce() -> T) -> Result<T, RpcError> {
        let g = self.inner.lock().unwrap();
        if let Some(op) = g.current.as_ref().filter(|op| op.client_id != client_id) {
            return Err(RpcError::new(ErrorCode::BrowserBusy, Retry::Never,
                "Finish or stop the current operation before selecting another browser.")
                .with_details(json!({ "operationId": op.id })));
        }
        Ok(select())
    }

    fn active<'a>(g: &'a GateInner, id: &str) -> Result<&'a Operation, RpcError> {
        match g.current.as_ref() {
            Some(op) if op.id == id && op.state == OpState::Active => Ok(op),
            _ => match g.finished.iter().rev().find(|(fid, _)| fid == id) {
                Some((_, OpState::Aborted)) => Err(RpcError::new(ErrorCode::Cancelled, Retry::Never,
                    "Stopped by the user. Start a new operation with browser_tabs action=attach after taking a fresh snapshot.")),
                Some(_) => Err(RpcError::new(ErrorCode::OperationInvalid, Retry::Never,
                    "This operation was released. Start a new one with browser_tabs action=attach.")),
                None => Err(RpcError::new(ErrorCode::OperationInvalid, Retry::Never,
                    "Unknown operationId. Call browser_tabs with action=attach first.")),
            },
        }
    }

    fn with_active<T>(&self, id: &str, f: impl FnOnce(&mut Operation) -> Result<T, RpcError>) -> Result<T, RpcError> {
        let mut g = self.inner.lock().unwrap();
        Self::active(&g, id)?;
        f(g.current.as_mut().expect("validated under the same lock"))
    }

    pub fn add_tab(&self, id: &str, tab: i64) -> Result<(), RpcError> {
        self.with_active(id, |op| { if !op.tabs.contains(&tab) { op.tabs.push(tab); } Ok(()) })
    }

    pub fn add_and_switch_tab(&self, id: &str, tab: i64) -> Result<(), RpcError> {
        self.with_active(id, |op| {
            if !op.tabs.contains(&tab) { op.tabs.push(tab); }
            op.current_tab = tab;
            op.current_tab_closed = false;
            Ok(())
        })
    }

    pub fn switch_tab(&self, id: &str, tab: i64) -> Result<(), RpcError> {
        self.with_active(id, |op| {
            if !op.tabs.contains(&tab) {
                return Err(RpcError::new(ErrorCode::TabNotFound, Retry::Never,
                    "That tab is not part of this operation. Use action=new or attach it first.")
                    .with_details(json!({ "tabId": tab, "operationTabs": op.tabs })));
            }
            op.current_tab = tab;
            op.current_tab_closed = false;
            Ok(())
        })
    }

    pub fn remove_tab(&self, tab: i64) {
        let mut g = self.inner.lock().unwrap();
        if let Some(op) = g.current.as_mut() {
            op.tabs.retain(|t| *t != tab);
            if op.current_tab == tab { op.current_tab_closed = true; }
        }
    }

    pub fn remove_tab_for_operation(&self, id: &str, tab: i64) {
        let mut g = self.inner.lock().unwrap();
        if let Some(op) = g.current.as_mut().filter(|op| op.id == id) {
            op.tabs.retain(|t| *t != tab);
            if op.current_tab == tab { op.current_tab_closed = true; }
        }
    }

    /// The event's profile must still own the operation if selection changed concurrently.
    pub fn remove_tab_for_client(&self, client_id: &str, tab: i64) {
        let mut g = self.inner.lock().unwrap();
        if let Some(op) = g.current.as_mut().filter(|op| op.client_id == client_id) {
            op.tabs.retain(|t| *t != tab);
            if op.current_tab == tab { op.current_tab_closed = true; }
        }
    }

    fn finish(g: &mut GateInner, state: OpState) -> Option<Operation> {
        let mut op = g.current.take()?;
        op.state = state;
        g.finished.push((op.id.clone(), state));
        if g.finished.len() > 50 { g.finished.remove(0); }
        Some(op)
    }

    pub fn release(&self, id: &str) -> Result<(), RpcError> {
        let mut g = self.inner.lock().unwrap();
        Self::active(&g, id)?;
        Self::finish(&mut g, OpState::Released);
        Ok(())
    }

    /// Closes the gate first: any later call for this operation gets CANCELLED.
    pub fn abort(&self, id: Option<&str>) -> Option<AbortedOperation> {
        let mut g = self.inner.lock().unwrap();
        let matches = g.current.as_ref().is_some_and(|o| id.is_none_or(|i| i == o.id));
        if !matches { return None; }
        g.generation += 1;
        let generation = g.generation;
        Self::finish(&mut g, OpState::Aborted).map(|op| AbortedOperation { id: op.id, generation, client_id: op.client_id })
    }

    pub fn current(&self) -> Option<Operation> {
        self.inner.lock().unwrap().current.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::ErrorCode;

    #[test]
    fn second_attach_while_active_is_busy() {
        let g = OperationGate::default();
        let op = g.attach(1, "cli").unwrap();
        let err = g.attach(2, "cli").unwrap_err();
        assert_eq!(err.code, ErrorCode::BrowserBusy);
        assert_eq!(err.details["operationId"], op.id);
    }

    #[test]
    fn abort_bumps_generation_and_cancels_further_calls() {
        let g = OperationGate::default();
        let op = g.attach(1, "cli").unwrap();
        let aborted = g.abort(None).unwrap();
        assert!(aborted.generation > op.generation);
        assert_eq!(aborted.client_id, "cli");
        assert_eq!(g.check(&op.id).unwrap_err().code, ErrorCode::Cancelled);
        // after abort a new attach is allowed
        assert!(g.attach(1, "cli").is_ok());
    }

    #[test]
    fn switch_outside_operation_tabs_is_rejected() {
        let g = OperationGate::default();
        let op = g.attach(1, "cli").unwrap();
        assert_eq!(g.switch_tab(&op.id, 99).unwrap_err().code, ErrorCode::TabNotFound);
        g.add_tab(&op.id, 7).unwrap();
        g.switch_tab(&op.id, 7).unwrap();
        assert_eq!(g.check(&op.id).unwrap().current_tab, 7);
    }

    #[test]
    fn closing_current_tab_falls_back_to_tab_closed_error() {
        let g = OperationGate::default();
        let op = g.attach(1, "cli").unwrap();
        g.remove_tab(1);
        assert_eq!(g.check(&op.id).unwrap_err().code, ErrorCode::TabClosed);
    }

    #[test]
    fn closed_current_tab_can_switch_to_a_remaining_tab() {
        let g = OperationGate::default();
        let op = g.attach(1, "cli").unwrap();
        g.add_tab(&op.id, 2).unwrap();
        g.remove_tab(1);
        g.switch_tab(&op.id, 2).unwrap();
        assert_eq!(g.check(&op.id).unwrap().current_tab, 2);
    }

    #[test]
    fn closed_current_tab_can_release() {
        let g = OperationGate::default();
        let op = g.attach(1, "cli").unwrap();
        g.remove_tab(1);
        g.release(&op.id).unwrap();
        assert!(g.current().is_none());
        assert!(g.attach(2, "cli").is_ok());
    }

    #[test]
    fn ended_operation_cannot_mutate_a_replacement() {
        let g = OperationGate::default();
        let old = g.attach(1, "cli").unwrap();
        g.abort(Some(&old.id));
        let new = g.attach(2, "cli").unwrap();
        assert_eq!(g.add_tab(&old.id, 3).unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(g.switch_tab(&old.id, 2).unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(g.release(&old.id).unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(g.current().unwrap().id, new.id);
        assert_eq!(g.current().unwrap().tabs, vec![2]);
    }

    #[test]
    fn abort_cannot_pass_the_validation_enqueue_boundary() {
        use std::sync::{Arc, mpsc};
        let gate = Arc::new(OperationGate::default());
        let op = gate.attach(1, "A").unwrap();
        let (entered, wait_entered) = mpsc::sync_channel(0);
        let (proceed, wait_proceed) = mpsc::sync_channel(0);
        let dispatcher = {
            let gate = gate.clone();
            let id = op.id.clone();
            std::thread::spawn(move || gate.with_checked(&id, true, |_| {
                entered.send(()).unwrap();
                wait_proceed.recv().unwrap();
                Ok(()) // The real router enqueues synchronously at this boundary.
            }))
        };
        wait_entered.recv().unwrap();
        assert!(matches!(gate.inner.try_lock(), Err(std::sync::TryLockError::WouldBlock)), "abort/release share the held gate lock");
        proceed.send(()).unwrap();
        dispatcher.join().unwrap().unwrap();
        let aborted = gate.abort(Some(&op.id)).unwrap();
        assert_eq!(aborted.client_id, "A");
        let mut sent = false;
        let error = gate.with_checked(&op.id, true, |_| { sent = true; Ok(()) }).unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(!sent);
    }

    #[test]
    fn unknown_operation_is_invalid() {
        let g = OperationGate::default();
        assert_eq!(g.check("op-nope").unwrap_err().code, ErrorCode::OperationInvalid);
    }
}
