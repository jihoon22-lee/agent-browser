pub mod auth;
pub mod config;
pub mod mcp;
pub mod rpc;
pub mod runtime;
pub mod server;

/// Writes every log line to stderr and, when a file is given, to that file as well.
struct Tee {
    file: Option<std::sync::Arc<std::sync::Mutex<BoundedLog>>>,
}

/// A log file that never grows past its limit while the process runs. The resident Bridge stays up for
/// weeks; checking the size only at startup let serve.log grow without bound. Each event is one write,
/// so the file is emptied between lines, never inside one.
struct BoundedLog { file: std::fs::File, path: std::path::PathBuf, written: u64, limit: u64 }
impl BoundedLog {
    fn open(path: &std::path::Path, limit: u64) -> std::io::Result<Self> {
        let file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
        let written = file.metadata()?.len();
        Ok(Self { file, path: path.to_path_buf(), written, limit })
    }
    fn write_line(&mut self, line: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        if self.written + line.len() as u64 > self.limit {
            // On Windows an append handle has no right to truncate (os error 5): empty the file through
            // a second handle. Appends then continue at the new end.
            std::fs::OpenOptions::new().write(true).open(&self.path)?.set_len(0)?;
            self.file.write_all(b"log truncated\n")?;
            self.written = 14;
        }
        self.file.write_all(line)?;
        self.written += line.len() as u64;
        Ok(())
    }
}

impl std::io::Write for Tee {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        if let Some(file) = &self.file {
            let _ = file.lock().unwrap().write_line(buf);
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if let Some(file) = &self.file {
            let _ = file.lock().unwrap().file.flush();
        }
        std::io::stderr().flush()
    }
}

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// `log_file` is used by `serve`, which runs detached with no usable stderr.
/// In `mcp` mode stdout belongs to the MCP transport, so logs never go there.
pub fn init_logging(log_file: Option<std::path::PathBuf>) {
    let file = log_file.and_then(|path| {
        std::fs::create_dir_all(path.parent()?).ok()?;
        Some(std::sync::Arc::new(std::sync::Mutex::new(BoundedLog::open(&path, MAX_LOG_BYTES).ok()?)))
    });
    tracing_subscriber::fmt()
        .with_writer(move || Tee { file: file.clone() })
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("AGENT_BROWSER_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
}

pub fn run_serve(port: Option<u16>) -> anyhow::Result<()> {
    let home = config::home_dir()?;
    let cfg = config::load_or_init(&home)?;
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        // Lets `start`, the installer, and tests find the detached process; removed again on a graceful exit.
        let pid_file = home.join("serve.pid");
        let handle = server::start_publishing_pid(server::ServeOptions { home: home.clone(), port: port.unwrap_or(cfg.port) }, &pid_file).await?;
        tokio::signal::ctrl_c().await.ok();
        // Removed while this process still holds the port, so no successor's PID can be in it yet.
        server::remove_own_pid_file(&pid_file);
        let _ = handle.shutdown.send(());
        Ok(())
    })
}
pub fn run_mcp() -> anyhow::Result<()> {
    let home = config::home_dir()?;
    let cfg = config::load_or_init(&home)?;
    let port = std::env::var("AGENT_BROWSER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(cfg.port);
    let exe = std::env::current_exe()?;
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        use rmcp::ServiceExt;
        let client = std::sync::Arc::new(mcp::client::ServeClient::connect_or_start(&home, port, &exe).await?);
        let server = mcp::BridgeMcp { client }.serve(rmcp::transport::stdio()).await?;
        server.waiting().await?;
        Ok(())
    })
}
fn bridge_port(cfg: &config::Config) -> u16 {
    std::env::var("AGENT_BROWSER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(cfg.port)
}

pub fn run_pair(open: bool, extension_id: Option<String>, seconds: u64) -> anyhow::Result<()> {
    let home = config::home_dir()?;
    let cfg = config::load_or_init(&home)?;
    if open {
        let extension_id = extension_id.ok_or_else(|| anyhow::anyhow!("--extension-id is required with --open"))?;
        let result = tokio::runtime::Runtime::new()?.block_on(mcp::client::admin_request(&home, bridge_port(&cfg), "pairing.open",
            serde_json::json!({ "extensionId": extension_id, "seconds": seconds })))?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    // The token is printed only on explicit request so the user can paste it into the extension options page.
    println!("{}", cfg.token);
    eprintln!("config: {}", home.join("config.json").display());
    Ok(())
}

pub fn run_status() -> anyhow::Result<()> {
    let home = config::home_dir()?;
    let cfg = config::load_or_init(&home)?;
    let result = tokio::runtime::Runtime::new()?.block_on(mcp::client::admin_request(&home, bridge_port(&cfg), "status.get", serde_json::json!({})))?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

pub fn run_start(port: Option<u16>) -> anyhow::Result<()> {
    let home = config::home_dir()?; let cfg = config::load_or_init(&home)?;
    let port = port.unwrap_or(cfg.port); let exe = std::env::current_exe()?;
    tokio::runtime::Runtime::new()?.block_on(async {
        let client = mcp::client::ServeClient::connect_or_start(&home,port,&exe).await?;
        anyhow::ensure!(client.connected().await,"Cannot start or authenticate the resident Bridge");
        let pid = std::fs::read_to_string(home.join("serve.pid")).ok().and_then(|text| text.trim().parse::<u32>().ok());
        println!("{}",serde_json::json!({"running":true,"port":port,"pid":pid,"home":home}));
        Ok(())
    })
}

#[cfg(test)]
mod log_tests {
    use super::BoundedLog;
    #[test]
    fn the_log_stays_within_its_limit_and_keeps_whole_lines() {
        let directory = std::env::temp_dir().join(format!("ab-log-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("serve.log");
        let line = format!("{}\n", "x".repeat(199));
        let mut log = BoundedLog::open(&path, 1024).unwrap();
        for _ in 0..20 { log.write_line(line.as_bytes()).unwrap(); }
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.len() as u64 <= 1024 + line.len() as u64, "log grew to {}", text.len());
        assert_eq!(text.lines().next(), Some("log truncated"));
        assert!(text.lines().skip(1).all(|kept| kept.len() == 199), "a line was cut");
        // An existing file that is already over the limit is emptied by the next line.
        drop(log);
        std::fs::write(&path, "y".repeat(4096)).unwrap();
        let mut log = BoundedLog::open(&path, 1024).unwrap();
        log.write_line(line.as_bytes()).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() < 1024);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
