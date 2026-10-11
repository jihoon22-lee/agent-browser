/// Returns true when an agent-browser serve that accepts `token` answers on `port`.
pub async fn probe(port: u16, token: &str) -> bool {
    let Ok(Ok((mut ws, _))) = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/mcp-proxy")),
    ).await else { return false };
    let hello = crate::rpc::Envelope::req("auth.hello", serde_json::json!({"role":"mcp","token":token,"clientId":"probe","clientVersion":env!("CARGO_PKG_VERSION")}));
    use futures_util::{SinkExt, StreamExt};
    if ws.send(tokio_tungstenite::tungstenite::Message::text(hello.to_text())).await.is_err() { return false; }
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(2), ws.next()).await,
        Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t)))) if t.contains("\"serverName\":\"agent-browser\"")
    )
}
