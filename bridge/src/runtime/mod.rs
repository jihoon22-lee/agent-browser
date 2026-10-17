mod diagnostics;
pub mod profile;
mod process;
pub(crate) use process::windows_to_wsl;
mod storage;
mod interop;
#[cfg(all(test, unix))]
mod interop_tests;

use crate::rpc::RpcError;
use profile::{invalid, Kind, Profile};
use process::Identity;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};
use storage::{failure, Store};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRecord {
    pub profile_id: String,
    pub instance: String,
    pub base_url: String,
    pub username: String,
    pub password: String,
    pub launcher: Identity,
    pub server: Option<Identity>,
    pub wsl_owner_file: Option<String>,
    pub version: Option<String>,
    #[serde(default)]
    pub bridge_port: Option<u16>,
    #[serde(default)]
    pub bridge_executable: Option<String>,
    #[serde(default)]
    pub wsl_keeper: Option<interop::Keeper>,
}

#[derive(Serialize,Deserialize)]
pub struct PortReservation { pub port: u16, pub controller: Identity }
struct ReservedPort<'a> { store: &'a Store, profile: String, port: u16 }
impl Drop for ReservedPort<'_> { fn drop(&mut self) { let _ = self.store.update(|config| { config.reservations.remove(&self.profile); Ok(()) }); } }

type DocCache = std::sync::Mutex<std::collections::HashSet<String>>;

/// Busy sessions of a managed runtime directory, for guarded panel request binding.
pub struct RuntimeSessions { pub profile_id: String, pub wsl: bool, pub busy: Vec<String> }

/// A managed runtime found by its launch id.
pub struct RuntimeRef { pub profile_id: String, pub wsl: bool, record: RuntimeRecord }

/// Every session that is not idle counts as working, so an unknown new state never reads as free;
/// a reply that is not a map is an error, never "no busy sessions".
fn busy_from(statuses: &Value) -> Result<Vec<String>, RpcError> {
    let map = statuses.as_object().ok_or_else(|| failure("The runtime's session status is not a map"))?;
    Ok(map.iter().filter(|(_, status)| status["type"].as_str() != Some("idle")).map(|(id, _)| id.clone()).collect())
}

pub struct Manager {
    home: PathBuf,
    port: u16,
    store: Store,
    locks: std::sync::Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>,
    verified_docs: DocCache,
}

impl Manager {
    pub fn new(home: PathBuf, port: u16) -> Self { Self { store: Store::new(home.clone()), home, port, locks: Default::default(), verified_docs: Default::default() } }
    fn lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> { self.locks.lock().unwrap().entry(id.into()).or_default().clone() }
    fn reserve_port(&self, profile: &str, requested: Option<u16>) -> Result<ReservedPort<'_>,RpcError> {
        let controller = process::identity(std::process::id()).ok_or_else(|| failure("Cannot verify the Bridge process identity"))?;
        let port = self.store.update(|config| {
            config.reservations.retain(|_,reservation| process::matches(&reservation.controller));
            let mut excluded: std::collections::BTreeSet<u16> = config.runtimes.values().filter_map(|runtime| reqwest::Url::parse(&runtime.base_url).ok().and_then(|url| url.port())).collect();
            excluded.extend(config.reservations.values().map(|reservation| reservation.port));
            let port = choose_port(requested,&excluded)?;
            config.reservations.insert(profile.into(),PortReservation {port,controller}); Ok(port)
        })?;
        Ok(ReservedPort {store:&self.store,profile:profile.into(),port})
    }
    fn overlay_current(&self, record: &RuntimeRecord) -> bool {
        record.bridge_port == Some(self.port) && record.bridge_executable.as_ref().is_some_and(|path| std::path::Path::new(path).is_file())
            && (record.wsl_owner_file.is_none() || record.wsl_keeper.is_some())
    }
    pub fn list(&self) -> Result<Value, RpcError> {
        let config = self.store.read()?;
        Ok(json!({"profiles":config.profiles.values().map(Profile::summary).collect::<Vec<_>>(),"defaultProfileId":config.default_profile_id}))
    }
    pub fn save(&self, profile: Profile, make_default: bool) -> Result<Value, RpcError> { self.save_mode(profile,make_default,false) }
    pub fn save_new(&self, profile: Profile, make_default: bool) -> Result<Value, RpcError> { self.save_mode(profile,make_default,true) }
    fn save_mode(&self, mut profile: Profile, make_default: bool, create_only: bool) -> Result<Value, RpcError> {
        profile.validate()?;
        let _operation = self.operation_lock(&profile.id)?;
        self.store.update(|config| {
            if create_only && config.profiles.contains_key(&profile.id) { return Err(invalid("This profile id already exists; no profile was changed")); }
            if config.runtimes.contains_key(&profile.id) { return Err(invalid("Stop the managed runtime before editing its profile")); }
            if let Some(old) = config.profiles.get(&profile.id) { profile.preserve_secrets(old); }
            if make_default || config.default_profile_id.is_none() { config.default_profile_id = Some(profile.id.clone()); }
            config.profiles.insert(profile.id.clone(), profile.clone());
            Ok(json!({"profile":profile.summary()}))
        })
    }
    fn profile(&self, id: &str) -> Result<Profile, RpcError> { self.store.read()?.profiles.get(id).cloned().ok_or_else(|| invalid("Unknown runtime profile")) }
    fn operation_lock(&self, id: &str) -> Result<storage::FileLock,RpcError> {
        self.try_operation_lock(id)?.ok_or_else(|| invalid("Another operation is already managing this profile; wait for it to finish"))
    }
    fn try_operation_lock(&self, id: &str) -> Result<Option<storage::FileLock>,RpcError> {
        if id.is_empty() || id.len() > 64 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)) { return Err(invalid("Invalid profile id")); }
        let directory = self.home.join("runtime"); std::fs::create_dir_all(&directory).map_err(|_| failure("Cannot create runtime directory"))?;
        let mut options = std::fs::OpenOptions::new(); options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let file = options.open(directory.join(format!("{id}.lock"))).map_err(|_| failure("Cannot open profile operation lock"))?;
        match file.try_lock() {
            Ok(()) => Ok(Some(storage::FileLock(file))),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(_) => Err(failure("Cannot lock profile operation")),
        }
    }
    pub async fn delete(&self, id: &str) -> Result<Value, RpcError> {
        let lock = self.lock(id); let _guard = lock.lock().await;
        let _operation = self.operation_lock(id)?;
        let profile = self.profile(id)?; self.stop_inner(&profile).await?;
        self.store.update(|config| {
            config.profiles.remove(id);
            if config.default_profile_id.as_deref() == Some(id) { config.default_profile_id = config.profiles.keys().next().cloned(); }
            Ok(json!({"deleted":true}))
        })
    }
    pub async fn ensure(&self, id: &str, origin: &str) -> Result<Value, RpcError> {
        let lock = self.lock(id); let _guard = lock.lock().await;
        let _operation = self.operation_lock(id)?;
        let profile = self.profile(id)?;
        let result = self.ensure_inner(&profile, origin).await;
        Ok(match result { Ok(value) => value, Err(error) => {
            let owned = if let Some(record) = self.store.read()?.runtimes.get(id) { self.owned(&profile,record).await } else { false };
            json!({"profileId":id,"directory":profile.directory,"state":"error","owned":owned,"error":error.message})
        } })
    }
    async fn ensure_inner(&self, profile: &Profile, origin: &str) -> Result<Value, RpcError> {
        if profile.kind == Kind::External {
            let url = profile.external_url()?.to_string();
            let version = health(&url, profile.username.as_deref(), profile.password.as_deref(), false, &self.verified_docs).await?;
            return Ok(json!({"profileId":profile.id,"state":"ready","baseUrl":url.trim_end_matches('/'),"directory":profile.directory,"username":profile.username,"password":profile.password,"version":version,"owned":false,"attachCommand":attach(&profile.id,&self.home)}));
        }
        if let Some(mut record) = self.store.read()?.runtimes.get(&profile.id).cloned() {
            let inspection = self.inspect(profile,&mut record).await?;
            if inspection.listener {
                if !self.overlay_current(&record) { return Err(failure("The managed runtime needs its browser MCP configuration refreshed (Bridge endpoint or owned WSL keeper). Stop this profile in Options, then start it again. The existing runtime was left running.")); }
                let version = health(&record.base_url, Some(&record.username), Some(&record.password), true, &self.verified_docs).await?;
                browser_mcp(profile,&record).await?;
                record.version = Some(version); self.persist(&record)?;
                return Ok(info(profile, &record, "ready", true,&self.home));
            }
            if inspection.owned { return Err(failure("The owned runtime is running but its listener cannot be verified; stop it before retrying")); }
            if profile.kind == Kind::Wsl && !matches!(inspection.state, WslState::NotStarted | WslState::Stopped) {
                return Err(failure(format!("{}: WSL ownership could not be verified; its record was retained. Run diagnose.cmd in the installation folder.",diagnostics::wsl_probe_reason(inspection.probe_code))));
            }
            if profile.kind == Kind::Wsl && self.terminate_wsl(profile,&record).await.is_none() { return Err(failure("Cannot safely stop the previous WSL interop keeper; retry Stop")); }
            self.store.update(|config| { config.runtimes.remove(&profile.id); Ok(()) })?;
        }
        let reservation = self.reserve_port(&profile.id,profile.port)?;
        let port = reservation.port;
        let instance = uuid::Uuid::new_v4().simple().to_string();
        let password = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let executable = profile.executable.as_deref().ok_or_else(|| invalid("Missing OpenCode executable"))?;
        let mut env = profile.env.clone().unwrap_or_default();
        env.insert("OPENCODE_SERVER_USERNAME".into(), "opencode".into());
        env.insert("OPENCODE_SERVER_PASSWORD".into(), password.clone());
        env.insert("AGENT_BROWSER_RUNTIME_ID".into(), instance.clone());
        self.overlay(profile, &mut env)?;
        let serve_args = vec!["serve".into(), "--hostname".into(), "127.0.0.1".into(), "--port".into(), port.to_string(), "--cors".into(), origin.into(), "--pure".into()];
        let mut record = if profile.kind == Kind::Wsl {
            let mut command = vec![executable.into()]; command.extend(serve_args);
            self.launch_wsl(profile,port,instance,password,env,command).await?
        } else {
            let (program, args) = native_command(executable, serve_args);
            let launcher = process::spawn(&program, &args, Some(&profile.directory), &env).map_err(|_| failure("Cannot launch OpenCode; check the executable, working directory, and environment"))?;
            RuntimeRecord {profile_id:profile.id.clone(),instance,base_url:format!("http://127.0.0.1:{port}"),username:"opencode".into(),password,launcher,server:None,wsl_owner_file:None,version:None,bridge_port:Some(self.port),bridge_executable:std::env::current_exe().ok().map(|path| path.to_string_lossy().into_owned()),wsl_keeper:None}
        };
        if profile.kind != Kind::Wsl {
            if let Err(error) = self.persist(&record) { self.terminate(profile, &record).await; return Err(error); }
        }
        drop(reservation);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            let inspection = match self.inspect(profile,&mut record).await {
                Ok(value) => value,
                Err(error) => { self.terminate(profile,&record).await; return Err(error); }
            };
            if inspection.listener && let Ok(version) = health(&record.base_url,Some(&record.username),Some(&record.password),true,&self.verified_docs).await {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if let Ok(Ok(())) = tokio::time::timeout(remaining,browser_mcp(profile,&record)).await {
                    record.version = Some(version); self.persist(&record)?;
                    tracing::info!(profile_id = %profile.id, "OpenCode HTTP and browser MCP ready");
                    return Ok(info(profile,&record,"ready",true,&self.home));
                }
            }
            if profile.kind == Kind::Wsl && matches!(inspection.state,WslState::Stopped | WslState::NotStarted) { break; }
            if tokio::time::Instant::now() >= deadline { break; }
            tokio::time::sleep(Duration::from_millis(if profile.kind == Kind::Wsl {1500} else {400})).await;
        }
        self.stop_inner(profile).await?;
        Err(failure("OpenCode HTTP and browser MCP did not become ready within 60 seconds. Check the executable/version, port, WSL localhost forwarding, directory, and environment."))
    }
    fn persist(&self, record: &RuntimeRecord) -> Result<(), RpcError> { self.store.update(|config| { config.runtimes.insert(record.profile_id.clone(), record.clone()); Ok(()) }) }
    fn overlay(&self, profile: &Profile, env: &mut BTreeMap<String,String>) -> Result<(), RpcError> {
        let existing = env.get("OPENCODE_CONFIG_CONTENT").cloned().or_else(|| std::env::var("OPENCODE_CONFIG_CONTENT").ok());
        let mut overlay: Value = existing.map(|text| serde_json::from_str(&text).map_err(|_| invalid("OPENCODE_CONFIG_CONTENT must be a JSON object"))).transpose()?.unwrap_or_else(|| json!({}));
        let object = overlay.as_object_mut().ok_or_else(|| invalid("OPENCODE_CONFIG_CONTENT must be a JSON object"))?;
        let mcp = object.entry("mcp").or_insert_with(|| json!({})).as_object_mut().ok_or_else(|| invalid("OPENCODE_CONFIG_CONTENT.mcp must be an object"))?;
        let exe = std::env::current_exe().map_err(|_| failure("Cannot resolve the Bridge executable"))?.to_string_lossy().into_owned();
        let exe = if profile.kind == Kind::Wsl { process::windows_to_wsl(&exe).ok_or_else(|| invalid("The Bridge executable must be on a Windows drive for WSL profiles"))? } else { exe };
        let mut mcp_env = json!({"AGENT_BROWSER_HOME":self.home.to_string_lossy(), "AGENT_BROWSER_PORT":self.port.to_string()});
        // The proxy names this launch so the server can bind a guarded panel request.
        let runtime_id = env.get("AGENT_BROWSER_RUNTIME_ID").cloned();
        if let Some(id) = &runtime_id { mcp_env["AGENT_BROWSER_RUNTIME_ID"] = json!(id); }
        if profile.kind == Kind::Wsl {
            mcp_env["WSLENV"] = json!(if runtime_id.is_some() { "AGENT_BROWSER_HOME/w:AGENT_BROWSER_PORT/w:AGENT_BROWSER_RUNTIME_ID/w" } else { "AGENT_BROWSER_HOME/w:AGENT_BROWSER_PORT/w" });
        }
        mcp.insert("browser".into(), json!({"type":"local","command":[exe,"mcp"],"environment":mcp_env,"enabled":true}));
        env.insert("OPENCODE_CONFIG_CONTENT".into(), overlay.to_string()); Ok(())
    }
    async fn inspect(&self, profile: &Profile, record: &mut RuntimeRecord) -> Result<Inspection,RpcError> {
        if profile.kind == Kind::Wsl {
            let code = wsl_control_status(profile,record,"inspect").await;
            let state = wsl_state_code(code,&record.launcher);
            return Ok(Inspection {owned:matches!(code,Some(0|20)),listener:code == Some(0) && wsl_forwarder(record),state,probe_code:code});
        }
        let owned = self.owned(profile,record).await;
        let listener = owned && self.verify_listener(profile,record).await?;
        Ok(Inspection {owned,listener,state:if owned {WslState::Running} else {WslState::Stopped},probe_code:None})
    }
    async fn owned(&self, profile: &Profile, record: &RuntimeRecord) -> bool {
        if profile.kind == Kind::Wsl { wsl_control(profile, record, "check").await }
        else { record.server.as_ref().is_some_and(process::matches) || process::matches(&record.launcher) }
    }
    async fn verify_listener(&self, profile: &Profile, record: &mut RuntimeRecord) -> Result<bool, RpcError> {
        if !self.listener_owned(profile, record).await { return Ok(false); }
        // The listener's identity is cleanup data, even when the health endpoint fails.
        self.persist(record)?;
        Ok(true)
    }
    async fn listener_owned(&self, profile: &Profile, record: &mut RuntimeRecord) -> bool {
        #[cfg(windows)] {
            let Some(port) = reqwest::Url::parse(&record.base_url).ok().and_then(|url| url.port()) else { return false; };
            let Some(listener) = process::listener(port) else { return false; };
            if profile.kind == Kind::Wsl {
                let image = listener.image.to_ascii_lowercase();
                let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()).to_ascii_lowercase();
                return wsl_control(profile,record,"listener").await && (image.starts_with(&format!("{root}\\system32\\")) || image.starts_with("c:\\program files\\wsl\\") || image.starts_with("c:\\program files\\windowsapps\\microsoftcorporationii.windowssubsystemforlinux_"))
                    && (image.ends_with("\\wslrelay.exe") || image.ends_with("\\wslhost.exe"));
            }
            if record.server.as_ref().is_some_and(|server| server.pid == listener.pid && server.created == listener.created && server.image == listener.image) || process::descendant(&listener, &record.launcher) {
                record.server = Some(listener); return true;
            }
            false
        }
        #[cfg(not(windows))] { let _ = profile; process::matches(&record.launcher) }
    }
    async fn terminate_wsl(&self, profile: &Profile, record: &RuntimeRecord) -> Option<bool> {
        let stopped = self.terminate_wsl_process(profile,record).await?;
        if let Some(keeper) = &record.wsl_keeper {
            if record.wsl_owner_file.as_deref() != Some(&keeper.owner_file) {
                let mut keeper_record = record.clone();
                keeper_record.launcher = keeper.launcher.clone(); keeper_record.wsl_owner_file = Some(keeper.owner_file.clone()); keeper_record.wsl_keeper = None;
                return Some(self.terminate_wsl_process(profile,&keeper_record).await? || stopped);
            }
        }
        Some(stopped)
    }
    async fn terminate_wsl_process(&self, profile: &Profile, record: &RuntimeRecord) -> Option<bool> {
        // Revoke before inspecting: a delayed WSL launch can publish ownership
        // after a timeout or after its Windows launcher has already exited.
        let revoked = self.revoke_wsl_permit(record);
        let mut stopped = false;
        // A pending owner is a launch in progress, including during persistence failure.
        for _ in 0..20 {
            match wsl_state(profile, record).await {
                WslState::NotStarted if !revoked => break,
                WslState::NotStarted | WslState::Stopped => {
                    process::terminate(&record.launcher);
                    return Some(stopped);
                }
                WslState::Running => { stopped |= wsl_control(profile, record, "stop").await; }
                WslState::Starting => {}
                WslState::Unknown => break,
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        None
    }
    async fn terminate(&self, profile: &Profile, record: &RuntimeRecord) -> bool {
        if profile.kind == Kind::Wsl { return self.terminate_wsl(profile, record).await.unwrap_or(false); }
        let stopped = record.server.as_ref().is_some_and(process::terminate);
        process::terminate(&record.launcher) || stopped
    }
    async fn stop_inner(&self, profile: &Profile) -> Result<Value, RpcError> {
        if profile.kind == Kind::External { return Ok(json!({"stopped":false})); }
        let Some(record) = self.store.read()?.runtimes.get(&profile.id).cloned() else { return Ok(json!({"stopped":false})); };
        if profile.kind == Kind::Wsl {
            if let Some(stopped) = self.terminate_wsl(profile, &record).await {
                self.store.update(|config| { config.runtimes.remove(&profile.id); Ok(()) })?;
                return Ok(json!({"stopped": stopped}));
            }
            let code=wsl_control_status(profile,&record,"state").await;
            return Err(failure(format!("{}: Cannot confirm the WSL runtime stopped; ownership record was retained. Run diagnose.cmd in the installation folder.",diagnostics::wsl_probe_reason(code))));
        }
        let stopped = self.terminate(profile, &record).await;
        for _ in 0..20 { if !self.owned(profile,&record).await { break; } tokio::time::sleep(Duration::from_millis(100)).await; }
        if self.owned(profile, &record).await { return Err(failure("Owned OpenCode process could not be stopped; ownership record was retained")); }
        self.store.update(|config| { config.runtimes.remove(&profile.id); Ok(()) })?;
        Ok(json!({"stopped":stopped}))
    }
    pub async fn stop(&self, id: &str) -> Result<Value, RpcError> { let lock = self.lock(id); let _guard = lock.lock().await; let _operation = self.operation_lock(id)?; self.stop_inner(&self.profile(id)?).await }
    pub async fn stop_all(&self) -> Result<Value,RpcError> {
        let config = self.store.read()?;
        let skipped: Vec<_> = config.profiles.values().filter(|profile| profile.kind == Kind::External).map(|profile| profile.id.clone()).collect();
        let mut stopped = Vec::new(); let mut errors = Vec::new();
        for id in config.runtimes.keys() {
            if skipped.contains(id) { continue; }
            match self.stop(id).await {
                Ok(result) if result["stopped"] == true => stopped.push(id.clone()),
                Ok(_) => {},
                Err(error) => errors.push(json!({"profileId":id,"message":error.message})),
            }
        }
        Ok(json!({"stoppedProfiles":stopped,"skippedExternal":skipped,"errors":errors}))
    }
    /// Integration tests: store a profile and a runtime record owned by this test process.
    #[doc(hidden)]
    pub fn record_runtime_for_tests(&self, profile: Value, instance: &str, base_url: &str) {
        let profile: Profile = serde_json::from_value(profile).expect("test profile");
        let identity = process::identity(std::process::id()).expect("test process identity");
        let record = RuntimeRecord{profile_id:profile.id.clone(),instance:instance.into(),base_url:base_url.into(),username:"opencode".into(),password:"test".into(),launcher:identity,server:None,wsl_owner_file:None,version:None,bridge_port:Some(self.port),bridge_executable:None,wsl_keeper:None};
        self.store.update(|config| { config.profiles.insert(profile.id.clone(), profile); Ok(()) }).expect("store test profile");
        self.persist(&record).expect("store test runtime");
    }

    /// The runtime launched as `instance`, read from the store without any HTTP call.
    pub fn runtime_of(&self, instance: &str) -> Result<RuntimeRef, RpcError> {
        let config = self.store.read()?;
        let record = config.runtimes.values().find(|record| record.instance == instance).cloned()
            .ok_or_else(|| invalid("This MCP proxy does not belong to the current runtime launch"))?;
        let wsl = config.profiles.get(&record.profile_id).is_some_and(|profile| profile.kind == Kind::Wsl);
        Ok(RuntimeRef { profile_id: record.profile_id.clone(), wsl, record })
    }

    /// Sessions of one directory that are not idle, read from the runtime itself.
    pub async fn busy_in(&self, runtime: &RuntimeRef, directory: &str) -> Result<Vec<String>, RpcError> {
        let record = &runtime.record;
        let mut url = reqwest::Url::parse(&format!("{}/session/status", record.base_url.trim_end_matches('/'))).map_err(|_| failure("Invalid managed runtime URL"))?;
        url.query_pairs_mut().append_pair("directory", directory);
        let response = http_client(&record.base_url)?.get(url).basic_auth(&record.username, Some(&record.password)).send().await
            .map_err(|_| failure("Cannot read the runtime's session status"))?;
        if !response.status().is_success() { return Err(failure("The runtime refused the session status request")); }
        busy_from(&limited_json(response, 1 << 20).await?)
    }

    /// Busy sessions of one OpenCode directory on the runtime launched as `instance`.
    /// A proxy from an earlier launch finds no record and gets an error.
    pub async fn busy_sessions(&self, instance: &str, directory: &str) -> Result<RuntimeSessions, RpcError> {
        let runtime = self.runtime_of(instance)?;
        let busy = self.busy_in(&runtime, directory).await?;
        Ok(RuntimeSessions { profile_id: runtime.profile_id, wsl: runtime.wsl, busy })
    }

    pub async fn status(&self, id: &str) -> Result<Value, RpcError> {
        let profile = self.profile(id)?;
        let lock = self.lock(id);
        let Ok(_guard) = lock.try_lock() else { return Ok(starting(id,&profile)); };
        let Some(_operation) = self.try_operation_lock(id)? else { return Ok(starting(id,&profile)); };
        let profile = self.profile(id)?; // Re-read under the cross-process lock before persisting ownership.
        if profile.kind == Kind::External {
            let url = profile.external_url()?.to_string();
            return Ok(match health(&url, profile.username.as_deref(), profile.password.as_deref(), false, &self.verified_docs).await {
                Ok(version) => json!({"profileId":id,"state":"ready","baseUrl":url.trim_end_matches('/'),"directory":profile.directory,"version":version,"owned":false}),
                Err(error) => json!({"profileId":id,"state":"error","directory":profile.directory,"owned":false,"error":error.message}),
            });
        }
        if let Some(mut record) = self.store.read()?.runtimes.get(id).cloned() {
            let inspection = self.inspect(&profile,&mut record).await?;
            match inspection.state {
                WslState::Starting => { let mut value=info(&profile,&record,"starting",false,&self.home); value["wslProbe"]=json!({"reason":"WSL_START_PENDING","exitCode":inspection.probe_code}); return Ok(value); }
                WslState::Unknown => { let mut value = info(&profile,&record,"error",false,&self.home); value["owned"] = json!(false); value["error"] = json!(format!("{}; ownership record was retained", diagnostics::wsl_probe_reason(inspection.probe_code))); value["wslProbe"] = json!({"reason":diagnostics::wsl_probe_reason(inspection.probe_code),"exitCode":inspection.probe_code}); return Ok(value); }
                _ => {}
            }
            if inspection.listener {
                if !self.overlay_current(&record) { let mut value = info(&profile,&record,"error",false,&self.home); value["error"] = json!("Bridge MCP configuration changed. Stop this profile in Options, then start it again; its existing runtime was left running."); return Ok(value); }
                if let Ok(version) = health(&record.base_url,Some(&record.username),Some(&record.password),true,&self.verified_docs).await {
                    record.version = Some(version);
                    if browser_mcp(&profile,&record).await.is_ok() { return Ok(info(&profile,&record,"ready",false,&self.home)); }
                    let mut value=info(&profile,&record,"error",false,&self.home);
                    value["httpReady"]=json!(true);
                    value["error"]=json!("OpenCode HTTP is available but browser MCP is not ready");
                    return Ok(value);
                }
                let mut value = info(&profile,&record,"error",false,&self.home); value["error"] = json!("Owned runtime failed its authenticated v1 HTTP or browser MCP readiness check"); return Ok(value);
            }
            if inspection.owned { let mut value = info(&profile,&record,"error",false,&self.home); value["error"] = json!("Owned process is running, but its listener ownership cannot be verified"); return Ok(value); }
        }
        Ok(json!({"profileId":id,"state":"stopped","directory":profile.directory,"owned":false}))
    }
    /// Extension-only connection discovery. Never launches a stopped runtime;
    /// ordinary status and doctor continue to omit credentials.
    pub async fn connection_status(&self, id: &str) -> Result<Value, RpcError> {
        let mut value=self.status(id).await?;
        if value["state"] == "ready" {
            let config=self.store.read()?;
            let profile=config.profiles.get(id).ok_or_else(||invalid("Unknown runtime profile"))?;
            if profile.kind == Kind::External {
                if value["baseUrl"] != profile.external_url()?.as_str().trim_end_matches('/') {
                    return Err(invalid("Profile changed during connection discovery"));
                }
                value["username"]=json!(profile.username);
                value["password"]=json!(profile.password);
            } else if let Some(record)=config.runtimes.get(id).filter(|r| value["baseUrl"]==r.base_url) {
                value["username"]=json!(record.username);
                value["password"]=json!(record.password);
            } else { return Err(invalid("Runtime changed during connection discovery")); }
        }
        Ok(value)
    }

    pub async fn doctor(&self, id: Option<&str>) -> Result<Value, RpcError> {
        let config = self.store.read()?;
        let ids: Vec<_> = if let Some(id) = id { vec![id.to_string()] } else { config.profiles.keys().cloned().collect() };
        let bridge = crate::mcp::client::probe_authenticated(&self.home,self.port).await;
        let mut checks = vec![json!({"id":"bridge","status":if bridge {"ok"} else {"warning"},"message":if bridge {format!("Authenticated Bridge {} · 127.0.0.1:{}",env!("CARGO_PKG_VERSION"),self.port)} else {format!("No authenticated Bridge at 127.0.0.1:{}; doctor did not start it",self.port)}}),
            json!({"id":"extension","status":"warning","message":"Check the connected and selected Chrome profile in the extension diagnostics"})];
        for id in ids {
            let profile = self.profile(&id)?;
            if profile.kind == Kind::Wsl {
                let owner=process::windows_to_wsl(&self.home.join("diagnostic-probe").to_string_lossy());
                let code=if let Some(owner)=owner {interop::preflight_code(&profile,&owner,"",true).await} else {None};
                checks.push(json!({"id":"wslPrerequisites","profileId":id,"status":if code==Some(0) {"ok"} else {"error"},"reason":if code==Some(0) {"WSL_PREREQUISITES_AVAILABLE"} else {diagnostics::wsl_probe_reason(code)},"exitCode":code}));
            }
            if profile.kind != Kind::External { checks.push(installation_check(&profile).await); }
            let status = self.status(&id).await?;
            let mut check = json!({"id":"opencode","profileId":id,"status":if status["state"] == "ready" {"ok"} else if status["state"] == "stopped" || status["state"] == "starting" {"warning"} else {"error"},"message":status["error"].as_str().unwrap_or(status["state"].as_str().unwrap_or("unknown")),"runtime":status});
            if let Some(reason) = check["runtime"]["reason"].as_str() { check["reason"] = json!(reason); }
            checks.push(check);
            if status["state"] == "ready" || status["httpReady"] == true {
                let mcp = self.diagnostic_api(&profile,"mcp").await;
                checks.push(diagnostics::mcp_check(&id,profile.kind != Kind::External,mcp.as_ref()));
                let providers = self.diagnostic_api(&profile,"provider").await;
                let (provider_count,model_count) = providers.as_ref().map(|value| {
                    let connected = value["connected"].as_array().cloned().unwrap_or_default();
                    let count = value["all"].as_array().map(|providers| providers.iter().filter(|provider| connected.contains(&provider["id"])).map(|provider| provider["models"].as_object().map_or(0,|models| models.len())).sum::<usize>()).unwrap_or(0);
                    (connected.len(),count)
                }).unwrap_or((0,0));
                checks.push(json!({"id":"model","profileId":id,"status":"warning","message":if providers.is_ok() {"Configured model metadata was read; inference is untested and delegated to the user after deployment"} else {"Provider metadata is unavailable; no inference or provider request was attempted"},"providerCount":provider_count,"modelCount":model_count,"inferenceTested":false}));
            } else {
                checks.push(json!({"id":"mcp","profileId":id,"status":"warning","message":"MCP was not checked because OpenCode is not ready; doctor does not start it"}));
                checks.push(json!({"id":"model","profileId":id,"status":"warning","message":"Model inference is untested and delegated to the user after deployment","inferenceTested":false}));
            }
        }
        Ok(json!({"ok":checks.iter().all(|check| check["status"] != "error"),"checks":checks}))
    }

    async fn diagnostic_api(&self, profile: &Profile, path: &str) -> Result<Value,RpcError> {
        let (base,username,password) = if profile.kind == Kind::External { (profile.external_url()?.to_string(),profile.username.clone(),profile.password.clone()) }
        else {
            let mut record = self.store.read()?.runtimes.get(&profile.id).cloned().ok_or_else(|| failure("No managed runtime"))?;
            if !self.inspect(profile,&mut record).await?.listener { return Err(failure("Runtime ownership cannot be verified")); }
            (record.base_url,Some(record.username),Some(record.password))
        };
        let client = http_client(&base)?;
        let mut url = reqwest::Url::parse(&format!("{}/{}",base.trim_end_matches('/'),path)).map_err(|_| invalid("Invalid runtime API URL"))?;
        url.query_pairs_mut().append_pair("directory",&profile.directory);
        let mut request = client.get(url).timeout(Duration::from_secs(12));
        if let Some(password) = password.filter(|value| !value.is_empty()) { request = request.basic_auth(username.unwrap_or_else(|| "opencode".into()),Some(password)); }
        let response = request.send().await.map_err(|error| failure("Runtime diagnostic API is unavailable").with_details(json!({"reason":if error.is_timeout() {"timeout"} else {"network"}})))?;
        if !response.status().is_success() { return Err(failure("Runtime diagnostic API returned an error").with_details(json!({"httpStatus":response.status().as_u16()}))); }
        limited_json(response,8 * 1024 * 1024).await
    }

    pub async fn attach(&self, id: &str, origin: &str) -> Result<(),RpcError> {
        let ready = self.ensure(id,origin).await?;
        if ready["state"] != "ready" { return Err(failure(ready["error"].as_str().unwrap_or("Runtime is not ready"))); }
        let profile = self.profile(id)?;
        let mut env = profile.env.clone().unwrap_or_default();
        if let Some(username) = ready["username"].as_str() { env.insert("OPENCODE_SERVER_USERNAME".into(),username.into()); }
        if let Some(password) = ready["password"].as_str() { env.insert("OPENCODE_SERVER_PASSWORD".into(),password.into()); }
        let url = ready["baseUrl"].as_str().ok_or_else(|| failure("Runtime URL is missing"))?;
        let executable = profile.executable.as_deref().unwrap_or("opencode");
        let mut command;
        if profile.kind == Kind::Wsl {
            let mut args = wsl_args(&profile); args.extend(["--exec".into(),"/bin/sh".into(),"-c".into(),"cd -- \"$1\" && exec \"$2\" attach \"$3\" --dir \"$1\"".into(),"agent-browser".into(),profile.directory.clone(),executable.into(),url.into()]);
            forward_wsl_env(&mut env);
            command = std::process::Command::new(process::wsl_executable()); command.args(args);
        } else {
            command = std::process::Command::new(executable);
            command.args(["attach",url,"--dir",&profile.directory]).current_dir(&profile.directory);
            #[cfg(windows)] if executable.to_ascii_lowercase().ends_with(".cmd") {
                use std::os::windows::process::CommandExt;
                env.insert("AGENT_BROWSER_ATTACH_EXEC".into(),executable.into()); env.insert("AGENT_BROWSER_ATTACH_URL".into(),url.into()); env.insert("AGENT_BROWSER_ATTACH_DIRECTORY".into(),profile.directory.clone());
                command = std::process::Command::new(format!("{}\\System32\\cmd.exe",std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())));
                command.args(["/d","/v:off","/s","/c"]).raw_arg("\"\"%AGENT_BROWSER_ATTACH_EXEC%\" attach \"%AGENT_BROWSER_ATTACH_URL%\" --dir \"%AGENT_BROWSER_ATTACH_DIRECTORY%\"\"").current_dir(&profile.directory);
            }
        }
        let status = command.env_remove("OPENCODE_SERVER_USERNAME").env_remove("OPENCODE_SERVER_PASSWORD").envs(env).status().map_err(|_| failure("Cannot launch the OpenCode attach client"))?;
        if !status.success() { return Err(failure("The OpenCode attach client exited unsuccessfully")); } Ok(())
    }
}

fn starting(id: &str, profile: &Profile) -> Value { json!({"profileId":id,"state":"starting","directory":profile.directory,"owned":false,"reason":"PROFILE_OPERATION_IN_PROGRESS"}) }
fn info(profile: &Profile, record: &RuntimeRecord, state: &str, secrets: bool, home: &std::path::Path) -> Value {
    let mut value = json!({"profileId":profile.id,"state":state,"baseUrl":record.base_url,"directory":profile.directory,"version":record.version,"owned":true,"attachCommand":attach(&profile.id,home)});
    if secrets { value["username"] = json!(record.username); value["password"] = json!(record.password); } value
}
fn attach(id: &str, home: &std::path::Path) -> String { format!("& {} --home {} attach --profile {}",quote_display(&std::env::current_exe().map(|exe| exe.to_string_lossy().into_owned()).unwrap_or_else(|_| "browser-bridge.exe".into())),quote_display(&home.to_string_lossy()),quote_display(id)) }
fn quote_display(value: &str) -> String { format!("'{}'",value.replace('\'', "''")) }
fn choose_port(requested: Option<u16>, excluded: &std::collections::BTreeSet<u16>) -> Result<u16, RpcError> {
    let bind = |port| std::net::TcpListener::bind(("127.0.0.1",port));
    if requested.is_some_and(|port| excluded.contains(&port)) { return Err(invalid("The requested OpenCode port is reserved by another managed profile")); }
    for _ in 0..64 {
        let listener = if let Some(port) = requested { bind(port).map_err(|_| invalid("The requested OpenCode port is already occupied; select another port or an external profile"))? } else if !excluded.contains(&4096) { bind(4096).or_else(|_| bind(0)).map_err(|_| failure("No loopback port is available"))? } else { bind(0).map_err(|_| failure("No loopback port is available"))? };
        let port = listener.local_addr().map(|address| address.port()).map_err(|_| failure("Cannot inspect the selected port"))?;
        if !excluded.contains(&port) { return Ok(port); }
    }
    Err(failure("Cannot reserve an unused OpenCode port"))
}
fn native_command(executable: &str, args: Vec<String>) -> (String,Vec<String>) {
    #[cfg(windows)] if executable.to_ascii_lowercase().ends_with(".cmd") {
        let cmd = format!("{}\\System32\\cmd.exe",std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()));
        let tail = format!("\"\"{executable}\" {}\"",args.join(" "));
        return (cmd,vec!["/d".into(),"/s".into(),"/c".into(),tail]);
    }
    (executable.into(),args)
}
fn wsl_args(profile: &Profile) -> Vec<String> {
    let mut args = vec!["--distribution".into(), profile.distribution.clone().unwrap_or_default()];
    if let Some(user) = &profile.user { args.extend(["--user".into(),user.clone()]); } args
}

fn forward_wsl_env(env: &mut BTreeMap<String, String>) {
    let mut entries: Vec<String> = std::env::var("WSLENV").unwrap_or_default().split(':')
        .filter(|entry| !entry.is_empty() && !env.contains_key(entry.split('/').next().unwrap_or_default())).map(str::to_string).collect();
    entries.extend(env.keys().map(|key| format!("{key}/u")));
    env.insert("WSLENV".into(), entries.join(":"));
}

async fn installation_check(profile: &Profile) -> Value {
    let mut env = profile.env.clone().unwrap_or_default();
    if profile.kind == Kind::Wsl { forward_wsl_env(&mut env); }
    let executable = profile.executable.as_deref().unwrap_or_default();
    let mut command;
    if profile.kind == Kind::Wsl {
        let mut args = wsl_args(profile); args.extend(["--exec".into(),"/bin/sh".into(),"-c".into(),"cd -- \"$1\" && test -x \"$2\" && exec \"$2\" --version".into(),"agent-browser".into(),profile.directory.clone(),executable.into()]);
        command = tokio::process::Command::new(process::wsl_executable()); command.args(args);
    } else {
        if !std::path::Path::new(executable).is_file() || !std::path::Path::new(&profile.directory).is_dir() { return json!({"id":"executable","profileId":profile.id,"status":"error","message":"The configured OpenCode executable or working directory does not exist"}); }
        let (program,args) = native_command(executable,vec!["--version".into()]); command = tokio::process::Command::new(program);
        #[cfg(windows)] {
            if executable.to_ascii_lowercase().ends_with(".cmd") { use std::os::windows::process::CommandExt; command.as_std_mut().args(&args[..3]).raw_arg(&args[3]); }
            else { command.args(args); }
        }
        #[cfg(not(windows))] { command.args(args); }
        command.current_dir(&profile.directory);
    }
    command.envs(env).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] { command.creation_flags(0x08000000); }
    let version = match tokio::time::timeout(Duration::from_secs(8),command.output()).await {
        Ok(Ok(output)) if output.status.success() => String::from_utf8(output.stdout).ok().map(|value| value.trim().to_string()).filter(|value| value.len() < 40 && value.starts_with("1.") && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))),
        _ => None,
    };
    match version {
        Some(version) => json!({"id":"executable","profileId":profile.id,"status":"ok","version":version,"message":"Configured OpenCode v1 executable and working directory are available"}),
        None => json!({"id":"executable","profileId":profile.id,"status":"error","message":"Cannot verify OpenCode v1; check the executable, working directory, WSL distribution/user, and interop availability"}),
    }
}
const WSL_LAUNCH: &str = r#"set -eu
directory=$1; owner=$2; instance=$3; shift 3
stat=$(cat /proc/$$/stat); rest=${stat##*) }; ticks=$(printf '%s\n' "$rest" | awk '{print $20}')
boot=$(cat /proc/sys/kernel/random/boot_id)
printf '%s %s %s %s\n' "$$" "$ticks" "$instance" "$boot" > "$owner.tmp"
mv -- "$owner.tmp" "$owner"
cd -- "$directory"
remaining=600
until [ -f "$owner.start" ] && [ "$(cat "$owner.start")" = "$instance" ]; do
  [ "$remaining" -gt 0 ] || exit 1
  remaining=$((remaining - 1))
  sleep 0.1
done
if [ -n "${AGENT_BROWSER_INTEROP_SOCKET:-}" ]; then
  [ -S "$AGENT_BROWSER_INTEROP_SOCKET" ] || exit 1
  export WSL_INTEROP=$AGENT_BROWSER_INTEROP_SOCKET
fi
exec "$@" </dev/null >/dev/null 2>&1"#;

#[derive(Debug, PartialEq, Eq)]
enum WslState { NotStarted, Starting, Running, Stopped, Unknown }
struct Inspection { owned: bool, listener: bool, state: WslState, probe_code: Option<i32> }
fn wsl_state_code(code: Option<i32>, launcher: &Identity) -> WslState {
    match code {
        Some(0|20) => WslState::Running,
        Some(10) if process::exited(launcher) => WslState::NotStarted,
        Some(10) => WslState::Starting,
        Some(11) => WslState::Stopped,
        _ => WslState::Unknown,
    }
}
async fn wsl_state(profile: &Profile, record: &RuntimeRecord) -> WslState {
    wsl_state_code(wsl_control_status(profile,record,"state").await,&record.launcher)
}
fn wsl_forwarder(record: &RuntimeRecord) -> bool {
    #[cfg(windows)] {
        let Some(port) = reqwest::Url::parse(&record.base_url).ok().and_then(|url| url.port()) else { return false; };
        let Some(listener) = process::listener(port) else { return false; };
        let image = listener.image.to_ascii_lowercase();
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()).to_ascii_lowercase();
        (image.starts_with(&format!("{root}\\system32\\")) || image.starts_with("c:\\program files\\wsl\\") || image.starts_with("c:\\program files\\windowsapps\\microsoftcorporationii.windowssubsystemforlinux_"))
            && (image.ends_with("\\wslrelay.exe") || image.ends_with("\\wslhost.exe"))
    }
    #[cfg(not(windows))] { let _ = record; true }
}
async fn wsl_control(profile: &Profile, record: &RuntimeRecord, mode: &str) -> bool {
    wsl_control_status(profile, record, mode).await == Some(0)
}
const WSL_CONTROL: &str = r#"set -eu
inspect_orphan_group() {
  wanted_group=$1; wanted_nonce=$2; found_live=0
  for member_stat in /proc/[0-9]*/stat; do
    member_text=$(cat "$member_stat" 2>/dev/null) || continue
    member_rest=${member_text##*) }; set -- $member_rest
    [ "$3" = "$wanted_group" ] && [ "$1" != Z ] || continue
    found_live=1; member_ticks=${20}
    member_pid=${member_stat#/proc/}; member_pid=${member_pid%/stat}
    tr '\000' '\n' </proc/$member_pid/environ 2>/dev/null | grep -Fqx "AGENT_BROWSER_RUNTIME_ID=$wanted_nonce" || continue
    # Recheck after reading the nonce: never adopt a reused/moved member PID.
    member_text=$(cat "$member_stat" 2>/dev/null) || continue
    member_rest=${member_text##*) }; set -- $member_rest
    [ "$3" = "$wanted_group" ] && [ "${20}" = "$member_ticks" ] && [ "$1" != Z ] && return 0
  done
  [ "$found_live" = 0 ] && return 11
  return 12
}
validate_owner() {
  [ -f "$1" ] || return 21
  [ -r "$1" ] || return 22
  read -r pid ticks instance boot < "$1" || return 23
  if [ "$pid" = pending ]; then [ "$ticks" = "$2" ] && [ -z "$instance$boot" ] || return 24; return 10; fi
  case $pid in ''|*[!0-9]*) return 23;; esac
  case $ticks in ''|*[!0-9]*) return 23;; esac
  [ "$pid" -gt 1 ] || return 23
  [ "$instance" = "$2" ] || return 24
  if [ -n "$boot" ]; then
    case $boot in *[!0-9a-f-]*) return 12;; esac
    case $boot in ????????-????-????-????-????????????) ;; *) return 12;; esac
    [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] || return 11
  fi
  if [ ! -d /proc/$pid ]; then
    [ "${3:-}" != leader ] || return 11
    inspect_orphan_group "$pid" "$2"; return $?
  fi
  stat=$(cat /proc/$pid/stat) || return 12; rest=${stat##*) }
  actual=$(printf '%s\n' "$rest" | awk '{print $20}')
  group=$(printf '%s\n' "$rest" | awk '{print $3}')
  state=$(printf '%s\n' "$rest" | awk '{print $1}')
  [ "$actual" = "$ticks" ] || return 11
  if [ "$state" = Z ]; then
    [ "${3:-}" != leader ] || return 11
    inspect_orphan_group "$pid" "$2"; return $?
  fi
  [ "$group" = "$pid" ] || return 12
  tr '\000' '\n' </proc/$pid/environ | grep -Fqx "AGENT_BROWSER_RUNTIME_ID=$2" || return 12
}
if validate_owner "$1" "$2"; then code=0; else code=$?; fi
if [ "$3" = dead ]; then [ "$code" = 11 ]; exit $?; fi
if [ "$code" != 0 ]; then
  case $3 in state|inspect) exit "$code";; *) exit 12;; esac
fi
if [ "$3" = inspect ] && [ -n "${5:-}" ]; then
  ( validate_owner "$5" "$2" leader || exit 12
    read -r nonce socket < "$5.ready" || exit 12
    [ "$nonce" = "$2" ] && [ "$socket" = "${6:-}" ] && [ -S "$socket" ]
  ) || exit 25
fi
if [ "$3" = listener ] || [ "$3" = inspect ]; then
  missing=1; [ "$3" != inspect ] || missing=20
  inode=$(awk -v addr="0100007F:$4" '$2 == addr && $4 == "0A" {print $10; exit}' /proc/net/tcp)
  [ -n "$inode" ] || exit "$missing"
  for fd in /proc/$pid/fd/*; do
    link=$(readlink "$fd" 2>/dev/null) || continue
    [ "$link" = "socket:[$inode]" ] && exit 0
  done
  for statfile in /proc/[0-9]*/stat; do
    procstat=$(cat "$statfile" 2>/dev/null) || continue
    procrest=${procstat##*) }
    procgroup=$(printf '%s\n' "$procrest" | awk '{print $3}')
    [ "$procgroup" = "$pid" ] || continue
    procpid=${statfile#/proc/}; procpid=${procpid%/stat}
    for fd in /proc/$procpid/fd/*; do
      link=$(readlink "$fd" 2>/dev/null) || continue
      [ "$link" = "socket:[$inode]" ] && exit 0
    done
  done
  exit "$missing"
fi
if [ "$3" = stop ]; then /bin/kill -TERM -- -$pid; fi"#;
async fn wsl_control_status(profile: &Profile, record: &RuntimeRecord, mode: &str) -> Option<i32> {
    tracing::debug!(profile_id = %profile.id, mode, "WSL control probe");
    let Some(owner) = &record.wsl_owner_file else { return None; };
    let script = WSL_CONTROL;
    let mut args = wsl_args(profile); args.extend(["--exec".into(),"/bin/sh".into(),"-c".into(),script.into(),"agent-browser".into(),owner.clone(),record.instance.clone(),mode.into(),format!("{:04X}",reqwest::Url::parse(&record.base_url).ok().and_then(|url| url.port()).unwrap_or(0)),record.wsl_keeper.as_ref().map(|keeper| keeper.owner_file.clone()).unwrap_or_default(),record.wsl_keeper.as_ref().map(|keeper| keeper.socket.clone()).unwrap_or_default()]);
    let mut command = tokio::process::Command::new(process::wsl_executable()); command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] { command.creation_flags(0x08000000); }
    match tokio::time::timeout(Duration::from_secs(5),command.status()).await {
        Err(_) => Some(-2),
        Ok(Err(_)) => Some(-3),
        Ok(Ok(status)) => status.code(),
    }
}
async fn health(base: &str, username: Option<&str>, password: Option<&str>, managed: bool, verified: &DocCache) -> Result<String,RpcError> {
    let client = http_client(base)?;
    let endpoint = |path: &str| format!("{}/{}",base.trim_end_matches('/'),path);
    if managed {
        let response = client.get(endpoint("global/health")).send().await.map_err(|_| failure("OpenCode is not reachable"))?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED { return Err(failure("Managed OpenCode must require Basic authentication")); }
    }
    let request = |path: &str| { let request = client.get(endpoint(path)); if let Some(password) = password.filter(|value| !value.is_empty()) { request.basic_auth(username.unwrap_or("opencode"),Some(password)) } else { request } };
    let response = request("global/health").send().await.map_err(|_| failure("OpenCode connection failed; verify URL, system proxy, and trusted certificates"))?;
    if !response.status().is_success() { return Err(failure(format!("OpenCode health returned HTTP {}",response.status().as_u16()))); }
    let value = limited_json(response,64 * 1024).await?;
    let version = value["version"].as_str().filter(|version| version.starts_with("1.")).ok_or_else(|| failure("Only OpenCode v1 is supported"))?;
    if value["healthy"] != true { return Err(failure("OpenCode reported unhealthy")); }
    // The ~825 KB API document only changes with the server version; status polls run every 15 s.
    let key = format!("{}#{version}", base.trim_end_matches('/'));
    if verified.lock().unwrap().contains(&key) { return Ok(version.into()); }
    let doc = limited_json(request("doc").send().await.map_err(|_| failure("OpenCode v1 API discovery failed"))?,4 * 1024 * 1024).await?;
    if !["/session","/provider","/event","/mcp"].iter().all(|path| doc["paths"].get(*path).is_some()) { return Err(failure("The server does not expose the required OpenCode v1 APIs")); }
    verified.lock().unwrap().insert(key);
    Ok(version.into())
}
async fn browser_mcp(profile: &Profile, record: &RuntimeRecord) -> Result<(),RpcError> {
    let mut url = reqwest::Url::parse(&format!("{}/mcp",record.base_url)).map_err(|_| failure("Invalid managed runtime URL"))?;
    url.query_pairs_mut().append_pair("directory",&profile.directory);
    let response = http_client(&record.base_url)?.get(url).basic_auth(&record.username,Some(&record.password))
        .timeout(Duration::from_secs(35)).send().await.map_err(|_| failure("OpenCode HTTP is available but browser MCP initialization did not finish"))?;
    if !response.status().is_success() { return Err(failure("Browser MCP status returned an error")); }
    let value = limited_json(response,1024 * 1024).await?;
    if value["browser"]["status"] != "connected" { return Err(failure("OpenCode HTTP is available but browser MCP is not connected; inspect WSL interop and the Bridge executable")); }
    Ok(())
}
fn http_client(base: &str) -> Result<reqwest::Client,RpcError> {
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(3));
    let url = reqwest::Url::parse(base).map_err(|_| invalid("Invalid OpenCode URL"))?;
    if matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"[::1]"|"::1")) { builder = builder.no_proxy(); }
    builder.build().map_err(|_| failure("Cannot initialize the system TLS client"))
}

async fn limited_json(mut response: reqwest::Response, limit: usize) -> Result<Value,RpcError> {
    if response.content_length().is_some_and(|length| length > limit as u64) { return Err(failure("OpenCode response exceeded the diagnostic size limit")); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failure("Cannot read OpenCode response"))? {
        if bytes.len() + chunk.len() > limit { return Err(failure("OpenCode response exceeded the diagnostic size limit")); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| failure("OpenCode returned invalid JSON"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn busy_sessions_reads_only_the_current_launch_and_directory() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = vec![0; 4096];
                let read = stream.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                log.lock().unwrap().push(request.lines().next().unwrap_or_default().to_string());
                let authorized = request.to_ascii_lowercase().contains("authorization: basic");
                let body = r#"{"ses_a":{"type":"busy"},"ses_b":{"type":"idle"},"ses_c":{"type":"retry","attempt":1,"message":"x","next":1}}"#;
                let response = if authorized { format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body) } else { "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into() };
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let home = tempfile::tempdir().unwrap(); let manager = Manager::new(home.path().into(),4317);
        let profile: Profile = serde_json::from_value(json!({"id":"p","name":"P","kind":"windows","directory":"C:\\w","executable":"C:\\o\\opencode.exe"})).unwrap();
        manager.store.update(|config| { config.profiles.insert("p".into(), profile); Ok(()) }).unwrap();
        manager.persist(&RuntimeRecord{profile_id:"p".into(),instance:"rid-now".into(),base_url:base,username:"opencode".into(),password:"private".into(),launcher:process::identity(std::process::id()).unwrap(),server:None,wsl_owner_file:None,version:None,bridge_port:Some(4317),bridge_executable:None,wsl_keeper:None}).unwrap();
        let found = manager.busy_sessions("rid-now","C:\\w").await.unwrap();
        assert_eq!((found.profile_id.as_str(),found.wsl),("p",false));
        let mut busy = found.busy; busy.sort(); assert_eq!(busy,vec!["ses_a","ses_c"]);
        assert!(seen.lock().unwrap()[0].starts_with("GET /session/status?directory=C%3A%5Cw "),"{:?}",seen.lock().unwrap());
        assert!(manager.busy_sessions("rid-old","C:\\w").await.is_err(),"a previous launch's proxy must not bind");
    }

    #[test]
    fn unknown_session_states_count_as_busy() {
        assert_eq!(busy_from(&json!({"a":{"type":"compacting"},"b":{"type":"idle"},"c":{"type":"busy"}})).unwrap(), vec!["a","c"]);
        assert!(busy_from(&json!(["a"])).is_err(), "a reply that is not a map never reads as idle");
    }

    #[tokio::test]
    async fn health_verifies_the_api_document_once_per_server_version() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let docs = Arc::new(AtomicUsize::new(0));
        let counter = docs.clone();
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = vec![0; 4096];
                let read = stream.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let body = if request.starts_with("GET /doc") { counter.fetch_add(1, Ordering::SeqCst); r#"{"paths":{"/session":{},"/provider":{},"/event":{},"/mcp":{}}}"# } else { r#"{"healthy":true,"version":"1.18.29"}"# };
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let cache = DocCache::default();
        assert_eq!(health(&base, None, None, false, &cache).await.unwrap(), "1.18.29");
        assert_eq!(health(&base, None, None, false, &cache).await.unwrap(), "1.18.29");
        assert_eq!(docs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn installer_create_only_does_not_replace_an_existing_profile() {
        let home=tempfile::tempdir().unwrap();
        let first=Manager::new(home.path().into(),4317);
        let second=Manager::new(home.path().into(),4317);
        let profile: Profile=serde_json::from_value(json!({"id":"existing","name":"Original","kind":"external","directory":"/fixture","baseUrl":"https://example.test","password":"original-secret"})).unwrap();
        first.save_new(profile.clone(),false).unwrap();
        let mut changed=profile;changed.name="Changed".into();changed.password=Some("replacement-secret".into());
        assert!(second.save_new(changed,false).is_err());
        assert_eq!(first.list().unwrap()["profiles"][0]["name"],"Original");
        assert_eq!(first.profile("existing").unwrap().password.as_deref(),Some("original-secret"));
    }

    #[tokio::test]
    async fn review_status_holds_profile_locks_until_inspection_finishes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let home = tempfile::tempdir().unwrap();
        let manager = Arc::new(Manager::new(home.path().into(),4317));
        let other = Manager::new(home.path().into(),4317);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let profile: Profile = serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"external","directory":"/fixture","baseUrl":format!("http://{}",listener.local_addr().unwrap())})).unwrap();
        manager.save(profile.clone(),false).unwrap();
        let (entered, inspecting) = tokio::sync::oneshot::channel();
        let (release, resume) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream,_) = listener.accept().await.unwrap();
            let mut request = [0;4]; stream.read_exact(&mut request).await.unwrap();
            assert_eq!(&request,b"GET ");
            entered.send(()).unwrap(); resume.await.unwrap();
            stream.write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        });
        let inspecting_manager = manager.clone();
        let status = tokio::spawn(async move { inspecting_manager.status("fixture").await });
        tokio::time::timeout(Duration::from_secs(2),inspecting).await.unwrap().unwrap();
        let local_blocked = manager.lock("fixture").try_lock().is_err();
        let other_manager_blocked = other.save(profile.clone(),false).is_err();
        release.send(()).unwrap();
        assert_eq!(status.await.unwrap().unwrap()["state"],"error"); server.await.unwrap();
        assert!(local_blocked,"Stop must not race an in-flight status inspection");
        assert!(other_manager_blocked,"Profile edits from another manager must not race status either");
        assert!(manager.lock("fixture").try_lock().is_ok());
        other.save(profile,false).unwrap();
    }

    #[test]
    fn overlay_preserves_settings_and_uses_actual_bridge_port() {
        let home = tempfile::tempdir().unwrap(); let manager = Manager::new(home.path().into(),54321);
        let profile: Profile = serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"windows","directory":"/fixture","executable":"/fixture/opencode"})).unwrap();
        let mut env = BTreeMap::from([("OPENCODE_CONFIG_CONTENT".into(),json!({"model":"fixture/model","provider":{"fixture":{"options":{"secret":"private"}}},"plugin":["fixture"],"mcp":{"existing":{"enabled":false}}}).to_string())]);
        manager.overlay(&profile,&mut env).unwrap();
        let value: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
        assert_eq!(value["model"],"fixture/model"); assert_eq!(value["provider"]["fixture"]["options"]["secret"],"private"); assert_eq!(value["plugin"],json!(["fixture"])); assert_eq!(value["mcp"]["existing"]["enabled"],false);
        assert_eq!(value["mcp"]["browser"]["environment"]["AGENT_BROWSER_PORT"],"54321");
    }
    #[test]
    fn overlay_hands_the_runtime_id_to_the_browser_mcp() {
        let home = tempfile::tempdir().unwrap(); let manager = Manager::new(home.path().into(),54321);
        let kinds: &[(&str,bool)] = if cfg!(windows) { &[("windows",false),("wsl",true)] } else { &[("windows",false)] };
        for (kind,wsl) in kinds {
            let profile: Profile = serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":kind,"distribution":"Ubuntu","directory":"/fixture","executable":"/fixture/opencode"})).unwrap();
            let mut env = BTreeMap::from([("AGENT_BROWSER_RUNTIME_ID".to_string(),"rid-1".to_string())]);
            manager.overlay(&profile,&mut env).unwrap();
            let value: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
            assert_eq!(value["mcp"]["browser"]["environment"]["AGENT_BROWSER_RUNTIME_ID"],"rid-1");
            assert_eq!(value["mcp"]["browser"]["environment"]["WSLENV"].as_str().is_some_and(|v| v.split(':').any(|e| e=="AGENT_BROWSER_RUNTIME_ID/w")),*wsl);
        }
    }
}

#[cfg(all(test,unix))]
mod stop_all_tests {
    use super::*;
    #[tokio::test]
    async fn r03_listener_record_write_failure_preserves_existing_runtime() {
        let home = tempfile::tempdir().unwrap(); let manager = Manager::new(home.path().into(),4317);
        let owned = process::spawn("/bin/sleep",&["60".into()],None,&BTreeMap::new()).unwrap();
        let profile: Profile = serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"windows","directory":home.path(),"executable":"/bin/sleep"})).unwrap();
        let mut record = RuntimeRecord {profile_id:"fixture".into(),instance:"fixture".into(),base_url:"http://127.0.0.1:65531".into(),username:"opencode".into(),password:"fixture-private".into(),launcher:owned.clone(),server:Some(owned.clone()),wsl_owner_file:None,version:None,bridge_port:Some(4317),bridge_executable:None,wsl_keeper:None};
        std::fs::create_dir(home.path().join("runtime.json")).unwrap();
        let result = manager.verify_listener(&profile,&mut record).await;
        let alive = process::matches(&owned);
        process::terminate(&owned);
        assert!(result.is_err(),"Fixture must fail to persist the listener identity");
        assert!(alive,"A status/reuse check must not terminate the existing runtime when persistence fails");
    }
    #[tokio::test]
    async fn stop_all_terminates_owned_processes_and_preserves_external_profiles() {
        let home = tempfile::tempdir().unwrap(); let manager = Manager::new(home.path().into(),4317);
        let owned = process::spawn("/bin/sleep",&["60".into()],None,&BTreeMap::new()).unwrap();
        let external = process::spawn("/bin/sleep",&["60".into()],None,&BTreeMap::new()).unwrap();
        let managed: Profile = serde_json::from_value(json!({"id":"owned","name":"Owned fixture","kind":"windows","directory":home.path(),"executable":"/bin/sleep"})).unwrap(); manager.save(managed,false).unwrap();
        let other: Profile = serde_json::from_value(json!({"id":"external","name":"External fixture","kind":"external","directory":"/fixture","baseUrl":"http://127.0.0.1:65530"})).unwrap(); manager.save(other,false).unwrap();
        manager.persist(&RuntimeRecord {profile_id:"owned".into(),instance:"fixture".into(),base_url:"http://127.0.0.1:65531".into(),username:"opencode".into(),password:"fixture-private".into(),launcher:owned.clone(),server:Some(owned.clone()),wsl_owner_file:None,version:None,bridge_port:Some(4317),bridge_executable:None,wsl_keeper:None}).unwrap();
        let result = manager.stop_all().await.unwrap();
        assert_eq!(result["stoppedProfiles"],json!(["owned"])); assert_eq!(result["skippedExternal"],json!(["external"])); assert_eq!(result["errors"],json!([]));
        assert!(!process::matches(&owned)); assert!(process::matches(&external)); assert!(!result.to_string().contains("fixture-private"));
        process::terminate(&external);
        assert!(manager.store.read().unwrap().runtimes.is_empty()); assert_eq!(manager.list().unwrap()["profiles"].as_array().unwrap().len(),2);
    }
}

#[cfg(test)]
mod overlay_identity_tests {
    use super::*;
    #[test]
    fn automatic_ports_are_reserved_across_profiles_before_a_process_binds() {
        let home = tempfile::tempdir().unwrap(); let one = Manager::new(home.path().into(),4317); let two = Manager::new(home.path().into(),4317);
        let first = one.reserve_port("first",None).unwrap(); let second = two.reserve_port("second",None).unwrap();
        assert_ne!(first.port,second.port); assert_eq!(one.store.read().unwrap().reservations.len(),2);
        drop(first); drop(second); assert!(one.store.read().unwrap().reservations.is_empty());
    }
    #[test]
    fn overlay_reuse_requires_same_port_and_an_existing_original_bridge_executable() {
        let home = tempfile::tempdir().unwrap(); let manager = Manager::new(home.path().into(),54321); let executable = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let mut record = RuntimeRecord {profile_id:"fixture".into(),instance:"fixture".into(),base_url:"http://127.0.0.1:4096".into(),username:"opencode".into(),password:"private".into(),launcher:process::identity(std::process::id()).unwrap(),server:None,wsl_owner_file:None,version:None,bridge_port:Some(54321),bridge_executable:Some(executable),wsl_keeper:None};
        assert!(manager.overlay_current(&record)); record.bridge_port = Some(4317); assert!(!manager.overlay_current(&record));
        record.bridge_port = Some(54321); record.bridge_executable = Some(home.path().join("removed-bridge.exe").to_string_lossy().into_owned()); assert!(!manager.overlay_current(&record));
    }
}

#[cfg(all(test,unix))]
mod lock_release_tests {
    use super::*;
    #[test]
    fn profile_lock_explicitly_unlocks_even_while_a_child_descriptor_copy_exists() {
        let home = tempfile::tempdir().unwrap(); let manager = Manager::new(home.path().into(),4317);
        let held = manager.operation_lock("fixture").unwrap(); let inherited = held.try_clone().unwrap(); drop(held);
        assert!(manager.operation_lock("fixture").is_ok(),"Closing only the parent's fd must not leave the operation lock held by a forked child");
        drop(inherited);
    }
}

#[cfg(all(test, unix))]
mod wsl_start_tests {
    use super::*;
    fn control(owner: &std::path::Path, instance: &str, mode: &str) -> Option<i32> {
        std::process::Command::new("/bin/sh").args(["-c", WSL_CONTROL, "fixture", owner.to_str().unwrap(), instance, mode, "0000"]).stderr(std::process::Stdio::null()).status().unwrap().code()
    }
    #[test]
    fn r04_launch_records_identity_before_cd_can_fail() {
        let home = tempfile::tempdir().unwrap(); let owner = home.path().join("owner");
        let status = std::process::Command::new("/usr/bin/setsid").args(["--wait", "/bin/sh", "-c", WSL_LAUNCH, "fixture", "/nonexistent-agent-browser-fixture", owner.to_str().unwrap(), "fixture", "/bin/true"])
            .env("AGENT_BROWSER_RUNTIME_ID", "fixture").stderr(std::process::Stdio::null()).status().unwrap();
        assert!(!status.success());
        assert!(std::fs::read_to_string(&owner).unwrap().contains("fixture"));
        assert_eq!(control(&owner, "fixture", "state"), Some(11));
    }
    #[test]
    fn review_wsl_launch_requires_matching_persisted_start_permit() {
        let home = tempfile::tempdir().unwrap(); let owner = home.path().join("owner"); let executed = home.path().join("executed");
        let mut child = std::process::Command::new("/usr/bin/setsid").args(["--wait","/bin/sh","-c",WSL_LAUNCH,"fixture",home.path().to_str().unwrap(),owner.to_str().unwrap(),"fixture","/bin/sh","-c","printf executed > \"$1\"","fixture",executed.to_str().unwrap()])
            .env("AGENT_BROWSER_RUNTIME_ID","fixture").spawn().unwrap();
        for _ in 0..100 { if owner.exists() {break;} std::thread::sleep(Duration::from_millis(10)); }
        std::thread::sleep(Duration::from_millis(150)); let before = executed.exists();
        std::fs::write(home.path().join("owner.start"),"wrong-instance").unwrap();
        std::thread::sleep(Duration::from_millis(150)); let wrong = executed.exists();
        std::fs::write(home.path().join("owner.start"),"fixture").unwrap();
        let status = child.wait().unwrap();
        assert!(!before && !wrong,"An unpersisted or wrong-instance launch must not execute OpenCode");
        assert!(status.success() && executed.exists(),"The matching persisted start permit must allow execution");
    }
    #[test]
    fn r04_missing_corrupt_and_nonce_mismatched_markers_are_never_dead() {
        let home = tempfile::tempdir().unwrap(); let owner = home.path().join("owner");
        assert_eq!(control(&owner, "fixture", "state"), Some(21));
        for marker in ["", "pending wrong\n", "pending fixture extra\n", "0 0 fixture\n", "1234 0 wrong\n", "1234 invalid fixture\n", "1234 123 fixture malformed-boot\n"] {
            std::fs::write(&owner, marker).unwrap();
            assert!(![Some(0),Some(10),Some(11)].contains(&control(&owner,"fixture","state")));
        }
        std::fs::write(&owner,"pending fixture\n").unwrap();
        assert_eq!(control(&owner,"fixture","state"),Some(10));
        assert_ne!(control(&owner,"fixture","stop"),Some(0));
    }
    #[test]
    fn r04_running_owner_is_verified_and_stops_only_its_own_group() {
        let home = tempfile::tempdir().unwrap(); let owner = home.path().join("owner");
        let mut child = std::process::Command::new("/usr/bin/setsid").args(["--wait", "/bin/sh", "-c", WSL_LAUNCH, "fixture", home.path().to_str().unwrap(), owner.to_str().unwrap(), "fixture", "/bin/sleep", "5"])
            .env("AGENT_BROWSER_RUNTIME_ID", "fixture").spawn().unwrap();
        for _ in 0..50 { if control(&owner,"fixture","state") == Some(0) { break; } std::thread::sleep(Duration::from_millis(10)); }
        assert_eq!(control(&owner,"fixture","state"),Some(0));
        assert_ne!(control(&owner,"wrong","stop"),Some(0));
        assert_eq!(control(&owner,"fixture","state"),Some(0));
        assert_eq!(control(&owner,"fixture","stop"),Some(0)); child.wait().unwrap();
        assert_eq!(control(&owner,"fixture","state"),Some(11));
    }
    #[tokio::test]
    async fn d01_doctor_uses_profile_env_and_directory() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap(); let executable = home.path().join("version.sh");
        std::fs::write(&executable, "#!/bin/sh\n[ \"$AB_VERSION_TEST\" = ready ] && [ \"$PWD\" = \"$AB_DIRECTORY_TEST\" ] || exit 1\nprintf '1.18.29\\n'\n").unwrap();
        std::fs::set_permissions(&executable,std::fs::Permissions::from_mode(0o700)).unwrap();
        let profile: Profile = serde_json::from_value(json!({"id":"fixture","name":"fixture","kind":"windows","directory":home.path(),"executable":executable,"env":{"AB_VERSION_TEST":"ready","AB_DIRECTORY_TEST":home.path()}})).unwrap();
        assert_eq!(installation_check(&profile).await["status"],"ok");
    }
}


#[cfg(all(test, windows))]
mod wsl_persist_failure_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Requires a local WSL Ubuntu distribution; uses only a synthetic sleep process"]
    async fn review_pending_wsl_owner_is_cleaned_after_initial_persist_failure() {
        let home = tempfile::tempdir().unwrap(); let manager = Manager::new(home.path().into(),4317);
        let directory = home.path().join("runtime"); std::fs::create_dir(&directory).unwrap();
        let owner = directory.join("fixture.owner"); let executed = directory.join("executed");
        std::fs::write(&owner,"pending fixture\n").unwrap();
        let mapped = process::windows_to_wsl(&owner.to_string_lossy()).unwrap();
        let executed_linux = process::windows_to_wsl(&executed.to_string_lossy()).unwrap();
        let profile: Profile = serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"wsl","distribution":"Ubuntu","directory":"/tmp","executable":"/bin/sh"})).unwrap();
        let mut args = wsl_args(&profile);
        args.extend(["--exec".into(),"/usr/bin/setsid".into(),"--wait".into(),"/bin/sh".into(),"-c".into(),format!("sleep 1; {WSL_LAUNCH}"),"fixture".into(),"/tmp".into(),mapped.clone(),"fixture".into(),"/bin/sh".into(),"-c".into(),"printf executed > \"$1\"; exec /bin/sleep 10".into(),"fixture".into(),executed_linux]);
        let mut env = BTreeMap::from([("AGENT_BROWSER_RUNTIME_ID".into(),"fixture".into())]); forward_wsl_env(&mut env);
        let launcher = process::spawn(&process::wsl_executable(),&args,None,&env).unwrap();
        let record = RuntimeRecord {profile_id:"fixture".into(),instance:"fixture".into(),base_url:"http://127.0.0.1:65531".into(),username:"opencode".into(),password:"fixture".into(),launcher,server:None,wsl_owner_file:Some(mapped),version:None,bridge_port:Some(4317),bridge_executable:None,wsl_keeper:None};
        let pending = std::fs::read_to_string(&owner).unwrap() == "pending fixture\n";
        std::fs::create_dir(home.path().join("runtime.json")).unwrap();
        let persist_failed = manager.persist(&record).is_err();
        let stopped = manager.terminate(&profile,&record).await;
        tokio::time::sleep(Duration::from_millis(1400)).await;
        let late_execution = executed.exists();
        // Always clean this fixture's nonce-verified process group before asserting.
        wsl_control(&profile,&record,"stop").await;
        for _ in 0..30 {
            if matches!(wsl_state(&profile,&record).await,WslState::Stopped | WslState::NotStarted) {break;}
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let ended = matches!(wsl_state(&profile,&record).await,WslState::Stopped | WslState::NotStarted);
        if ended {process::terminate(&record.launcher);}
        assert!(pending && persist_failed,"Fixture must reach initial persistence failure with a pending owner");
        assert!(ended,"Synthetic WSL process must be cleaned up");
        assert!(stopped && !late_execution,"Pending cleanup returned before ownership was published; child executed after persistence failed");
    }
}

#[cfg(test)]
mod issue8_runtime_tests {
    use super::*;
    #[tokio::test]
    async fn f15_unmappable_home_returns_invalid_params_before_launch() {
        let profile:Profile=serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"wsl","distribution":"Ubuntu","directory":"/tmp","executable":"/bin/true"})).unwrap();
        for home in [r"\\server\share\agent-browser",r"\\?\C:\fixture\agent-browser"] {
            let manager=Manager::new(home.into(),4317);
            let result=manager.launch_wsl(&profile,65531,"fixture".into(),"fixture".into(),BTreeMap::new(),vec!["/bin/true".into()]).await;
            let error=match result {Err(error)=>error,Ok(_)=>panic!("Unmappable home must fail before spawning")};
            assert_eq!(error.code,crate::rpc::ErrorCode::InvalidParams);
            assert!(error.message.contains("Windows Bridge home"),"{}",error.message);
        }
    }
    #[tokio::test]
    async fn f14_managed_http_ready_mcp_failure_reaches_doctor_details() {
        use tokio::io::{AsyncReadExt,AsyncWriteExt};
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port=listener.local_addr().unwrap().port();
        let server=tokio::spawn(async move {
            loop {
                let Ok((mut stream,_))=listener.accept().await else {break};
                tokio::spawn(async move {
                    let mut bytes=[0;8192];let n=stream.read(&mut bytes).await.unwrap();
                    let request=String::from_utf8_lossy(&bytes[..n]);
                    let authorized=request.to_ascii_lowercase().contains("authorization: basic ");
                    let value=if request.contains("/global/health") {json!({"healthy":true,"version":"1.18.29"})}
                        else if request.contains("/doc") {json!({"paths":{"/session":{},"/provider":{},"/event":{},"/mcp":{}}})}
                        else if request.contains("/mcp") {json!({"browser":{"status":"failed","error":"spawn missing.exe ENOENT private-fixture-detail"}})}
                        else {json!({})};
                    let body=value.to_string();let status=if authorized {"200 OK"} else {"401 Unauthorized"};
                    let response=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                    let _=stream.write_all(response.as_bytes()).await;
                });
            }
        });
        let home=tempfile::tempdir().unwrap();let manager=Manager::new(home.path().into(),0);
        let profile:Profile=serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"windows","directory":home.path(),"executable":home.path().join("absent-opencode.exe")})).unwrap();
        manager.save(profile,false).unwrap();
        let identity=process::identity(std::process::id()).unwrap();
        manager.persist(&RuntimeRecord{profile_id:"fixture".into(),instance:"fixture".into(),base_url:format!("http://127.0.0.1:{port}"),username:"opencode".into(),password:"private-fixture-password".into(),launcher:identity.clone(),server:Some(identity),wsl_owner_file:None,version:None,bridge_port:Some(0),bridge_executable:Some(std::env::current_exe().unwrap().to_string_lossy().into_owned()),wsl_keeper:None}).unwrap();
        let status=manager.status("fixture").await.unwrap();
        assert_eq!(status["state"],"error");
        let doctor=manager.doctor(Some("fixture")).await.unwrap();server.abort();
        assert!(doctor["checks"].as_array().unwrap().iter().any(|check|check["id"]=="mcp"&&check["reason"]=="executable_missing"),"{doctor}");
        assert!(!doctor.to_string().contains("private-fixture"));
        assert!(!status.to_string().contains("private-fixture"));
    }
}
