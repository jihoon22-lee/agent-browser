mod common;
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn bin() -> &'static str { env!("CARGO_BIN_EXE_browser-bridge") }

struct McpChild { child: tokio::process::Child, stdin: tokio::process::ChildStdin, out: tokio::io::Lines<BufReader<tokio::process::ChildStdout>> }

async fn spawn_mcp(home: &std::path::Path, port: u16) -> McpChild {
    let mut child = tokio::process::Command::new(bin())
        .arg("mcp")
        .env("AGENT_BROWSER_HOME", home)
        .env("AGENT_BROWSER_PORT", port.to_string())
        .env("AGENT_BROWSER_LOG", "debug")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn().unwrap();
    let stdin = child.stdin.take().unwrap();
    let out = BufReader::new(child.stdout.take().unwrap()).lines();
    McpChild { child, stdin, out }
}

impl McpChild {
    async fn send(&mut self, v: Value) { self.stdin.write_all(format!("{v}\n").as_bytes()).await.unwrap(); }
    async fn recv(&mut self) -> Value {
        let line = tokio::time::timeout(std::time::Duration::from_secs(15), self.out.next_line()).await.unwrap().unwrap().unwrap();
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("stdout must be pure JSON-RPC, got {line:?}: {e}"))
    }
    async fn init(&mut self) {
        self.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}})).await;
        let r = self.recv().await;
        assert_eq!(r["result"]["serverInfo"]["name"], "agent-browser");
        self.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await;
    }
}

#[tokio::test]
async fn initialize_and_list_tools_over_stdio() {
    let (home, serve, _cfg) = common::start_test_serve().await;
    let mut m = spawn_mcp(home.path(), serve.port).await;
    m.init().await;
    m.send(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).await;
    let r = m.recv().await;
    let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names.len(), 11);
    assert!(names.contains(&"browser_snapshot"));
}

#[tokio::test]
async fn tool_error_is_reported_as_is_error_with_code() {
    let (home, serve, _cfg) = common::start_test_serve().await;
    let mut m = spawn_mcp(home.path(), serve.port).await;
    m.init().await;
    m.send(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_click","arguments":{"ref":"s1f0e1"}}})).await;
    let r = m.recv().await;
    assert_eq!(r["result"]["isError"], true);
    assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("OPERATION_REQUIRED"));
}

#[tokio::test]
async fn starts_serve_when_missing_and_serve_outlives_mcp() {
    let home = tempfile::tempdir().unwrap();
    let port = free_port();
    let mut m = spawn_mcp(home.path(), port).await;
    m.init().await;
    m.send(json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_tabs","arguments":{"action":"list"}}})).await;
    let r = m.recv().await;
    // No browser in this test: the call reaches a running serve and reports BROWSER_DISCONNECTED.
    assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("BROWSER_DISCONNECTED"));
    drop(m.stdin);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), m.child.wait()).await;
    assert!(agent_browser_bridge::mcp::client::probe(port).await, "serve must keep running after mcp exits");
    // The detached serve has no stderr, so it logs to a file; the pairing token must never be in it.
    let log = std::fs::read_to_string(home.path().join("logs").join("serve.log")).expect("serve.log");
    let cfg = agent_browser_bridge::config::load_or_init(home.path()).unwrap();
    assert!(log.contains("serve listening"), "{log}");
    assert!(!log.contains(&cfg.token), "token leaked into serve.log");
    // serve writes its PID to home/serve.pid; Linux-only cleanup.
    let pid: u32 = std::fs::read_to_string(home.path().join("serve.pid")).unwrap().trim().parse().unwrap();
    let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
}

#[tokio::test]
async fn mcp_exits_cleanly_when_stdin_closes() {
    let (home, serve, _cfg) = common::start_test_serve().await;
    let mut m = spawn_mcp(home.path(), serve.port).await;
    m.init().await;
    drop(m.stdin);
    let status = tokio::time::timeout(std::time::Duration::from_secs(5), m.child.wait()).await.unwrap().unwrap();
    assert!(status.success());
}

#[tokio::test]
async fn tools_list_works_without_any_serve_and_calls_report_disconnected() {
    // A port nothing listens on and an exe that cannot become a serve is covered by the
    // unit tests; here serve cannot be started because the port is held by another program.
    let squatter = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = squatter.local_addr().unwrap().port();
    let home = tempfile::tempdir().unwrap();
    let mut m = spawn_mcp(home.path(), port).await;
    m.init().await;
    m.send(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).await;
    assert_eq!(m.recv().await["result"]["tools"].as_array().unwrap().len(), 11);
    m.send(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_tabs","arguments":{"action":"list"}}})).await;
    let r = m.recv().await;
    assert_eq!(r["result"]["isError"], true);
    let text = r["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("BROWSER_DISCONNECTED"), "{text}");
    assert!(text.contains("could not be started"), "{text}");
}

fn free_port() -> u16 { std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() }
