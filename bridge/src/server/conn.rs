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
}

impl ServerState {
    pub fn new(home: std::path::PathBuf, cfg: Config) -> Self {
        Self { home, cfg: tokio::sync::Mutex::new(cfg) }
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
    if !authenticate(&mut ws, role, extension_id, &connection_id, &state).await {
        return;
    }
    tracing::debug!(role = role.name(), %connection_id, "connection authenticated");
    serve_requests(&mut ws, role).await;
}

/// Runs the `auth.hello` handshake. On any failure it answers, closes the socket and returns false.
async fn authenticate(
    ws: &mut Ws,
    role: Role,
    extension_id: Option<String>,
    connection_id: &str,
    state: &ServerState,
) -> bool {
    let first = match tokio::time::timeout(HELLO_TIMEOUT, ws.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => t,
        _ => {
            send_err_and_close(ws, "", ErrorCode::AuthRequired, "auth.hello must be the first message").await;
            return false;
        }
    };
    let (id, params) = match parse_envelope(&first) {
        Ok(Envelope::Req { id, method, params, .. }) if method == "auth.hello" => (id, params),
        Ok(other) => {
            let id = other.id().unwrap_or_default().to_string();
            send_err_and_close(ws, &id, ErrorCode::AuthRequired, "auth.hello must be the first message").await;
            return false;
        }
        Err(e) => {
            let _ = send(ws, &Envelope::err(raw_id(&first), e)).await;
            let _ = ws.close(None).await;
            return false;
        }
    };
    let hello: Hello = match serde_json::from_value(params) {
        Ok(h) => h,
        Err(e) => {
            send_err_and_close(ws, &id, ErrorCode::InvalidParams, &format!("invalid auth.hello params: {e}")).await;
            return false;
        }
    };
    let expected_token = state.cfg.lock().await.token.clone();
    if hello.role != role.name() || !config::tokens_equal(&hello.token, &expected_token) {
        send_err_and_close(ws, &id, ErrorCode::AuthFailed, "authentication failed").await;
        return false;
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
            return false;
        }
        if cfg.paired_extension_id.as_deref() != Some(ext_id.as_str()) {
            let mut updated = cfg.clone();
            updated.paired_extension_id = Some(ext_id);
            if let Err(e) = config::save(&state.home, &updated) {
                drop(cfg);
                tracing::error!("cannot save pairing: {e:#}");
                send_err_and_close(ws, &id, ErrorCode::Internal, "cannot save pairing").await;
                return false;
            }
            *cfg = updated;
        }
    }
    let result = json!({
        "serverName": "agent-browser",
        "serverVersion": env!("CARGO_PKG_VERSION"),
        "protocolVersion": PROTOCOL_VERSION,
        "connectionId": connection_id,
        "selected": false,
        "clientId": hello.client_id,
    });
    send(ws, &Envelope::ok(id, result)).await
}

async fn serve_requests(ws: &mut Ws, role: Role) {
    while let Some(frame) = ws.next().await {
        let text = match frame {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        let env = match parse_envelope(&text) {
            Ok(env) => env,
            Err(e) => {
                let fatal = e.code == ErrorCode::ProtocolVersionUnsupported;
                let _ = send(ws, &Envelope::err(raw_id(&text), e)).await;
                if fatal {
                    let _ = ws.close(None).await;
                    break;
                }
                continue;
            }
        };
        let Envelope::Req { id, method, .. } = env else { continue };
        let reply = if !role.allows(&method) {
            Envelope::err(
                id,
                RpcError::new(ErrorCode::ForbiddenMethod, Retry::Never, format!("{method} is not allowed for this connection")),
            )
        } else if role == Role::Extension && method == "heartbeat" {
            Envelope::ok(id, json!({ "at": now_ms() }))
        } else {
            Envelope::err(id, RpcError::new(ErrorCode::Internal, Retry::Never, "not available yet"))
        };
        if !send(ws, &reply).await {
            break;
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
