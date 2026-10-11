mod common;
use agent_browser_bridge::rpc::Envelope;
use common::*;
use serde_json::{json, Value};

const EXT: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

type Reply = fn(&str, &Value) -> Result<Value, (&'static str, &'static str)>;

/// Fake extension: answers each command with `reply(method, params)`.
/// A reply object may carry `"__delayMs"` to be held back before it is sent.
/// Returns the list of command methods the fake received, shared with the caller.
async fn fake_extension(port: u16, token: String, reply: Reply) -> std::sync::Arc<std::sync::Mutex<Vec<String>>> {
    let mut ws = ws_connect(port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut ws, "extension", &token, "cli-1").await;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        use futures_util::{SinkExt, StreamExt};
        while let Some(Ok(msg)) = ws.next().await {
            let Ok(text) = msg.into_text() else { continue };
            let Ok(Envelope::Req { id, method, params, .. }) = agent_browser_bridge::rpc::parse_envelope(&text) else { continue };
            log.lock().unwrap().push(method.clone());
            let res = match reply(&method, &params) {
                Ok(mut v) => {
                    if let Some(ms) = v.as_object_mut().and_then(|o| o.remove("__delayMs")).and_then(|d| d.as_u64()) {
                        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                    }
                    Envelope::ok(id, v)
                }
                Err((code, msg)) => Envelope::err(id, serde_json::from_value(json!({"code":code,"message":msg,"retry":"never"})).unwrap()),
            };
            ws.send(tokio_tungstenite::tungstenite::Message::text(res.to_text())).await.unwrap();
        }
    });
    seen
}

fn default_reply(method: &str, p: &Value) -> Result<Value, (&'static str, &'static str)> {
    match method {
        "browser.tabs.get" => Ok(json!({"tabId": 42, "url": "http://127.0.0.1/x", "title": "x", "active": true})),
        "browser.tabs.create" => Ok(json!({"tabId": 77, "url": p["url"], "title": "new", "active": true})),
        "browser.snapshot" => Ok(json!({"snapshotId": 1, "url": "http://127.0.0.1/x", "elements": [], "tabId": p["tabId"]})),
        "browser.click" => Ok(json!({"executed": true, "verified": {"urlChanged": false, "domChanged": true}})),
        "browser.fill" => Ok(json!({"verified": {"value": p["text"]}})),
        _ => Err(("INTERNAL", "unexpected")),
    }
}

async fn tool(ws: &mut Ws, name: &str, args: Value) -> Value {
    let res = call(ws, "tool.call", json!({"name": name, "arguments": args})).await;
    let Envelope::Res { ok: true, result: Some(r), .. } = res else { panic!("{res:?}") };
    r
}

async fn mcp_client(port: u16, token: &str, id: &str) -> Ws {
    let mut mcp = ws_connect(port, "/mcp-proxy", None).await.unwrap();
    hello(&mut mcp, "mcp", token, id).await;
    mcp
}

#[tokio::test]
async fn attach_snapshot_click_flow() {
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), default_reply).await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let a = tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await;
    assert_eq!(a["ok"], true);
    let op = a["operationId"].as_str().unwrap().to_string();
    let s = tool(&mut mcp, "browser_snapshot", json!({"operationId": op})).await;
    assert_eq!(s["ok"], true);
    assert_eq!(s["data"]["tabId"], 42, "commands carry the operation's current tab");
    let c = tool(&mut mcp, "browser_click", json!({"operationId": op, "ref": "s1f0e1"})).await;
    assert_eq!(c["executed"], "yes");
    assert_eq!(c["delivered"], true);
    assert_eq!(c["verified"]["domChanged"], true);
}

#[tokio::test]
async fn mutating_tool_without_operation_is_rejected_without_contacting_browser() {
    let (_h, serve, cfg) = start_test_serve().await;
    let ext = fake_extension(serve.port, cfg.token.clone(), default_reply).await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let c = tool(&mut mcp, "browser_click", json!({"ref": "s1f0e1"})).await;
    assert_eq!(c["error"]["code"], "OPERATION_REQUIRED");
    assert_eq!(c["delivered"], false);
    assert_eq!(c["executed"], "no");
    assert!(ext.lock().unwrap().is_empty(), "browser was contacted: {:?}", ext.lock().unwrap());
}

#[tokio::test]
async fn second_client_attach_gets_busy() {
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), default_reply).await;
    let mut a = mcp_client(serve.port, &cfg.token, "mcp-a").await;
    let mut b = mcp_client(serve.port, &cfg.token, "mcp-b").await;
    tool(&mut a, "browser_tabs", json!({"action": "attach"})).await;
    let r = tool(&mut b, "browser_tabs", json!({"action": "attach"})).await;
    assert_eq!(r["error"]["code"], "BROWSER_BUSY");
}

#[tokio::test]
async fn abort_from_extension_cancels_following_calls() {
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), default_reply).await;
    let mut panel = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut panel, "extension", &cfg.token, "panel-1").await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let a = tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await;
    let op = a["operationId"].as_str().unwrap().to_string();
    call(&mut panel, "operation.abort", json!({})).await;
    let c = tool(&mut mcp, "browser_click", json!({"operationId": op, "ref": "s1f0e1"})).await;
    assert_eq!(c["error"]["code"], "CANCELLED");
    assert_eq!(c["delivered"], false);
}

#[tokio::test]
async fn browser_error_is_passed_through_with_code() {
    fn stale(method: &str, p: &Value) -> Result<Value, (&'static str, &'static str)> {
        if method == "browser.click" { Err(("STALE_ELEMENT", "gone")) } else { default_reply(method, p) }
    }
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), stale).await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let a = tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await;
    let c = tool(&mut mcp, "browser_click", json!({"operationId": a["operationId"], "ref": "s1f0e1"})).await;
    assert_eq!(c["error"]["code"], "STALE_ELEMENT");
    assert_eq!(c["delivered"], true);
    assert_eq!(c["executed"], "no");
}

#[tokio::test]
async fn unknown_tool_and_bad_args_are_invalid_params() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    assert_eq!(tool(&mut mcp, "browser_eval", json!({})).await["error"]["code"], "INVALID_PARAMS");
    assert_eq!(tool(&mut mcp, "browser_tabs", json!({"action": "explode"})).await["error"]["code"], "INVALID_PARAMS");
    assert_eq!(tool(&mut mcp, "browser_snapshot", json!({"operationId": "op-x", "maxChars": 5})).await["error"]["code"], "INVALID_PARAMS");
    assert_eq!(tool(&mut mcp, "browser_tabs", json!({"action": "new"})).await["error"]["code"], "INVALID_PARAMS");
}

#[tokio::test]
async fn new_tab_joins_the_operation_and_becomes_current() {
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), default_reply).await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let a = tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await;
    let op = a["operationId"].as_str().unwrap().to_string();
    let n = tool(&mut mcp, "browser_tabs", json!({"action": "new", "operationId": op, "url": "http://127.0.0.1/y"})).await;
    assert_eq!(n["ok"], true, "{n}");
    let s = tool(&mut mcp, "browser_snapshot", json!({"operationId": op})).await;
    assert_eq!(s["data"]["tabId"], 77);
    let back = tool(&mut mcp, "browser_tabs", json!({"action": "switch", "operationId": op, "tabId": 42})).await;
    assert_eq!(back["ok"], true, "{back}");
    let s = tool(&mut mcp, "browser_snapshot", json!({"operationId": op})).await;
    assert_eq!(s["data"]["tabId"], 42);
    let outside = tool(&mut mcp, "browser_tabs", json!({"action": "switch", "operationId": op, "tabId": 999})).await;
    assert_eq!(outside["error"]["code"], "TAB_NOT_FOUND");
}

#[tokio::test]
async fn release_ends_the_operation_and_allows_a_new_attach() {
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), default_reply).await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let a = tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await;
    let op = a["operationId"].as_str().unwrap().to_string();
    assert_eq!(tool(&mut mcp, "browser_tabs", json!({"action": "release", "operationId": op})).await["ok"], true);
    let s = tool(&mut mcp, "browser_snapshot", json!({"operationId": op})).await;
    assert_eq!(s["error"]["code"], "OPERATION_INVALID");
    assert_eq!(tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await["ok"], true);
}

#[tokio::test]
async fn fill_text_never_reaches_the_timeline() {
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), default_reply).await;
    let mut panel = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut panel, "extension", &cfg.token, "panel-1").await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let a = tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await;
    let secret = "correct-horse-battery-staple";
    let f = tool(&mut mcp, "browser_fill", json!({"operationId": a["operationId"], "ref": "s1f0e2", "text": secret})).await;
    assert_eq!(f["ok"], true, "{f}");
    let status = call(&mut panel, "status.get", json!({})).await;
    let Envelope::Res { result: Some(r), .. } = status else { panic!() };
    let timeline = r["timeline"].to_string();
    assert!(timeline.contains("browser_fill"), "{timeline}");
    assert!(!timeline.contains(secret), "{timeline}");
    assert!(timeline.contains("text(28 chars)"), "{timeline}");
}

#[tokio::test]
async fn read_result_arriving_after_abort_is_reported_as_cancelled() {
    fn slow_snapshot(method: &str, p: &Value) -> Result<Value, (&'static str, &'static str)> {
        match method {
            "browser.snapshot" => Ok(json!({"snapshotId": 1, "elements": [], "__delayMs": 400})),
            _ => default_reply(method, p),
        }
    }
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), slow_snapshot).await;
    let mut panel = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut panel, "extension", &cfg.token, "panel-1").await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let a = tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await;
    let op = a["operationId"].as_str().unwrap().to_string();
    let reader = tokio::spawn(async move { tool(&mut mcp, "browser_snapshot", json!({"operationId": op})).await });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    call(&mut panel, "operation.abort", json!({})).await;
    let s = reader.await.unwrap();
    assert_eq!(s["error"]["code"], "CANCELLED", "{s}");
    assert_eq!(s["delivered"], true);
}

#[tokio::test]
async fn write_result_arriving_after_abort_is_kept_and_flagged() {
    fn slow_click(method: &str, p: &Value) -> Result<Value, (&'static str, &'static str)> {
        match method {
            "browser.click" => Ok(json!({"verified": {"domChanged": true}, "__delayMs": 400})),
            _ => default_reply(method, p),
        }
    }
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), slow_click).await;
    let mut panel = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut panel, "extension", &cfg.token, "panel-1").await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let a = tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await;
    let op = a["operationId"].as_str().unwrap().to_string();
    let clicker = tokio::spawn(async move { tool(&mut mcp, "browser_click", json!({"operationId": op, "ref": "s1f0e1"})).await });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    call(&mut panel, "operation.abort", json!({})).await;
    let c = clicker.await.unwrap();
    assert_eq!(c["executed"], "yes", "the click really ran: {c}");
    assert_eq!(c["data"]["abortedAfter"], true, "{c}");
}
