//! Guarded binding of id-less browser tool calls to the open panel request (handoff §11).
mod common;
use agent_browser_bridge::rpc::Envelope;
use common::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::{atomic::{AtomicUsize, Ordering}, Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const EXT: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const DIR: &str = "C:\\w";

/// Fake OpenCode answering `/session/status` with the shared value; returns its base URL.
async fn fake_opencode(statuses: Arc<Mutex<Value>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0; 4096];
            let _ = stream.read(&mut buffer).await.unwrap();
            let body = statuses.lock().unwrap().to_string();
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    base
}

/// Browser commands the fake extension received, with their parameters.
type Seen = Arc<Mutex<Vec<(String, Value)>>>;

/// A fake extension that answers browser commands and can send its own requests.
struct Ext { outbound: tokio::sync::mpsc::UnboundedSender<(Envelope, tokio::sync::oneshot::Sender<Envelope>)>, seen: Seen }

impl Ext {
    async fn connect(port: u16, token: &str, slow_second_snapshot: bool) -> Self {
        let mut ws = ws_connect(port, "/extension", Some(EXT)).await.unwrap();
        hello(&mut ws, "extension", token, "cli-1").await;
        let (outbound, mut requests) = tokio::sync::mpsc::unbounded_channel::<(Envelope, tokio::sync::oneshot::Sender<Envelope>)>();
        let seen: Seen = Arc::default();
        let log = seen.clone();
        let snapshots = Arc::new(AtomicUsize::new(0));
        tokio::spawn(async move {
            let mut waiting = std::collections::HashMap::new();
            loop {
                tokio::select! {
                    Some((request, reply)) = requests.recv() => {
                        waiting.insert(request.id().unwrap_or_default().to_string(), reply);
                        ws.send(tokio_tungstenite::tungstenite::Message::text(request.to_text())).await.unwrap();
                    }
                    Some(Ok(message)) = ws.next() => {
                        let Ok(text) = message.into_text() else { continue };
                        let Ok(envelope) = agent_browser_bridge::rpc::parse_envelope(&text) else { continue };
                        match envelope {
                            Envelope::Req { id, method, params, .. } => {
                                log.lock().unwrap().push((method.clone(), params.clone()));
                                let value = match method.as_str() {
                                    "browser.tabs.get" => json!({"tabId": params["tabId"].as_i64().unwrap_or(11), "url": "http://127.0.0.1/x", "title": "x", "active": true, "attachable": true}),
                                    "browser.snapshot" => {
                                        if slow_second_snapshot && snapshots.fetch_add(1, Ordering::SeqCst) == 1 { tokio::time::sleep(std::time::Duration::from_secs(3)).await; }
                                        json!({"snapshotId": 1, "url": "http://127.0.0.1/x", "frames": [], "tabs": [], "tabId": params["tabId"]})
                                    }
                                    "browser.tabs.list" => json!({"tabs": []}),
                                    "browser.click" => json!({"executed": true, "verified": {"urlChanged": false, "domChanged": true}}),
                                    _ => json!({}),
                                };
                                ws.send(tokio_tungstenite::tungstenite::Message::text(Envelope::ok(id, value).to_text())).await.unwrap();
                            }
                            Envelope::Res { ref id, .. } => { if let Some(reply) = waiting.remove(id.as_str()) { let _ = reply.send(envelope); } }
                            _ => {}
                        }
                    }
                    else => break,
                }
            }
        });
        Self { outbound, seen }
    }

    async fn request(&self, method: &str, params: Value) -> Envelope {
        let (reply, response) = tokio::sync::oneshot::channel();
        self.outbound.send((Envelope::req(method, params), reply)).unwrap();
        response.await.unwrap()
    }

    async fn begin(&self) {
        let begun = self.request("request.begin", json!({"requestId":"req","clientId":"cli-1","tabId":11,"profileId":"p","sessionId":"ses_panel","directory":DIR})).await;
        assert!(matches!(begun, Envelope::Res { ok: true, .. }), "{begun:?}");
    }

    fn methods(&self) -> Vec<String> { self.seen.lock().unwrap().iter().map(|(method, _)| method.clone()).collect() }
}

struct Fixture { _home: tempfile::TempDir, _serve: agent_browser_bridge::server::ServeHandle, port: u16, token: String, statuses: Arc<Mutex<Value>>, ext: Ext }

async fn setup(slow_second_snapshot: bool) -> Fixture {
    let (home, serve, cfg) = start_test_serve().await;
    let statuses = Arc::new(Mutex::new(json!({"ses_panel":{"type":"busy"}})));
    let base = fake_opencode(statuses.clone()).await;
    agent_browser_bridge::runtime::Manager::new(home.path().into(), serve.port)
        .record_runtime_for_tests(json!({"id":"p","name":"P","kind":"windows","directory":DIR,"executable":"C:\\o\\opencode.exe"}), "rid-now", &base);
    let ext = Ext::connect(serve.port, &cfg.token, slow_second_snapshot).await;
    ext.begin().await;
    let port = serve.port;
    Fixture { _home: home, _serve: serve, port, token: cfg.token, statuses, ext }
}

async fn proxy(f: &Fixture, runtime: Option<&str>, cwd: &str) -> Ws {
    let mut ws = ws_connect(f.port, "/mcp-proxy", None).await.unwrap();
    let mut extra = json!({"cwd": cwd});
    if let Some(runtime) = runtime { extra["runtimeId"] = json!(runtime); }
    hello_with(&mut ws, "mcp", &f.token, "mcp-bound", extra).await;
    ws
}

async fn tool(ws: &mut Ws, name: &str, args: Value) -> Value {
    let res = call(ws, "tool.call", json!({"name": name, "arguments": args})).await;
    let Envelope::Res { ok: true, result: Some(r), .. } = res else { panic!("{res:?}") };
    r
}

fn message(outcome: &Value) -> String { outcome["error"]["message"].as_str().unwrap_or_default().to_string() }

#[tokio::test]
async fn first_page_tool_attaches_the_captured_tab_implicitly() {
    let f = setup(false).await;
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let read = tool(&mut mcp, "browser_snapshot", json!({})).await;
    assert_eq!(read["ok"], true, "{read}");
    let operation = read["operationId"].as_str().unwrap().to_string();
    assert_eq!(f.ext.seen.lock().unwrap().iter().find(|(m, _)| m == "browser.tabs.get").unwrap().1["tabId"], 11, "the captured tab is attached");
    let clicked = tool(&mut mcp, "browser_click", json!({"ref":"s1f0e1"})).await;
    assert_eq!((clicked["ok"].clone(), clicked["operationId"].clone()), (json!(true), json!(operation)));
    let forwarded = f.ext.seen.lock().unwrap().iter().rev().find(|(m, _)| m == "browser.click").unwrap().1.clone();
    assert_eq!(forwarded["operationId"], json!(operation), "the click runs in the bound operation, under its usual ref checks");
}

#[tokio::test]
async fn busy_cli_session_blocks_implicit_binding() {
    let f = setup(false).await;
    *f.statuses.lock().unwrap() = json!({"ses_panel":{"type":"busy"},"ses_cli":{"type":"busy"}});
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let before = f.ext.methods().len();
    let attached = tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await;
    assert_eq!(attached["ok"], false);
    assert!(message(&attached).contains("Missing requestId"), "{attached}");
    assert_eq!(f.ext.methods().len(), before, "no browser command ran");
}

#[tokio::test]
async fn two_busy_sessions_fall_back_to_explicit_ids() {
    let f = setup(false).await;
    *f.statuses.lock().unwrap() = json!({"ses_panel":{"type":"busy"},"ses_other":{"type":"retry"}});
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let attached = tool(&mut mcp, "browser_tabs", json!({"action":"attach","requestId":"req"})).await;
    assert_eq!(attached["ok"], true, "the explicit path still works: {attached}");
}

#[tokio::test]
async fn guard_is_reevaluated_on_every_call() {
    let f = setup(false).await;
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let first = tool(&mut mcp, "browser_snapshot", json!({})).await;
    assert_eq!(first["ok"], true, "{first}");
    *f.statuses.lock().unwrap() = json!({"ses_panel":{"type":"busy"},"ses_cli":{"type":"busy"}});
    let unbound = tool(&mut mcp, "browser_snapshot", json!({})).await;
    assert_eq!(unbound["error"]["code"], "OPERATION_REQUIRED", "{unbound}");
    let explicit = tool(&mut mcp, "browser_snapshot", json!({"operationId": first["operationId"]})).await;
    assert_eq!(explicit["ok"], true, "{explicit}");
}

#[tokio::test]
async fn stale_runtime_external_profile_and_ended_request_do_not_bind() {
    let f = setup(false).await;
    for (runtime, cwd) in [(Some("rid-old"), DIR), (None, DIR), (Some("rid-now"), "C:\\other")] {
        let mut mcp = proxy(&f, runtime, cwd).await;
        let attached = tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await;
        assert!(message(&attached).contains("Missing requestId"), "{runtime:?} {cwd}: {attached}");
    }
    let ended = f.ext.request("request.end", json!({"requestId":"req","clientId":"cli-1"})).await;
    assert!(matches!(ended, Envelope::Res { ok: true, .. }));
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let late = tool(&mut mcp, "browser_tabs", json!({"action":"attach","requestId":"req"})).await;
    assert!(message(&late).contains("already ended"), "{late}");
}

#[tokio::test]
async fn stopped_client_block_still_applies() {
    let f = setup(false).await;
    let stopped = f.ext.request("request.end", json!({"requestId":"req","clientId":"cli-1","abort":true})).await;
    assert!(matches!(stopped, Envelope::Res { ok: true, .. }));
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let attached = tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await;
    assert_eq!(attached["error"]["code"], "CANCELLED", "{attached}");
    assert!(message(&attached).contains("Unscoped attach is blocked"));
}

#[tokio::test]
async fn cancelling_an_implicit_attach_releases_the_new_operation() {
    let f = setup(true).await;
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    // The implicit attach's own snapshot answers at once; the requested snapshot is held back.
    let request = Envelope::req("tool.call", json!({"name":"browser_snapshot","arguments":{}}));
    send_raw(&mut mcp, &request.to_text()).await;
    for _ in 0..200 {
        if f.ext.methods().iter().filter(|m| *m == "browser.snapshot").count() >= 2 { break; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    call(&mut mcp, "tool.cancel", json!({"requestId": request.id()})).await;
    let next = tool(&mut mcp, "browser_tabs", json!({"action":"attach","requestId":"req"})).await;
    assert_eq!(next["ok"], true, "the cancelled call's operation must not hold the request: {next}");
}
