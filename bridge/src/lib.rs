pub mod rpc;

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

pub fn run_serve(_port: Option<u16>) -> anyhow::Result<()> {
    anyhow::bail!("serve is not implemented yet")
}
pub fn run_mcp() -> anyhow::Result<()> {
    anyhow::bail!("mcp is not implemented yet")
}
pub fn run_pair() -> anyhow::Result<()> {
    anyhow::bail!("pair is not implemented yet")
}
