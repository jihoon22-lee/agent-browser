mod common;
use agent_browser_bridge::rpc::Envelope;
use common::*;
use serde_json::json;

const FIXED: &str = "icgmjjcpnaenpfjfoggnaodeaidbnihl";

async fn pair_request(port: u16, extension_id: &str) -> Envelope {
    let mut ws = ws_connect(port, "/extension", Some(&format!("chrome-extension://{extension_id}"))).await.unwrap();
    call(&mut ws, "pair.request", json!({"clientId":"cli-new"})).await
}

#[tokio::test]
async fn an_open_window_hands_the_existing_token_once_to_the_fixed_extension_only() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut installer = ws_connect(serve.port, "/mcp-proxy", None).await.unwrap();
    hello(&mut installer, "mcp", &cfg.token, "installer").await;
    assert!(matches!(pair_request(serve.port, FIXED).await, Envelope::Res { ok: false, .. }), "a closed window must refuse");
    let seen = call(&mut installer, "status.get", json!({})).await;
    let Envelope::Res { ok: true, result: Some(seen), .. } = seen else { panic!("{seen:?}") };
    assert_eq!(seen["extensionSeen"], FIXED, "the wizard can tell the extension was loaded");
    let opened = call(&mut installer, "pairing.open", json!({"extensionId": FIXED, "seconds": 60})).await;
    assert!(matches!(opened, Envelope::Res { ok: true, .. }), "{opened:?}");
    assert!(matches!(pair_request(serve.port, "abcdefghijklmnopabcdefghijklmnop").await, Envelope::Res { ok: false, .. }), "another extension must not get the token");
    let Envelope::Res { ok: true, result: Some(granted), .. } = pair_request(serve.port, FIXED).await else { panic!("the fixed extension did not get the token") };
    assert_eq!(granted["token"], cfg.token, "pairing hands over the existing token, never a new one");
    assert!(matches!(pair_request(serve.port, FIXED).await, Envelope::Res { ok: false, .. }), "the window is one-shot");
    let status = call(&mut installer, "status.get", json!({})).await;
    let Envelope::Res { ok: true, result: Some(status), .. } = status else { panic!("{status:?}") };
    assert!(status["browsers"].is_array());
    assert_eq!(status["serverVersion"], env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn pairing_open_rejects_invalid_ids_and_durations() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut installer = ws_connect(serve.port, "/mcp-proxy", None).await.unwrap();
    hello(&mut installer, "mcp", &cfg.token, "installer").await;
    for params in [json!({"extensionId":"not-an-id"}), json!({"extensionId": FIXED, "seconds": 3600})] {
        assert!(matches!(call(&mut installer, "pairing.open", params).await, Envelope::Res { ok: false, .. }));
    }
}
