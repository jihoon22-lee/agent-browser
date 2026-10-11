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

pub fn load_or_init(home: &Path) -> anyhow::Result<Config> {
    let path = home.join(FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).with_context(|| format!("invalid config at {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let cfg = Config { version: 1, token: new_token(), port: DEFAULT_PORT, paired_extension_id: None, selected_client_id: None };
            save(home, &cfg)?;
            Ok(cfg)
        }
        Err(e) => Err(e).with_context(|| format!("cannot read {}", path.display())),
    }
}

pub fn save(home: &Path, cfg: &Config) -> anyhow::Result<()> {
    std::fs::create_dir_all(home).with_context(|| format!("cannot create {}", home.display()))?;
    let tmp = home.join(format!("{FILE}.tmp-{}", std::process::id()));
    write_private(&tmp, &serde_json::to_vec_pretty(cfg)?)?;
    std::fs::rename(&tmp, home.join(FILE))?;
    Ok(())
}

/// The file holds the pairing token. On Unix it is created owner-only; on Windows the
/// per-user `%LOCALAPPDATA%` directory's inherited ACL already limits it to the user.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)
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
