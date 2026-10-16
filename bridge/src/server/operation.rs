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
    pub needs_observation: bool,
    #[serde(skip)]
    pub target_epoch: u64,
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
    // Explicitly visited targets, ordered for deterministic return after close.
    recent_tabs: Vec<i64>,
    request: Option<RequestTarget>,
    stopped_clients: std::collections::HashMap<String, std::time::Instant>,
}

/// Which runtime session owns a panel request, as reported by the panel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestScope { pub profile: String, pub session: String, pub directory: String }

/// The open scoped panel request and its current operation, if any.
#[derive(Clone, Debug)]
pub struct BoundRequest { pub id: String, pub client: String, pub tab: Option<i64>, pub scope: RequestScope, pub operation: Option<String> }

#[derive(Clone)]
struct RequestTarget { id: String, client: String, tab: Option<i64>, scope: Option<RequestScope> }

impl OperationGate {
    pub fn attach(&self, tab_id: i64, client_id: &str) -> Result<Operation, RpcError> {
        self.attach_request(tab_id, client_id, None)
    }

    pub fn begin_request(&self, id: &str, client: &str, tab: Option<i64>) -> Result<(), RpcError> {
        self.begin_scoped_request(id,client,tab,None)
    }

    pub fn begin_scoped_request(&self, id: &str, client: &str, tab: Option<i64>, scope: Option<RequestScope>) -> Result<(), RpcError> {
        let mut g=self.inner.lock().unwrap();
        if let Some(r)=&g.request {
            if r.id==id && r.client==client { return Ok(()); }
            return Err(RpcError::new(ErrorCode::BrowserBusy,Retry::Never,"Another user request owns the browser. Wait for it to finish or stop it."));
        }
        if g.current.is_some() { return Err(RpcError::new(ErrorCode::BrowserBusy,Retry::Never,"Finish or stop the previous browser operation before starting a new request.")); }
        g.request=Some(RequestTarget{id:id.into(),client:client.into(),tab,scope});
        Ok(())
    }

    /// The open panel request and its current operation, when the panel said which
    /// runtime session owns it. Binding still needs the caller-side guard in `binding`.
    pub fn bound_request(&self) -> Option<BoundRequest> {
        let g=self.inner.lock().unwrap();
        let r=g.request.as_ref()?; let scope=r.scope.clone()?;
        let operation=g.current.as_ref().filter(|o| o.state==OpState::Active && o.client_id==r.client).map(|o| o.id.clone());
        Some(BoundRequest{id:r.id.clone(),client:r.client.clone(),tab:r.tab,scope,operation})
    }

    fn request_matches(g:&GateInner,id:Option<&str>,client:&str)->Result<(),RpcError> {
        if g.request.is_none() && id.is_none() && g.stopped_clients.get(client).is_some_and(|until| *until > std::time::Instant::now()) {
            return Err(RpcError::new(ErrorCode::Cancelled,Retry::Never,"A panel request was stopped. Unscoped attach is blocked for 30 seconds; wait for a new user request."));
        }
        match (&g.request,id) {
            (None,None)=>Ok(()),
            (Some(r),Some(id)) if r.id==id && r.client==client=>Ok(()),
            (Some(r),None) if r.client==client=>Err(RpcError::new(ErrorCode::OperationInvalid,Retry::Safe,
                "Missing requestId. No browser action ran. Copy requestId from the Browser context for the latest user request into browser_tabs attach/new arguments and retry. Do not reuse an earlier requestId or operationId; if that context is unavailable, stop and ask for a new panel request.")),
            (None,Some(_))=>Err(RpcError::new(ErrorCode::OperationInvalid,Retry::Never,
                "This requestId belongs to a request that already ended. Do not reuse it; a new panel request provides a new requestId. Outside the panel, omit requestId.")),
            _=>Err(RpcError::new(ErrorCode::OperationInvalid,Retry::Never,"A panel request owns the browser. Wait for completion or stop it in the panel; scoped calls must use that requestId.")),
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
        self.finish_request(id,client,false)
    }

    pub fn cancel_request(&self,id:&str,client:&str)->Result<Option<AbortedOperation>,RpcError> {
        self.finish_request(id,client,true)
    }

    fn stop_client(g: &mut GateInner, client: &str) {
        let now=std::time::Instant::now();
        g.stopped_clients.retain(|_,until| *until>now);
        g.stopped_clients.insert(client.into(),now+std::time::Duration::from_secs(30));
    }

    fn finish_request(&self,id:&str,client:&str,cancel:bool)->Result<Option<AbortedOperation>,RpcError> {
        let mut g=self.inner.lock().unwrap();Self::request_matches(&g,Some(id),client)?;
        if cancel { Self::stop_client(&mut g,client); }
        g.request=None;g.generation+=1;let generation=g.generation;
        let state=if cancel {OpState::Aborted} else {OpState::Released};
        Ok(Self::finish(&mut g,state).map(|op|AbortedOperation{id:op.id,generation,client_id:op.client_id}))
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
            if op.client_id==client_id && request_id.is_some() {
                return Err(RpcError::new(ErrorCode::BrowserBusy,Retry::Safe,"This request already has an operation. Use its operationId with action=new or switch to continue; do not create a new requestId per tab.").with_details(json!({"operationId":op.id})));
            }
            return Err(RpcError::new(ErrorCode::BrowserBusy, Retry::Never,
                "Another browser operation is running. Wait for it to finish or ask the user to press Stop.")
                .with_details(json!({ "operationId": op.id })));
        }
        g.generation += 1;
        g.owned_tabs.clear(); g.owned_tabs.extend(tab_id); g.closed_tabs.clear();
        g.recent_tabs.clear(); g.recent_tabs.extend(tab_id);
        let op = Operation {
            id: format!("op-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
            generation: g.generation,
            tabs: tab_id.into_iter().collect(),
            opened_tabs: vec![],
            current_tab: tab_id.unwrap_or(0),
            client_id: client_id.to_string(),
            state: OpState::Active,
            current_tab_closed: tab_id.is_none(),
            needs_observation:false,target_epoch:0,
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
        Self::select_tab(&mut g,tab);
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
        let target=if op.current_tab==source {tabs.first().copied()} else {None};
        if let Some(tab)=target {Self::select_tab(&mut g,tab);}
        Ok(g.current.as_ref().unwrap().clone())
    }

    fn select_tab(g: &mut GateInner, tab: i64) {
        g.recent_tabs.retain(|visited| *visited != tab);
        g.recent_tabs.push(tab);
        let op=g.current.as_mut().unwrap();
        op.current_tab=tab;op.current_tab_closed=false;
        op.target_epoch+=1;op.needs_observation=false;
    }

    pub fn switch_tab(&self, id: &str, tab: i64) -> Result<(), RpcError> {
        let mut g=self.inner.lock().unwrap();let op=Self::active(&g,id)?;
        if !op.tabs.contains(&tab) {return Err(RpcError::new(ErrorCode::TabNotFound,Retry::Never,"Tab has not been verified for this operation"));}
        Self::select_tab(&mut g,tab);Ok(())
    }

    /// Only call after this operation's browser has returned the exact tab.
    pub fn visit_verified_tab(&self, id: &str, tab: i64) -> Result<(), RpcError> {
        let mut g=self.inner.lock().unwrap();Self::active(&g,id)?;
        if g.closed_tabs.contains(&tab) {return Err(RpcError::new(ErrorCode::TabClosed,Retry::Never,"The selected tab closed during verification"));}
        g.owned_tabs.insert(tab);
        let op=g.current.as_mut().unwrap();if !op.tabs.contains(&tab) {op.tabs.push(tab);}
        Self::select_tab(&mut g,tab);Ok(())
    }

    fn remove_current_tab(g: &mut GateInner, tab: i64) {
        g.closed_tabs.insert(tab);g.owned_tabs.remove(&tab);
        g.recent_tabs.retain(|visited| *visited != tab);
        if let Some(op)=g.current.as_mut() {
            op.tabs.retain(|t| *t != tab);op.opened_tabs.retain(|t| *t != tab);
            if op.current_tab==tab {
                if let Some(previous)=g.recent_tabs.iter().rev().find(|id|op.tabs.contains(id)) {
                    op.current_tab=*previous;op.current_tab_closed=false;
                    op.target_epoch+=1;op.needs_observation=true;
                } else {op.current_tab_closed=true;}
            }
        }
    }

    pub fn observe_target(&self, origin: &Operation) {
        let mut g=self.inner.lock().unwrap();
        if let Some(op)=g.current.as_mut().filter(|op|op.id==origin.id && op.target_epoch==origin.target_epoch && op.current_tab==origin.current_tab && !op.current_tab_closed) {op.needs_observation=false;}
    }

    pub fn remove_tab(&self, tab: i64) {
        let mut g=self.inner.lock().unwrap();
        if g.current.is_some() {Self::remove_current_tab(&mut g,tab);}
    }

    pub fn remove_tab_for_operation(&self, id: &str, tab: i64) {
        let mut g=self.inner.lock().unwrap();
        if g.current.as_ref().is_some_and(|op|op.id==id) {Self::remove_current_tab(&mut g,tab);}
    }

    /// A close event from another browser must not change this request's target.
    pub fn remove_tab_for_client(&self, client_id: &str, tab: i64) {
        let mut g=self.inner.lock().unwrap();
        if g.current.as_ref().is_some_and(|op|op.client_id==client_id) {Self::remove_current_tab(&mut g,tab);}
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
        self.abort_inner(id,false)
    }

    pub fn abort_user(&self, id: Option<&str>) -> Option<AbortedOperation> {
        self.abort_inner(id,true)
    }

    fn abort_inner(&self,id:Option<&str>,user:bool)->Option<AbortedOperation> {
        let mut g = self.inner.lock().unwrap();
        let matches = g.current.as_ref().is_some_and(|o| id.is_none_or(|i| i == o.id));
        if user && (id.is_none() || matches) {
            if let Some(request)=g.request.take() { Self::stop_client(&mut g,&request.client); }
        }
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
    fn a_scoped_request_reports_its_scope_and_current_operation() {
        let g=OperationGate::default();
        let scope=RequestScope{profile:"p".into(),session:"ses_1".into(),directory:"/w".into()};
        g.begin_scoped_request("req","browser",Some(12),Some(scope.clone())).unwrap();
        let bound=g.bound_request().unwrap();
        assert_eq!((bound.id.as_str(),bound.tab,&bound.scope,bound.operation.as_deref()),("req",Some(12),&scope,None));
        let op=g.attach_request(12,"browser",Some("req")).unwrap();
        assert_eq!(g.bound_request().unwrap().operation,Some(op.id));
        g.end_request("req","browser").unwrap();
        assert!(g.bound_request().is_none(),"an ended request binds nothing");
        g.begin_request("plain","browser",Some(12)).unwrap();
        assert!(g.bound_request().is_none(),"an unscoped request binds nothing");
    }
    #[test]
    fn a_finished_request_id_is_explained_instead_of_reported_as_busy() {
        let g = OperationGate::default();
        g.begin_request("turn-a", "browser", Some(12)).unwrap();
        g.end_request("turn-a", "browser").unwrap();
        let error = g.attach_request(12, "browser", Some("turn-a")).unwrap_err();
        assert!(error.message.contains("already ended"), "{}", error.message);
        assert!(!error.message.contains("Wait"));
    }

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
    fn nested_close_returns_to_recent_targets_without_adopting_other_browsers() {
        let gate=OperationGate::default();let op=gate.attach(1,"A").unwrap();
        gate.add_and_switch_tab(&op.id,2).unwrap();gate.add_and_switch_tab(&op.id,3).unwrap();
        gate.remove_tab_for_client("B",3);assert_eq!(gate.check(&op.id).unwrap().current_tab,3);
        gate.remove_tab_for_client("A",3);assert_eq!(gate.check(&op.id).unwrap().current_tab,2);
        gate.remove_tab_for_operation(&op.id,2);assert_eq!(gate.check(&op.id).unwrap().current_tab,1);
        gate.observe_target(&op);assert!(gate.check(&op.id).unwrap().needs_observation,"An old snapshot from before the popup cannot acknowledge return");
        let returned=gate.check(&op.id).unwrap();gate.observe_target(&returned);assert!(!gate.check(&op.id).unwrap().needs_observation);
        gate.visit_verified_tab(&op.id,9).unwrap();assert!(!gate.check(&op.id).unwrap().opened_tabs.contains(&9));
        gate.remove_tab(1);assert_eq!(gate.check(&op.id).unwrap().current_tab,9);
        gate.remove_tab(9);assert_eq!(gate.check(&op.id).unwrap_err().code,ErrorCode::TabClosed);
        gate.visit_verified_tab(&op.id,10).unwrap();assert_eq!(gate.check(&op.id).unwrap().current_tab,10);
        assert_eq!(gate.visit_verified_tab(&op.id,9).unwrap_err().code,ErrorCode::TabClosed);
    }

    #[test]
    fn unvisited_background_tabs_are_not_automatic_close_fallbacks() {
        let gate=OperationGate::default();let op=gate.attach(1,"A").unwrap();
        gate.add_tab(&op.id,2).unwrap();gate.remove_tab(1);
        assert_eq!(gate.check(&op.id).unwrap_err().code,ErrorCode::TabClosed);
        gate.switch_tab(&op.id,2).unwrap();assert_eq!(gate.check(&op.id).unwrap().current_tab,2);
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

#[cfg(test)]
mod issue8_tests {
    use super::*;
    #[test]
    fn omitted_request_id_can_be_corrected_without_releasing_or_exposing_the_owner() {
        let g=OperationGate::default();g.begin_request("private-request","browser",Some(7)).unwrap();
        let error=g.request_target(None,"browser",None).unwrap_err();
        assert_eq!(error.code,ErrorCode::OperationInvalid);
        assert_eq!(error.retry,Retry::Safe);
        assert!(error.message.contains("requestId") && error.message.contains("latest user request"));
        assert!(!error.message.contains("private-request"));
        assert_eq!(g.request_target(Some("wrong"),"browser",None).unwrap_err().retry,Retry::Never);
        assert_eq!(g.request_target(None,"other-client",None).unwrap_err().retry,Retry::Never);
        assert_eq!(g.request_target(Some("private-request"),"browser",None).unwrap(),Some(7));
        let op=g.attach_request(7,"browser",Some("private-request")).unwrap();
        g.end_request("private-request","browser").unwrap();
        assert!(g.check(&op.id).is_err());
        assert!(g.request_target(Some("private-request"),"browser",None).is_err());
        g.begin_request("cancel-me","browser",Some(7)).unwrap();
        g.cancel_request("cancel-me","browser").unwrap();
        assert_eq!(g.request_target(None,"browser",None).unwrap_err().code,ErrorCode::Cancelled);
        g.begin_request("after-stop","browser",Some(8)).unwrap();
        assert_eq!(g.request_target(None,"browser",None).unwrap_err().retry,Retry::Safe);
        assert_eq!(g.request_target(Some("cancel-me"),"browser",None).unwrap_err().retry,Retry::Never);
    }
    #[test]
    fn stop_cancels_the_operation_and_blocks_unscoped_reattach() {
        let g=OperationGate::default();g.begin_request("req","browser",Some(7)).unwrap();
        let op=g.attach_request(7,"browser",Some("req")).unwrap();
        g.cancel_request("req","browser").unwrap();
        assert_eq!(g.check(&op.id).unwrap_err().code,ErrorCode::Cancelled);
        assert_eq!(g.attach(9,"browser").unwrap_err().code,ErrorCode::Cancelled);
        g.begin_request("next","browser",Some(9)).unwrap();
        assert!(g.attach_request(9,"browser",Some("next")).is_ok());
    }
    #[test]
    fn mcp_abort_keeps_the_captured_request_and_tab() {
        let g=OperationGate::default();g.begin_request("req","browser",Some(7)).unwrap();
        let op=g.attach_request(7,"browser",Some("req")).unwrap();g.abort(Some(&op.id));
        assert_eq!(g.request_target(Some("req"),"browser",None).unwrap(),Some(7));
        assert!(g.attach(42,"browser").is_err());
        assert!(g.attach_request(7,"browser",Some("req")).is_ok());
    }
    #[test]
    fn normal_completion_releases_the_request_for_cli() {
        let g=OperationGate::default();g.begin_request("req","browser",Some(7)).unwrap();
        let op=g.attach_request(7,"browser",Some("req")).unwrap();g.end_request("req","browser").unwrap();
        assert_eq!(g.check(&op.id).unwrap_err().code,ErrorCode::OperationInvalid);
        assert!(g.attach(9,"browser").is_ok());
    }
}
