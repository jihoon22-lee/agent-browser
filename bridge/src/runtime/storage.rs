use super::{profile::{Profile, invalid}, RuntimeRecord, PortReservation};
use crate::rpc::{RpcError, ErrorCode, Retry};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::{Path, PathBuf}};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    #[serde(default = "version")]
    pub version: u32,
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_profile_id: Option<String>,
    #[serde(default)]
    pub runtimes: BTreeMap<String, RuntimeRecord>,
    #[serde(default)]
    pub reservations: BTreeMap<String, PortReservation>,
}
fn version() -> u32 { 1 }

pub struct Store { home: PathBuf }
pub(super) struct FileLock(pub std::fs::File);
impl Drop for FileLock { fn drop(&mut self) { let _ = self.0.unlock(); } }
#[cfg(all(test,unix))]
impl FileLock { pub fn try_clone(&self) -> std::io::Result<std::fs::File> { self.0.try_clone() } }
impl Store {
    pub fn new(home: PathBuf) -> Self { Self { home } }
    pub fn read(&self) -> Result<RuntimeConfig, RpcError> {
        let path = self.home.join("runtime.json");
        let config: RuntimeConfig = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| invalid("runtime.json is invalid; its contents were preserved"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => RuntimeConfig { version: 1, ..Default::default() },
            Err(_) => return Err(failure("Cannot read runtime.json")),
        };
        if config.version != 1 { return Err(invalid("Unsupported runtime.json version")); }
        Ok(config)
    }
    pub fn update<T>(&self, update: impl FnOnce(&mut RuntimeConfig) -> Result<T, RpcError>) -> Result<T, RpcError> {
        std::fs::create_dir_all(&self.home).map_err(|_| failure("Cannot create the runtime configuration directory"))?;
        let path = self.home.join("runtime-write.lock");
        let mut options = std::fs::OpenOptions::new(); options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let lock = options.open(path).map_err(|_| failure("Cannot open runtime configuration lock"))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match lock.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(_) => return Err(failure("Runtime configuration is locked; retry after the other configuration operation finishes")),
            }
        }
        // Closing our descriptor alone can leave a Unix flock held by a concurrent
        // fork until exec; explicitly unlock the shared open-file description.
        let _held = FileLock(lock);
        let mut config = self.read()?;
        let result = update(&mut config)?;
        write_private_json(&self.home.join("runtime.json"), &config)?;
        Ok(result)
    }
}

pub fn failure(message: impl Into<String>) -> RpcError { RpcError::new(ErrorCode::Internal, Retry::Safe, message) }

pub fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), RpcError> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| failure("Runtime file path has no parent"))?;
    std::fs::create_dir_all(parent).map_err(|_| failure("Cannot create the runtime data directory"))?;
    let temp = parent.join(format!(".runtime-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&temp).map_err(|_| failure("Cannot create runtime configuration file"))?;
    let outcome = (|| {
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| failure("Cannot serialize runtime configuration"))?;
        file.write_all(&bytes).map_err(|_| failure("Cannot write runtime configuration"))?;
        file.sync_all().map_err(|_| failure("Cannot flush runtime configuration"))?;
        drop(file);
        std::fs::rename(&temp, path).map_err(|_| failure("Cannot publish runtime configuration"))
    })();
    let _ = std::fs::remove_file(temp);
    outcome
}
