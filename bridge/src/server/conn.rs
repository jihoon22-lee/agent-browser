use super::{operation::OperationGate, registry::Registry, timeline::Timeline};
use crate::config::{self, Config};
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
            Role::Extension => matches!(method, "heartbeat" | "status.get" | "operation.abort" | "browser.use"),
            Role::Mcp => method == "tool.call",
        }
    }
}

pub struct ServerState {
    pub home: std::path::PathBuf,
    pub cfg: tokio::sync::Mutex<Config>,
    pub registry: Registry,
    pub ops: OperationGate,
    pub timeline: Timeline,
}

impl ServerState {
    pub fn new(home: std::path::PathBuf, cfg: Config) -> Self {
        let registry = Registry::new(cfg.selected_client_id.clone());
        Self {
            home,
            cfg: tokio::sync::Mutex::new(cfg),
            registry,
            ops: OperationGate::default(),
            timeline: Timeline::default(),
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
    token: String,
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
                serve_extension(&mut ws, rx, &state).await;
            }
            state.registry.unregister(conn);
            state.broadcast_status();
        }
        Role::Mcp => {
            if send_hello_ok(&mut ws, hello_id, &connection_id, false, &hello.client_id).await {
                serve_mcp(&mut ws).await;
            }
        }
    }
}

/// Runs the `auth.hello` handshake. On any failure it answers, closes the socket and returns false.
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
    let hello: Hello = match serde_json::from_value(params) {
        Ok(h) => h,
        Err(e) => {
            send_err_and_close(ws, &id, ErrorCode::InvalidParams, &format!("invalid auth.hello params: {e}")).await;
            return None;
        }
    };
    let expected_token = state.cfg.lock().await.token.clone();
    if hello.role != role.name() || !config::tokens_equal(&hello.token, &expected_token) {
        // serverName lets `serve` startup recognize a running instance without ever sending it the token.
        let error = RpcError::new(ErrorCode::AuthFailed, Retry::Never, "authentication failed")
            .with_details(json!({ "serverName": SERVER_NAME }));
        let _ = send(ws, &Envelope::err(&id, error)).await;
        let _ = ws.close(None).await;
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

async fn serve_mcp(ws: &mut Ws) {
    while let Some(frame) = ws.next().await {
        let text = match frame {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        let env = match parse_or_reject(ws, &text).await {
            Ok(env) => env,
            Err(true) => break,
            Err(false) => continue,
        };
        let Envelope::Req { id, method, .. } = env else { continue };
        let reply = if Role::Mcp.allows(&method) { not_available(id) } else { forbidden(id, &method) };
        if !send(ws, &reply).await {
            break;
        }
    }
}

async fn serve_extension(ws: &mut Ws, mut outbound: tokio::sync::mpsc::UnboundedReceiver<String>, state: &ServerState) {
    loop {
        tokio::select! {
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
                    Envelope::Res { .. } => state.registry.handle_response(env),
                    Envelope::Req { id, method, params, .. } => {
                        let reply = if Role::Extension.allows(&method) {
                            extension_request(state, id, &method, &params).await
                        } else {
                            forbidden(id, &method)
                        };
                        if !send(ws, &reply).await { break; }
                    }
                    Envelope::Evt { .. } => {}
                }
            }
        }
    }
}

async fn extension_request(state: &ServerState, id: String, method: &str, params: &Value) -> Envelope {
    match method {
        "heartbeat" => Envelope::ok(id, json!({ "at": now_ms() })),
        "status.get" => Envelope::ok(id, state.status()),
        "operation.abort" => {
            let operation_id = params.get("operationId").and_then(Value::as_str);
            match state.ops.abort(operation_id) {
                Some((op_id, generation)) => {
                    // The gate is already closed; tell the selected browser to stop whatever it is running.
                    state.registry.notify_selected("browser.cancel", json!({ "operationId": op_id, "generation": generation }));
                    state.broadcast_status();
                    Envelope::ok(id, json!({ "aborted": true, "operationId": op_id }))
                }
                None => Envelope::ok(id, json!({ "aborted": false, "operationId": Value::Null })),
            }
        }
        "browser.use" => match params.get("clientId").and_then(Value::as_str).filter(|c| !c.is_empty()) {
            Some(client_id) => {
                state.registry.use_browser(client_id);
                state.persist_selection().await;
                state.broadcast_status();
                Envelope::ok(id, json!({ "selected": client_id }))
            }
            None => Envelope::err(id, RpcError::new(ErrorCode::InvalidParams, Retry::Never, "clientId is required")),
        },
        _ => not_available(id),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
