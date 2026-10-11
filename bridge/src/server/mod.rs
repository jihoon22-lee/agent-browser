pub mod conn;
pub mod operation;
pub mod registry;
pub mod router;
pub mod timeline;

use crate::config;
use std::{path::PathBuf, sync::Arc};
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
    let cfg = config::load_or_init(&opts.home)?;
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
    let state = Arc::new(conn::ServerState::new(opts.home, cfg));
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
