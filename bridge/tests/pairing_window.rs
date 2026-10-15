mod common;
use agent_browser_bridge::rpc::Envelope;
use common::*;
use serde_json::json;

const FIXED: &str = "icgmjjcpnaenpfjfoggnaodeaidbnihl";

async fn pair_request(port: u16, extension_id: &str, code: Option<&str>) -> Envelope {
    let mut ws = ws_connect(port, "/extension", Some(&format!("chrome-extension://{extension_id}"))).await.unwrap();
    let params = match code { Some(code) => json!({"clientId":"cli-new","code":code}), None => json!({"clientId":"cli-new"}) };
    call(&mut ws, "pair.request", params).await
}

async fn installer(port: u16, token: &str) -> Ws {
    let mut ws = ws_connect(port, "/mcp-proxy", None).await.unwrap();
    hello(&mut ws, "mcp", token, "installer").await;
    ws
}

async fn open_window(installer: &mut Ws) -> String {
    let opened = call(installer, "pairing.open", json!({"extensionId": FIXED, "seconds": 60})).await;
    let Envelope::Res { ok: true, result: Some(result), .. } = opened else { panic!("{opened:?}") };
    let code = result["code"].as_str().unwrap().to_string();
    assert!(code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit()), "{code}");
    code
}

#[tokio::test]
async fn the_token_is_handed_only_for_the_shown_code_and_the_fixed_extension() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut installer = installer(serve.port, &cfg.token).await;
    assert!(matches!(pair_request(serve.port, FIXED, None).await, Envelope::Res { ok: false, .. }), "without a window nothing is granted");
    let seen = call(&mut installer, "status.get", json!({})).await;
    let Envelope::Res { ok: true, result: Some(seen), .. } = seen else { panic!("{seen:?}") };
    assert_eq!(seen["extensionSeen"], FIXED, "the wizard can tell the extension was loaded");
    let code = open_window(&mut installer).await;
    assert!(matches!(pair_request(serve.port, FIXED, None).await, Envelope::Res { ok: false, .. }), "no code, no token: never trust on first use");
    assert!(matches!(pair_request(serve.port, "abcdefghijklmnopabcdefghijklmnop", Some(&code)).await, Envelope::Res { ok: false, .. }), "another extension must not get the token");
    let Envelope::Res { ok: true, result: Some(granted), .. } = pair_request(serve.port, FIXED, Some(&code)).await else { panic!("the shown code did not pair") };
    assert_eq!(granted["token"], cfg.token, "pairing hands over the existing token, never a new one");
    assert!(matches!(pair_request(serve.port, FIXED, Some(&code)).await, Envelope::Res { ok: false, .. }), "the window is one-shot");
}

#[tokio::test]
async fn five_wrong_codes_close_the_window() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut installer = installer(serve.port, &cfg.token).await;
    let code = open_window(&mut installer).await;
    let wrong = if code == "000000" { "111111" } else { "000000" };
    for _ in 0..5 { assert!(matches!(pair_request(serve.port, FIXED, Some(wrong)).await, Envelope::Res { ok: false, .. })); }
    assert!(matches!(pair_request(serve.port, FIXED, Some(&code)).await, Envelope::Res { ok: false, .. }), "guessing must exhaust the window");
}

#[tokio::test]
async fn pairing_open_rejects_invalid_ids_and_durations() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut installer = installer(serve.port, &cfg.token).await;
    for params in [json!({"extensionId":"not-an-id"}), json!({"extensionId": FIXED, "seconds": 3600})] {
        assert!(matches!(call(&mut installer, "pairing.open", params).await, Envelope::Res { ok: false, .. }));
    }
}
