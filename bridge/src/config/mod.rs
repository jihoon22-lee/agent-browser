use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 4317;
const FILE: &str = "config.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    pub token: String,
    pub port: u16,
    #[serde(default)]
    pub paired_extension_id: Option<String>,
    #[serde(default)]
    pub selected_client_id: Option<String>,
}

pub fn home_dir() -> anyhow::Result<PathBuf> {
    if let Some(p) = std::env::var_os("AGENT_BROWSER_HOME") {
        return Ok(PathBuf::from(p));
    }
    Ok(dirs::data_local_dir().context("no local data directory for this user")?.join("AgentBrowser"))
}

fn new_token() -> String {
    // Two v4 UUIDs = 244 random bits from the OS CSPRNG.
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

const INIT_LOCK: &str = "config.init.lock";
const INIT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

fn read_config(path: &Path) -> anyhow::Result<Option<Config>> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).with_context(|| format!("invalid config at {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("cannot read {}", path.display())),
    }
}

struct InitLock(PathBuf);
impl Drop for InitLock {
    fn drop(&mut self) { let _ = std::fs::remove_dir(&self.0); }
}

pub fn load_or_init(home: &Path) -> anyhow::Result<Config> {
    let path = home.join(FILE);
    if let Some(cfg) = read_config(&path)? { return Ok(cfg); }
    std::fs::create_dir_all(home).with_context(|| format!("cannot create {}", home.display()))?;
    let lock_path = home.join(INIT_LOCK);
    let deadline = std::time::Instant::now() + INIT_WAIT;
    loop {
        match std::fs::create_dir(&lock_path) {
            Ok(()) => {
                let _lock = InitLock(lock_path);
                // A previous initializer may have published between our first read and lock acquisition.
                if let Some(cfg) = read_config(&path)? { return Ok(cfg); }
                let cfg = Config { version: 1, token: new_token(), port: DEFAULT_PORT, paired_extension_id: None, selected_client_id: None };
                save(home, &cfg)?;
                return Ok(cfg);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Publication uses rename: readers never see an incomplete config.
                if let Some(cfg) = read_config(&path)? { return Ok(cfg); }
                if std::time::Instant::now() >= deadline {
                    anyhow::bail!("config initialization lock {} remained held for two seconds; verify no bridge or pair process is initializing before removing a stale lock", lock_path.display());
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => return Err(e).with_context(|| format!("cannot acquire config initialization lock {}", lock_path.display())),
        }
    }
}

struct TempConfig(PathBuf);
impl Drop for TempConfig {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

pub fn save(home: &Path, cfg: &Config) -> anyhow::Result<()> {
    std::fs::create_dir_all(home).with_context(|| format!("cannot create {}", home.display()))?;
    let tmp = TempConfig(home.join(format!("{FILE}.tmp-{}", uuid::Uuid::new_v4().simple())));
    write_private(&tmp.0, &serde_json::to_vec_pretty(cfg)?)?;
    std::fs::rename(&tmp.0, home.join(FILE))?;
    Ok(())
}

/// The file holds the pairing token. On Unix it is created owner-only; on Windows the
/// per-user `%LOCALAPPDATA%` directory's inherited ACL already limits it to the user.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

pub fn tokens_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    // usize accumulator: a u8 would let lengths that differ by a multiple of 256 cancel out.
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= (a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0)) as usize;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_creates_token_and_reload_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_or_init(dir.path()).unwrap();
        assert_eq!(a.token.len(), 64);
        assert_eq!(a.port, DEFAULT_PORT);
        let b = load_or_init(dir.path()).unwrap();
        assert_eq!(a.token, b.token);
    }

    #[test]
    fn save_preserves_pairing_fields() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = load_or_init(dir.path()).unwrap();
        c.paired_extension_id = Some("abcdefghijklmnopabcdefghijklmnop".into());
        save(dir.path(), &c).unwrap();
        assert_eq!(load_or_init(dir.path()).unwrap().paired_extension_id, c.paired_extension_id);
    }

    #[test]
    fn works_in_korean_path_with_spaces() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("에이전트 브라우저 설정");
        let c = load_or_init(&home).unwrap();
        assert!(home.join("config.json").exists());
        assert!(!c.token.is_empty());
    }

    #[test]
    fn concurrent_first_initializers_all_observe_the_published_token() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        let start = Arc::new(Barrier::new(16));
        let results = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..16).map(|_| {
                let start = start.clone();
                let home = dir.path();
                scope.spawn(move || { start.wait(); load_or_init(home) })
            }).collect();
            handles.into_iter().map(|handle| handle.join().unwrap()).collect::<Vec<_>>()
        });
        let published = load_or_init(dir.path()).unwrap();
        for result in results {
            let config = result.expect("concurrent initialization must not fail");
            assert!(tokens_equal(&config.token, &published.token), "initializers returned different tokens");
        }
    }

    #[test]
    fn abandoned_initialization_lock_fails_with_a_bounded_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(INIT_LOCK)).unwrap();
        let started = std::time::Instant::now();
        let error = load_or_init(dir.path()).unwrap_err().to_string();
        assert!(error.contains("config initialization lock"));
        assert!(error.contains("stale lock"));
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
        assert!(!dir.path().join(FILE).exists(), "a contender must not invent a second token");
        assert!(dir.path().join(INIT_LOCK).exists(), "never remove another process's lock");
    }

    #[test]
    fn token_compare() {
        assert!(tokens_equal("abc", "abc"));
        assert!(!tokens_equal("abc", "abd"));
        assert!(!tokens_equal("abc", "abcd"));
    }

    #[cfg(unix)]
    #[test]
    fn config_file_holding_the_token_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_init(dir.path()).unwrap();
        let mode = std::fs::metadata(dir.path().join("config.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn corrupt_config_is_an_error_not_a_silent_reset() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{not json").unwrap();
        assert!(load_or_init(dir.path()).is_err());
    }
}
