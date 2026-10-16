#![allow(dead_code)]
use agent_browser_bridge::{config::{self, Config}, rpc::{parse_envelope, Envelope, ErrorCode}, server::{self, ServeHandle, ServeOptions}};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::{client::IntoClientRequest, Message}, MaybeTlsStream, WebSocketStream};

pub type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub async fn start_test_serve() -> (tempfile::TempDir, ServeHandle, Config) {
    let home = tempfile::tempdir().unwrap();
    let cfg = config::load_or_init(home.path()).unwrap();
    let serve = server::start(ServeOptions { home: home.path().to_path_buf(), port: 0 }).await.unwrap();
    (home, serve, cfg)
}

pub async fn ws_connect(port: u16, path: &str, origin: Option<&str>) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
    let mut req = format!("ws://127.0.0.1:{port}{path}").into_client_request()?;
    if let Some(o) = origin {
        req.headers_mut().insert("Origin", o.parse().unwrap());
    }
    Ok(connect_async(req).await?.0)
}

pub async fn send_raw(ws: &mut Ws, text: &str) {
    ws.send(Message::text(text)).await.unwrap();
}

pub async fn recv(ws: &mut Ws) -> Envelope {
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await.expect("recv timeout") {
            Some(Ok(Message::Text(t))) => return parse_envelope(&t).unwrap(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            other => panic!("unexpected frame: {other:?}"),
        }
    }
}

/// Sends a request and waits for the response with the same id; `evt` frames in between are skipped.
pub async fn call(ws: &mut Ws, method: &str, params: serde_json::Value) -> Envelope {
    let req = Envelope::req(method, params);
    send_raw(ws, &req.to_text()).await;
    loop {
        let env = recv(ws).await;
        if matches!(env, Envelope::Res { .. }) && env.id() == req.id() {
            return env;
        }
    }
}

/// Waits for the next `evt` with this name, ignoring everything else.
pub async fn next_event(ws: &mut Ws, name: &str) -> serde_json::Value {
    loop {
        if let Envelope::Evt { event, data, .. } = recv(ws).await {
            if event == name {
                return data;
            }
        }
    }
}

pub async fn hello(ws: &mut Ws, role: &str, token: &str, client_id: &str) -> Envelope {
    hello_repair(ws, role, token, client_id, false).await
}

pub async fn hello_repair(ws: &mut Ws, role: &str, token: &str, client_id: &str, repair: bool) -> Envelope {
    use agent_browser_bridge::auth;
    let nonce = auth::nonce();
    let challenge = call(ws, "auth.hello", serde_json::json!({
        "authVersion":1,"role":role,"clientId":client_id,"clientNonce":nonce,"clientVersion":"test","repair":repair
    })).await;
    let Envelope::Res { ok: true, result: Some(challenge), .. } = challenge else { return challenge };
    let server_nonce = challenge["serverNonce"].as_str().unwrap();
    // Intentionally send an incorrect proof for wrong-token server rejection tests.
    let proof = auth::proof(token, &auth::transcript("client", role, client_id, &nonce, server_nonce, repair));
    call(ws, "auth.prove", serde_json::json!({"authVersion":1,"proof":proof})).await
}

/// Like `hello`, with extra hello parameters (for example an MCP proxy's runtimeId/cwd).
pub async fn hello_with(ws: &mut Ws, role: &str, token: &str, client_id: &str, extra: serde_json::Value) -> Envelope {
    use agent_browser_bridge::auth;
    let nonce = auth::nonce();
    let mut params = serde_json::json!({"authVersion":1,"role":role,"clientId":client_id,"clientNonce":nonce,"clientVersion":"test","repair":false});
    if let (Some(target), Some(fields)) = (params.as_object_mut(), extra.as_object()) { for (key, value) in fields { target.insert(key.clone(), value.clone()); } }
    let challenge = call(ws, "auth.hello", params).await;
    let Envelope::Res { ok: true, result: Some(challenge), .. } = challenge else { return challenge };
    let server_nonce = challenge["serverNonce"].as_str().unwrap();
    let proof = auth::proof(token, &auth::transcript("client", role, client_id, &nonce, server_nonce, false));
    call(ws, "auth.prove", serde_json::json!({"authVersion":1,"proof":proof})).await
}

pub fn err_code(env: &Envelope) -> Option<ErrorCode> {
    match env { Envelope::Res { ok: false, error: Some(e), .. } => Some(e.code), _ => None }
}

pub async fn next_is_close(ws: &mut Ws) -> bool {
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await,
        Ok(None) | Ok(Some(Ok(Message::Close(_)))) | Ok(Some(Err(_)))
    )
}
