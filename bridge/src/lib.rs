pub mod auth;
pub mod config;
pub mod mcp;
pub mod rpc;
pub mod runtime;
pub mod server;

/// Writes every log line to stderr and, when a file is given, to that file as well.
struct Tee {
    file: Option<std::sync::Arc<std::sync::Mutex<std::fs::File>>>,
}

impl std::io::Write for Tee {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        if let Some(file) = &self.file {
            let _ = file.lock().unwrap().write_all(buf);
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if let Some(file) = &self.file {
            let _ = file.lock().unwrap().flush();
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
        let oversized = std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_LOG_BYTES);
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).write(true);
        if oversized {
            opts.truncate(true);
        } else {
            opts.append(true);
        }
        let file = opts.open(&path).ok()?;
        Some(std::sync::Arc::new(std::sync::Mutex::new(file)))
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
        let handle = server::start(server::ServeOptions { home: home.clone(), port: port.unwrap_or(cfg.port) }).await?;
        // Lets tests and `mcp` cleanup find the detached process; removed again on a graceful exit.
        let pid_file = home.join("serve.pid");
        let _ = std::fs::write(&pid_file, std::process::id().to_string());
        tokio::signal::ctrl_c().await.ok();
        let _ = handle.shutdown.send(());
        let _ = std::fs::remove_file(&pid_file);
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
pub fn run_pair() -> anyhow::Result<()> {
    let home = config::home_dir()?;
    let cfg = config::load_or_init(&home)?;
    // The token is printed only on explicit request so the user can paste it into the extension options page.
    println!("{}", cfg.token);
    eprintln!("config: {}", home.join("config.json").display());
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
