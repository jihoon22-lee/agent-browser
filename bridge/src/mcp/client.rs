//! The `mcp` side of the bridge: a lazily connected, auto-starting client of `serve`.
use super::tools;
use crate::{auth, config};
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
/// something else entirely. It only reads serverName from a challenge. This identifies
/// the service for diagnostics; it is not authentication and does not grant trust.
pub async fn probe(port: u16) -> bool {
    let Ok(Ok((mut ws, _))) = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/mcp-proxy")),
    ).await else { return false };
    let hello = crate::rpc::Envelope::req("auth.hello", serde_json::json!({"authVersion":auth::VERSION,"role":"mcp","clientNonce":auth::nonce(),"clientId":"probe","repair":false,"clientVersion":env!("CARGO_PKG_VERSION")}));
    if ws.send(tokio_tungstenite::tungstenite::Message::text(hello.to_text())).await.is_err() { return false; }
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(2), ws.next()).await,
        Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t)))) if t.contains("\"serverName\":\"agent-browser\"")
    )
}

/// Authenticate an existing Bridge for diagnostics, without starting a process.
pub async fn probe_authenticated(home: &Path, port: u16) -> bool {
    let Ok(cfg) = config::load_or_init(home) else { return false; };
    let client = ServeClient { port, exe: Path::new("").into(), token: cfg.token, conn: tokio::sync::Mutex::new(None), last_error: std::sync::Mutex::new(None), start_failed_at: std::sync::Mutex::new(None) };
    client.open().await.is_ok()
}

async fn auth_exchange(ws: &mut Ws, request: &Envelope) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(5), async {
        ws.send(Message::text(request.to_text())).await.map_err(|_| "authentication send failed".to_string())?;
        match ws.next().await {
            Some(Ok(Message::Text(text))) => match parse_envelope(&text) {
                Ok(Envelope::Res { id, ok: true, result: Some(result), .. }) if Some(id.as_str()) == request.id() => Ok(result),
                Ok(Envelope::Res { error: Some(error), .. }) => Err(format!("{:?}: {}", error.code, error.message)),
                _ => Err("invalid authentication response".to_string()),
            },
            _ => Err("connection closed during authentication".to_string()),
        }
    }).await.map_err(|_| "authentication timed out".to_string())?
}

/// Starts `exe serve --port <port>` so that it keeps running after this process exits.
pub fn spawn_detached_serve(exe: &Path, port: u16) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        spawn_windows_without_handles(exe, port)
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new(exe);
        cmd.arg("serve").arg("--port").arg(port.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0);
        cmd.spawn().map(|child| tracing::info!(serve_spawn = true, launch_method = "unix-process-group", pid = child.id(), "detached bridge started"))
    }
}

/// Stable std::process::Command inherits every inheritable Windows handle, including WSL
/// interop channels unrelated to stdio (rust-lang/rust#161158). A detached serve needs none:
/// it logs to its own file and communicates over WebSocket. Explicitly inherit zero handles
/// so closing MCP stdin also lets the WSL parent observe process exit while serve survives.
#[cfg(windows)]
fn spawn_windows_without_handles(exe: &Path, port: u16) -> std::io::Result<()> {
    use std::{io, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{
        CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
        CREATE_UNICODE_ENVIRONMENT, DETACHED_PROCESS,
    }};

    let mut application: Vec<u16> = exe.as_os_str().encode_wide().collect();
    if !exe.is_absolute() || application.iter().any(|unit| *unit == 0 || *unit == u16::from(b'"')) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "detached serve requires an absolute executable path without NUL or quotes"));
    }
    // The executable is an explicit lpApplicationName, never searched or interpreted by a shell.
    // It ends in a filename, so wrapping argv[0] in quotes preserves spaces and Unicode exactly.
    let mut command_line = vec![u16::from(b'"')];
    command_line.extend_from_slice(&application);
    command_line.extend(format!("\" serve --port {port}").encode_utf16());
    command_line.push(0);
    application.push(0);
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
    for (extra, method) in [(CREATE_BREAKAWAY_FROM_JOB, "windows-breakaway"), (0, "windows-detached-fallback")] {
        let mut command = command_line.clone();
        let startup = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
        let mut process = PROCESS_INFORMATION::default();
        // SAFETY: UTF-16 buffers are NUL terminated and live for the call; command is writable.
        // Null security/environment/directory pointers select documented defaults. No stdio
        // handles or STARTF_USESTDHANDLES are supplied, and bInheritHandles is FALSE.
        let created = unsafe {
            CreateProcessW(application.as_ptr(), command.as_mut_ptr(), ptr::null(), ptr::null(),
                0, base | extra, ptr::null(), ptr::null(), &startup, &mut process)
        };
        if created != 0 {
            // SAFETY: successful CreateProcessW returned these owned kernel handles. Closing
            // our references does not stop the detached child; its PID is retained only for logs.
            unsafe { CloseHandle(process.hThread); CloseHandle(process.hProcess); }
            tracing::info!(serve_spawn = true, launch_method = method, pid = process.dwProcessId, "detached bridge started");
            return Ok(());
        }
        if extra == 0 { return Err(io::Error::last_os_error()); }
    }
    unreachable!("the final spawn attempt always returns")
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
    pub async fn connected(&self) -> bool { self.conn.lock().await.is_some() }
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
        let client_id = format!("mcp-{}", std::process::id());
        let client_nonce = auth::nonce();
        let hello = Envelope::req("auth.hello", json!({
            "authVersion":auth::VERSION,"role":"mcp","clientId":client_id,"clientNonce":client_nonce,
            "clientVersion":env!("CARGO_PKG_VERSION"),"repair":false
        }));
        let challenge = auth_exchange(&mut ws, &hello).await?;
        let server_nonce = challenge["serverNonce"].as_str().unwrap_or_default();
        if challenge["authVersion"].as_u64() != Some(auth::VERSION) || !auth::valid_hex(server_nonce)
            || !auth::verify(&self.token, &auth::transcript("server", "mcp", &client_id, &client_nonce, server_nonce, false),
                challenge["serverProof"].as_str().unwrap_or_default())
        {
            return Err("AUTH_FAILED: Bridge server proof is invalid. Update both components and check pairing credentials.".to_string());
        }
        let proof = auth::proof(&self.token, &auth::transcript("client", "mcp", &client_id, &client_nonce, server_nonce, false));
        let prove = Envelope::req("auth.prove", json!({"authVersion":auth::VERSION,"proof":proof}));
        let ack = auth_exchange(&mut ws, &prove).await?;
        if ack["authVersion"].as_u64() != Some(auth::VERSION) {
            return Err("AUTH_FAILED: Bridge did not acknowledge mutual authentication v1".to_string());
        }
        Ok(ws)
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

    fn cancelled(&self, name: &str, args: &Value, delivered: bool) -> Value {
        let uncertain = delivered && tools::class_of(name, args) == CommandClass::Write;
        self.failure(name, args, delivered, if uncertain { "unknown" } else { "no" }, RpcError::new(
            if uncertain { ErrorCode::ExecutionUnknown } else { ErrorCode::Cancelled },
            if uncertain { Retry::Unsafe } else { Retry::Never },
            "The request was cancelled. A delivered action may already have happened; inspect before retrying.",
        ))
    }

    async fn cancel_request(conn: &mut Option<Ws>, id: &str) {
        // send() flushes any partially queued request before its cancellation. Keep this
        // socket alive so unrelated requests on the persistent MCP connection can proceed.
        if let Some(ws) = conn.as_mut() {
            let cancel = Envelope::req("tool.cancel", json!({"requestId": id}));
            if !matches!(tokio::time::timeout(Duration::from_secs(2), ws.send(Message::text(cancel.to_text()))).await, Ok(Ok(()))) {
                *conn = None; // Transport failure: serve drops its outstanding request futures.
            }
        }
    }

    /// Returns the `ToolOutcome` JSON produced by serve, or one built locally when serve cannot be reached.
    pub async fn call_tool(&self, name: &str, args: Value) -> anyhow::Result<Value> {
        self.call_tool_cancellable(name, args, std::future::pending()).await
    }

    pub async fn call_tool_cancellable(&self, name: &str, args: Value, cancel: impl std::future::Future<Output = ()> + Send) -> anyhow::Result<Value> {
        tokio::pin!(cancel);
        let class = tools::class_of(name, &args);
        let mut conn = tokio::select! {
            biased;
            _ = &mut cancel => return Ok(self.cancelled(name, &args, false)),
            conn = self.conn.lock() => conn,
        };
        let req = Envelope::req("tool.call", json!({ "name": name, "arguments": args }));
        let req_text = req.to_text();

        // Before sending, a dead connection is simply replaced: nothing can have been executed yet.
        let mut sent = false;
        for _ in 0..2 {
            tokio::select! {
                biased;
                _ = &mut cancel => return Ok(self.cancelled(name, &args, false)),
                _ = self.ensure_connected(&mut conn) => {},
            }
            let Some(ws) = conn.as_mut() else { break };
            let send = tokio::select! {
                biased;
                _ = &mut cancel => {
                    Self::cancel_request(&mut conn, req.id().unwrap()).await;
                    return Ok(self.cancelled(name, &args, true));
                },
                sent = ws.send(Message::text(req_text.clone())) => sent,
            };
            match send {
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
        let reply = tokio::select! {
            biased;
            _ = &mut cancel => {
                Self::cancel_request(&mut conn, req.id().unwrap()).await;
                return Ok(self.cancelled(name, &args, true));
            },
            reply = tokio::time::timeout(REPLY_WAIT, async {
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
            }) => reply,
        };
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

#[cfg(test)]
mod auth_tests {
    use super::*;


    #[tokio::test]
    async fn r01_cancellation_interrupts_connection_authentication() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (started, cancel) = tokio::sync::oneshot::channel();
        let fake = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            ws.next().await.unwrap().unwrap(); let _ = started.send(());
            // The client must drop auth instead of waiting for its five-second timeout.
            assert!(tokio::time::timeout(Duration::from_secs(1),ws.next()).await.is_ok());
        });
        let client = ServeClient {port,exe:PathBuf::new(),token:"fixture".into(),conn:tokio::sync::Mutex::new(None),last_error:std::sync::Mutex::new(None),start_failed_at:std::sync::Mutex::new(None)};
        let outcome = tokio::time::timeout(Duration::from_secs(1), client.call_tool_cancellable("browser_tabs",json!({"action":"list"}),async {let _ = cancel.await;})).await.unwrap().unwrap();
        assert_eq!(outcome["error"]["code"],"CANCELLED"); assert_eq!(outcome["delivered"],false);
        fake.await.unwrap();
    }
    #[tokio::test]
    async fn fake_server_cannot_obtain_token_or_client_proof() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let fake = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let Message::Text(text) = ws.next().await.unwrap().unwrap() else { panic!("expected hello") };
            assert!(!text.contains("secret-test-token"));
            let Envelope::Req { id, params, .. } = parse_envelope(&text).unwrap() else { panic!("expected request") };
            assert!(params.get("token").is_none());
            ws.send(Message::text(Envelope::ok(id, json!({"authVersion":1,"serverNonce":"11".repeat(32),"serverProof":"00".repeat(32)})).to_text())).await.unwrap();
            assert!(!matches!(ws.next().await, Some(Ok(Message::Text(_)))));
        });
        let client = ServeClient {
            port, exe: PathBuf::new(), token: "secret-test-token".into(),
            conn: tokio::sync::Mutex::new(None), last_error: std::sync::Mutex::new(None), start_failed_at: std::sync::Mutex::new(None),
        };
        assert!(client.open().await.unwrap_err().contains("server proof is invalid"));
        fake.await.unwrap();
    }
}
