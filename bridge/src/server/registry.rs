use crate::rpc::{Envelope, ErrorCode, Retry, RpcError};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio::sync::{mpsc::UnboundedSender, oneshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandClass { Read, Write }
pub type ConnId = u64;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo { pub client_id: String, pub connected: bool, pub selected: bool }

struct Conn { client_id: String, tx: UnboundedSender<String> }
struct Pending { conn: ConnId, class: CommandClass, tx: oneshot::Sender<Result<Value, RpcError>> }

pub struct Registry { inner: Mutex<Inner> }
struct Inner {
    next: ConnId,
    conns: HashMap<ConnId, Conn>,
    selected: Option<String>,
    pending: HashMap<String, Pending>,
}

impl Registry {
    pub fn new(selected: Option<String>) -> Self {
        Self { inner: Mutex::new(Inner { next: 1, conns: HashMap::new(), selected, pending: HashMap::new() }) }
    }

    pub fn register(&self, client_id: &str, tx: UnboundedSender<String>) -> ConnId {
        let mut g = self.inner.lock().unwrap();
        let id = g.next;
        g.next += 1;
        g.conns.insert(id, Conn { client_id: client_id.into(), tx });
        if g.selected.is_none() && g.conns.len() == 1 {
            g.selected = Some(client_id.into());
        }
        id
    }

    pub fn unregister(&self, conn: ConnId) {
        let mut g = self.inner.lock().unwrap();
        g.conns.remove(&conn);
        let lost: Vec<String> = g.pending.iter().filter(|(_, p)| p.conn == conn).map(|(k, _)| k.clone()).collect();
        for id in lost {
            let p = g.pending.remove(&id).unwrap();
            let _ = p.tx.send(Err(lost_error(p.class, "The browser connection closed before replying.")));
        }
    }

    pub fn use_browser(&self, client_id: &str) { self.inner.lock().unwrap().selected = Some(client_id.into()); }
    pub fn selected_client(&self) -> Option<String> { self.inner.lock().unwrap().selected.clone() }

    /// Only the selected profile's newest authenticated worker may send tab lifecycle events.
    pub fn selected_connection_client(&self, conn: ConnId) -> Option<String> {
        let g = self.inner.lock().unwrap();
        newest_for(&g, g.selected.as_deref())
            .filter(|(id, _)| *id == conn)
            .map(|(_, c)| c.client_id.clone())
    }

    pub fn snapshot(&self) -> Vec<BrowserInfo> {
        let g = self.inner.lock().unwrap();
        let mut ids: Vec<(ConnId, &str)> = g.conns.iter().map(|(k, c)| (*k, c.client_id.as_str())).collect();
        ids.sort_by_key(|(k, _)| *k);
        let mut out: Vec<BrowserInfo> = Vec::new();
        for (_, client_id) in ids {
            // A service worker that reconnected before its old socket was reaped shows up once.
            if out.iter().any(|b| b.client_id == client_id) { continue; }
            out.push(BrowserInfo { client_id: client_id.to_string(), connected: true, selected: g.selected.as_deref() == Some(client_id) });
        }
        if let Some(sel) = &g.selected {
            if !out.iter().any(|b| &b.client_id == sel) {
                out.push(BrowserInfo { client_id: sel.clone(), connected: false, selected: true });
            }
        }
        out
    }

    pub fn broadcast(&self, text: &str) {
        for c in self.inner.lock().unwrap().conns.values() { let _ = c.tx.send(text.to_string()); }
    }

    /// Fire-and-forget request to the selected browser (used for `browser.cancel`).
    pub fn notify_selected(&self, method: &str, params: Value) -> bool {
        let g = self.inner.lock().unwrap();
        let Some((_, c)) = newest_for(&g, g.selected.as_deref()) else { return false };
        c.tx.send(Envelope::req(method, params).to_text()).is_ok()
    }

    pub async fn send_command(&self, method: &str, params: Value, class: CommandClass, timeout: Duration) -> Result<Value, RpcError> {
        let req = Envelope::req(method, params);
        let id = req.id().unwrap().to_string();
        let (tx, rx) = oneshot::channel();
        let conn_tx = {
            let mut g = self.inner.lock().unwrap();
            let found = newest_for(&g, g.selected.as_deref()).map(|(k, c)| (k, c.tx.clone()));
            let Some((conn, ctx)) = found else {
                return Err(RpcError::new(ErrorCode::BrowserDisconnected, Retry::Safe,
                    "Chrome is not connected to the bridge. Ask the user to open Chrome with the AgentBrowser extension."));
            };
            g.pending.insert(id.clone(), Pending { conn, class, tx });
            ctx
        };
        if conn_tx.send(req.to_text()).is_err() {
            self.inner.lock().unwrap().pending.remove(&id);
            return Err(RpcError::new(ErrorCode::BrowserDisconnected, Retry::Safe, "The browser connection is closing."));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(lost_error(class, "The bridge dropped the request.")),
            Err(_) => {
                self.inner.lock().unwrap().pending.remove(&id);
                let _ = conn_tx.send(Envelope::req("browser.cancel", json!({ "requestId": id })).to_text());
                Err(match class {
                    CommandClass::Read => RpcError::new(ErrorCode::Timeout, Retry::Safe, "The browser did not answer in time."),
                    CommandClass::Write => RpcError::new(ErrorCode::ExecutionUnknown, Retry::Unsafe,
                        "No reply in time; the action may or may not have happened. Take a snapshot to check before retrying."),
                })
            }
        }
    }

    pub fn handle_response(&self, env: Envelope) {
        let Envelope::Res { id, ok, result, error, .. } = env else { return };
        let Some(p) = self.inner.lock().unwrap().pending.remove(&id) else {
            tracing::debug!(%id, "late or unknown response ignored");
            return;
        };
        let r = if ok { Ok(result.unwrap_or(Value::Null)) } else {
            Err(error.unwrap_or_else(|| RpcError::new(ErrorCode::Internal, Retry::Never, "error without details")))
        };
        let _ = p.tx.send(r);
    }
}

/// The newest connection of the selected client. Never falls back to a different client.
fn newest_for<'a>(g: &'a Inner, client_id: Option<&str>) -> Option<(ConnId, &'a Conn)> {
    let client_id = client_id?;
    g.conns.iter().filter(|(_, c)| c.client_id == client_id).max_by_key(|(k, _)| **k).map(|(k, c)| (*k, c))
}

fn lost_error(class: CommandClass, msg: &str) -> RpcError {
    match class {
        CommandClass::Read => RpcError::new(ErrorCode::BrowserDisconnected, Retry::Safe, msg),
        CommandClass::Write => RpcError::new(ErrorCode::ExecutionUnknown, Retry::Unsafe,
            format!("{msg} The action may or may not have happened. Take a snapshot to check before retrying.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{parse_envelope, Envelope, ErrorCode};
    use std::time::Duration;

    fn reg() -> Registry { Registry::new(None) }

    #[tokio::test]
    async fn single_connection_is_auto_selected_and_answers() {
        let r = std::sync::Arc::new(reg());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        r.register("cli-1", tx);
        let r2 = r.clone();
        let task = tokio::spawn(async move { r2.send_command("browser.tabs.list", json!({}), CommandClass::Read, Duration::from_secs(2)).await });
        let Envelope::Req { id, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        r.handle_response(Envelope::ok(id, json!({"tabs": []})));
        assert_eq!(task.await.unwrap().unwrap(), json!({"tabs": []}));
    }

    #[tokio::test]
    async fn two_connections_without_selection_are_not_guessed() {
        let r = reg();
        let (a, _ra) = tokio::sync::mpsc::unbounded_channel();
        let (b, _rb) = tokio::sync::mpsc::unbounded_channel();
        r.register("cli-1", a);
        r.register("cli-2", b);
        // cli-1 was auto-selected when it was alone; it stays selected.
        assert_eq!(r.selected_client().as_deref(), Some("cli-1"));
        let r = Registry::new(None);
        let (a, _ra) = tokio::sync::mpsc::unbounded_channel();
        let (b, _rb) = tokio::sync::mpsc::unbounded_channel();
        let ca = r.register("cli-1", a);
        r.register("cli-2", b);
        r.unregister(ca);
        // selected browser disconnected: do not silently move to cli-2
        let err = r.send_command("browser.tabs.list", json!({}), CommandClass::Read, Duration::from_millis(200)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::BrowserDisconnected);
    }

    #[tokio::test]
    async fn write_lost_on_disconnect_is_execution_unknown() {
        let r = std::sync::Arc::new(reg());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = r.register("cli-1", tx);
        let r2 = r.clone();
        let task = tokio::spawn(async move { r2.send_command("browser.click", json!({}), CommandClass::Write, Duration::from_secs(2)).await });
        rx.recv().await.unwrap();
        r.unregister(conn);
        let err = task.await.unwrap().unwrap_err();
        assert_eq!(err.code, ErrorCode::ExecutionUnknown);
    }

    #[tokio::test]
    async fn read_lost_on_disconnect_is_retryable_disconnect() {
        let r = std::sync::Arc::new(reg());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let conn = r.register("cli-1", tx);
        let r2 = r.clone();
        let task = tokio::spawn(async move { r2.send_command("browser.snapshot", json!({}), CommandClass::Read, Duration::from_secs(2)).await });
        rx.recv().await.unwrap();
        r.unregister(conn);
        let err = task.await.unwrap().unwrap_err();
        assert_eq!(err.code, ErrorCode::BrowserDisconnected);
        assert_eq!(err.retry, crate::rpc::Retry::Safe);
    }

    #[tokio::test]
    async fn write_timeout_is_unknown_and_sends_cancel() {
        let r = reg();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        r.register("cli-1", tx);
        let err = r.send_command("browser.click", json!({}), CommandClass::Write, Duration::from_millis(100)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::ExecutionUnknown);
        let _cmd = rx.recv().await.unwrap();
        let cancel = parse_envelope(&rx.recv().await.unwrap()).unwrap();
        assert!(matches!(cancel, Envelope::Req { ref method, .. } if method == "browser.cancel"));
    }

    #[tokio::test]
    async fn late_response_after_timeout_is_ignored() {
        let r = reg();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        r.register("cli-1", tx);
        let _ = r.send_command("browser.snapshot", json!({}), CommandClass::Read, Duration::from_millis(50)).await;
        let Envelope::Req { id, .. } = parse_envelope(&rx.recv().await.unwrap()).unwrap() else { panic!() };
        // must not panic or resolve anything
        r.handle_response(Envelope::ok(id, json!({})));
    }

    #[tokio::test]
    async fn reconnect_with_same_client_id_keeps_selection_and_routes_to_newest_connection() {
        let r = std::sync::Arc::new(reg());
        let (old_tx, mut old_rx) = tokio::sync::mpsc::unbounded_channel();
        let (new_tx, mut new_rx) = tokio::sync::mpsc::unbounded_channel();
        r.register("cli-1", old_tx);
        r.register("cli-1", new_tx); // service worker restarted before the old socket was reaped
        assert_eq!(r.selected_client().as_deref(), Some("cli-1"));
        assert_eq!(r.snapshot().len(), 1);
        let r2 = r.clone();
        let task = tokio::spawn(async move { r2.send_command("browser.snapshot", json!({}), CommandClass::Read, Duration::from_millis(200)).await });
        let Envelope::Req { id, .. } = parse_envelope(&new_rx.recv().await.unwrap()).unwrap() else { panic!() };
        assert!(old_rx.try_recv().is_err(), "old connection must not receive the command");
        r.handle_response(Envelope::ok(id, json!({})));
        assert!(task.await.unwrap().is_ok());
    }
}
