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
        "browser.tabs.get" if p["tabId"]==999 => Err(("TAB_NOT_FOUND","No such fixture tab")),
        "browser.tabs.get" => Ok(json!({"tabId": p["tabId"].as_i64().unwrap_or(42), "url": "http://127.0.0.1/x", "title": "x", "active": true, "attachable":true})),
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
    assert_eq!(tool(&mut mcp, "browser_tabs", json!({"action": "new", "url": 42})).await["error"]["code"], "INVALID_PARAMS");
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

#[tokio::test]
async fn undeclared_arguments_are_not_forwarded_to_the_browser() {
    fn echo(method: &str, p: &Value) -> Result<Value, (&'static str, &'static str)> {
        match method {
            "browser.click" => Ok(json!({ "params": p })),
            _ => default_reply(method, p),
        }
    }
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), echo).await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let a = tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await;
    let c = tool(
        &mut mcp,
        "browser_click",
        json!({"operationId": a["operationId"], "ref": "s1f0e1", "frameId": 5, "tabId": 999, "generation": 0}),
    )
    .await;
    let forwarded = c["data"]["params"].as_object().unwrap();
    assert!(!forwarded.contains_key("frameId"), "{forwarded:?}");
    assert_eq!(forwarded["tabId"], 42, "the gate decides the tab, never the model");
    assert_ne!(forwarded["generation"], 0);
    assert_eq!(forwarded["ref"], "s1f0e1");
}

#[tokio::test]
async fn non_http_urls_are_rejected_before_reaching_the_browser() {
    let (_h, serve, cfg) = start_test_serve().await;
    let seen = fake_extension(serve.port, cfg.token.clone(), default_reply).await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let a = tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await;
    let op = a["operationId"].clone();
    for url in ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "data:text/html,x", "  JAVASCRIPT:1"] {
        let n = tool(&mut mcp, "browser_navigate", json!({"operationId": op, "url": url})).await;
        assert_eq!(n["error"]["code"], "UNSUPPORTED_PAGE", "{url}: {n}");
        assert_eq!(n["delivered"], false);
        let t = tool(&mut mcp, "browser_tabs", json!({"action": "new", "operationId": op, "url": url})).await;
        assert_eq!(t["error"]["code"], "UNSUPPORTED_PAGE", "{url}: {t}");
    }
    let methods = seen.lock().unwrap().clone();
    assert!(!methods.iter().any(|m| m == "browser.navigate" || m == "browser.tabs.create"), "{methods:?}");
}

// Complete a browser_tabs request against a real authenticated extension socket.
async fn attach_with_socket(mcp: Ws, ext: &mut Ws, args: Value) -> (Ws, Value) {
    call_with_socket(mcp, ext, "browser_tabs", args).await
}

async fn call_with_socket(mcp: Ws, ext: &mut Ws, name: &'static str, args: Value) -> (Ws, Value) {
    let task = tokio::spawn(async move {
        let mut mcp = mcp;
        let result = tool(&mut mcp, name, args).await;
        (mcp, result)
    });
    // Answer every command (tabs.get/create, then the attached follow-up reads) until the call returns.
    let mut task = task;
    loop {
        tokio::select! {
            done = &mut task => return done.unwrap(),
            env = recv(ext) => if let Envelope::Req { id, method, params, .. } = env {
                let response = match default_reply(&method, &params) {
                    Ok(value) => Envelope::ok(id, value),
                    Err((code, message)) => Envelope::err(id, serde_json::from_value(json!({"code":code,"message":message,"retry":"never"})).unwrap()),
                };
                send_raw(ext, &response.to_text()).await;
            },
        }
    }
}

async fn close_tab_and_status(ext: &mut Ws, tab: i64) -> Value {
    send_raw(ext, &Envelope::evt("tab.closed", json!({"tabId": tab})).to_text()).await;
    let Envelope::Res { result: Some(status), .. } = call(ext, "status.get", json!({})).await else { panic!() };
    status
}

#[tokio::test]
async fn selected_extension_tab_closed_allows_switch_and_release() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut ext = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut ext, "extension", &cfg.token, "cli-1").await;
    let mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let (mcp, attached) = attach_with_socket(mcp, &mut ext, json!({"action":"attach"})).await;
    let op = attached["operationId"].clone();
    let (mcp, _) = attach_with_socket(mcp, &mut ext, json!({"action":"new","operationId":op,"url":"http://127.0.0.1/y"})).await;
    let status = close_tab_and_status(&mut ext, 77).await;
    assert_eq!(status["operation"]["currentTabClosed"], false);
    assert_eq!(status["operation"]["currentTab"],42);
    assert_eq!(status["operation"]["needsObservation"],true);
    let (mcp, blocked) = call_with_socket(mcp, &mut ext, "browser_fill", json!({"operationId":op,"ref":"s1f0e1","text":"do not retarget"})).await;
    assert_eq!(blocked["error"]["code"], "STALE_ELEMENT");
    assert!(blocked["data"]["snapshot"].is_object(), "a blocked write carries the restored tab's snapshot: {blocked}");
    let (mut mcp, switched) = attach_with_socket(mcp, &mut ext, json!({"action":"switch","operationId":op,"tabId":42})).await;
    assert_eq!(switched["ok"], true, "{switched}");
    assert_eq!(close_tab_and_status(&mut ext, 42).await["operation"]["currentTabClosed"], true);
    let released = tool(&mut mcp, "browser_tabs", json!({"action":"release","operationId":op})).await;
    assert_eq!(released["ok"], true, "{released}");
}

#[tokio::test]
async fn another_profile_or_superseded_connection_cannot_close_operation_tab() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut old = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut old, "extension", &cfg.token, "cli-1").await;
    let mut ext = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut ext, "extension", &cfg.token, "cli-1").await;
    let mut other = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut other, "extension", &cfg.token, "cli-2").await;
    let mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let (_mcp, _) = attach_with_socket(mcp, &mut ext, json!({"action":"attach"})).await;
    for socket in [&mut old, &mut other] {
        assert_eq!(close_tab_and_status(socket, 42).await["operation"]["currentTabClosed"], false);
    }
    assert_eq!(close_tab_and_status(&mut ext, 42).await["operation"]["currentTabClosed"], true);
}

#[tokio::test]
async fn profile_switch_is_busy_until_operation_is_released() {
    let (_h, serve, cfg) = start_test_serve().await;
    fake_extension(serve.port, cfg.token.clone(), default_reply).await;
    let mut panel = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut panel, "extension", &cfg.token, "cli-2").await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let attached = tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await;
    assert_eq!(err_code(&call(&mut panel, "browser.use", json!({"clientId":"cli-2"})).await), Some(agent_browser_bridge::rpc::ErrorCode::BrowserBusy));
    assert!(matches!(call(&mut panel, "browser.use", json!({"clientId":"cli-1"})).await, Envelope::Res { ok: true, .. }));
    tool(&mut mcp, "browser_tabs", json!({"action":"release","operationId":attached["operationId"]})).await;
    assert!(matches!(call(&mut panel, "browser.use", json!({"clientId":"cli-2"})).await, Envelope::Res { ok: true, .. }));
}

#[tokio::test]
async fn profile_switch_during_attach_returns_busy_without_blocking_browser_reply() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut ext = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut ext, "extension", &cfg.token, "cli-1").await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let attaching = tokio::spawn(async move { tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await });
    let request_id = loop {
        if let Envelope::Req { id, method, .. } = recv(&mut ext).await {
            assert_eq!(method, "browser.tabs.get");
            break id;
        }
    };
    // Same socket can issue UI requests while handling the pending browser command.
    let switched = tokio::time::timeout(std::time::Duration::from_millis(200),
        call(&mut ext, "browser.use", json!({"clientId":"cli-2"}))).await.expect("must not block the reply loop");
    assert_eq!(err_code(&switched), Some(agent_browser_bridge::rpc::ErrorCode::BrowserBusy));
    send_raw(&mut ext, &Envelope::ok(request_id, json!({"tabId":42,"url":"http://127.0.0.1/x"})).to_text()).await;
    // attach now returns its first snapshot and open tabs; answer those follow-up reads too.
    let mut attaching = attaching;
    let attached = loop {
        tokio::select! {
            done = &mut attaching => break done.unwrap(),
            env = recv(&mut ext) => if let Envelope::Req { id, method, .. } = env {
                assert!(matches!(method.as_str(), "browser.snapshot" | "browser.tabs.list"), "{method}");
                send_raw(&mut ext, &Envelope::ok(id, json!({"snapshotId": 1, "frames": [], "tabs": [], "tabId": 42})).to_text()).await;
            },
        }
    };
    assert_eq!(attached["ok"], true);
}

#[tokio::test]
async fn r01_cancel_crossing_attach_response_releases_only_that_operation() {
    let (_h,serve,cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port,cfg.token.clone(),default_reply).await;
    let mut mcp = mcp_client(serve.port,&cfg.token,"cancel-crossing").await;
    let request = Envelope::req("tool.call",json!({"name":"browser_tabs","arguments":{"action":"attach"}}));
    send_raw(&mut mcp,&request.to_text()).await;
    let Envelope::Res {result:Some(result),..} = recv(&mut mcp).await else {panic!("expected attach");};
    assert_eq!(result["ok"],true);
    call(&mut mcp,"tool.cancel",json!({"requestId":request.id()})).await;
    let next = tool(&mut mcp,"browser_tabs",json!({"action":"attach"})).await;
    assert_eq!(next["ok"],true);
    call(&mut mcp,"tool.cancel",json!({"requestId":request.id()})).await;
    let snapshot = tool(&mut mcp,"browser_snapshot",json!({"operationId":next["operationId"]})).await;
    assert_eq!(snapshot["ok"],true,"late cancellation must not stop a replacement operation");
}

#[tokio::test]
async fn close_requires_current_target_and_observation_after_return_then_allows_original_close() {
    let (_h, serve, cfg) = start_test_serve().await;
    let seen = fake_extension(serve.port, cfg.token.clone(), |method,p| {
        if method == "browser.tabs.close" { assert!(matches!(p["tabId"].as_i64(),Some(42|77))); return Ok(json!({"closed":true})); }
        if method == "browser.tabs.get" { return Ok(json!({"tabId":p["tabId"].as_i64().unwrap_or(42),"attachable":true})); }
        default_reply(method,p)
    }).await;
    let mut mcp = mcp_client(serve.port,&cfg.token,"close-client").await;
    let a=tool(&mut mcp,"browser_tabs",json!({"action":"attach"})).await;
    let op=a["operationId"].as_str().unwrap();
    let rejected=tool(&mut mcp,"browser_tabs",json!({"action":"close","operationId":op,"tabId":77})).await;
    assert_eq!(rejected["error"]["code"],"INVALID_PARAMS");
    assert!(!seen.lock().unwrap().iter().any(|m|m=="browser.tabs.close"));
    assert_eq!(tool(&mut mcp,"browser_tabs",json!({"action":"new","operationId":op,"url":"https://example.test"})).await["ok"],true);
    assert_eq!(tool(&mut mcp,"browser_tabs",json!({"action":"close","operationId":op,"tabId":42})).await["error"]["code"],"INVALID_PARAMS");
    assert_eq!(tool(&mut mcp,"browser_tabs",json!({"action":"close","operationId":op})).await["executed"],"yes");
    assert_eq!(tool(&mut mcp,"browser_tabs",json!({"action":"close","operationId":op})).await["error"]["code"],"STALE_ELEMENT");
    assert_eq!(tool(&mut mcp,"browser_snapshot",json!({"operationId":op})).await["data"]["tabId"],42);
    assert_eq!(tool(&mut mcp,"browser_tabs",json!({"action":"close","operationId":op})).await["executed"],"yes");
    assert_eq!(tool(&mut mcp,"browser_snapshot",json!({"operationId":op})).await["error"]["code"],"TAB_CLOSED");
}

#[tokio::test]
async fn new_can_reserve_an_operation_without_attach_and_existing_operation_is_protected() {
    let (_h,serve,cfg)=start_test_serve().await;
    let seen=fake_extension(serve.port,cfg.token.clone(),default_reply).await;
    let mut mcp=mcp_client(serve.port,&cfg.token,"new-client").await;
    let created=tool(&mut mcp,"browser_tabs",json!({"action":"new"})).await;
    assert_eq!(created["ok"],true);assert_eq!(created["data"]["tab"]["url"],"about:blank");
    assert_eq!(tool(&mut mcp,"browser_tabs",json!({"action":"new"})).await["error"]["code"],"BROWSER_BUSY");
    assert_eq!(seen.lock().unwrap().iter().filter(|m|m.as_str()=="browser.tabs.create").count(),1);
    let op=created["operationId"].as_str().unwrap();
    assert_eq!(tool(&mut mcp,"browser_snapshot",json!({"operationId":op})).await["data"]["tabId"],77);
}
#[tokio::test]
async fn failed_standalone_creation_releases_its_reservation() {
    let (_h,serve,cfg)=start_test_serve().await;
    fake_extension(serve.port,cfg.token.clone(),|method,p| {
        if method=="browser.tabs.create" {Err(("EXECUTION_UNKNOWN","synthetic failure"))}else{default_reply(method,p)}
    }).await;
    let mut mcp=mcp_client(serve.port,&cfg.token,"failed-new").await;
    assert_eq!(tool(&mut mcp,"browser_tabs",json!({"action":"new"})).await["error"]["code"],"EXECUTION_UNKNOWN");
    assert_eq!(tool(&mut mcp,"browser_tabs",json!({"action":"attach"})).await["ok"],true);
}

fn snapshot_reply(method: &str, p: &Value) -> Result<Value, (&'static str, &'static str)> {
    match method {
        "browser.snapshot" => Ok(json!({"snapshotId": 7, "url": "http://127.0.0.1/x", "frames": [{"elements":[{"ref":"s7f0e1","name":"다음"}]}], "tabId": p["tabId"], "maxChars": p["maxChars"], "settleMs": p["settleMs"]})),
        "browser.click" if p["ref"] == "stale" => Err(("STALE_ELEMENT", "Element ref stale is no longer in the page.")),
        "browser.click" if p["ref"] == "noop" => Ok(json!({"executed": true, "verified": {"urlChanged": false, "domChanged": false}})),
        "browser.click" if p["ref"] == "opener" => Ok(json!({"executed": true, "verified": {"urlChanged": false, "domChanged": true},
            "openedTabs": [{"tabId": 77, "url": "http://127.0.0.1/n", "sourceTabId": p["tabId"], "sourceFrameId": 0}]})),
        _ => default_reply(method, p),
    }
}

#[tokio::test]
async fn page_changing_actions_return_a_fresh_snapshot() {
    let (_h, serve, cfg) = start_test_serve().await;
    let seen = fake_extension(serve.port, cfg.token.clone(), snapshot_reply).await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let attached = tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await;
    assert_eq!(attached["data"]["snapshot"]["snapshotId"], 7);
    let op = attached["operationId"].as_str().unwrap().to_string();
    let clicked = tool(&mut mcp, "browser_click", json!({"operationId": op, "ref": "s7f0e1"})).await;
    assert_eq!(clicked["ok"], true);
    assert_eq!(clicked["data"]["snapshot"]["frames"][0]["elements"][0]["name"], "다음");
    assert_eq!(clicked["data"]["snapshot"]["maxChars"], 1500, "follow-up snapshots spend less context on page text");
    assert_eq!(clicked["data"]["snapshot"]["settleMs"], 6000);
    let unchanged = tool(&mut mcp, "browser_click", json!({"operationId": op, "ref": "noop"})).await;
    assert!(unchanged["data"]["snapshot"].is_null(), "refs stay valid when nothing changed");
    let stale = tool(&mut mcp, "browser_click", json!({"operationId": op, "ref": "stale"})).await;
    assert_eq!(stale["error"]["code"], "STALE_ELEMENT");
    assert_eq!(stale["data"]["snapshot"]["snapshotId"], 7);
    let filled = tool(&mut mcp, "browser_fill", json!({"operationId": op, "ref": "s7f0e1", "text": "x"})).await;
    assert!(filled["data"]["snapshot"].is_null(), "fill does not change the page structure");
    assert_eq!(seen.lock().unwrap().iter().filter(|m| *m == "browser.snapshot").count(), 3);
}

#[tokio::test]
async fn click_that_opens_a_tab_returns_the_new_tab_snapshot() {
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), snapshot_reply).await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let op = tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await["operationId"].as_str().unwrap().to_string();
    let clicked = tool(&mut mcp, "browser_click", json!({"operationId": op, "ref": "opener"})).await;
    assert_eq!(clicked["data"]["currentTab"], 77);
    assert_eq!(clicked["data"]["snapshot"]["tabId"], 77);
}

fn tabs_reply(method: &str, p: &Value) -> Result<Value, (&'static str, &'static str)> {
    match method {
        "browser.tabs.list" => Ok(json!({"tabs":[
            {"tabId":42,"windowId":1,"title":"현재","url":"http://127.0.0.1/x","active":true,"attachable":true},
            {"tabId":43,"windowId":1,"title":"메일","url":"http://127.0.0.1/mail","active":false,"attachable":true}]})),
        "browser.tabs.get" if p["tabId"] == 999 => Err(("TAB_NOT_FOUND", "No such fixture tab")),
        "browser.tabs.get" => Ok(json!({"tabId": p["tabId"].as_i64().unwrap_or(42), "windowId": 1, "url": "http://127.0.0.1/x", "title": "x", "active": true, "attachable": true})),
        _ => snapshot_reply(method, p),
    }
}

#[tokio::test]
async fn attach_lists_open_tabs_and_a_failed_switch_offers_them_again() {
    let (_h, serve, cfg) = start_test_serve().await;
    let _ext = fake_extension(serve.port, cfg.token.clone(), tabs_reply).await;
    let mut mcp = mcp_client(serve.port, &cfg.token, "mcp-1").await;
    let attached = tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await;
    assert_eq!(attached["data"]["openTabs"][1]["tabId"], 43);
    assert_eq!(attached["data"]["openTabs"][1]["title"], "메일");
    let op = attached["operationId"].as_str().unwrap().to_string();
    let missed = tool(&mut mcp, "browser_tabs", json!({"action":"switch","operationId":op,"tabId":999})).await;
    assert_eq!(missed["error"]["code"], "TAB_NOT_FOUND");
    assert_eq!(missed["data"]["openTabs"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn follow_up_snapshots_ask_for_fewer_elements_than_a_full_read() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut ext = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut ext, "extension", &cfg.token, "cli-1").await;
    let mcp = mcp_client(serve.port, &cfg.token, "follow-cap").await;
    let task = tokio::spawn(async move { let mut mcp = mcp; tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await });
    let mut snapshot_params = None;
    let mut task = task;
    loop {
        tokio::select! {
            done = &mut task => { done.unwrap(); break; }
            env = recv(&mut ext) => if let Envelope::Req { id, method, params, .. } = env {
                if method == "browser.snapshot" { snapshot_params = Some(params.clone()); }
                let reply = default_reply(&method, &params).map(|v| Envelope::ok(id.clone(), v))
                    .unwrap_or_else(|_| Envelope::ok(id.clone(), json!({"tabs": []})));
                send_raw(&mut ext, &reply.to_text()).await;
            },
        }
    }
    assert_eq!(snapshot_params.unwrap()["maxElements"], 40);
}

#[tokio::test]
async fn resume_requires_a_fresh_snapshot_before_writing() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut ext = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut ext, "extension", &cfg.token, "cli-1").await;
    let mcp = mcp_client(serve.port, &cfg.token, "handoff").await;
    let (mcp, attached) = attach_with_socket(mcp, &mut ext, json!({"action":"attach"})).await;
    let op = attached["operationId"].clone();
    assert!(matches!(call(&mut ext, "operation.pause", json!({"operationId":op,"clientId":"cli-1"})).await, Envelope::Res { ok: true, .. }));
    assert!(matches!(call(&mut ext, "operation.resume", json!({"operationId":op,"clientId":"cli-1"})).await, Envelope::Res { ok: true, .. }));
    let (mcp, stale) = call_with_socket(mcp, &mut ext, "browser_fill", json!({"operationId":op,"ref":"s1f0e1","text":"x"})).await;
    assert_eq!(stale["error"]["code"], "STALE_ELEMENT", "{stale}");
    let (mcp, _) = call_with_socket(mcp, &mut ext, "browser_snapshot", json!({"operationId":op})).await;
    let (_mcp, filled) = call_with_socket(mcp, &mut ext, "browser_fill", json!({"operationId":op,"ref":"s1f0e1","text":"x"})).await;
    assert_eq!(filled["ok"], true, "{filled}");
}
