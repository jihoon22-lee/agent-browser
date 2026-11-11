mod common;
use agent_browser_bridge::rpc::{parse_envelope, Envelope};
use common::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const EXT: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

/// Fake extension that answers `browser.snapshot` with a raw frame: `{ID}` is the command id,
/// so the frame can be text that no JSON serializer would produce.
async fn raw_extension(port: u16, token: &str, snapshot_frame: &'static str) {
    let mut ws = ws_connect(port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut ws, "extension", token, "cli-1").await;
    tokio::spawn(async move {
        use futures_util::StreamExt;
        while let Some(Ok(msg)) = ws.next().await {
            let Ok(text) = msg.into_text() else { continue };
            let Ok(Envelope::Req { id, method, params, .. }) = parse_envelope(&text) else { continue };
            let frame = match method.as_str() {
                "browser.snapshot" | "browser.fill" => snapshot_frame.replace("{ID}", &id),
                "browser.tabs.get" => Envelope::ok(id, json!({"tabId": params["tabId"].as_i64().unwrap_or(42), "url": "http://127.0.0.1/x", "attachable": true})).to_text(),
                _ => Envelope::ok(id, json!({"tabs": []})).to_text(),
            };
            send_raw(&mut ws, &frame).await;
        }
    });
}

async fn tool(ws: &mut Ws, name: &str, args: Value) -> Value {
    let Envelope::Res { ok: true, result: Some(result), .. } = call(ws, "tool.call", json!({"name": name, "arguments": args})).await else { panic!("tool.call failed") };
    result
}

async fn attached(port: u16, token: &str) -> (Ws, String) {
    let mut mcp = ws_connect(port, "/mcp-proxy", None).await.unwrap();
    hello(&mut mcp, "mcp", token, "mcp-1").await;
    // attach's own follow-up snapshot gets the same frame; only the operation id is needed here.
    let attach = tool(&mut mcp, "browser_tabs", json!({"action": "attach"})).await;
    let op = attach["operationId"].as_str().unwrap_or_else(|| panic!("{attach}")).to_string();
    (mcp, op)
}

#[tokio::test]
async fn a_reply_with_a_lone_surrogate_escape_completes_the_command() {
    let (_h, serve, cfg) = start_test_serve().await;
    raw_extension(serve.port, &cfg.token, r#"{"v":1,"type":"res","id":"{ID}","ok":true,"result":{"tabId":42,"cut":"xxxx\ud83d","pair":"😀","literal":"\\ud83d"}}"#).await;
    let (mut mcp, op) = attached(serve.port, &cfg.token).await;
    let started = Instant::now();
    let snapshot = tool(&mut mcp, "browser_snapshot", json!({"operationId": op})).await;
    assert_eq!(snapshot["ok"], true, "{snapshot}");
    assert_eq!(snapshot["data"]["cut"], "xxxx\u{fffd}", "the lone surrogate is replaced, the rest kept");
    assert_eq!(snapshot["data"]["pair"], "\u{1f600}", "a valid pair is untouched");
    assert_eq!(snapshot["data"]["literal"], "\\ud83d", "an escaped backslash followed by text is untouched");
    assert!(started.elapsed() < Duration::from_secs(3), "the reply must complete the command, not its timeout");
}

#[tokio::test]
async fn an_unparseable_reply_fails_its_command_at_once() {
    let (_h, serve, cfg) = start_test_serve().await;
    raw_extension(serve.port, &cfg.token, r#"{"v":1,"type":"res","id":"{ID}","ok":true,"result":{"text":"bad \x escape"}}"#).await;
    let (mut mcp, op) = attached(serve.port, &cfg.token).await;
    let started = Instant::now();
    let snapshot = tool(&mut mcp, "browser_snapshot", json!({"operationId": op})).await;
    assert_eq!(snapshot["error"]["code"], "INTERNAL", "{snapshot}");
    assert_eq!(snapshot["error"]["retry"], "safe");
    let filled = tool(&mut mcp, "browser_fill", json!({"operationId": op, "ref": "s1f0e1", "text": "x"})).await;
    assert_eq!(filled["error"]["code"], "EXECUTION_UNKNOWN", "a write whose reply is unreadable may have run: {filled}");
    assert_eq!(filled["executed"], "unknown");
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}: the commands waited for their timeouts", started.elapsed());
}
