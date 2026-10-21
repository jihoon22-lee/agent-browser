pub mod conn;
pub mod binding;
pub mod operation;
pub mod registry;
pub mod router;
pub mod timeline;

use crate::config;
use std::{path::{Path, PathBuf}, sync::Arc};
use tokio::net::TcpListener;

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct ServeOptions { pub home: PathBuf, pub port: u16 }
#[derive(Debug)]
pub struct ServeHandle {
    pub port: u16,
    pub shutdown: tokio::sync::oneshot::Sender<()>,
    pub join: tokio::task::JoinHandle<()>,
}

#[derive(Debug, thiserror::Error)]
pub enum ServeError {
    #[error("agent-browser serve is already running on 127.0.0.1:{port}")]
    AlreadyRunning { port: u16 },
    #[error("port 127.0.0.1:{port} is used by another program: {source}")]
    PortInUse { port: u16, source: std::io::Error },
}

pub async fn start(opts: ServeOptions) -> anyhow::Result<ServeHandle> {
    start_with(opts, None).await
}

/// Like [`start`], and publishes this process's PID to `pid_file` once it owns the port but
/// before it accepts a client. A serve that loses a startup race therefore never touches the
/// file, and a client that has authenticated always finds the winner's PID there.
pub async fn start_publishing_pid(opts: ServeOptions, pid_file: &Path) -> anyhow::Result<ServeHandle> {
    start_with(opts, Some(pid_file)).await
}

/// Removes `pid_file` only while it still names this process, so a later serve's PID survives.
pub fn remove_own_pid_file(pid_file: &Path) {
    if std::fs::read_to_string(pid_file).is_ok_and(|text| text.trim() == std::process::id().to_string()) {
        let _ = std::fs::remove_file(pid_file);
    }
}

async fn start_with(opts: ServeOptions, pid_file: Option<&Path>) -> anyhow::Result<ServeHandle> {
    let listener = match TcpListener::bind(("127.0.0.1", opts.port)).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            if crate::mcp::client::probe(opts.port).await {
                return Err(ServeError::AlreadyRunning { port: opts.port }.into());
            }
            return Err(ServeError::PortInUse { port: opts.port, source: e }.into());
        }
        Err(e) => return Err(e.into()),
    };
    let port = listener.local_addr()?.port();
    // Persist only a successfully bound port. Read the current configuration here so
    // the token, pairing, and browser selection survive a custom-port start.
    let mut cfg = config::load_or_init(&opts.home)?;
    if cfg.port != port { cfg.port = port; config::save(&opts.home,&cfg)?; }
    if let Some(pid_file) = pid_file
        && let Err(error) = std::fs::write(pid_file, std::process::id().to_string())
    {
        tracing::warn!(%error, "cannot publish serve.pid");
    }
    let state = Arc::new(conn::ServerState::new_with_port(opts.home, cfg, port));
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let state = state.clone();
                    tokio::spawn(async move { conn::handle(stream, state).await });
                }
            }
        }
    });
    tracing::info!(port, "serve listening");
    Ok(ServeHandle { port, shutdown: tx, join })
}
