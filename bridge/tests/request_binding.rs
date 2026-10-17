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
static STATUS_REQUESTS: AtomicUsize = AtomicUsize::new(0);

async fn fake_opencode(statuses: Arc<Mutex<Value>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0; 4096];
            let _ = stream.read(&mut buffer).await.unwrap();
            STATUS_REQUESTS.fetch_add(1, Ordering::SeqCst);
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
    async fn connect(port: u16, token: &str, slow_first_snapshot: bool) -> Self {
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
                                        if slow_first_snapshot && snapshots.fetch_add(1, Ordering::SeqCst) == 0 { tokio::time::sleep(std::time::Duration::from_secs(3)).await; }
                                        json!({"snapshotId": 1, "url": "http://127.0.0.1/x", "frames": [], "tabs": [], "tabId": params["tabId"]})
                                    }
                                    "browser.tabs.list" => json!({"tabs": []}),
                                    "browser.tabs.create" => json!({"tabId": 77, "url": params["url"], "title": "new", "active": false, "attachable": true}),
                                    "browser.press" => json!({"executed": true, "verified": {"urlChanged": false, "domChanged": false}}),
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

async fn setup(slow_first_snapshot: bool) -> Fixture {
    let (home, serve, cfg) = start_test_serve().await;
    let statuses = Arc::new(Mutex::new(json!({"ses_panel":{"type":"busy"}})));
    let base = fake_opencode(statuses.clone()).await;
    agent_browser_bridge::runtime::Manager::new(home.path().into(), serve.port)
        .record_runtime_for_tests(json!({"id":"p","name":"P","kind":"windows","directory":DIR,"executable":"C:\\o\\opencode.exe"}), "rid-now", &base);
    let ext = Ext::connect(serve.port, &cfg.token, slow_first_snapshot).await;
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
    // The implicit attach in front of a read takes no snapshot of its own; the read is held back.
    let request = Envelope::req("tool.call", json!({"name":"browser_snapshot","arguments":{}}));
    send_raw(&mut mcp, &request.to_text()).await;
    for _ in 0..200 {
        if f.ext.methods().iter().any(|m| m == "browser.snapshot") { break; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    call(&mut mcp, "tool.cancel", json!({"requestId": request.id()})).await;
    let next = tool(&mut mcp, "browser_tabs", json!({"action":"attach","requestId":"req"})).await;
    assert_eq!(next["ok"], true, "the cancelled call's operation must not hold the request: {next}");
}

#[tokio::test]
async fn first_id_less_write_returns_the_attached_page_instead_of_running() {
    let f = setup(false).await;
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let held = tool(&mut mcp, "browser_press", json!({"key":"Enter"})).await;
    assert_eq!((held["ok"].clone(), held["executed"].clone(), held["error"]["code"].clone()), (json!(false), json!("no"), json!("STALE_ELEMENT")), "{held}");
    assert!(held["operationId"].is_string() && !held["data"]["snapshot"].is_null(), "the model gets the page it has not seen: {held}");
    assert!(!f.ext.methods().iter().any(|m| m == "browser.press"), "nothing was pressed on an unseen page");
    let repeated = tool(&mut mcp, "browser_press", json!({"key":"Enter"})).await;
    assert_eq!((repeated["ok"].clone(), repeated["operationId"].clone()), (json!(true), held["operationId"].clone()), "{repeated}");
}

#[tokio::test]
async fn id_less_new_joins_the_bound_operation() {
    let f = setup(false).await;
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let read = tool(&mut mcp, "browser_snapshot", json!({})).await;
    let opened = tool(&mut mcp, "browser_tabs", json!({"action":"new","url":"http://127.0.0.1/y"})).await;
    assert_eq!((opened["ok"].clone(), opened["operationId"].clone()), (json!(true), read["operationId"].clone()), "{opened}");
}

#[tokio::test]
async fn an_implicit_attach_before_a_read_reads_the_page_once() {
    let f = setup(false).await;
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let read = tool(&mut mcp, "browser_snapshot", json!({})).await;
    assert_eq!(read["ok"], true, "{read}");
    assert_eq!(f.ext.methods().iter().filter(|m| *m == "browser.snapshot").count(), 1);
    assert!(!f.ext.methods().iter().any(|m| m == "browser.tabs.list"), "openTabs of a discarded attach result are not read");
}

#[tokio::test]
async fn concurrent_id_less_first_calls_share_one_operation() {
    let f = setup(false).await;
    let (mut a, mut b) = (proxy(&f, Some("rid-now"), DIR).await, proxy(&f, Some("rid-now"), DIR).await);
    let (x, y) = tokio::join!(tool(&mut a, "browser_snapshot", json!({})), tool(&mut b, "browser_snapshot", json!({})));
    assert_eq!((x["ok"].clone(), y["ok"].clone()), (json!(true), json!(true)), "{x} {y}");
    assert_eq!(x["operationId"], y["operationId"]);
}

#[tokio::test]
async fn null_ids_count_as_omitted() {
    let f = setup(false).await;
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let read = tool(&mut mcp, "browser_snapshot", json!({"operationId": null})).await;
    assert_eq!(read["ok"], true, "{read}");
}

#[tokio::test]
async fn an_unreadable_status_reply_never_binds() {
    let f = setup(false).await;
    *f.statuses.lock().unwrap() = json!(["ses_cli"]);
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let attached = tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await;
    assert!(message(&attached).contains("Missing requestId"), "{attached}");
}

#[tokio::test]
async fn another_directory_does_not_query_status() {
    let f = setup(false).await;
    let mut mcp = proxy(&f, Some("rid-now"), "C:\\other").await;
    let before = STATUS_REQUESTS.load(Ordering::SeqCst);
    let attached = tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await;
    assert!(message(&attached).contains("Missing requestId"), "{attached}");
    assert_eq!(STATUS_REQUESTS.load(Ordering::SeqCst), before, "a proxy for another folder is rejected before any HTTP call");
}

#[tokio::test]
async fn a_concurrent_write_joining_the_new_operation_is_held_like_a_first_write() {
    let f = setup(false).await;
    let (mut a, mut b) = (proxy(&f, Some("rid-now"), DIR).await, proxy(&f, Some("rid-now"), DIR).await);
    let (read, write) = tokio::join!(tool(&mut a, "browser_snapshot", json!({})), tool(&mut b, "browser_navigate", json!({"url":"http://127.0.0.1/elsewhere"})));
    assert_eq!(read["ok"], true, "{read}");
    assert_eq!((write["ok"].clone(), write["executed"].clone(), write["error"]["code"].clone()), (json!(false), json!("no"), json!("STALE_ELEMENT")), "{write}");
    assert!(!f.ext.methods().iter().any(|m| m == "browser.navigate"), "nothing navigated an unseen page");
}
