use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "browser-bridge", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the resident bridge that Chrome and MCP proxies connect to.
    Serve {
        #[arg(long)]
        port: Option<u16>,
    },
    /// Run the MCP stdio server that OpenCode launches.
    Mcp,
    /// Print the pairing token for the Chrome extension.
    Pair,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    agent_browser_bridge::init_logging();
    match cli.command {
        Command::Serve { port } => agent_browser_bridge::run_serve(port),
        Command::Mcp => agent_browser_bridge::run_mcp(),
        Command::Pair => agent_browser_bridge::run_pair(),
    }
}
