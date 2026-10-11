pub mod config;
pub mod mcp;
pub mod rpc;
pub mod server;

pub fn init_logging() {
    // stderr only: in `mcp` mode stdout belongs to the MCP transport.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
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
        let handle = server::start(server::ServeOptions { home, port: port.unwrap_or(cfg.port) }).await?;
        tokio::signal::ctrl_c().await.ok();
        let _ = handle.shutdown.send(());
        Ok(())
    })
}
pub fn run_mcp() -> anyhow::Result<()> {
    anyhow::bail!("mcp is not implemented yet")
}
pub fn run_pair() -> anyhow::Result<()> {
    let home = config::home_dir()?;
    let cfg = config::load_or_init(&home)?;
    // The token is printed only on explicit request so the user can paste it into the extension options page.
    println!("{}", cfg.token);
    eprintln!("config: {}", home.join("config.json").display());
    Ok(())
}
