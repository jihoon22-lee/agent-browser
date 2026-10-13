use super::{now_ms, operation::OperationGate, registry::{ConnId, Registry}, router, timeline::Timeline};
use crate::config::{self, Config};
use crate::auth;
use crate::rpc::{parse_envelope, Envelope, ErrorCode, Retry, RpcError, PROTOCOL_VERSION};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http::StatusCode,
        Message,
    },
    WebSocketStream,
};

const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const EXTENSION_PATH: &str = "/extension";
const MCP_PATH: &str = "/mcp-proxy";
pub const SERVER_NAME: &str = "agent-browser";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Extension,
    Mcp,
}

impl Role {
    fn name(self) -> &'static str {
        match self {
            Role::Extension => "extension",
            Role::Mcp => "mcp",
        }
    }

    /// Methods a connection of this role may call on serve. Anything else is FORBIDDEN_METHOD.
    fn allows(self, method: &str) -> bool {
        match self {
            Role::Extension => matches!(method, "heartbeat" | "status.get" | "operation.abort" | "request.begin" | "request.end" | "browser.use" | "profile.list" | "profile.save" | "profile.delete" | "runtime.ensure" | "runtime.status" | "runtime.stop" | "doctor.run"),
            Role::Mcp => matches!(method, "tool.call" | "tool.cancel"),
        }
    }
}

pub struct ServerState {
    pub runtime: crate::runtime::Manager,
    pub home: std::path::PathBuf,
    pub cfg: tokio::sync::Mutex<Config>,
    pub registry: Registry,
    pub ops: OperationGate,
    pub timeline: Timeline,
    // Protect selection across attach's asynchronous tab lookup and gate registration.
    pub selection: tokio::sync::Mutex<()>,
}

impl ServerState {
    pub fn new(home: std::path::PathBuf, cfg: Config) -> Self {
        let port = cfg.port;
        Self::new_with_port(home,cfg,port)
    }
    pub fn new_with_port(home: std::path::PathBuf, cfg: Config, port: u16) -> Self {
        let registry = Registry::new(cfg.selected_client_id.clone());
        Self {
            runtime: crate::runtime::Manager::new(home.clone(),port),
            home,
            cfg: tokio::sync::Mutex::new(cfg),
            registry,
            ops: OperationGate::default(),
            timeline: Timeline::default(),
            selection: tokio::sync::Mutex::new(()),
        }
    }

    /// Payload shared by `status.get` and the `status.changed` event.
    pub fn status(&self) -> Value {
        json!({
            "operation": self.ops.current(),
            "browsers": self.registry.snapshot(),
            "timeline": self.timeline.entries(),
        })
    }

    pub fn broadcast_status(&self) {
        self.registry.broadcast(&Envelope::evt("status.changed", self.status()).to_text());
    }

    /// Writes the registry's current selection to config.json when it changed.
    async fn persist_selection(&self) {
        let selected = self.registry.selected_client();
        let mut cfg = self.cfg.lock().await;
        if cfg.selected_client_id == selected {
            return;
        }
        let mut updated = cfg.clone();
        updated.selected_client_id = selected;
        match config::save(&self.home, &updated) {
            Ok(()) => *cfg = updated,
            Err(e) => tracing::error!("cannot save selected browser: {e:#}"),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    role: String,
    auth_version: u64,
    client_nonce: String,
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    repair: bool,
}

type Ws = WebSocketStream<TcpStream>;

fn reject(status: StatusCode, reason: &str) -> ErrorResponse {
    let mut resp = ErrorResponse::new(Some(reason.to_string()));
    *resp.status_mut() = status;
    resp
}

/// `chrome-extension://<32 chars a-p>` → the 32-char extension id.
fn extension_id_from_origin(origin: &str) -> Option<String> {
    let id = origin.strip_prefix("chrome-extension://")?;
    (id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))).then(|| id.to_string())
}

fn raw_id(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

async fn send(ws: &mut Ws, env: &Envelope) -> bool {
    ws.send(Message::text(env.to_text())).await.is_ok()
}

async fn send_err_and_close(ws: &mut Ws, id: &str, code: ErrorCode, message: &str) {
    let _ = send(ws, &Envelope::err(id, RpcError::new(code, Retry::Never, message))).await;
    let _ = ws.close(None).await;
}

pub async fn handle(stream: TcpStream, state: Arc<ServerState>) {
    let slot: Arc<StdMutex<Option<(Role, Option<String>)>>> = Arc::new(StdMutex::new(None));
    let callback = {
        let slot = slot.clone();
        move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
            let accepted = match req.uri().path() {
                EXTENSION_PATH => match origin.and_then(extension_id_from_origin) {
                    Some(id) => (Role::Extension, Some(id)),
                    None => return Err(reject(StatusCode::FORBIDDEN, "extension origin required")),
                },
                MCP_PATH => {
                    if origin.is_some() {
                        return Err(reject(StatusCode::FORBIDDEN, "browser origins are not allowed"));
                    }
                    (Role::Mcp, None)
                }
                _ => return Err(reject(StatusCode::NOT_FOUND, "unknown path")),
            };
            *slot.lock().unwrap() = Some(accepted);
            Ok(resp)
        }
    };
    let mut ws = match accept_hdr_async(stream, callback).await {
        Ok(ws) => ws,
        Err(e) => {
            tracing::debug!("handshake refused: {e}");
            return;
        }
    };
    let Some((role, extension_id)) = slot.lock().unwrap().take() else { return };
    let connection_id = format!("conn-{}", uuid::Uuid::new_v4());
    let Some((hello_id, hello)) = authenticate(&mut ws, role, extension_id, &state).await else { return };
    tracing::debug!(role = role.name(), %connection_id, "connection authenticated");
    match role {
        Role::Extension => {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let conn = state.registry.register(&hello.client_id, tx);
            state.persist_selection().await;
            let selected = state.registry.selected_client().as_deref() == Some(hello.client_id.as_str());
            if send_hello_ok(&mut ws, hello_id, &connection_id, selected, &hello.client_id).await {
                state.broadcast_status();
                serve_extension(&mut ws, rx, &state, conn).await;
            }
            state.registry.unregister(conn);
            state.broadcast_status();
        }
        Role::Mcp => {
            if send_hello_ok(&mut ws, hello_id, &connection_id, false, &hello.client_id).await {
                serve_mcp(&mut ws, &state).await;
            }
        }
    }
}

/// Mutual HMAC handshake: server proof first, then client proof. Pair only after both.
async fn authenticate(
    ws: &mut Ws,
    role: Role,
    extension_id: Option<String>,
    state: &ServerState,
) -> Option<(String, Hello)> {
    let first = match tokio::time::timeout(HELLO_TIMEOUT, ws.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => t,
        _ => {
            send_err_and_close(ws, "", ErrorCode::AuthRequired, "auth.hello must be the first message").await;
            return None;
        }
    };
    let (id, params) = match parse_envelope(&first) {
        Ok(Envelope::Req { id, method, params, .. }) if method == "auth.hello" => (id, params),
        Ok(other) => {
            let id = other.id().unwrap_or_default().to_string();
            send_err_and_close(ws, &id, ErrorCode::AuthRequired, "auth.hello must be the first message").await;
            return None;
        }
        Err(e) => {
            let _ = send(ws, &Envelope::err(raw_id(&first), e)).await;
            let _ = ws.close(None).await;
            return None;
        }
    };
    if params.get("authVersion").and_then(Value::as_u64) != Some(auth::VERSION) || params.get("token").is_some() {
        let error = RpcError::new(ErrorCode::AuthFailed, Retry::Never,
            "Mutual authentication v1 is required. Update both the Bridge and extension, then reconnect.")
            .with_details(json!({ "serverName": SERVER_NAME, "authVersion": auth::VERSION }));
        let _ = send(ws, &Envelope::err(&id, error)).await;
        let _ = ws.close(None).await;
        return None;
    }
    let hello: Hello = match serde_json::from_value(params) {
        Ok(h) => h,
        Err(e) => {
            send_err_and_close(ws, &id, ErrorCode::InvalidParams, &format!("invalid auth.hello params: {e}")).await;
            return None;
        }
    };
    if hello.auth_version != auth::VERSION || hello.role != role.name()
        || !auth::valid_hex(&hello.client_nonce) || hello.client_id.is_empty() || hello.client_id.len() > 256
    {
        send_err_and_close(ws, &id, ErrorCode::AuthFailed, "Invalid authentication role, clientId or nonce").await;
        return None;
    }
    let expected_token = state.cfg.lock().await.token.clone();
    let server_nonce = auth::nonce();
    let server_proof = auth::proof(&expected_token, &auth::transcript(
        "server", &hello.role, &hello.client_id, &hello.client_nonce, &server_nonce, hello.repair));
    if !send(ws, &Envelope::ok(&id, json!({
        "authVersion": auth::VERSION, "serverName": SERVER_NAME,
        "serverNonce": server_nonce, "serverProof": server_proof
    }))).await { return None; }
    let text = match tokio::time::timeout(HELLO_TIMEOUT, ws.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => text,
        _ => {
            send_err_and_close(ws, "", ErrorCode::AuthRequired, "auth.prove must complete within five seconds").await;
            return None;
        }
    };
    let (id, params) = match parse_envelope(&text) {
        Ok(Envelope::Req { id, method, params, .. }) if method == "auth.prove" => (id, params),
        _ => {
            send_err_and_close(ws, &raw_id(&text), ErrorCode::AuthRequired, "auth.prove must follow auth.hello").await;
            return None;
        }
    };
    if params.get("authVersion").and_then(Value::as_u64) != Some(auth::VERSION)
        || !auth::verify(&expected_token, &auth::transcript(
            "client", &hello.role, &hello.client_id, &hello.client_nonce, &server_nonce, hello.repair),
            params.get("proof").and_then(Value::as_str).unwrap_or_default())
    {
        send_err_and_close(ws, &id, ErrorCode::AuthFailed, "Client authentication proof is invalid; check pairing credentials").await;
        return None;
    }
    if let Some(ext_id) = extension_id {
        let mut cfg = state.cfg.lock().await;
        let allowed = match cfg.paired_extension_id.as_deref() {
            None => true,
            Some(current) => current == ext_id || hello.repair,
        };
        if !allowed {
            drop(cfg);
            send_err_and_close(
                ws,
                &id,
                ErrorCode::NotPaired,
                "This bridge is paired with another extension ID. Re-pair from the extension options page.",
            )
            .await;
            return None;
        }
        if cfg.paired_extension_id.as_deref() != Some(ext_id.as_str()) {
            let mut updated = cfg.clone();
            updated.paired_extension_id = Some(ext_id);
            if let Err(e) = config::save(&state.home, &updated) {
                drop(cfg);
                tracing::error!("cannot save pairing: {e:#}");
                send_err_and_close(ws, &id, ErrorCode::Internal, "cannot save pairing").await;
                return None;
            }
            *cfg = updated;
        }
    }
    if role == Role::Extension && hello.client_id.is_empty() {
        send_err_and_close(ws, &id, ErrorCode::InvalidParams, "clientId is required for extensions").await;
        return None;
    }
    Some((id, hello))
}

async fn send_hello_ok(ws: &mut Ws, id: String, connection_id: &str, selected: bool, client_id: &str) -> bool {
    let result = json!({
        "serverName": SERVER_NAME,
        "authVersion": auth::VERSION,
        "serverVersion": env!("CARGO_PKG_VERSION"),
        "protocolVersion": PROTOCOL_VERSION,
        "connectionId": connection_id,
        "selected": selected,
        "clientId": client_id,
    });
    send(ws, &Envelope::ok(id, result)).await
}

/// Parses one inbound text frame. `Err(true)` means the connection must be closed.
async fn parse_or_reject(ws: &mut Ws, text: &str) -> Result<Envelope, bool> {
    match parse_envelope(text) {
        Ok(env) => Ok(env),
        Err(e) => {
            let fatal = e.code == ErrorCode::ProtocolVersionUnsupported;
            let _ = send(ws, &Envelope::err(raw_id(text), e)).await;
            if fatal {
                let _ = ws.close(None).await;
            }
            Err(fatal)
        }
    }
}

fn forbidden(id: String, method: &str) -> Envelope {
    Envelope::err(id, RpcError::new(ErrorCode::ForbiddenMethod, Retry::Never, format!("{method} is not allowed for this connection")))
}

fn not_available(id: String) -> Envelope {
    Envelope::err(id, RpcError::new(ErrorCode::Internal, Retry::Never, "not available yet"))
}

async fn serve_mcp(ws: &mut Ws, state: &ServerState) {
    use futures_util::{future::{AbortHandle, Abortable}, stream::FuturesUnordered};
    let mut pending = FuturesUnordered::new();
    let mut running = std::collections::HashMap::<String, AbortHandle>::new();
    // A cancellation may cross an attach reply in flight. Only this connection's
    // successful attach ID can release that newly created operation, never another one.
    let mut attached: Option<(String, String)> = None;
    loop {
        tokio::select! {
            biased;
            frame = ws.next() => {
                let text = match frame {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => continue,
                };
                let env = match parse_or_reject(ws, &text).await {
                    Ok(env) => env, Err(true) => break, Err(false) => continue,
                };
                let Envelope::Req { id, method, params, .. } = env else { continue };
                if method == "tool.cancel" {
                    if let Some(request) = params["requestId"].as_str() {
                        if let Some(handle) = running.get(request) { handle.abort(); }
                        if attached.as_ref().is_some_and(|(id, _)| id == request) {
                            let (_, op) = attached.take().unwrap();
                            state.ops.abort(Some(&op)); state.broadcast_status();
                        }
                    }
                    if !send(ws, &Envelope::ok(id, json!({"cancelled":true}))).await { break; }
                    continue;
                }
                if !Role::Mcp.allows(&method) {
                    if !send(ws, &forbidden(id, &method)).await { break; }
                    continue;
                }
                if running.len() >= 32 || running.contains_key(&id) {
                    if !send(ws, &Envelope::err(id, RpcError::new(ErrorCode::BrowserBusy, Retry::Never, "Too many or duplicate pending requests"))).await { break; }
                    continue;
                }
                let name = params["name"].as_str().unwrap_or_default().to_string();
                let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
                let attach = name == "browser_tabs" && (arguments["action"] == "attach" || (arguments["action"] == "new" && arguments.get("operationId").is_none()));
                let (abort, registration) = AbortHandle::new_pair();
                running.insert(id.clone(), abort);
                pending.push(async move {
                    let result = Abortable::new(router::call_tool(state, &name, arguments), registration).await;
                    (id, attach, result)
                });
            }
            Some((id, attach, result)) = pending.next(), if !pending.is_empty() => {
                running.remove(&id);
                let Ok(outcome) = result else { continue }; // Dropping the router sends request-scoped browser.cancel.
                let created = attach && outcome.ok;
                if created { attached = outcome.operation_id.clone().map(|op| (id.clone(), op)); }
                let reply = Envelope::ok(id, serde_json::to_value(outcome).expect("tool outcome serializes"));
                if !send(ws, &reply).await {
                    if created && let Some((_, op)) = attached.take() { state.ops.abort(Some(&op)); state.broadcast_status(); }
                    break;
                }
            }
        }
    }
    // Dropping pending cancels only commands belonging to this socket.
}

async fn serve_extension(ws: &mut Ws, mut outbound: tokio::sync::mpsc::UnboundedReceiver<String>, state: &Arc<ServerState>, conn: ConnId) {
    let (replies, mut pending) = tokio::sync::mpsc::unbounded_channel::<Envelope>();
    loop {
        tokio::select! {
            Some(reply) = pending.recv() => { if !send(ws,&reply).await { break; } }
            out = outbound.recv() => {
                let Some(text) = out else { break };
                if ws.send(Message::text(text)).await.is_err() { break; }
            }
            frame = ws.next() => {
                let text = match frame {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => continue,
                };
                let env = match parse_or_reject(ws, &text).await {
                    Ok(env) => env,
                    Err(true) => break,
                    Err(false) => continue,
                };
                match env {
                    Envelope::Res { .. } => state.registry.handle_response(conn, env),
                    Envelope::Req { id, method, params, .. } => {
                        if Role::Extension.allows(&method) && (method.starts_with("profile.") || method.starts_with("runtime.") || method == "doctor.run") {
                            let state = state.clone(); let replies = replies.clone();
                            tokio::spawn(async move { let reply = extension_request(&state,id,&method,&params).await; let _ = replies.send(reply); });
                            continue;
                        }
                        let reply = if Role::Extension.allows(&method) {
                            extension_request(state, id, &method, &params).await
                        } else {
                            forbidden(id, &method)
                        };
                        if !send(ws, &reply).await { break; }
                    }
                    Envelope::Evt { event, data, .. } => {
                        if event == "tab.closed" {
                            if let (Some(client), Some(tab_id)) = (
                                state.registry.selected_connection_client(conn),
                                data.get("tabId").and_then(Value::as_i64),
                            ) {
                                state.ops.remove_tab_for_client(&client, tab_id);
                                state.broadcast_status();
                            }
                        }
                    }
                }
            }
        }
    }
}

async fn extension_request(state: &ServerState, id: String, method: &str, params: &Value) -> Envelope {
    if method.starts_with("profile.") || method.starts_with("runtime.") || method == "doctor.run" {
        let result = management_request(state,method,params).await;
        return match result { Ok(value) => Envelope::ok(id,value), Err(error) => Envelope::err(id,error) };
    }
    match method {
        "heartbeat" => Envelope::ok(id, json!({ "at": now_ms() })),
        "status.get" => Envelope::ok(id, state.status()),
        "request.begin" | "request.end" => {
            // Selection validation and reservation must be atomic with browser.use.
            // Never wait on this socket: attach may need its tabs.get response.
            // End remains independent so Stop can invalidate an in-flight attach.
            let _selection = if method=="request.begin" {
                match state.selection.try_lock() {
                    Ok(lock)=>Some(lock),
                    Err(_)=>return Envelope::err(id,RpcError::new(ErrorCode::BrowserBusy,Retry::Never,"Browser selection or attach is in progress.")),
                }
            } else { None };
            let Some(request)=params["requestId"].as_str().filter(|s|!s.is_empty()&&s.len()<=128) else {
                return Envelope::err(id,RpcError::new(ErrorCode::InvalidParams,Retry::Never,"requestId is required"));
            };
            let Some(client)=params["clientId"].as_str().filter(|s|!s.is_empty() && (method=="request.end" || Some(*s)==state.registry.selected_client().as_deref())) else {
                return Envelope::err(id,RpcError::new(ErrorCode::BrowserBusy,Retry::Never,"This request's browser is not selected."));
            };
            let result=if method=="request.begin" {
                state.ops.begin_request(request,client,params["tabId"].as_i64().filter(|n|*n>0)).map(|_|None)
            } else if params["abort"] == true { state.ops.cancel_request(request,client) }
            else { state.ops.end_request(request,client) };
            match result {
                Ok(operation)=>{
                    if let Some(op)=operation {state.registry.notify_for(&op.client_id,"browser.cancel",json!({"operationId":op.id,"generation":op.generation}));}
                    state.broadcast_status();Envelope::ok(id,json!({"requestId":request}))
                },
                Err(error)=>Envelope::err(id,error),
            }
        },
        "operation.abort" => {
            let operation_id = params.get("operationId").and_then(Value::as_str);
            match state.ops.abort_user(operation_id) {
                Some(op) => {
                    // The closed operation's owner receives cancellation, never a later selection.
                    state.registry.notify_for(&op.client_id, "browser.cancel", json!({ "operationId": op.id, "generation": op.generation }));
                    state.broadcast_status();
                    Envelope::ok(id, json!({ "aborted": true, "operationId": op.id }))
                }
                None => Envelope::ok(id, json!({ "aborted": false, "operationId": Value::Null })),
            }
        }
        "browser.use" => match params.get("clientId").and_then(Value::as_str).filter(|c| !c.is_empty()) {
            Some(client_id) => {
                // Waiting here could block this socket from delivering attach's tabs.get response.
                let Ok(_selection) = state.selection.try_lock() else {
                    return Envelope::err(id, RpcError::new(ErrorCode::BrowserBusy, Retry::Never,
                        "A browser operation is being attached. Wait for it to finish before selecting a browser."));
                };
                if let Err(error) = state.ops.select_browser(client_id, || state.registry.use_browser(client_id)) {
                    return Envelope::err(id, error);
                }
                state.persist_selection().await;
                state.broadcast_status();
                Envelope::ok(id, json!({ "selected": client_id }))
            }
            None => Envelope::err(id, RpcError::new(ErrorCode::InvalidParams, Retry::Never, "clientId is required")),
        },
        _ => not_available(id),
    }
}

async fn management_request(state: &ServerState, method: &str, params: &Value) -> Result<Value,RpcError> {
    let profile_id = || params.get("profileId").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or_else(|| crate::runtime::profile::invalid("profileId is required"));
    match method {
        "profile.list" => state.runtime.list(),
        "profile.save" => {
            let profile = serde_json::from_value(params.get("profile").cloned().unwrap_or(Value::Null)).map_err(|_| crate::runtime::profile::invalid("Invalid profile object"))?;
            state.runtime.save(profile,params.get("makeDefault").and_then(Value::as_bool).unwrap_or(false))
        }
        "profile.delete" => state.runtime.delete(profile_id()?).await,
        "runtime.ensure" => {
            let extension = state.cfg.lock().await.paired_extension_id.clone().ok_or_else(|| crate::runtime::profile::invalid("Pair a Chrome extension before starting OpenCode"))?;
            state.runtime.ensure(profile_id()?,&format!("chrome-extension://{extension}")).await
        }
        "runtime.status" => if params["includeConnection"] == true { state.runtime.connection_status(profile_id()?).await } else { state.runtime.status(profile_id()?).await },
        "runtime.stop" => state.runtime.stop(profile_id()?).await,
        "doctor.run" => {
            let mut report = state.runtime.doctor(params.get("profileId").and_then(Value::as_str)).await?;
            let browsers = state.registry.snapshot();
            let selected = browsers.iter().any(|browser| browser.selected && browser.connected);
            if let Some(check) = report["checks"].as_array_mut().and_then(|checks| checks.iter_mut().find(|check| check["id"] == "extension")) {
                *check = json!({"id":"extension","status":if selected {"ok"} else {"warning"},"message":if selected {"Selected Chrome profile is authenticated and connected"} else {"Select an authenticated, connected Chrome profile"},"browsers":browsers});
            }
            Ok(report)
        }
        _ => Err(crate::runtime::profile::invalid("Unknown management method")),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_begin_cannot_cross_browser_selection_and_end_does_not_wait_for_attach() {
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), config::load_or_init(home.path()).unwrap());
        let (a, _rx) = tokio::sync::mpsc::unbounded_channel();
        state.registry.register("A", a);
        let params=json!({"requestId":"request-a","clientId":"A","tabId":42});
        let lock=state.selection.lock().await;
        let reply=extension_request(&state,"busy".into(),"request.begin",&params).await;
        assert!(matches!(reply,Envelope::Res{ok:false,..}),"{reply:?}");
        drop(lock);
        let reply=extension_request(&state,"begin".into(),"request.begin",&params).await;
        assert!(matches!(reply,Envelope::Res{ok:true,..}),"{reply:?}");
        let _lock=state.selection.lock().await;
        let reply=extension_request(&state,"stop".into(),"request.end",&params).await;
        assert!(matches!(reply,Envelope::Res{ok:true,..}),"{reply:?}");
        assert!(state.ops.request_target(Some("request-a"),"A",None).is_err());
    }

    #[tokio::test]
    async fn abort_notifies_the_operation_owner_after_selection_has_changed() {
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), config::load_or_init(home.path()).unwrap());
        let (a, mut from_a) = tokio::sync::mpsc::unbounded_channel();
        let (b, mut from_b) = tokio::sync::mpsc::unbounded_channel();
        state.registry.register("A", a);
        state.registry.register("B", b);
        let op = state.ops.attach(1, "A").unwrap();
        state.registry.use_browser("B");
        let reply = extension_request(&state, "stop".into(), "operation.abort", &json!({"operationId":op.id})).await;
        assert!(matches!(reply, Envelope::Res { ok: true, .. }));
        let cancel = parse_envelope(&from_a.recv().await.unwrap()).unwrap();
        assert!(matches!(cancel, Envelope::Req { ref method, ref params, .. } if method == "browser.cancel" && params["operationId"] == op.id));
        while let Ok(text) = from_b.try_recv() {
            assert!(matches!(parse_envelope(&text).unwrap(), Envelope::Evt { .. }), "B may receive status, but never A's cancellation");
        }
    }
}
