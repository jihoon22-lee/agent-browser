use agent_browser_bridge::{config, server::{self, ServeOptions}};
use futures_util::StreamExt;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn port_conflict_probe_does_not_send_the_pairing_token_to_the_other_program() {
    let squatter = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = squatter.local_addr().unwrap().port();
    let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<String>();
    tokio::spawn(async move {
        let (stream, _) = squatter.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        if let Some(Ok(Message::Text(t))) = ws.next().await {
            let _ = seen_tx.send(t.to_string());
        }
    });
    let home = tempfile::tempdir().unwrap();
    let cfg = config::load_or_init(home.path()).unwrap();
    let err = server::start(ServeOptions { home: home.path().to_path_buf(), port }).await.unwrap_err();
    assert!(err.to_string().contains("used by another program"), "{err}");
    let seen = tokio::time::timeout(Duration::from_secs(3), seen_rx).await.unwrap().unwrap();
    assert!(!seen.contains(&cfg.token), "pairing token leaked to the program that owns the port");
}

#[tokio::test]
async fn instance_with_a_different_token_is_still_reported_as_already_running() {
    let home_a = tempfile::tempdir().unwrap();
    let a = server::start(ServeOptions { home: home_a.path().to_path_buf(), port: 0 }).await.unwrap();
    let home_b = tempfile::tempdir().unwrap();
    let err = server::start(ServeOptions { home: home_b.path().to_path_buf(), port: a.port }).await.unwrap_err();
    assert!(err.to_string().contains("already running"), "{err}");
}
