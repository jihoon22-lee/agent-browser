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
pub(crate) const REPLY_WAIT: Duration = Duration::from_secs(60);

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
    let client = ServeClient { port, exe: Path::new("").into(), home: home.to_path_buf(), token: cfg.token, conn: tokio::sync::Mutex::new(None), last_error: std::sync::Mutex::new(None), start_failed_at: std::sync::Mutex::new(None) };
    client.open().await.is_ok()
}

/// One authenticated request to a running serve for local tools such as the installer. Never starts serve.
pub async fn admin_request(home: &Path, port: u16, method: &str, params: Value) -> anyhow::Result<Value> {
    let cfg = config::load_or_init(home)?;
    let client = ServeClient { port, exe: Path::new("").into(), home: home.to_path_buf(), token: cfg.token, conn: tokio::sync::Mutex::new(None), last_error: std::sync::Mutex::new(None), start_failed_at: std::sync::Mutex::new(None) };
    let mut ws = client.open().await.map_err(|error| anyhow::anyhow!("No authenticated Bridge at 127.0.0.1:{port}: {error}"))?;
    auth_exchange(&mut ws, &Envelope::req(method, params)).await.map_err(|error| anyhow::anyhow!(error))
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

/// A managed runtime lists here, comma-separated, the environment keys its profile added on
/// top of the Bridge's own environment. OpenCode hands them to this proxy with everything
/// else, and a serve started from the proxy would keep them for its whole life and pass them
/// to every runtime it launches later, of any profile. The runtime sets this variable in the
/// MCP environment of its overlay; `serve_environment` reads it and drops the listed keys.
pub(crate) const PROFILE_ENV_KEYS: &str = "AGENT_BROWSER_PROFILE_ENV_KEYS";
/// What a managed runtime injects into its OpenCode process, and so into this proxy.
const RUNTIME_ENV: [&str; 5] = ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "OPENCODE_CONFIG_CONTENT", "AGENT_BROWSER_RUNTIME_ID", PROFILE_ENV_KEYS];
/// The overlay sets these for the proxy itself; they locate the Bridge and are never dropped.
const SERVE_ENV: [&str; 2] = ["AGENT_BROWSER_HOME", "AGENT_BROWSER_PORT"];

/// The environment for a serve started from this proxy: the proxy's own, without what the
/// launching runtime injected. Windows compares variable names without case.
pub(crate) fn serve_environment(vars: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>, ignore_case: bool) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let vars: Vec<_> = vars.collect();
    let same = |a: &str, b: &str| if ignore_case { a.eq_ignore_ascii_case(b) } else { a == b };
    let listed: Vec<String> = vars.iter().find(|(key, _)| key.to_str().is_some_and(|key| same(key, PROFILE_ENV_KEYS)))
        .and_then(|(_, value)| value.to_str()).map(|value| value.split(',').filter(|key| !key.is_empty()).map(str::to_owned).collect()).unwrap_or_default();
    vars.into_iter().filter(|(key, _)| {
        let Some(key) = key.to_str() else { return true };
        SERVE_ENV.iter().any(|kept| same(key, kept)) || !(RUNTIME_ENV.iter().any(|dropped| same(key, dropped)) || listed.iter().any(|dropped| same(key, dropped)))
    }).collect()
}

/// Starts `exe serve --port <port>` so that it keeps running after this process exits.
/// It runs in the Bridge home, not in the caller's (project) directory, and without the
/// variables a managed runtime injected into the caller.
pub fn spawn_detached_serve(exe: &Path, port: u16, home: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        spawn_windows_without_handles(exe, port, home)
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new(exe);
        cmd.arg("serve").arg("--port").arg(port.to_string())
            .env_clear().envs(serve_environment(std::env::vars_os(), false)).current_dir(home)
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
fn spawn_windows_without_handles(exe: &Path, port: u16, home: &Path) -> std::io::Result<()> {
    use std::{io, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{
        CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
        CREATE_UNICODE_ENVIRONMENT,
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
    let directory: Vec<u16> = home.as_os_str().encode_wide().chain([0]).collect();
    if directory.iter().filter(|unit| **unit == 0).count() != 1 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "detached serve requires a Bridge home without NUL"));
    }
    // A Unicode block of NAME=value entries, each NUL terminated, sorted by name without case.
    let mut sorted = std::collections::BTreeMap::new();
    for (key, value) in serve_environment(std::env::vars_os(), true) { sorted.insert(key.to_string_lossy().to_ascii_uppercase(), (key, value)); }
    let mut environment = Vec::<u16>::new();
    for (key, value) in sorted.values() { environment.extend(key.encode_wide()); environment.push(u16::from(b'=')); environment.extend(value.encode_wide()); environment.push(0); }
    if environment.is_empty() { environment.push(0); }
    environment.push(0);
    // Do not combine DETACHED_PROCESS with CREATE_NO_WINDOW: Windows ignores
    // the latter, allowing launcher descendants to create visible consoles.
    let base = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
    for (extra, method) in [(CREATE_BREAKAWAY_FROM_JOB, "windows-breakaway"), (0, "windows-detached-fallback")] {
        let mut command = command_line.clone();
        let startup = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
        let mut process = PROCESS_INFORMATION::default();
        // SAFETY: UTF-16 buffers are NUL terminated and live for the call; command is writable.
        // The environment block ends with an empty entry and CREATE_UNICODE_ENVIRONMENT is set.
        // Null security pointers select documented defaults. No stdio handles or
        // STARTF_USESTDHANDLES are supplied, and bInheritHandles is FALSE.
        let created = unsafe {
            CreateProcessW(application.as_ptr(), command.as_mut_ptr(), ptr::null(), ptr::null(),
                0, base | extra, environment.as_ptr().cast(), directory.as_ptr(), &startup, &mut process)
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
    home: PathBuf,
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
            home: home.to_path_buf(),
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
        let hello = Envelope::req("auth.hello", hello_params(&client_id, &client_nonce,
            std::env::var("AGENT_BROWSER_RUNTIME_ID").ok(),
            std::env::current_dir().ok().map(|dir| dir.to_string_lossy().into_owned())));
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
        if let Err(e) = spawn_detached_serve(&self.exe, self.port, &self.home) {
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
            let mut queued = false;
            let send = tokio::select! {
                biased;
                _ = &mut cancel => {
                    if queued { Self::cancel_request(&mut conn, req.id().unwrap()).await; }
                    return Ok(self.cancelled(name, &args, queued));
                },
                sent = async {
                    // feed completes immediately after the sink accepts the message.
                    // Cancellation before acceptance cannot have delivered this call.
                    ws.feed(Message::text(req_text.clone())).await?;
                    queued = true;
                    ws.flush().await
                } => sent,
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

/// A managed runtime starts one proxy per OpenCode directory with that directory as cwd
/// and passes its per-launch id; the server uses both only to bind a guarded panel request.
pub(crate) fn hello_params(client_id: &str, client_nonce: &str, runtime_id: Option<String>, cwd: Option<String>) -> Value {
    json!({
        "authVersion":auth::VERSION,"role":"mcp","clientId":client_id,"clientNonce":client_nonce,
        "clientVersion":env!("CARGO_PKG_VERSION"),"repair":false,
        "runtimeId":runtime_id.filter(|id| !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')),
        "cwd":cwd.filter(|dir| dir.len() <= 4096),
    })
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    #[test]
    fn serve_environment_drops_what_the_runtime_injected_and_nothing_else() {
        let vars = |pairs: &[(&str, &str)]| pairs.iter().map(|(key, value)| (std::ffi::OsString::from(key), std::ffi::OsString::from(value))).collect::<Vec<_>>();
        let names = |kept: Vec<(std::ffi::OsString, std::ffi::OsString)>| kept.into_iter().map(|(key, _)| key.to_string_lossy().into_owned()).collect::<Vec<_>>();
        let inherited = vars(&[("PATH", "/bin"), ("OPENCODE_SERVER_PASSWORD", "private"), ("OPENCODE_SERVER_USERNAME", "opencode"), ("OPENCODE_CONFIG_CONTENT", "{}"),
            ("AGENT_BROWSER_RUNTIME_ID", "rid"), (PROFILE_ENV_KEYS, "AB_TOKEN,,AGENT_BROWSER_HOME,AGENT_BROWSER_PORT"), ("AB_TOKEN", "profile-private"), ("ab_token", "other"),
            ("AGENT_BROWSER_HOME", "/home"), ("AGENT_BROWSER_PORT", "4317"), ("AGENT_BROWSER_LOG", "debug")]);
        assert_eq!(names(serve_environment(inherited.clone().into_iter(), false)), ["PATH", "ab_token", "AGENT_BROWSER_HOME", "AGENT_BROWSER_PORT", "AGENT_BROWSER_LOG"]);
        assert_eq!(names(serve_environment(inherited.into_iter(), true)), ["PATH", "AGENT_BROWSER_HOME", "AGENT_BROWSER_PORT", "AGENT_BROWSER_LOG"], "Windows names have no case");
        let windows = vars(&[("Path", "C:\\Windows"), ("opencode_server_password", "private"), ("agent_browser_profile_env_keys", "Ab_Token"), ("AB_TOKEN", "x"), ("=C:", "C:\\work")]);
        assert_eq!(names(serve_environment(windows.into_iter(), true)), ["Path", "=C:"]);
        let plain = vars(&[("PATH", "/bin"), ("HOME", "/home/fixture")]);
        assert_eq!(serve_environment(plain.clone().into_iter(), false), plain, "an ordinary environment passes unchanged");
    }

    #[test]
    fn hello_names_the_runtime_and_directory_only_when_known() {
        let named = super::hello_params("mcp-1","00",Some("rid".into()),Some("/work".into()));
        assert_eq!(named["runtimeId"],"rid"); assert_eq!(named["cwd"],"/work"); assert_eq!(named["role"],"mcp");
        let plain = super::hello_params("mcp-1","00",None,None);
        assert!(plain["runtimeId"].is_null() && plain["cwd"].is_null());
        let oversized = super::hello_params("mcp-1","00",Some("x".repeat(65)),None);
        assert!(oversized["runtimeId"].is_null(),"an implausible runtime id is not sent");
    }


    #[tokio::test]
    async fn review_cancel_before_send_is_undelivered_and_reuses_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream,_) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(stream).await.unwrap()
        });
        let (ws,_) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}")).await.unwrap();
        let mut peer = server.await.unwrap();
        let client = ServeClient {port,exe:PathBuf::new(),home:PathBuf::new(),token:"fixture".into(),conn:tokio::sync::Mutex::new(Some(ws)),last_error:std::sync::Mutex::new(None),start_failed_at:std::sync::Mutex::new(None)};
        let mut polls = 0;
        // First poll: before the mutex. Second: before the cached connection.
        // Third: the send select, before its send future has ever been polled.
        let cancel = std::future::poll_fn(|_| {
            polls += 1;
            if polls == 3 { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }
        });
        let outcome = client.call_tool_cancellable("browser_click",json!({"ref":"e1","operationId":"fixture"}),cancel).await.unwrap();
        assert_eq!(outcome["error"]["code"],"CANCELLED");
        assert_eq!(outcome["delivered"],false); assert_eq!(outcome["executed"],"no");
        assert!(tokio::time::timeout(Duration::from_millis(30),peer.next()).await.is_err(),"Neither tool.call nor tool.cancel should be sent");
        let next = tokio::spawn(async move {
            let Message::Text(text) = peer.next().await.unwrap().unwrap() else {panic!("expected tool.call")};
            let Envelope::Req {id,method,..} = parse_envelope(&text).unwrap() else {panic!("expected request")};
            assert_eq!(method,"tool.call");
            peer.send(Message::text(Envelope::ok(id,json!({"ok":true})).to_text())).await.unwrap();
        });
        assert_eq!(client.call_tool("browser_tabs",json!({"action":"list"})).await.unwrap()["ok"],true);
        next.await.unwrap();
    }

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
        let client = ServeClient {port,exe:PathBuf::new(),home:PathBuf::new(),token:"fixture".into(),conn:tokio::sync::Mutex::new(None),last_error:std::sync::Mutex::new(None),start_failed_at:std::sync::Mutex::new(None)};
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
            port, exe: PathBuf::new(), home: PathBuf::new(), token: "secret-test-token".into(),
            conn: tokio::sync::Mutex::new(None), last_error: std::sync::Mutex::new(None), start_failed_at: std::sync::Mutex::new(None),
        };
        assert!(client.open().await.unwrap_err().contains("server proof is invalid"));
        fake.await.unwrap();
    }
}
