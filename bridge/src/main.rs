use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "browser-bridge", version)]
struct Cli {
    /// Override this user's Bridge configuration directory.
    #[arg(long, global = true)]
    home: Option<std::path::PathBuf>,
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
    /// Start or authenticate the detached resident Bridge.
    Start { #[arg(long)] port: Option<u16> },
    /// Inspect configuration and runtime health without starting OpenCode.
    Doctor { #[arg(long)] json: bool, #[arg(long)] profile: Option<String> },
    /// Manage OpenCode profiles without exposing saved secrets.
    Profile { #[command(subcommand)] command: ProfileCommand },
    /// Attach an interactive OpenCode CLI to this profile's authenticated server.
    Attach { #[arg(long)] profile: String },
    /// Manage only Bridge-owned OpenCode runtime processes.
    Runtime { #[command(subcommand)] command: RuntimeCommand },
}

#[derive(Subcommand)]
enum RuntimeCommand {
    /// Stop all verified managed runtimes; external servers are left untouched.
    StopAll { #[arg(long)] json: bool },
    /// Start or reuse a saved runtime, without printing credentials.
    Start { #[arg(long)] profile: String },
}

#[derive(Subcommand)]
enum ProfileCommand {
    List { #[arg(long)] json: bool },
    Save { #[arg(long)] file: std::path::PathBuf, #[arg(long = "default")] make_default: bool, #[arg(long)] create_only: bool },
    Delete { #[arg(long)] id: String },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    // CLI initialization runs before creating any threads or asynchronous runtimes.
    if let Some(home) = &cli.home { unsafe { std::env::set_var("AGENT_BROWSER_HOME",home); } }
    let log_file = match cli.command {
        Command::Serve { .. } => agent_browser_bridge::config::home_dir().ok().map(|h| h.join("logs").join("serve.log")),
        _ => None,
    };
    agent_browser_bridge::init_logging(log_file);
    match cli.command {
        Command::Serve { port } => agent_browser_bridge::run_serve(port),
        Command::Mcp => agent_browser_bridge::run_mcp(),
        Command::Pair => agent_browser_bridge::run_pair(),
        Command::Start { port } => agent_browser_bridge::run_start(port),
        command => {
            let home = agent_browser_bridge::config::home_dir()?;
            let cfg = agent_browser_bridge::config::load_or_init(&home)?;
            let port = std::env::var("AGENT_BROWSER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(cfg.port);
            let manager = agent_browser_bridge::runtime::Manager::new(home,port);
            let runtime = tokio::runtime::Runtime::new()?;
            if let Command::Attach { profile } = command {
                let origin = cfg.paired_extension_id.map(|id| format!("chrome-extension://{id}")).ok_or_else(|| anyhow::anyhow!("Pair the Chrome extension first"))?;
                return runtime.block_on(manager.attach(&profile,&origin)).map_err(|error| anyhow::anyhow!(error.message));
            }
            if let Command::Runtime { command } = command {
                let mut result = match command {
                    RuntimeCommand::StopAll { .. } => runtime.block_on(manager.stop_all()),
                    RuntimeCommand::Start { profile } => {
                        let origin = cfg.paired_extension_id.map(|id| format!("chrome-extension://{id}")).ok_or_else(|| anyhow::anyhow!("Pair the Chrome extension first"))?;
                        runtime.block_on(manager.ensure(&profile,&origin))
                    }
                }.map_err(|error| anyhow::anyhow!(error.message))?;
                if let Some(object) = result.as_object_mut() { object.remove("password"); object.remove("username"); }
                println!("{}",serde_json::to_string_pretty(&result)?);
                anyhow::ensure!(result["errors"].as_array().is_none_or(|errors| errors.is_empty()) && result["state"] != "error", "One or more runtime operations failed; failed ownership records were retained");
                return Ok(());
            }
            let result = match command {
                Command::Doctor { profile,.. } => runtime.block_on(manager.doctor(profile.as_deref())),
                Command::Profile { command: ProfileCommand::List { .. } } => manager.list(),
                Command::Profile { command: ProfileCommand::Save { file,make_default,create_only } } => {
                    let bytes = std::fs::read(file)?;
                    let profile = serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("Invalid profile JSON"))?;
                    if create_only { manager.save_new(profile,make_default) } else { manager.save(profile,make_default) }
                }
                Command::Profile { command: ProfileCommand::Delete { id } } => runtime.block_on(manager.delete(&id)),
                _ => unreachable!(),
            }.map_err(|error| anyhow::anyhow!(error.message))?;
            println!("{}",serde_json::to_string_pretty(&result)?); Ok(())
        }
    }
}
