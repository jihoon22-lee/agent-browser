use crate::rpc::{ErrorCode, Retry, RpcError};
use serde_json::json;
use std::collections::HashSet;
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
    /// The user holds the browser: tool calls wait until resume (handoff §16).
    pub paused: bool,
    /// needs_observation was set by a hand-back, not by a tab restore (only the message differs).
    #[serde(skip)]
    pub handed_back: bool,
    #[serde(skip)]
    pub target_epoch: u64,
    #[serde(skip)]
    pub input_connection: Option<String>,
    /// The panel request this operation works for; None for a call outside the panel.
    #[serde(skip)]
    pub request: Option<String>,
    /// Tabs this operation may adopt children from: it attached, opened or visited them.
    #[serde(skip)]
    owned_tabs: HashSet<i64>,
    /// Tabs that closed while this operation ran; they never join it later.
    #[serde(skip)]
    closed_tabs: HashSet<i64>,
    /// Explicitly visited targets, ordered for deterministic return after close.
    #[serde(skip)]
    recent_tabs: Vec<i64>,
}

#[derive(Debug)]
pub struct AbortedOperation {
    pub id: String,
    pub generation: u64,
    pub client_id: String,
}

pub struct OperationGate {
    inner: Mutex<GateInner>,
    /// Wakes calls waiting on a handoff when it is resumed or the operation ends.
    resumed: tokio::sync::Notify,
}

impl Default for OperationGate {
    fn default() -> Self { Self::with_limit(1) }
}

struct GateInner {
    generation: u64,
    /// Running operations, oldest first; at most `limit`.
    ops: Vec<Operation>,
    finished: Vec<(String, OpState)>, // last 50 ended operations, to answer CANCELLED vs OPERATION_INVALID
    /// Open panel requests, oldest first; at most `limit`.
    requests: Vec<RequestTarget>,
    stopped_clients: std::collections::HashMap<String, std::time::Instant>,
    limit: usize,
}

/// Which runtime session owns a panel request, as reported by the panel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestScope { pub profile: String, pub session: String, pub directory: String }

/// The open scoped panel request and its current operation, if any.
#[derive(Clone, Debug)]
pub struct BoundRequest { pub id: String, pub client: String, pub tab: Option<i64>, pub scope: RequestScope, pub operation: Option<String> }

#[derive(Clone)]
struct RequestTarget { id: String, client: String, tab: Option<i64>, scope: Option<RequestScope>,
    /// The panel lets this request run beside other conversations' requests.
    concurrent: bool,
    /// Another request ran beside this one: its id-less calls are no longer bound by guesswork.
    overlapped: bool }

impl GateInner {
    fn op(&self, id: &str) -> Option<&Operation> { self.ops.iter().find(|op| op.id == id) }
    fn op_mut(&mut self, id: &str) -> Option<&mut Operation> { self.ops.iter_mut().find(|op| op.id == id) }
    fn request(&self, id: &str) -> Option<&RequestTarget> { self.requests.iter().find(|r| r.id == id) }
    /// Another running operation already works in this tab: one tab, one operation.
    fn held_elsewhere(&self, id: Option<&str>, tab: i64) -> Option<&Operation> {
        self.ops.iter().find(|op| Some(op.id.as_str()) != id && op.tabs.contains(&tab))
    }
    fn request_op(&self, request: &RequestTarget) -> Option<&Operation> {
        self.ops.iter().find(|op| op.request.as_deref() == Some(request.id.as_str()) && op.client_id == request.client)
    }
}

impl OperationGate {
    /// `limit` is how many operations, and how many panel requests, may run at once.
    pub fn with_limit(limit: usize) -> Self {
        let inner = GateInner { generation: 0, ops: vec![], finished: vec![], requests: vec![], stopped_clients: Default::default(), limit: limit.max(1) };
        Self { inner: Mutex::new(inner), resumed: tokio::sync::Notify::new() }
    }

    pub fn pin_input_connection(&self,id:&str,connection:&str) {
        let mut g=self.inner.lock().unwrap();if let Some(op)=g.op_mut(id) { if op.input_connection.is_none(){op.input_connection=Some(connection.into());} }
    }
    pub fn input_connection_matches(&self,id:&str,connection:Option<&str>)->bool {
        let g=self.inner.lock().unwrap();g.op(id).is_some_and(|op|connection.is_some()&&op.input_connection.as_deref()==connection)
    }

    pub fn attach(&self, tab_id: i64, client_id: &str) -> Result<Operation, RpcError> {
        self.attach_request(tab_id, client_id, None)
    }

    #[cfg(test)]
    pub(crate) fn begin_request(&self, id: &str, client: &str, tab: Option<i64>) -> Result<(), RpcError> {
        self.begin_scoped_request(id,client,tab,None)
    }

    pub fn begin_scoped_request(&self, id: &str, client: &str, tab: Option<i64>, scope: Option<RequestScope>) -> Result<(), RpcError> {
        self.begin_request_with(id,client,tab,scope,false)
    }

    /// `concurrent` requests may run beside each other, up to the gate's limit; any other request runs alone.
    pub fn begin_request_with(&self, id: &str, client: &str, tab: Option<i64>, scope: Option<RequestScope>, concurrent: bool) -> Result<(), RpcError> {
        let mut g=self.inner.lock().unwrap();
        if let Some(r)=g.request(id) {
            if r.client==client { return Ok(()); }
            return Err(RpcError::new(ErrorCode::BrowserBusy,Retry::Never,"Another user request owns the browser. Wait for it to finish or stop it."));
        }
        let beside=concurrent && g.requests.iter().all(|r| r.concurrent);
        if !g.requests.is_empty() && !beside || g.requests.len()>=g.limit { return Err(RpcError::new(ErrorCode::BrowserBusy,Retry::Never,"Another user request owns the browser. Wait for it to finish or stop it.")); }
        // An operation outside the panel holds the browser until it ends.
        if g.ops.iter().any(|op| op.request.is_none()) || g.ops.len()>=g.limit { return Err(RpcError::new(ErrorCode::BrowserBusy,Retry::Never,"Finish or stop the previous browser operation before starting a new request.")); }
        let overlapped=!g.requests.is_empty();
        for other in &mut g.requests { other.overlapped=true; }
        g.requests.push(RequestTarget{id:id.into(),client:client.into(),tab,scope,concurrent,overlapped});
        Ok(())
    }

    /// The panel request that owns this active operation, if any: only its attachments may be uploaded.
    pub fn panel_request_of(&self, op_id: &str) -> Option<String> {
        let g=self.inner.lock().unwrap();
        let op=g.op(op_id).filter(|o| o.state==OpState::Active)?;
        let r=g.request(op.request.as_deref()?)?;
        (r.client==op.client_id).then(|| r.id.clone())
    }

    /// The open panel request and its current operation, when the panel said which
    /// runtime session owns it. Binding still needs the caller-side guard in `binding`.
    pub fn bound_request(&self) -> Option<BoundRequest> { self.bound_request_for(None) }

    /// With `session` (reported by a runtime the Bridge launched), the request of that session.
    /// Without it, only a lone request that never ran beside another: no guessing between conversations.
    pub fn bound_request_for(&self, session: Option<&str>) -> Option<BoundRequest> {
        let g=self.inner.lock().unwrap();
        let r=match session {
            Some(session)=>g.requests.iter().find(|r| r.scope.as_ref().is_some_and(|scope| scope.session==session))?,
            None=>{ let [r]=g.requests.as_slice() else { return None }; if r.overlapped { return None; } r }
        };
        let scope=r.scope.clone()?;
        let operation=g.request_op(r).filter(|o| o.state==OpState::Active).map(|o| o.id.clone());
        Some(BoundRequest{id:r.id.clone(),client:r.client.clone(),tab:r.tab,scope,operation})
    }

    fn request_matches(g:&GateInner,id:Option<&str>,client:&str)->Result<(),RpcError> {
        if g.requests.is_empty() && id.is_none() && g.stopped_clients.get(client).is_some_and(|until| *until > std::time::Instant::now()) {
            return Err(RpcError::new(ErrorCode::Cancelled,Retry::Never,"A panel request was stopped. Unscoped attach is blocked for 30 seconds; wait for a new user request."));
        }
        match id {
            None if g.requests.is_empty() => Ok(()),
            Some(id) if g.request(id).is_some_and(|r| r.client==client) => Ok(()),
            None if g.requests.iter().any(|r| r.client==client) => Err(RpcError::new(ErrorCode::OperationInvalid,Retry::Safe,
                "Missing requestId. No browser action ran. Copy requestId from the Browser context for the latest user request into browser_tabs attach/new arguments and retry. Do not reuse an earlier requestId or operationId; if that context is unavailable, stop and ask for a new panel request.")),
            Some(_) if g.requests.is_empty() => Err(RpcError::new(ErrorCode::OperationInvalid,Retry::Never,
                "This requestId belongs to a request that already ended. Do not reuse it; a new panel request provides a new requestId. Outside the panel, omit requestId.")),
            _ => Err(RpcError::new(ErrorCode::OperationInvalid,Retry::Never,"A panel request owns the browser. Wait for completion or stop it in the panel; scoped calls must use that requestId.")),
        }
    }

    pub fn request_target(&self,id:Option<&str>,client:&str,explicit:Option<i64>)->Result<Option<i64>,RpcError> {
        let g=self.inner.lock().unwrap(); Self::request_matches(&g,id,client)?;
        if explicit.is_some() { return Ok(explicit); }
        match id.and_then(|id| g.request(id)) {
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
        g.requests.retain(|r| r.id!=id);g.generation+=1;let generation=g.generation;
        let state=if cancel {OpState::Aborted} else {OpState::Released};
        let op=g.ops.iter().find(|op| op.request.as_deref()==Some(id)).map(|op| op.id.clone());
        let finished=op.and_then(|op| Self::finish(&mut g,&op,state)).map(|op|AbortedOperation{id:op.id,generation,client_id:op.client_id});
        drop(g); self.resumed.notify_waiters();
        Ok(finished)
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
        if let Some(op) = request_id.and_then(|id| g.ops.iter().find(|op| op.request.as_deref()==Some(id) && op.client_id==client_id)) {
            return Err(RpcError::new(ErrorCode::BrowserBusy,Retry::Safe,"This request already has an operation. Use its operationId with action=new or switch to continue; do not create a new requestId per tab.").with_details(json!({"operationId":op.id})));
        }
        // An operation outside the panel runs alone, as before concurrent requests.
        let blocking = g.ops.iter().find(|op| request_id.is_none() || op.request.is_none()).or(g.ops.first().filter(|_| g.ops.len()>=g.limit));
        if let Some(op) = blocking {
            return Err(RpcError::new(ErrorCode::BrowserBusy, Retry::Never,
                "Another browser operation is running. Wait for it to finish or ask the user to press Stop.")
                .with_details(json!({ "operationId": op.id })));
        }
        if let Some(other) = tab_id.and_then(|tab| g.held_elsewhere(None, tab)) { return Err(Self::tab_taken(other)); }
        g.generation += 1;
        let op = Operation {
            id: format!("op-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
            generation: g.generation,
            tabs: tab_id.into_iter().collect(),
            opened_tabs: vec![],
            current_tab: tab_id.unwrap_or(0),
            client_id: client_id.to_string(),
            state: OpState::Active,
            current_tab_closed: tab_id.is_none(),
            needs_observation:false,paused:false,handed_back:false,target_epoch:0,input_connection:None,
            request: request_id.map(String::from),
            owned_tabs: tab_id.into_iter().collect(), closed_tabs: HashSet::new(), recent_tabs: tab_id.into_iter().collect(),
        };
        g.ops.push(op.clone());
        Ok(op)
    }

    /// Validates operation identity/state, even when its current tab has closed.
    pub fn check_active(&self, id: &str) -> Result<Operation, RpcError> {
        let g = self.inner.lock().unwrap();
        Self::active(&g, id).cloned()
    }

    #[cfg(test)]
    pub(crate) fn check(&self, id: &str) -> Result<Operation, RpcError> {
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
        if g.requests.iter().any(|r|r.client!=client_id) {
            return Err(RpcError::new(ErrorCode::BrowserBusy,Retry::Never,"Another request has captured a different browser."));
        }
        if let Some(op) = g.ops.iter().find(|op| op.client_id != client_id) {
            return Err(RpcError::new(ErrorCode::BrowserBusy, Retry::Never,
                "Finish or stop the current operation before selecting another browser.")
                .with_details(json!({ "operationId": op.id })));
        }
        Ok(select())
    }

    fn tab_taken(other: &Operation) -> RpcError {
        RpcError::new(ErrorCode::BrowserBusy, Retry::Never,
            "Another request is working in this tab. Open a new tab with browser_tabs action=new, or pick a tab no other request uses.")
            .with_details(json!({ "operationId": other.id }))
    }

    fn active<'a>(g: &'a GateInner, id: &str) -> Result<&'a Operation, RpcError> {
        match g.op(id) {
            Some(op) if op.state == OpState::Active => Ok(op),
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

    #[cfg(test)]
    pub(crate) fn add_tab(&self, id: &str, tab: i64) -> Result<(), RpcError> {
        let mut g = self.inner.lock().unwrap(); Self::active(&g,id)?;
        let op = g.op_mut(id).unwrap();
        if op.closed_tabs.contains(&tab) { return Err(RpcError::new(ErrorCode::TabClosed,Retry::Never,"The new tab closed before it could join the operation")); }
        op.owned_tabs.insert(tab);
        if !op.tabs.contains(&tab) { op.tabs.push(tab); op.opened_tabs.push(tab); } Ok(())
    }

    pub fn add_and_switch_tab(&self, id: &str, tab: i64) -> Result<(), RpcError> {
        let mut g = self.inner.lock().unwrap(); Self::active(&g,id)?;
        if let Some(other) = g.held_elsewhere(Some(id), tab) { return Err(Self::tab_taken(other)); }
        let op = g.op_mut(id).unwrap();
        if op.closed_tabs.contains(&tab) { return Err(RpcError::new(ErrorCode::TabClosed,Retry::Never,"The new tab closed before it could join the operation")); }
        op.owned_tabs.insert(tab);
        if !op.tabs.contains(&tab) { op.tabs.push(tab); op.opened_tabs.push(tab); }
        Self::select_tab(op,tab);
        // A tab this operation just created holds nothing the model has yet to see, and a blank
        // one cannot be read before its first navigation.
        op.needs_observation=false; op.handed_back=false;
        Ok(())
    }

    /// The source was captured under the same gate lock as command enqueue. Only
    /// that operation/generation/profile may adopt Chrome-confirmed child tabs.
    pub fn adopt_children(&self,id: &str,generation: u64,client: &str,source: i64,tabs: &[i64]) -> Result<Operation,RpcError> {
        let mut g = self.inner.lock().unwrap(); Self::active(&g,id)?;
        let elsewhere: Vec<i64> = tabs.iter().copied().filter(|tab| g.held_elsewhere(Some(id), *tab).is_some()).collect();
        let op = g.op_mut(id).unwrap();
        if op.generation != generation || op.client_id != client || !op.owned_tabs.contains(&source) {
            return Err(RpcError::new(ErrorCode::OperationInvalid,Retry::Never,"New-tab source does not belong to this operation generation"));
        }
        let tabs: Vec<_> = tabs.iter().copied().filter(|tab| *tab > 0 && *tab != source && !op.closed_tabs.contains(tab) && !elsewhere.contains(tab)).collect();
        op.owned_tabs.extend(tabs.iter().copied());
        for tab in &tabs { if !op.tabs.contains(tab) { op.tabs.push(*tab); op.opened_tabs.push(*tab); } }
        // A concurrent explicit switch wins over an older click's new-tab result.
        let target=if op.current_tab==source {tabs.first().copied()} else {None};
        if let Some(tab)=target {Self::select_tab(op,tab);}
        Ok(op.clone())
    }

    fn select_tab(op: &mut Operation, tab: i64) {
        op.recent_tabs.retain(|visited| *visited != tab);
        op.recent_tabs.push(tab);
        // Selecting a tab is not looking at it: only observe_target lifts needs_observation.
        op.current_tab=tab;op.current_tab_closed=false;op.target_epoch+=1;
    }

    #[cfg(test)]
    pub(crate) fn switch_tab(&self, id: &str, tab: i64) -> Result<(), RpcError> {
        let mut g=self.inner.lock().unwrap();let op=Self::active(&g,id)?;
        if !op.tabs.contains(&tab) {return Err(RpcError::new(ErrorCode::TabNotFound,Retry::Never,"Tab has not been verified for this operation"));}
        Self::select_tab(g.op_mut(id).unwrap(),tab);Ok(())
    }

    /// Only call after this operation's browser has returned the exact tab.
    pub fn visit_verified_tab(&self, id: &str, tab: i64) -> Result<(), RpcError> {
        let mut g=self.inner.lock().unwrap();Self::active(&g,id)?;
        if let Some(other) = g.held_elsewhere(Some(id), tab) { return Err(Self::tab_taken(other)); }
        let op=g.op_mut(id).unwrap();
        if op.closed_tabs.contains(&tab) {return Err(RpcError::new(ErrorCode::TabClosed,Retry::Never,"The selected tab closed during verification"));}
        op.owned_tabs.insert(tab);
        if !op.tabs.contains(&tab) {op.tabs.push(tab);}
        Self::select_tab(op,tab);Ok(())
    }

    fn remove_current_tab(op: &mut Operation, tab: i64) {
        op.closed_tabs.insert(tab);op.owned_tabs.remove(&tab);
        op.recent_tabs.retain(|visited| *visited != tab);
        op.tabs.retain(|t| *t != tab);op.opened_tabs.retain(|t| *t != tab);
        if op.current_tab==tab {
            if let Some(previous)=op.recent_tabs.iter().rev().find(|id|op.tabs.contains(id)).copied() {
                op.current_tab=previous;op.current_tab_closed=false;
                op.target_epoch+=1;op.needs_observation=true;op.handed_back=false;
            } else {op.current_tab_closed=true;}
        }
    }

    pub fn observe_target(&self, origin: &Operation) {
        let mut g=self.inner.lock().unwrap();
        if let Some(op)=g.op_mut(&origin.id).filter(|op|op.target_epoch==origin.target_epoch && op.current_tab==origin.current_tab && !op.current_tab_closed) {op.needs_observation=false;op.handed_back=false;}
    }

    #[cfg(test)]
    pub(crate) fn remove_tab(&self, tab: i64) {
        let mut g=self.inner.lock().unwrap();
        for op in &mut g.ops {Self::remove_current_tab(op,tab);}
    }

    pub fn remove_tab_for_operation(&self, id: &str, tab: i64) {
        let mut g=self.inner.lock().unwrap();
        if let Some(op)=g.op_mut(id) {Self::remove_current_tab(op,tab);}
    }

    /// The browser no longer has a tab this operation asked for. Only a tab the operation held is
    /// recorded as closed: an id it never held may be a guess that Chrome assigns later.
    pub fn forget_missing_tab(&self, id: &str, tab: i64) {
        let mut g=self.inner.lock().unwrap();
        if let Some(op)=g.op_mut(id).filter(|op|op.tabs.contains(&tab)) {Self::remove_current_tab(op,tab);}
    }

    /// A close event from another browser must not change this request's target.
    pub fn remove_tab_for_client(&self, client_id: &str, tab: i64) {
        let mut g=self.inner.lock().unwrap();
        for op in g.ops.iter_mut().filter(|op|op.client_id==client_id) {Self::remove_current_tab(op,tab);}
    }

    fn finish(g: &mut GateInner, id: &str, state: OpState) -> Option<Operation> {
        let index = g.ops.iter().position(|op| op.id == id)?;
        let mut op = g.ops.remove(index);
        op.state = state;
        g.finished.push((op.id.clone(), state));
        if g.finished.len() > 50 { g.finished.remove(0); }
        Some(op)
    }

    pub fn release(&self, id: &str) -> Result<(), RpcError> {
        let mut g = self.inner.lock().unwrap();
        Self::active(&g, id)?;
        Self::finish(&mut g, id, OpState::Released);
        drop(g); self.resumed.notify_waiters();
        Ok(())
    }

    /// The user takes the browser over; only the operation's own browser may do so.
    pub fn pause(&self, id: &str, client: &str) -> Result<Operation, RpcError> {
        let mut g = self.inner.lock().unwrap();
        Self::active(&g, id)?;
        let op = g.op_mut(id).filter(|op| op.client_id == client)
            .ok_or_else(|| RpcError::new(ErrorCode::OperationInvalid, Retry::Never, "Only the browser running this operation can take it over."))?;
        op.paused = true;
        Ok(op.clone())
    }

    /// Hands the browser back. The user may have changed the page, so the next write needs a fresh snapshot.
    pub fn resume(&self, id: &str, client: &str) -> Result<Operation, RpcError> {
        let mut g = self.inner.lock().unwrap();
        Self::active(&g, id)?;
        let op = g.op_mut(id).filter(|op| op.client_id == client && op.paused)
            .ok_or_else(|| RpcError::new(ErrorCode::OperationInvalid, Retry::Never, "This operation is not held by this browser."))?;
        op.paused = false; op.target_epoch += 1; op.needs_observation = true; op.handed_back = true;
        let op = op.clone();
        drop(g); self.resumed.notify_waiters();
        Ok(op)
    }

    /// Waits while the user holds the operation; returns at once when it is not held.
    pub async fn wait_until_resumed(&self, id: &str, limit: std::time::Duration) -> Result<(), RpcError> {
        let deadline = tokio::time::Instant::now() + limit;
        let mut waited = false;
        loop {
            let notified = self.resumed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.check_active(id)?.paused {
                // A call that waited does not run: the page may have changed, and the remaining
                // MCP reply window may not fit the command and its follow-up reads.
                if waited { return Err(RpcError::new(ErrorCode::StaleElement, Retry::Safe,
                    "The user handed the browser back. Nothing ran; take browser_snapshot to see the current page, then continue.")); }
                return Ok(());
            }
            waited = true;
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(RpcError::new(ErrorCode::BrowserBusy, Retry::Safe,
                    "The user has taken over this tab. Wait, then try again; take a fresh snapshot before acting.")
                    .with_details(json!({"handoff": true})));
            }
        }
    }

    /// Closes the gate first: any later call for this operation gets CANCELLED.
    pub fn abort(&self, id: Option<&str>) -> Option<AbortedOperation> {
        self.abort_inner(id,false).into_iter().next()
    }

    /// The user's Stop: one operation, or with no id every operation and open panel request.
    pub fn abort_user(&self, id: Option<&str>) -> Vec<AbortedOperation> {
        self.abort_inner(id,true)
    }

    fn abort_inner(&self,id:Option<&str>,user:bool)->Vec<AbortedOperation> {
        let mut g = self.inner.lock().unwrap();
        // Without an id, the user's Stop ends everything; any other caller ends only the oldest.
        let targets: Vec<String> = g.ops.iter().filter(|o| id.is_none_or(|i| i == o.id)).take(if user || id.is_some() { usize::MAX } else { 1 }).map(|o| o.id.clone()).collect();
        if user {
            let requests: Vec<RequestTarget> = match id {
                None => std::mem::take(&mut g.requests),
                Some(_) => {
                    let owned: Vec<String> = targets.iter().filter_map(|t| g.op(t)?.request.clone()).collect();
                    let (stopped, kept) = std::mem::take(&mut g.requests).into_iter().partition(|r| owned.contains(&r.id));
                    g.requests = kept; stopped
                }
            };
            for request in requests { Self::stop_client(&mut g,&request.client); }
        }
        if targets.is_empty() { return vec![]; }
        let mut aborted = vec![];
        for target in targets {
            g.generation += 1;
            let generation = g.generation;
            if let Some(op) = Self::finish(&mut g, &target, OpState::Aborted) { aborted.push(AbortedOperation { id: op.id, generation, client_id: op.client_id }); }
        }
        drop(g); self.resumed.notify_waiters();
        aborted
    }

    /// Every running operation, oldest first.
    pub fn all(&self) -> Vec<Operation> {
        self.inner.lock().unwrap().ops.clone()
    }

    /// The oldest running operation; the panel's status shows this one.
    pub fn current(&self) -> Option<Operation> {
        self.inner.lock().unwrap().ops.first().cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::ErrorCode;

    #[tokio::test]
    async fn paused_calls_wait_then_continue_after_resume() {
        let g=std::sync::Arc::new(OperationGate::default());
        let op=g.attach(12,"browser").unwrap();
        assert!(g.pause(&op.id,"browser").unwrap().paused);
        let waiting={let g=g.clone();let id=op.id.clone();tokio::spawn(async move{g.wait_until_resumed(&id,std::time::Duration::from_secs(5)).await})};
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!waiting.is_finished(),"a call waits while the user holds the browser");
        let resumed=g.resume(&op.id,"browser").unwrap();
        assert!(!resumed.paused && resumed.needs_observation);
        assert!(waiting.await.unwrap().is_err(),"the waiting call is told to look again, not run");
    }

    #[tokio::test]
    async fn paused_calls_time_out_with_a_handoff_message() {
        let g=OperationGate::default();let op=g.attach(12,"browser").unwrap();g.pause(&op.id,"browser").unwrap();
        let error=g.wait_until_resumed(&op.id,std::time::Duration::from_millis(50)).await.unwrap_err();
        assert_eq!((error.code,error.retry),(ErrorCode::BrowserBusy,Retry::Safe));
        assert_eq!(error.details["handoff"],true);
    }

    #[tokio::test]
    async fn abort_releases_calls_waiting_on_a_handoff() {
        let g=std::sync::Arc::new(OperationGate::default());let op=g.attach(12,"browser").unwrap();g.pause(&op.id,"browser").unwrap();
        let waiting={let g=g.clone();let id=op.id.clone();tokio::spawn(async move{g.wait_until_resumed(&id,std::time::Duration::from_secs(5)).await})};
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        g.abort(Some(&op.id));
        let error=tokio::time::timeout(std::time::Duration::from_secs(1),waiting).await.expect("abort wakes the waiter").unwrap().unwrap_err();
        assert_eq!(error.code,ErrorCode::Cancelled);
    }

    #[tokio::test]
    async fn a_call_that_waited_reports_the_hand_back_instead_of_running() {
        let g=std::sync::Arc::new(OperationGate::default());let op=g.attach(12,"browser").unwrap();g.pause(&op.id,"browser").unwrap();
        let waiting={let g=g.clone();let id=op.id.clone();tokio::spawn(async move{g.wait_until_resumed(&id,std::time::Duration::from_secs(5)).await})};
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        g.resume(&op.id,"browser").unwrap();
        let error=waiting.await.unwrap().unwrap_err();
        assert_eq!((error.code,error.retry),(ErrorCode::StaleElement,Retry::Safe));
        assert!(error.message.contains("handed the browser back"));
        assert!(g.wait_until_resumed(&op.id,std::time::Duration::from_millis(10)).await.is_ok(),"an unheld operation runs at once");
    }

    #[test]
    fn only_the_owner_pauses_or_resumes() {
        let g=OperationGate::default();let op=g.attach(12,"browser").unwrap();
        assert!(g.pause(&op.id,"other").is_err());
        assert!(g.resume(&op.id,"browser").is_err(),"resume needs a pause");
    }

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
    fn switching_tabs_does_not_stand_in_for_looking_at_the_page() {
        let gate=OperationGate::default();let op=gate.attach(1,"A").unwrap();
        gate.add_and_switch_tab(&op.id,2).unwrap();gate.remove_tab(2);
        assert!(gate.check(&op.id).unwrap().needs_observation);
        gate.switch_tab(&op.id,1).unwrap();
        assert!(gate.check(&op.id).unwrap().needs_observation,"re-selecting the restored tab is not an observation");
        gate.visit_verified_tab(&op.id,9).unwrap();
        let moved=gate.check(&op.id).unwrap();
        assert!(moved.needs_observation && moved.current_tab==9,"another existing tab has not been seen either");
        gate.observe_target(&moved);assert!(!gate.check(&op.id).unwrap().needs_observation);
        gate.pause(&op.id,"A").unwrap();gate.resume(&op.id,"A").unwrap();
        gate.switch_tab(&op.id,1).unwrap();
        let back=gate.check(&op.id).unwrap();
        assert!(back.needs_observation && back.handed_back,"a switch after a hand-back keeps the hand-back reason");
        gate.add_and_switch_tab(&op.id,3).unwrap();
        let fresh=gate.check(&op.id).unwrap();
        assert!(!fresh.needs_observation && !fresh.handed_back,"a tab this operation just created holds nothing unseen");
    }

    #[test]
    fn a_missing_tab_the_operation_never_held_is_not_remembered_as_closed() {
        let gate=OperationGate::default();let op=gate.attach(1,"A").unwrap();
        gate.forget_missing_tab(&op.id,99);
        assert!(gate.visit_verified_tab(&op.id,99).is_ok(),"a mistyped id that Chrome later assigns must stay selectable");
        gate.add_tab(&op.id,2).unwrap();gate.forget_missing_tab(&op.id,2);
        assert_eq!(gate.check(&op.id).unwrap().tabs,vec![1,99]);
        assert_eq!(gate.visit_verified_tab(&op.id,2).unwrap_err().code,ErrorCode::TabClosed,"a held tab that is gone stays closed");
        gate.forget_missing_tab("op-other",99);assert_eq!(gate.check(&op.id).unwrap().current_tab,99);
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

#[cfg(test)]
mod input_owner_tests {
    use super::*;
    #[test]
    fn an_operation_cannot_transfer_its_input_connection() {
        let gate=OperationGate::default();let op=gate.attach(1,"browser").unwrap();
        gate.pin_input_connection(&op.id,"mcp-a");
        assert!(gate.input_connection_matches(&op.id,Some("mcp-a")));
        assert!(!gate.input_connection_matches(&op.id,Some("mcp-b")));
        gate.pin_input_connection(&op.id,"mcp-b");
        assert!(!gate.input_connection_matches(&op.id,Some("mcp-b")));
        assert!(!gate.input_connection_matches(&op.id,None));
    }
}

#[cfg(test)]
mod concurrent_tests {
    use super::*;

    fn two() -> OperationGate { OperationGate::with_limit(2) }

    #[test]
    fn each_request_gets_its_own_operation_and_tab() {
        let g=two();
        g.begin_request_with("a","browser",Some(1),None,true).unwrap(); g.begin_request_with("b","browser",Some(2),None,true).unwrap();
        let (a,b)=(g.attach_request(1,"browser",Some("a")).unwrap(),g.attach_request(2,"browser",Some("b")).unwrap());
        assert_ne!(a.id,b.id);
        assert_eq!(g.panel_request_of(&a.id).as_deref(),Some("a"));
        assert_eq!(g.panel_request_of(&b.id).as_deref(),Some("b"));
        assert_eq!(g.request_target(Some("b"),"browser",None).unwrap(),Some(2),"each request keeps its own captured tab");
        assert_eq!(g.attach_request(1,"browser",Some("a")).unwrap_err().details["operationId"],a.id.as_str());
    }

    #[test]
    fn a_third_request_waits_for_a_free_slot() {
        let g=two();
        g.begin_request_with("a","browser",None,None,true).unwrap(); g.begin_request_with("b","browser",None,None,true).unwrap();
        assert_eq!(g.begin_request_with("c","browser",None,None,true).unwrap_err().code,ErrorCode::BrowserBusy);
        g.end_request("a","browser").unwrap();
        g.begin_request_with("c","browser",None,None,true).unwrap();
    }

    #[test]
    fn ending_or_stopping_one_request_leaves_the_other_running() {
        let g=two();
        g.begin_request_with("a","browser",Some(1),None,true).unwrap(); g.begin_request_with("b","browser",Some(2),None,true).unwrap();
        let (a,b)=(g.attach_request(1,"browser",Some("a")).unwrap(),g.attach_request(2,"browser",Some("b")).unwrap());
        assert_eq!(g.end_request("a","browser").unwrap().unwrap().id,a.id);
        assert!(g.check(&b.id).is_ok());
        assert_eq!(g.abort_user(Some(&b.id)).len(),1);
        assert_eq!(g.check(&b.id).unwrap_err().code,ErrorCode::Cancelled);
        assert_eq!(g.check(&a.id).unwrap_err().code,ErrorCode::OperationInvalid);
    }

    #[test]
    fn stopping_one_operation_keeps_the_other_request_open() {
        let g=two();
        g.begin_request_with("a","browser",Some(1),None,true).unwrap(); g.begin_request_with("b","browser",Some(2),None,true).unwrap();
        let a=g.attach_request(1,"browser",Some("a")).unwrap();
        g.abort_user(Some(&a.id));
        assert_eq!(g.attach_request(1,"browser",Some("a")).unwrap_err().code,ErrorCode::OperationInvalid,"the stopped request has ended");
        assert!(g.attach_request(2,"browser",Some("b")).is_ok(),"the other request still runs");
    }

    #[test]
    fn stop_without_an_id_ends_every_operation_and_request() {
        let g=two();
        g.begin_request_with("a","browser",Some(1),None,true).unwrap(); g.begin_request_with("b","browser",Some(2),None,true).unwrap();
        g.attach_request(1,"browser",Some("a")).unwrap(); g.attach_request(2,"browser",Some("b")).unwrap();
        assert_eq!(g.abort_user(None).len(),2);
        assert!(g.current().is_none());
        g.begin_request_with("c","browser",None,None,true).unwrap();
    }

    #[test]
    fn a_closed_tab_leaves_only_the_operation_that_held_it() {
        let g=two();
        g.begin_request_with("a","browser",None,None,true).unwrap(); g.begin_request_with("b","browser",None,None,true).unwrap();
        let (a,b)=(g.attach_request(1,"browser",Some("a")).unwrap(),g.attach_request(2,"browser",Some("b")).unwrap());
        g.remove_tab_for_client("browser",1);
        assert_eq!(g.check(&a.id).unwrap_err().code,ErrorCode::TabClosed);
        assert_eq!(g.check(&b.id).unwrap().current_tab,2);
        assert!(g.adopt_children(&b.id,b.generation,"browser",1,&[9]).is_err(),"a tab the other operation held is not a source");
    }

    #[test]
    fn an_operation_outside_the_panel_runs_alone() {
        let g=two();
        let cli=g.attach(1,"browser").unwrap();
        assert_eq!(g.begin_request_with("a","browser",None,None,true).unwrap_err().code,ErrorCode::BrowserBusy);
        assert_eq!(g.attach(2,"browser").unwrap_err().details["operationId"],cli.id.as_str());
        g.release(&cli.id).unwrap();
        g.begin_request_with("a","browser",None,None,true).unwrap(); g.attach_request(1,"browser",Some("a")).unwrap();
        assert_eq!(g.attach(2,"browser").unwrap_err().code,ErrorCode::OperationInvalid,"an id-less call during a panel request must name its request");
    }

    #[test]
    fn a_tab_belongs_to_one_operation() {
        let g=two();
        g.begin_request_with("a","browser",None,None,true).unwrap(); g.begin_request_with("b","browser",None,None,true).unwrap();
        let a=g.attach_request(1,"browser",Some("a")).unwrap();
        assert_eq!(g.attach_request(1,"browser",Some("b")).unwrap_err().details["operationId"],a.id.as_str());
        let b=g.reserve_new("browser",Some("b")).unwrap();
        assert_eq!(g.visit_verified_tab(&b.id,1).unwrap_err().code,ErrorCode::BrowserBusy);
        assert_eq!(g.add_and_switch_tab(&b.id,1).unwrap_err().code,ErrorCode::BrowserBusy);
        g.add_and_switch_tab(&b.id,2).unwrap();
        let adopted=g.adopt_children(&a.id,a.generation,"browser",1,&[2,3]).unwrap();
        assert_eq!(adopted.tabs,vec![1,3],"a child tab another operation holds is not adopted");
        g.release(&b.id).unwrap();
        g.visit_verified_tab(&a.id,2).unwrap();
    }

    #[test]
    fn id_less_calls_bind_only_while_one_request_is_open() {
        let g=two();
        let scope=|s:&str|Some(RequestScope{profile:"p".into(),session:s.into(),directory:"/w".into()});
        g.begin_request_with("a","browser",None,scope("ses_a"),true).unwrap();
        assert_eq!(g.bound_request().unwrap().id,"a");
        g.begin_request_with("b","browser",None,scope("ses_b"),true).unwrap();
        assert!(g.bound_request().is_none());
        g.end_request("a","browser").unwrap();
        assert!(g.bound_request().is_none(),"b ran beside a: its id-less calls stay unbound until it ends");
    }

    #[test]
    fn an_internal_abort_without_an_id_ends_only_one_operation() {
        let g=two();
        g.begin_request_with("a","browser",None,None,true).unwrap(); g.begin_request_with("b","browser",None,None,true).unwrap();
        let a=g.attach_request(1,"browser",Some("a")).unwrap(); let b=g.attach_request(2,"browser",Some("b")).unwrap();
        assert_eq!(g.abort(None).unwrap().id,a.id);
        assert!(g.check(&b.id).is_ok());
    }

    #[test]
    fn the_default_gate_explains_a_wrong_request_id_as_before() {
        let g=OperationGate::default();
        g.begin_request("a","browser",None).unwrap();
        let error=g.attach_request(1,"browser",Some("old")).unwrap_err();
        assert!(error.message.contains("A panel request owns the browser"),"{}",error.message);
    }

    #[test]
    fn requests_run_side_by_side_only_when_each_allows_it() {
        let g=two();
        g.begin_request_with("a","browser",None,None,true).unwrap();
        assert_eq!(g.begin_request_with("b","browser",None,None,false).unwrap_err().code,ErrorCode::BrowserBusy,"a request that runs alone waits");
        g.begin_request_with("b","browser",None,None,true).unwrap();
        assert_eq!(g.begin_request_with("c","browser",None,None,true).unwrap_err().code,ErrorCode::BrowserBusy,"the limit holds");
        let g=two();
        g.begin_request_with("a","browser",None,None,false).unwrap();
        assert_eq!(g.begin_request_with("b","browser",None,None,true).unwrap_err().code,ErrorCode::BrowserBusy,"an older request that runs alone keeps the browser");
    }

    #[test]
    fn a_request_that_ran_beside_another_needs_its_id_or_its_session() {
        let g=two();
        let scope=|s:&str|Some(RequestScope{profile:"p".into(),session:s.into(),directory:"/w".into()});
        g.begin_request_with("a","browser",None,scope("ses_a"),true).unwrap();
        g.begin_request_with("b","browser",None,scope("ses_b"),true).unwrap();
        assert_eq!(g.bound_request_for(Some("ses_b")).unwrap().id,"b");
        g.end_request("b","browser").unwrap();
        assert!(g.bound_request().is_none(),"a overlapped b, so an id-less call is not bound to it by elimination");
        assert_eq!(g.bound_request_for(Some("ses_a")).unwrap().id,"a");
        assert!(g.bound_request_for(Some("ses_other")).is_none());
    }

    #[test]
    fn the_default_gate_still_runs_one_request() {
        let g=OperationGate::default();
        g.begin_request("a","browser",None).unwrap();
        assert_eq!(g.begin_request("b","browser",None).unwrap_err().code,ErrorCode::BrowserBusy);
    }
}
