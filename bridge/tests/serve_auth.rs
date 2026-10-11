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
    let res = hello_repair(&mut b, "extension", &cfg.token, "cli-2", true).await;
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
    let res = hello_repair(&mut b, "extension", "wrong", "cli-2", true).await;
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

#[tokio::test]
async fn extension_status_get_reports_selected_browser() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    hello(&mut ws, "extension", &cfg.token, "cli-1").await;
    let res = call(&mut ws, "status.get", serde_json::json!({})).await;
    let Envelope::Res { ok: true, result: Some(r), .. } = res else { panic!("{res:?}") };
    assert_eq!(r["browsers"][0]["clientId"], "cli-1");
    assert_eq!(r["browsers"][0]["selected"], true);
}

#[tokio::test]
async fn auto_selection_of_the_only_browser_is_persisted() {
    let (home, serve, cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    hello(&mut ws, "extension", &cfg.token, "cli-1").await;
    let saved = agent_browser_bridge::config::load_or_init(home.path()).unwrap();
    assert_eq!(saved.selected_client_id.as_deref(), Some("cli-1"));
}

#[tokio::test]
async fn browser_use_changes_and_persists_the_selected_browser() {
    let (home, serve, cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    hello(&mut ws, "extension", &cfg.token, "cli-1").await;
    let res = call(&mut ws, "browser.use", serde_json::json!({"clientId": "cli-9"})).await;
    assert!(matches!(res, Envelope::Res { ok: true, .. }), "{res:?}");
    let status = call(&mut ws, "status.get", serde_json::json!({})).await;
    let Envelope::Res { result: Some(r), .. } = status else { panic!() };
    let selected: Vec<_> = r["browsers"].as_array().unwrap().iter().filter(|b| b["selected"] == true).collect();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0]["clientId"], "cli-9");
    assert_eq!(selected[0]["connected"], false);
    let saved = agent_browser_bridge::config::load_or_init(home.path()).unwrap();
    assert_eq!(saved.selected_client_id.as_deref(), Some("cli-9"));
}

#[tokio::test]
async fn abort_without_active_operation_reports_not_aborted() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    hello(&mut ws, "extension", &cfg.token, "cli-1").await;
    let res = call(&mut ws, "operation.abort", serde_json::json!({})).await;
    let Envelope::Res { ok: true, result: Some(r), .. } = res else { panic!("{res:?}") };
    assert_eq!(r["aborted"], false);
}

#[tokio::test]
async fn status_changed_is_broadcast_when_another_browser_connects() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut a = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    hello(&mut a, "extension", &cfg.token, "cli-1").await;
    let mut b = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    hello(&mut b, "extension", &cfg.token, "cli-2").await;
    // `a` first sees its own registration, then cli-2 joining; wait until both browsers are listed.
    loop {
        let data = next_event(&mut a, "status.changed").await;
        if data["browsers"].as_array().is_some_and(|b| b.len() == 2) {
            break;
        }
    }
}

#[tokio::test]
async fn legacy_token_hello_is_refused_without_pairing() {
    let (home, serve, cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    let response = call(&mut ws, "auth.hello", serde_json::json!({
        "role":"extension", "token":cfg.token, "clientId":"old-client"
    })).await;
    assert_eq!(err_code(&response), Some(ErrorCode::AuthFailed));
    assert!(agent_browser_bridge::config::load_or_init(home.path()).unwrap().paired_extension_id.is_none());
}

#[tokio::test]
async fn hello_challenge_does_not_pair_or_authorize_commands() {
    let (home, serve, _cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/extension", Some(EXT_ORIGIN)).await.unwrap();
    let response = call(&mut ws, "auth.hello", serde_json::json!({
        "authVersion":1,"role":"extension","clientId":"cli-1","clientNonce":"11".repeat(32),"repair":false
    })).await;
    let Envelope::Res { ok: true, result: Some(challenge), .. } = response else { panic!("{response:?}") };
    assert_eq!(challenge["authVersion"], 1);
    assert_eq!(challenge["serverNonce"].as_str().unwrap().len(), 64);
    assert_eq!(challenge["serverProof"].as_str().unwrap().len(), 64);
    assert!(agent_browser_bridge::config::load_or_init(home.path()).unwrap().paired_extension_id.is_none());
    let response = call(&mut ws, "status.get", serde_json::json!({})).await;
    assert_eq!(err_code(&response), Some(ErrorCode::AuthRequired));
    assert!(next_is_close(&mut ws).await);
}

#[tokio::test]
async fn server_proof_cannot_be_reflected_as_client_proof() {
    let (_home, serve, cfg) = start_test_serve().await;
    let mut ws = ws_connect(serve.port, "/mcp-proxy", None).await.unwrap();
    let client_nonce = "11".repeat(32);
    let response = call(&mut ws, "auth.hello", serde_json::json!({
        "authVersion":1,"role":"mcp","clientId":"proof-test","clientNonce":client_nonce,"repair":false
    })).await;
    let Envelope::Res { result: Some(challenge), .. } = response else { panic!("{response:?}") };
    assert!(agent_browser_bridge::auth::verify(&cfg.token,
        &agent_browser_bridge::auth::transcript("server", "mcp", "proof-test", &client_nonce, challenge["serverNonce"].as_str().unwrap(), false),
        challenge["serverProof"].as_str().unwrap()));
    let response = call(&mut ws, "auth.prove", serde_json::json!({"authVersion":1,"proof":challenge["serverProof"]})).await;
    assert_eq!(err_code(&response), Some(ErrorCode::AuthFailed));
    assert!(next_is_close(&mut ws).await);
}

#[tokio::test]
async fn client_proof_cannot_be_replayed_on_another_connection() {
    use agent_browser_bridge::auth;
    let (_home, serve, cfg) = start_test_serve().await;
    let mut first = ws_connect(serve.port, "/mcp-proxy", None).await.unwrap();
    let nonce = "11".repeat(32);
    let params = serde_json::json!({"authVersion":1,"role":"mcp","clientId":"proof-test","clientNonce":nonce,"repair":false});
    let response = call(&mut first, "auth.hello", params.clone()).await;
    let Envelope::Res { result: Some(challenge), .. } = response else { panic!("{response:?}") };
    let proof = auth::proof(&cfg.token, &auth::transcript("client", "mcp", "proof-test", &nonce, challenge["serverNonce"].as_str().unwrap(), false));
    let accepted = call(&mut first, "auth.prove", serde_json::json!({"authVersion":1,"proof":proof})).await;
    assert!(matches!(accepted, Envelope::Res { ok: true, .. }));
    let mut second = ws_connect(serve.port, "/mcp-proxy", None).await.unwrap();
    let response = call(&mut second, "auth.hello", params).await;
    let Envelope::Res { result: Some(next), .. } = response else { panic!("{response:?}") };
    assert_ne!(challenge["serverNonce"], next["serverNonce"]);
    let rejected = call(&mut second, "auth.prove", serde_json::json!({"authVersion":1,"proof":proof})).await;
    assert_eq!(err_code(&rejected), Some(ErrorCode::AuthFailed));
    assert!(next_is_close(&mut second).await);
}

#[tokio::test]
async fn client_proof_binds_role_client_id_and_repair() {
    use agent_browser_bridge::auth;
    let (_home, serve, cfg) = start_test_serve().await;
    for (signed_role, signed_client, signed_repair) in [("extension", "proof-test", false), ("mcp", "other-client", false), ("mcp", "proof-test", true)] {
        let mut ws = ws_connect(serve.port, "/mcp-proxy", None).await.unwrap();
        let nonce = auth::nonce();
        let response = call(&mut ws, "auth.hello", serde_json::json!({"authVersion":1,"role":"mcp","clientId":"proof-test","clientNonce":nonce,"repair":false})).await;
        let Envelope::Res { result: Some(challenge), .. } = response else { panic!("{response:?}") };
        let proof = auth::proof(&cfg.token, &auth::transcript("client", signed_role, signed_client, &nonce, challenge["serverNonce"].as_str().unwrap(), signed_repair));
        let rejected = call(&mut ws, "auth.prove", serde_json::json!({"authVersion":1,"proof":proof})).await;
        assert_eq!(err_code(&rejected), Some(ErrorCode::AuthFailed));
    }
}
