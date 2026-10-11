mod common;
use agent_browser_bridge::rpc::{Envelope, ErrorCode};
use common::*;

const EXT_ORIGIN: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

#[tokio::test]
async fn extension_with_valid_token_and_origin_is_accepted_and_paired() {
    let (home, serve, cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    let res = hello(&mut ws, "extension", &cfg.token, "cli-1").await;
    assert!(matches!(res, Envelope::Res { ok: true, .. }), "{res:?}");
    let saved = agent_browser_bridge::config::load_or_init(home.path()).unwrap();
    assert_eq!(saved.paired_extension_id.as_deref(), Some("abcdefghijklmnopabcdefghijklmnop"));
}

#[tokio::test]
async fn wrong_token_is_rejected_and_connection_closed() {
    let (_h, serve, _cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    let res = hello(&mut ws, "extension", "nope", "cli-1").await;
    assert_eq!(err_code(&res), Some(ErrorCode::AuthFailed));
    assert!(next_is_close(&mut ws).await);
}

#[tokio::test]
async fn extension_path_without_extension_origin_is_refused_at_handshake() {
    let (_h, serve, _cfg) = start_test_serve().await;
    assert!(ws_connect(serve.port, "/extension", Some("https://evil.example")).await.is_err());
    assert!(ws_connect(serve.port, "/extension", None).await.is_err());
}

#[tokio::test]
async fn mcp_proxy_with_browser_origin_is_refused() {
    let (_h, serve, _cfg) = start_test_serve().await;
    assert!(ws_connect(serve.port, "/mcp-proxy", Some("https://evil.example")).await.is_err());
}

#[tokio::test]
async fn different_extension_id_after_pairing_needs_repair() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut a = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    hello(&mut a, "extension", &cfg.token, "cli-1").await;
    let mut b = ws_connect(serve.port, "/extension", Some("chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba")).await.unwrap();
    let res = hello(&mut b, "extension", &cfg.token, "cli-2").await;
    assert_eq!(err_code(&res), Some(ErrorCode::NotPaired));
}

#[tokio::test]
async fn requests_before_hello_are_rejected() {
    let (_h, serve, _cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/mcp-proxy", None).await.unwrap();
    let res = call(&mut ws, "tool.call", serde_json::json!({"name":"browser_tabs","arguments":{"action":"list"}})).await;
    assert_eq!(err_code(&res), Some(ErrorCode::AuthRequired));
}

#[tokio::test]
async fn mcp_role_cannot_call_extension_or_admin_methods() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/mcp-proxy", None).await.unwrap();
    hello(&mut ws, "mcp", &cfg.token, "mcp-1").await;
    for m in ["operation.abort", "browser.use", "runtime.ensure", "config.set"] {
        let res = call(&mut ws, m, serde_json::json!({})).await;
        assert_eq!(err_code(&res), Some(ErrorCode::ForbiddenMethod), "{m}");
    }
}

#[tokio::test]
async fn second_serve_on_same_port_reports_already_running() {
    let (home, serve, _cfg) = start_test_serve().await;
    let err = agent_browser_bridge::server::start(agent_browser_bridge::server::ServeOptions {
        home: home.path().to_path_buf(),
        port: serve.port,
    })
    .await
    .unwrap_err();
    assert!(err.to_string().contains("already running"), "{err}");
}

#[tokio::test]
async fn unknown_protocol_version_gets_error_then_close() {
    let (_h, serve, _cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/mcp-proxy", None).await.unwrap();
    send_raw(&mut ws, r#"{"v":2,"type":"req","id":"x","method":"auth.hello","params":{}}"#).await;
    let res = recv(&mut ws).await;
    assert_eq!(err_code(&res), Some(ErrorCode::ProtocolVersionUnsupported));
    assert!(next_is_close(&mut ws).await);
}

#[tokio::test]
async fn repair_with_valid_token_replaces_the_paired_extension_id() {
    let (home, serve, cfg) = start_test_serve().await;
    let mut a = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    hello(&mut a, "extension", &cfg.token, "cli-1").await;
    let other = "ponmlkjihgfedcbaponmlkjihgfedcba";
    let mut b = ws_connect(serve.port, "/extension", Some(&format!("chrome-extension://{other}"))).await.unwrap();
    let res = call(
        &mut b,
        "auth.hello",
        serde_json::json!({"role":"extension","token":cfg.token,"clientId":"cli-2","clientVersion":"test","repair":true}),
    )
    .await;
    assert!(matches!(res, Envelope::Res { ok: true, .. }), "{res:?}");
    let saved = agent_browser_bridge::config::load_or_init(home.path()).unwrap();
    assert_eq!(saved.paired_extension_id.as_deref(), Some(other));
}

#[tokio::test]
async fn repair_with_wrong_token_does_not_replace_pairing() {
    let (home, serve, cfg) = start_test_serve().await;
    let mut a = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    hello(&mut a, "extension", &cfg.token, "cli-1").await;
    let mut b = ws_connect(serve.port, "/extension", Some("chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba")).await.unwrap();
    let res = call(
        &mut b,
        "auth.hello",
        serde_json::json!({"role":"extension","token":"wrong","clientId":"cli-2","clientVersion":"test","repair":true}),
    )
    .await;
    assert_eq!(err_code(&res), Some(ErrorCode::AuthFailed));
    let saved = agent_browser_bridge::config::load_or_init(home.path()).unwrap();
    assert_eq!(saved.paired_extension_id.as_deref(), Some("abcdefghijklmnopabcdefghijklmnop"));
}

#[tokio::test]
async fn authenticated_extension_gets_heartbeat_timestamp() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    hello(&mut ws, "extension", &cfg.token, "cli-1").await;
    let res = call(&mut ws, "heartbeat", serde_json::json!({})).await;
    match res {
        Envelope::Res { ok: true, result: Some(r), .. } => assert!(r["at"].as_u64().unwrap() > 0),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn unknown_path_is_refused_at_handshake() {
    let (_h, serve, _cfg) = start_test_serve().await;
    assert!(ws_connect(serve.port, "/other", None).await.is_err());
}
