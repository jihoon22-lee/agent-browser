//! Guarded binding of id-less browser tool calls to the open panel request (handoff §11).
//! It binds only when the caller is the current launch's MCP proxy for the request's
//! OpenCode directory and no other session of that directory is working.
use super::conn::ServerState;
use super::operation::BoundRequest;
use super::router::Caller;

/// OpenCode starts one proxy per directory with that directory as its cwd. A WSL proxy is a
/// Windows process, so its cwd is a `\\wsl.localhost\<distro>\…` path, or the drive path of a
/// `/mnt/<drive>/…` directory; anything else never matches.
pub fn same_directory(cwd: &str, directory: &str, wsl: bool) -> bool {
    if directory.is_empty() || cwd.is_empty() { return false; }
    if wsl {
        let linux = ["\\\\wsl.localhost\\", "\\\\wsl$\\"].iter().find_map(|prefix| {
            let rest = cwd.strip_prefix(prefix)?; let (_, path) = rest.split_once('\\')?;
            Some(format!("/{}", path.replace('\\', "/")))
        });
        if let Some(path) = linux { return path.trim_end_matches('/') == directory.trim_end_matches('/'); }
        // A directory under /mnt/<drive> is a Windows folder: the proxy sees its drive path.
        return crate::runtime::windows_to_wsl(cwd).is_some_and(|path| path.trim_end_matches('/') == directory.trim_end_matches('/'));
    }
    // OpenCode keys its instances by the directory string, and busy sessions are read with the
    // request's exact string; only the drive letter and separators may differ.
    let normal = |path: &str| {
        let mut path = path.replace('/', "\\").trim_end_matches('\\').to_string();
        if path.as_bytes().get(1) == Some(&b':') { path[..1].make_ascii_lowercase(); }
        path
    };
    normal(cwd) == normal(directory)
}

/// The request's own session may be working (it is calling this tool) or between steps.
pub fn only_this_session_busy(busy: &[String], session: &str) -> bool { busy.iter().all(|id| id == session) }

pub async fn resolve(state: &ServerState, caller: &Caller) -> Option<BoundRequest> {
    let (runtime, cwd) = (caller.runtime_id.as_deref()?, caller.cwd.as_deref()?);
    let request = state.ops.bound_request()?;
    let launched = match state.runtime.runtime_of(runtime) {
        Ok(launched) => launched,
        Err(error) => { tracing::debug!(error = %error.message, "panel request not bound: unknown runtime launch"); return None; }
    };
    // The cheap checks first: a proxy for another profile or folder never costs an HTTP call.
    let (profile, directory) = (launched.profile_id == request.scope.profile, same_directory(cwd, &request.scope.directory, launched.wsl));
    if !(profile && directory) {
        tracing::debug!(profile, directory, cwd, request_directory = %request.scope.directory, "panel request not bound");
        return None;
    }
    let busy = match state.runtime.busy_in(&launched, &request.scope.directory).await {
        Ok(busy) => busy,
        Err(error) => { tracing::debug!(error = %error.message, "panel request not bound: runtime status unavailable"); return None; }
    };
    let idle = only_this_session_busy(&busy, &request.scope.session);
    if !idle { tracing::debug!(busy = busy.len(), "panel request not bound: another session is working"); }
    let fits = idle;
    // The request may have ended or gained an operation while status was read.
    let now = state.ops.bound_request()?;
    (fits && now.id == request.id).then_some(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directories_compare_like_their_platform() {
        assert!(same_directory(r"C:\Work\App\", r"c:\Work\App", false), "the drive letter and a trailing separator do not matter");
        assert!(!same_directory(r"C:\Work\App", r"C:\work\app", false), "OpenCode keys instances by the exact string; a differently cased folder is another instance");
        assert!(same_directory("C:/Work/App", r"C:\Work\App", false));
        assert!(!same_directory(r"C:\Work\App2", r"C:\Work\App", false));
        assert!(same_directory(r"\\wsl.localhost\Ubuntu\home\u\app", "/home/u/app", true));
        assert!(same_directory(r"\\wsl$\Ubuntu\home\u\app\", "/home/u/app", true));
        assert!(!same_directory(r"\\wsl.localhost\Ubuntu\home\u\App", "/home/u/app", true), "Linux paths keep case");
        assert!(same_directory(r"C:\Users\U\Work", "/mnt/c/Users/U/Work", true), "a WSL directory on a Windows drive is the proxy's drive path");
        assert!(same_directory(r"c:\Users\U\Work\", "/mnt/c/Users/U/Work/", true), "the drive letter and a trailing separator do not matter");
        assert!(!same_directory(r"C:\users\u\work", "/mnt/c/Users/U/Work", true), "folder case is kept");
        assert!(!same_directory(r"C:\Users\U\Work2", "/mnt/c/Users/U/Work", true));
        assert!(!same_directory(r"C:\Windows\System32", "/home/u/app", true), "an unmapped WSL cwd never binds");
        assert!(!same_directory("", "/home/u/app", true));
    }
    #[test]
    fn only_the_request_session_may_be_busy() {
        assert!(only_this_session_busy(&["ses_a".into()], "ses_a"));
        assert!(only_this_session_busy(&[], "ses_a"), "the request may be between model steps");
        assert!(!only_this_session_busy(&["ses_a".into(), "ses_cli".into()], "ses_a"));
        assert!(!only_this_session_busy(&["ses_cli".into()], "ses_a"));
    }
}
