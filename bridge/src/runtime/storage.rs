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
            // The file holds credentials and a serde message can quote a value: log the position only.
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| { tracing::warn!(line = error.line(), column = error.column(), "runtime.json is invalid"); invalid("runtime.json is invalid; its contents were preserved") })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => RuntimeConfig { version: 1, ..Default::default() },
            Err(error) => return Err(os_failure("Cannot read runtime.json")(error)),
        };
        if config.version != 1 { return Err(invalid("Unsupported runtime.json version")); }
        Ok(config)
    }
    pub fn update<T>(&self, update: impl FnOnce(&mut RuntimeConfig) -> Result<T, RpcError>) -> Result<T, RpcError> {
        std::fs::create_dir_all(&self.home).map_err(os_failure("Cannot create the runtime configuration directory"))?;
        let path = self.home.join("runtime-write.lock");
        let mut options = std::fs::OpenOptions::new(); options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let lock = options.open(path).map_err(os_failure("Cannot open runtime configuration lock"))?;
        match lock.try_lock() {
            Ok(()) => {}
            // Another writer holds it for a few milliseconds. Waiting sleeps on this thread, so
            // an async worker first hands its other tasks to the runtime.
            Err(std::fs::TryLockError::WouldBlock) => {
                let on_worker = tokio::runtime::Handle::try_current().is_ok_and(|handle| handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread);
                if on_worker { tokio::task::block_in_place(|| wait_for_lock(&lock)) } else { wait_for_lock(&lock) }?;
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(os_failure("Cannot lock runtime configuration")(error)),
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

fn wait_for_lock(lock: &std::fs::File) -> Result<(), RpcError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match lock.try_lock() {
            Ok(()) => return Ok(()),
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(10)),
            Err(std::fs::TryLockError::WouldBlock) => return Err(failure("Runtime configuration is locked; retry after the other configuration operation finishes")),
            Err(std::fs::TryLockError::Error(error)) => return Err(os_failure("Cannot lock runtime configuration")(error)),
        }
    }
}

pub fn failure(message: impl Into<String>) -> RpcError { RpcError::new(ErrorCode::Internal, Retry::Safe, message) }
/// The caller sees a fixed message; the operating system's reason goes to the log, where
/// "access denied", "disk full" and "sharing violation" can be told apart.
pub(super) fn os_failure(message: &'static str) -> impl Fn(std::io::Error) -> RpcError {
    move |error| { tracing::warn!(%error, "{message}"); failure(message) }
}

pub fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), RpcError> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| failure("Runtime file path has no parent"))?;
    std::fs::create_dir_all(parent).map_err(os_failure("Cannot create the runtime data directory"))?;
    let temp = parent.join(format!(".runtime-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&temp).map_err(os_failure("Cannot create runtime configuration file"))?;
    let outcome = (|| {
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| failure("Cannot serialize runtime configuration"))?;
        file.write_all(&bytes).map_err(os_failure("Cannot write runtime configuration"))?;
        file.sync_all().map_err(os_failure("Cannot flush runtime configuration"))?;
        drop(file);
        std::fs::rename(&temp, path).map_err(os_failure("Cannot publish runtime configuration"))
    })();
    let _ = std::fs::remove_file(temp);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn waiting_for_the_configuration_lock_does_not_stall_other_tasks() {
        let home = tempfile::tempdir().unwrap();
        Store::new(home.path().into()).update(|_| Ok(())).unwrap();
        let held = std::fs::OpenOptions::new().read(true).write(true).open(home.path().join("runtime-write.lock")).unwrap();
        held.try_lock().unwrap();
        let release = std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(900)); held.unlock().unwrap(); });
        let started = std::time::Instant::now();
        let path = home.path().to_path_buf();
        let update = tokio::spawn(async move { Store::new(path).update(|_| Ok(())).map(|()| started.elapsed()) });
        let other = tokio::spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(50)).await; started.elapsed() });
        let (waited, ticked) = (update.await.unwrap().unwrap(), other.await.unwrap());
        release.join().unwrap();
        assert!(waited >= std::time::Duration::from_millis(800), "the update waits for the other writer: {waited:?}");
        assert!(ticked < std::time::Duration::from_millis(600), "another task on the only worker ran {ticked:?} after start");
    }

    #[test]
    fn a_lock_held_past_the_deadline_is_reported_outside_a_runtime() {
        let home = tempfile::tempdir().unwrap(); let store = Store::new(home.path().into());
        store.update(|_| Ok(())).unwrap();
        let held = std::fs::OpenOptions::new().read(true).write(true).open(home.path().join("runtime-write.lock")).unwrap();
        held.try_lock().unwrap();
        let error = store.update(|_| Ok(())).unwrap_err();
        assert!(error.message.contains("locked"), "{}", error.message);
    }
}
