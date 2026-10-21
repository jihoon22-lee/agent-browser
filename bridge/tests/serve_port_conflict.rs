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

fn bin() -> std::path::PathBuf {
    // A cross-built Windows test runs with an explicit local copy of the same exe.
    std::env::var_os("AGENT_BROWSER_TEST_EXE").map(std::path::PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_browser-bridge").into())
}

#[tokio::test]
async fn losing_serve_keeps_the_running_servers_pid_file() {
    let home = tempfile::tempdir().unwrap();
    let winner = server::start(ServeOptions { home: home.path().to_path_buf(), port: 0 }).await.unwrap();
    // Stands in for the PID that the serve owning the port published.
    let pid_file = home.path().join("serve.pid");
    std::fs::write(&pid_file, "4242").unwrap();
    let output = tokio::time::timeout(Duration::from_secs(15), tokio::process::Command::new(bin())
        .args(["serve", "--port", &winner.port.to_string()])
        .env("AGENT_BROWSER_HOME", home.path())
        .kill_on_drop(true)
        .output()).await.unwrap().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("already running"), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(std::fs::read_to_string(&pid_file).unwrap(), "4242", "a serve that lost the port must not touch serve.pid");
    let _ = winner.shutdown.send(());
}

async fn spawn_serve(home: &std::path::Path) -> (tokio::process::Child, u16) {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let child = tokio::process::Command::new(bin())
        .args(["serve", "--port", &port.to_string()])
        .env("AGENT_BROWSER_HOME", home)
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !agent_browser_bridge::mcp::client::probe(port).await {
        assert!(tokio::time::Instant::now() < deadline, "serve did not start");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    (child, port)
}

#[tokio::test]
async fn serve_publishes_its_pid_before_answering_clients() {
    let home = tempfile::tempdir().unwrap();
    let (child, _port) = spawn_serve(home.path()).await;
    let published = std::fs::read_to_string(home.path().join("serve.pid")).unwrap();
    assert_eq!(published, child.id().unwrap().to_string());
}

#[cfg(unix)]
async fn interrupt(mut child: tokio::process::Child) {
    std::process::Command::new("kill").arg("-INT").arg(child.id().unwrap().to_string()).status().unwrap();
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait()).await.unwrap().unwrap();
    assert!(status.success(), "{status}");
}

#[cfg(unix)]
#[tokio::test]
async fn graceful_exit_removes_only_its_own_pid_file() {
    let home = tempfile::tempdir().unwrap();
    let pid_file = home.path().join("serve.pid");
    let (child, _port) = spawn_serve(home.path()).await;
    interrupt(child).await;
    assert!(!pid_file.exists());
    let (child, _port) = spawn_serve(home.path()).await;
    // Another serve's PID, e.g. one written by an older Bridge version, is left in place.
    std::fs::write(&pid_file, "4242").unwrap();
    interrupt(child).await;
    assert_eq!(std::fs::read_to_string(&pid_file).unwrap(), "4242");
}
