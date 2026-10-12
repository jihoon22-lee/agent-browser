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
    pub opened_tabs: Vec<i64>,
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
    owned_tabs: std::collections::HashSet<i64>,
    closed_tabs: std::collections::HashSet<i64>,
    request: Option<RequestTarget>,
}

#[derive(Clone)]
struct RequestTarget { id: String, client: String, tab: Option<i64> }

impl OperationGate {
    pub fn attach(&self, tab_id: i64, client_id: &str) -> Result<Operation, RpcError> {
        self.attach_request(tab_id, client_id, None)
    }

    pub fn begin_request(&self, id: &str, client: &str, tab: Option<i64>) -> Result<(), RpcError> {
        let mut g=self.inner.lock().unwrap();
        if let Some(r)=&g.request {
            if r.id==id && r.client==client { return Ok(()); }
            return Err(RpcError::new(ErrorCode::BrowserBusy,Retry::Never,"Another user request owns the browser. Wait for it to finish or stop it."));
        }
        if g.current.is_some() { return Err(RpcError::new(ErrorCode::BrowserBusy,Retry::Never,"Finish or stop the previous browser operation before starting a new request.")); }
        g.request=Some(RequestTarget{id:id.into(),client:client.into(),tab});
        Ok(())
    }

    fn request_matches(g:&GateInner,id:Option<&str>,client:&str)->Result<(),RpcError> {
        match (&g.request,id) {
            (None,None)=>Ok(()),
            (Some(r),Some(id)) if r.id==id && r.client==client=>Ok(()),
            _=>Err(RpcError::new(ErrorCode::OperationInvalid,Retry::Never,"Attach with the requestId from the current user request. Do not reuse another request's operation.")),
        }
    }

    pub fn request_target(&self,id:Option<&str>,client:&str,explicit:Option<i64>)->Result<Option<i64>,RpcError> {
        let g=self.inner.lock().unwrap(); Self::request_matches(&g,id,client)?;
        if explicit.is_some() { return Ok(explicit); }
        match &g.request {
            Some(r)=>r.tab.map(Some).ok_or_else(||RpcError::new(ErrorCode::TabNotFound,Retry::Never,"No safe active tab was available when the user submitted this request. Ask for an explicit tab.")),
            None=>Ok(None),
        }
    }

    pub fn end_request(&self,id:&str,client:&str)->Result<Option<AbortedOperation>,RpcError> {
        let mut g=self.inner.lock().unwrap();Self::request_matches(&g,Some(id),client)?;
        g.request=None;g.generation+=1;let generation=g.generation;
        Ok(Self::finish(&mut g,OpState::Released).map(|op|AbortedOperation{id:op.id,generation,client_id:op.client_id}))
    }

    pub fn attach_request(&self, tab_id:i64, client_id:&str, request_id:Option<&str>)->Result<Operation,RpcError> {
        self.begin(Some(tab_id),client_id,request_id)
    }

    pub fn reserve_new(&self,client_id:&str,request_id:Option<&str>)->Result<Operation,RpcError> {
        self.begin(None,client_id,request_id)
    }

    fn begin(&self,tab_id:Option<i64>,client_id:&str,request_id:Option<&str>)->Result<Operation,RpcError> {
        let mut g = self.inner.lock().unwrap();
        Self::request_matches(&g,request_id,client_id)?;
        if let Some(op) = g.current.as_ref().filter(|o| o.state == OpState::Active) {
            return Err(RpcError::new(ErrorCode::BrowserBusy, Retry::Never,
                "Another browser operation is running. Wait for it to finish or ask the user to press Stop.")
                .with_details(json!({ "operationId": op.id })));
        }
        g.generation += 1;
        g.owned_tabs.clear(); g.owned_tabs.extend(tab_id); g.closed_tabs.clear();
        let op = Operation {
            id: format!("op-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
            generation: g.generation,
            tabs: tab_id.into_iter().collect(),
            opened_tabs: vec![],
            current_tab: tab_id.unwrap_or(0),
            client_id: client_id.to_string(),
            state: OpState::Active,
            current_tab_closed: tab_id.is_none(),
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
        if g.request.as_ref().is_some_and(|r|r.client!=client_id) {
            return Err(RpcError::new(ErrorCode::BrowserBusy,Retry::Never,"Another request has captured a different browser."));
        }
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
        let mut g = self.inner.lock().unwrap(); Self::active(&g,id)?;
        if g.closed_tabs.contains(&tab) { return Err(RpcError::new(ErrorCode::TabClosed,Retry::Never,"The new tab closed before it could join the operation")); }
        g.owned_tabs.insert(tab);
        let op = g.current.as_mut().unwrap(); if !op.tabs.contains(&tab) { op.tabs.push(tab); op.opened_tabs.push(tab); } Ok(())
    }

    pub fn add_and_switch_tab(&self, id: &str, tab: i64) -> Result<(), RpcError> {
        let mut g = self.inner.lock().unwrap(); Self::active(&g,id)?;
        if g.closed_tabs.contains(&tab) { return Err(RpcError::new(ErrorCode::TabClosed,Retry::Never,"The new tab closed before it could join the operation")); }
        g.owned_tabs.insert(tab);
        let op = g.current.as_mut().unwrap();
            if !op.tabs.contains(&tab) { op.tabs.push(tab); op.opened_tabs.push(tab); }
            op.current_tab = tab;
            op.current_tab_closed = false;
        Ok(())
    }

    /// The source was captured under the same gate lock as command enqueue. Only
    /// that operation/generation/profile may adopt Chrome-confirmed child tabs.
    pub fn adopt_children(&self,id: &str,generation: u64,client: &str,source: i64,tabs: &[i64]) -> Result<Operation,RpcError> {
        let mut g = self.inner.lock().unwrap(); let op = Self::active(&g,id)?;
        if op.generation != generation || op.client_id != client || !g.owned_tabs.contains(&source) {
            return Err(RpcError::new(ErrorCode::OperationInvalid,Retry::Never,"New-tab source does not belong to this operation generation"));
        }
        let tabs: Vec<_> = tabs.iter().copied().filter(|tab| *tab > 0 && *tab != source && !g.closed_tabs.contains(tab)).collect();
        g.owned_tabs.extend(tabs.iter().copied());
        let op = g.current.as_mut().unwrap();
        for tab in &tabs { if !op.tabs.contains(tab) { op.tabs.push(*tab); op.opened_tabs.push(*tab); } }
        // A concurrent explicit switch wins over an older click's new-tab result.
        if op.current_tab == source { if let Some(tab) = tabs.first() { op.current_tab = *tab; op.current_tab_closed = false; } }
        Ok(op.clone())
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
        if g.current.is_some() { g.closed_tabs.insert(tab); }
        if let Some(op) = g.current.as_mut() {
            op.tabs.retain(|t| *t != tab);
            op.opened_tabs.retain(|t| *t != tab);
            if op.current_tab == tab { op.current_tab_closed = true; }
        }
    }

    pub fn remove_tab_for_operation(&self, id: &str, tab: i64) {
        let mut g = self.inner.lock().unwrap();
        if g.current.as_ref().is_some_and(|op| op.id == id) { g.closed_tabs.insert(tab); }
        if let Some(op) = g.current.as_mut().filter(|op| op.id == id) {
            op.tabs.retain(|t| *t != tab);
            op.opened_tabs.retain(|t| *t != tab);
            if op.current_tab == tab { op.current_tab_closed = true; }
        }
    }

    /// The event's profile must still own the operation if selection changed concurrently.
    pub fn remove_tab_for_client(&self, client_id: &str, tab: i64) {
        let mut g = self.inner.lock().unwrap();
        if g.current.as_ref().is_some_and(|op| op.client_id == client_id) { g.closed_tabs.insert(tab); }
        if let Some(op) = g.current.as_mut().filter(|op| op.client_id == client_id) {
            op.tabs.retain(|t| *t != tab);
            op.opened_tabs.retain(|t| *t != tab);
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
        if id.is_none() || matches { g.request=None; }
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
    fn standalone_new_respects_request_owner_without_requiring_a_default_tab() {
        let g=OperationGate::default();g.begin_request("new-request","browser",None).unwrap();
        assert!(g.reserve_new("browser",None).is_err());
        assert!(g.reserve_new("other",Some("new-request")).is_err());
        let op=g.reserve_new("browser",Some("new-request")).unwrap();
        assert!(op.tabs.is_empty());g.add_and_switch_tab(&op.id,42).unwrap();
        assert!(g.begin_request("next","browser",Some(7)).is_err());
        g.end_request("new-request","browser").unwrap();
        assert!(g.reserve_new("browser",Some("new-request")).is_err());
    }

    #[test]
    fn request_target_is_captured_and_explicit_target_wins() {
        let g = OperationGate::default();
        g.begin_request("turn-a", "browser", Some(12)).unwrap();
        assert_eq!(g.request_target(Some("turn-a"), "browser", None).unwrap(), Some(12));
        assert_eq!(g.request_target(Some("turn-a"), "browser", Some(99)).unwrap(), Some(99));
        assert!(g.request_target(None, "browser", None).is_err());
        assert!(g.request_target(Some("turn-a"), "other", None).is_err());
        assert!(g.begin_request("turn-b", "browser", Some(22)).is_err());
    }

    #[test]
    fn request_end_invalidates_its_operation_and_late_request_ids() {
        let g = OperationGate::default();
        g.begin_request("turn-a", "browser", Some(12)).unwrap();
        let op=g.attach_request(12,"browser",Some("turn-a")).unwrap();
        assert!(g.end_request("wrong", "browser").is_err());
        assert_eq!(g.check(&op.id).unwrap().current_tab,12);
        g.end_request("turn-a","browser").unwrap();
        assert!(g.check(&op.id).is_err());
        assert!(g.attach_request(12,"browser",Some("turn-a")).is_err());
        g.begin_request("turn-b","browser",Some(22)).unwrap();
        assert_eq!(g.request_target(Some("turn-b"),"browser",None).unwrap(),Some(22));
    }

    #[test]
    fn ambiguous_default_never_falls_back_but_explicit_target_is_allowed() {
        let g=OperationGate::default();
        g.begin_request("turn-a","browser",None).unwrap();
        assert!(g.request_target(Some("turn-a"),"browser",None).is_err());
        assert_eq!(g.request_target(Some("turn-a"),"browser",Some(7)).unwrap(),Some(7));
    }

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

    #[test]
    fn child_adoption_keeps_original_tab_and_rejects_other_owner_or_generation() {
        let gate = OperationGate::default(); let op = gate.attach(1,"A").unwrap();
        assert!(gate.adopt_children(&op.id,op.generation,"B",1,&[2]).is_err());
        assert!(gate.adopt_children(&op.id,op.generation+1,"A",1,&[2]).is_err());
        assert!(gate.adopt_children(&op.id,op.generation,"A",99,&[2]).is_err());
        let adopted = gate.adopt_children(&op.id,op.generation,"A",1,&[2]).unwrap();
        assert_eq!(adopted.tabs,vec![1,2]); assert_eq!(adopted.current_tab,2);
        gate.switch_tab(&op.id,1).unwrap(); assert_eq!(gate.check(&op.id).unwrap().current_tab,1);
    }

    #[test]
    fn closed_children_and_late_aborted_results_cannot_be_resurrected() {
        let gate = OperationGate::default(); let old = gate.attach(1,"A").unwrap();
        gate.remove_tab_for_client("A",2);
        let op = gate.adopt_children(&old.id,old.generation,"A",1,&[2]).unwrap();
        assert_eq!(op.tabs,vec![1]); assert_eq!(op.current_tab,1);
        gate.abort(Some(&old.id)); let new = gate.attach(1,"A").unwrap();
        assert_eq!(gate.adopt_children(&old.id,old.generation,"A",1,&[3]).unwrap_err().code,ErrorCode::Cancelled);
        assert_eq!(gate.current().unwrap().id,new.id); assert_eq!(gate.current().unwrap().tabs,vec![1]);
    }

    #[test]
    fn child_adoption_does_not_override_an_explicit_concurrent_tab_switch() {
        let gate = OperationGate::default(); let op = gate.attach(1,"A").unwrap();
        gate.add_tab(&op.id,7).unwrap(); gate.switch_tab(&op.id,7).unwrap();
        let result = gate.adopt_children(&op.id,op.generation,"A",1,&[2]).unwrap();
        assert_eq!(result.tabs,vec![1,7,2]); assert_eq!(result.current_tab,7);
    }
}
