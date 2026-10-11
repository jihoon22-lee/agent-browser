//! The `mcp` side of the bridge: a lazily connected, auto-starting client of `serve`.
use super::tools;
use crate::config;
use crate::rpc::{parse_envelope, Envelope, ErrorCode, Retry, RpcError};
use crate::server::registry::CommandClass;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, time::Duration};
use tokio::net::TcpStream;
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const START_WAIT: Duration = Duration::from_secs(10);
const RETRY_EVERY: Duration = Duration::from_millis(200);
const START_COOLDOWN: Duration = Duration::from_secs(30);
/// Longest tool timeout serve applies (navigate, 30s) plus headroom for its own bookkeeping.
const REPLY_WAIT: Duration = Duration::from_secs(60);

/// Returns true when an agent-browser serve answers on `port`.
///
/// The probe never sends the pairing token: whatever program owns the port could be
/// something else entirely. It sends a hello with an empty token and recognizes serve by
/// the `serverName` it puts into the AUTH_FAILED details.
pub async fn probe(port: u16) -> bool {
    let Ok(Ok((mut ws, _))) = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/mcp-proxy")),
    ).await else { return false };
    let hello = crate::rpc::Envelope::req("auth.hello", serde_json::json!({"role":"mcp","token":"","clientId":"probe","clientVersion":env!("CARGO_PKG_VERSION")}));
    if ws.send(tokio_tungstenite::tungstenite::Message::text(hello.to_text())).await.is_err() { return false; }
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(2), ws.next()).await,
        Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t)))) if t.contains("\"serverName\":\"agent-browser\"")
    )
}

/// Starts `exe serve --port <port>` so that it keeps running after this process exits.
pub fn spawn_detached_serve(exe: &Path, port: u16) -> std::io::Result<()> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
        // WSL interop and some terminals run us inside a job object; try to leave it so
        // serve survives OpenCode exiting. Fall back when the job forbids breakaway.
        cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        cmd.creation_flags(base);
        return cmd.spawn().map(|_| ());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
        cmd.spawn().map(|_| ())
    }
}

pub struct ServeClient {
    port: u16,
    exe: PathBuf,
    token: String,
    conn: tokio::sync::Mutex<Option<Ws>>,
    last_error: std::sync::Mutex<Option<String>>,
    /// When the last full start attempt gave up; calls inside `START_COOLDOWN` only try to connect once.
    start_failed_at: std::sync::Mutex<Option<tokio::time::Instant>>,
}

impl ServeClient {
    /// Never fails because serve is unreachable: `tools/list` must work without it, and a failed
    /// start is reported by each tool call instead.
    pub async fn connect_or_start(home: &Path, port: u16, exe: &Path) -> anyhow::Result<ServeClient> {
        let cfg = config::load_or_init(home)?;
        let client = ServeClient {
            port,
            exe: exe.to_path_buf(),
            token: cfg.token,
            conn: tokio::sync::Mutex::new(None),
            last_error: std::sync::Mutex::new(None),
            start_failed_at: std::sync::Mutex::new(None),
        };
        {
            let mut conn = client.conn.lock().await;
            client.ensure_connected(&mut conn).await;
        }
        Ok(client)
    }

    async fn open(&self) -> Result<Ws, String> {
        let (mut ws, _) = tokio::time::timeout(
            Duration::from_secs(2),
            tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/mcp-proxy", self.port)),
        )
        .await
        .map_err(|_| "connection attempt timed out".to_string())?
        .map_err(|e| e.to_string())?;
        let hello = Envelope::req(
            "auth.hello",
            json!({"role":"mcp","token":self.token,"clientId":format!("mcp-{}", std::process::id()),"clientVersion":env!("CARGO_PKG_VERSION")}),
        );
        ws.send(Message::text(hello.to_text())).await.map_err(|e| e.to_string())?;
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => match parse_envelope(&t) {
                Ok(Envelope::Res { ok: true, .. }) => Ok(ws),
                Ok(Envelope::Res { error: Some(e), .. }) => Err(format!("{:?}: {}", e.code, e.message)),
                other => Err(format!("unexpected reply to auth.hello: {other:?}")),
            },
            _ => Err("no reply to auth.hello".to_string()),
        }
    }

    /// Connects, starting a detached serve when nothing answers, and retries for up to 10 seconds.
    async fn ensure_connected(&self, slot: &mut Option<Ws>) {
        if slot.is_some() {
            return;
        }
        let mut cause = match self.open().await {
            Ok(ws) => {
                *slot = Some(ws);
                return;
            }
            Err(e) => e,
        };
        let cooling_down = self.start_failed_at.lock().unwrap().is_some_and(|at| at.elapsed() < START_COOLDOWN);
        if cooling_down {
            *self.last_error.lock().unwrap() = Some(cause);
            return;
        }
        if let Err(e) = spawn_detached_serve(&self.exe, self.port) {
            *self.last_error.lock().unwrap() = Some(format!("cannot launch {}: {e}", self.exe.display()));
            return;
        }
        let deadline = tokio::time::Instant::now() + START_WAIT;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(RETRY_EVERY).await;
            match self.open().await {
                Ok(ws) => {
                    *slot = Some(ws);
                    *self.last_error.lock().unwrap() = None;
                    *self.start_failed_at.lock().unwrap() = None;
                    return;
                }
                Err(e) => cause = e,
            }
        }
        *self.start_failed_at.lock().unwrap() = Some(tokio::time::Instant::now());
        *self.last_error.lock().unwrap() = Some(cause);
    }

    fn failure(&self, name: &str, args: &Value, delivered: bool, executed: &str, error: RpcError) -> Value {
        json!({
            "ok": false,
            "tool": name,
            "operationId": args.get("operationId").cloned().unwrap_or(Value::Null),
            "delivered": delivered,
            "executed": executed,
            "verified": Value::Null,
            "data": Value::Null,
            "error": error,
        })
    }

    /// Returns the `ToolOutcome` JSON produced by serve, or one built locally when serve cannot be reached.
    pub async fn call_tool(&self, name: &str, args: Value) -> anyhow::Result<Value> {
        let class = tools::class_of(name, &args);
        let mut conn = self.conn.lock().await;
        let req = Envelope::req("tool.call", json!({ "name": name, "arguments": args }));
        let req_text = req.to_text();

        // Before sending, a dead connection is simply replaced: nothing can have been executed yet.
        let mut sent = false;
        for _ in 0..2 {
            self.ensure_connected(&mut conn).await;
            let Some(ws) = conn.as_mut() else { break };
            match ws.send(Message::text(req_text.clone())).await {
                Ok(()) => {
                    sent = true;
                    break;
                }
                Err(_) => *conn = None,
            }
        }
        if !sent {
            let cause = self.last_error.lock().unwrap().clone().unwrap_or_else(|| "connection lost".to_string());
            let error = RpcError::new(
                ErrorCode::BrowserDisconnected,
                Retry::Safe,
                format!("Bridge serve could not be started: {cause}"),
            );
            return Ok(self.failure(name, &args, false, "no", error));
        }

        let ws = conn.as_mut().expect("connection exists after a successful send");
        let reply = tokio::time::timeout(REPLY_WAIT, async {
            loop {
                match ws.next().await {
                    Some(Ok(Message::Text(t))) => match parse_envelope(&t) {
                        Ok(Envelope::Res { id, ok, result, error, .. }) if Some(id.as_str()) == req.id() => {
                            return Ok(if ok { result.unwrap_or(Value::Null) } else { json!({ "rpcError": error }) });
                        }
                        _ => continue,
                    },
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => return Err(e.to_string()),
                    None => return Err("connection closed".to_string()),
                }
            }
        })
        .await;
        let cause = match reply {
            Ok(Ok(outcome)) if outcome.get("rpcError").is_none() => return Ok(outcome),
            Ok(Ok(rpc_failure)) => {
                let message = rpc_failure["rpcError"]["message"].as_str().unwrap_or("serve rejected the request").to_string();
                return Ok(self.failure(name, &args, false, "no", RpcError::new(ErrorCode::Internal, Retry::Never, message)));
            }
            Ok(Err(cause)) => cause,
            Err(_) => "no reply from serve".to_string(),
        };
        *conn = None;
        // The request left this process; whether serve forwarded it is unknown.
        let (code, retry, executed, message) = match class {
            CommandClass::Write => (
                ErrorCode::ExecutionUnknown,
                Retry::Unsafe,
                "unknown",
                format!("Lost the connection to the bridge ({cause}); the action may or may not have happened. Take a snapshot to check before retrying."),
            ),
            CommandClass::Read => (
                ErrorCode::BrowserDisconnected,
                Retry::Safe,
                "no",
                format!("Lost the connection to the bridge ({cause})."),
            ),
        };
        Ok(self.failure(name, &args, true, executed, RpcError::new(code, retry, message)))
    }
}
