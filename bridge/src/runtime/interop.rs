//! A runtime owns its relay keeper. No user's terminal or init fallback is borrowed.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keeper {
    pub launcher: Identity,
    pub owner_file: String,
    pub socket: String,
}

pub(super) const WSL_PREFLIGHT: &str = r#"set -eu
[ -d "$1" ] && [ -x "$1" ] || exit 31
[ -f "$4" ] && [ -x "$4" ] || exit 32
[ "${5:-}" = diagnose ] || { [ -r "$2" ] && [ -w "$2" ] && [ "$(cat "$2")" = "pending $3" ] || exit 33; }
[ -w "$(dirname "$2")" ] || exit 33
for tool in /usr/bin/setsid /usr/bin/timeout /bin/kill; do [ -x "$tool" ] || exit 34; done
for tool in awk cat grep tr readlink mv sleep; do command -v "$tool" >/dev/null || exit 34; done
[ -r /proc/$$/environ ] && [ -r /proc/$$/stat ] && [ -r /proc/sys/kernel/random/boot_id ] || exit 35
# Registration metadata can be unavailable even when interop works. Exercise
# this exact Windows Bridge, without starting its server or changing WSL policy.
version=$(/usr/bin/timeout -k 1 5 "$6" --version 2>/dev/null) || exit 36
case "$version" in 'browser-bridge '*) ;; *) exit 36;; esac
"#;

pub(super) async fn preflight_code(profile: &Profile, owner: &str, instance: &str, diagnostic: bool) -> Option<i32> {
    // Unit-test harness executables do not implement the Bridge CLI. Native
    // persistence tests use the separately built real Bridge for this canary.
    #[cfg(test)]
    let executable=std::env::var_os("AGENT_BROWSER_TEST_EXE").map(std::path::PathBuf::from).or_else(||std::env::current_exe().ok());
    #[cfg(not(test))]
    let executable=std::env::current_exe().ok();
    let bridge=executable.and_then(|path|process::windows_to_wsl(&path.to_string_lossy()));
    let Some(bridge)=bridge else {return Some(36)};
    let mut args=wsl_args(profile);
    args.extend(["--exec".into(),"/bin/sh".into(),"-c".into(),WSL_PREFLIGHT.into(),"agent-browser-preflight".into(),profile.directory.clone(),owner.into(),instance.into(),profile.executable.clone().unwrap_or_default(),if diagnostic {"diagnose"} else {"launch"}.into(),bridge]);
    let mut probe=tokio::process::Command::new(process::wsl_executable());
    probe.env_remove("WSL_INTEROP").args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] {probe.creation_flags(0x08000000);}
    match tokio::time::timeout(Duration::from_secs(10),probe.status()).await {
        Err(_) => Some(-2), Ok(Err(_)) => Some(-3), Ok(Ok(status)) => status.code(),
    }
}

impl Manager {
    pub(super) fn revoke_wsl_permit(&self, record: &RuntimeRecord) -> bool {
        // Never derive a removal path from an unchecked runtime.json field.
        if record.instance.is_empty() || !record.instance.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') { return false; }
        for suffix in ["owner","keeper"] {
            let directory=self.home.join("runtime");
            let owner=directory.join(format!("{}.{suffix}",record.instance));
            if process::windows_to_wsl(&owner.to_string_lossy()).as_deref() != record.wsl_owner_file.as_deref() { continue; }
            let permit=directory.join(format!("{}.{suffix}.start",record.instance));
            return match std::fs::remove_file(permit) { Ok(()) => true, Err(error) => error.kind() == std::io::ErrorKind::NotFound };
        }
        false
    }

    async fn spawn_wsl_owned(&self, profile: &Profile, instance: &str, suffix: &str, command: Vec<String>, env: &BTreeMap<String,String>) -> Result<(Identity,String),RpcError> {
        let owner = self.home.join("runtime").join(format!("{instance}.{suffix}"));
        std::fs::create_dir_all(owner.parent().unwrap()).map_err(|_| failure("Cannot create WSL ownership directory"))?;
        let mapped = process::windows_to_wsl(&owner.to_string_lossy()).ok_or_else(|| invalid("WSL runtimes require a Windows Bridge home on a drive mounted by WSL"))?;
        std::fs::write(&owner,format!("pending {instance}\n")).map_err(|_| failure("Cannot initialize WSL ownership marker"))?;
        let code=preflight_code(profile,&mapped,instance,false).await;
        if code != Some(0) {return Err(failure(format!("{}: WSL launch prerequisites could not be verified.",diagnostics::wsl_probe_reason(code))));}
        let mut args = wsl_args(profile);
        args.extend(["--exec".into(),"/usr/bin/setsid".into(),"--wait".into(),"/bin/sh".into(),"-c".into(),WSL_LAUNCH.into(),"agent-browser".into(),profile.directory.clone(),mapped.clone(),instance.into()]);
        args.extend(command);
        let mut env = env.clone(); forward_wsl_env(&mut env);
        let launcher = process::spawn(&process::wsl_executable(),&args,None,&env).map_err(|_| failure("Cannot launch the owned WSL runtime"))?;
        Ok((launcher,mapped))
    }

    fn permit_wsl(&self, instance: &str, suffix: &str) -> Result<(),RpcError> {
        std::fs::write(self.home.join("runtime").join(format!("{instance}.{suffix}.start")),instance)
            .map_err(|_| failure("Cannot authorize the persisted WSL runtime to start"))
    }

    pub(super) async fn launch_wsl(&self, profile: &Profile, port: u16, instance: String, password: String, mut env: BTreeMap<String,String>, command: Vec<String>) -> Result<RuntimeRecord,RpcError> {
        let owner = self.home.join("runtime").join(format!("{instance}.keeper"));
        let mapped = process::windows_to_wsl(&owner.to_string_lossy()).ok_or_else(|| invalid("WSL runtimes require a Windows Bridge home on a drive mounted by WSL"))?;
        let bridge = std::env::current_exe().map_err(|_| failure("Cannot resolve the Bridge executable"))?.to_string_lossy().into_owned();
        let probe = process::windows_to_wsl(&bridge).ok_or_else(|| invalid("The Bridge executable must be on a Windows drive"))?;
        let script = format!("{CANARY_FUNCTION}\n{KEEPER_SCRIPT}");
        let (launcher,owner_file) = self.spawn_wsl_owned(profile,&instance,"keeper",vec!["/bin/sh".into(),"-c".into(),script,"agent-browser-keeper".into(),mapped,instance.clone(),probe.clone()],&env).await?;
        // This provisional record also covers a crash between keeper and server launch.
        let mut record = RuntimeRecord {profile_id:profile.id.clone(),instance:instance.clone(),base_url:format!("http://127.0.0.1:{port}"),username:"opencode".into(),password,launcher:launcher.clone(),server:None,wsl_owner_file:Some(owner_file.clone()),version:None,bridge_port:Some(self.port),bridge_executable:Some(bridge),wsl_keeper:Some(Keeper {launcher,owner_file,socket:String::new()})};
        if let Err(error) = self.persist(&record) { self.terminate_wsl(profile,&record).await; return Err(error); }
        let result = async {
            self.permit_wsl(&instance,"keeper")?;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            let ready = self.home.join("runtime").join(format!("{instance}.keeper.ready"));
            let socket = loop {
                if let Ok(value) = std::fs::read_to_string(&ready) {
                    if let Some(socket) = ready_socket(&value,&instance) { break socket; }
                    return Err(failure("WSL interop keeper returned an invalid readiness record"));
                }
                if process::exited(&record.launcher) || tokio::time::Instant::now() >= deadline {
                    return Err(failure("WSL interop keeper could not execute the Windows Bridge canary within 20 seconds; browser MCP was not started"));
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            };
            record.wsl_keeper.as_mut().unwrap().socket = socket.clone();
            // The shell and MCP use precisely the socket exercised by the canary.
            env.insert("AGENT_BROWSER_INTEROP_SOCKET".into(),socket.clone());
            let mut overlay: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).map_err(|_| failure("Invalid managed MCP overlay"))?;
            overlay["mcp"]["browser"]["environment"]["WSL_INTEROP"] = json!(&socket);
            overlay["mcp"]["browser"]["command"] = json!(["/bin/sh","-c",MCP_LAUNCH,"agent-browser-mcp",record.wsl_keeper.as_ref().unwrap().owner_file,instance,socket,probe]);
            env.insert("OPENCODE_CONFIG_CONTENT".into(),overlay.to_string());
            let (launcher,owner) = self.spawn_wsl_owned(profile,&instance,"owner",command,&env).await?;
            record.launcher = launcher; record.wsl_owner_file = Some(owner);
            self.persist(&record)?;
            self.permit_wsl(&instance,"owner")?;
            Ok(record.clone())
        }.await;
        if result.is_err() {
            // Use the in-memory record too: server spawn may have preceded a failed write.
            if self.terminate_wsl(profile,&record).await.is_some() {
                self.store.update(|config| {config.runtimes.remove(&profile.id); Ok(())})?;
            }
        }
        result
    }
}

fn ready_socket(value: &str, instance: &str) -> Option<String> {
    let fields: Vec<_> = value.split_whitespace().collect();
    if fields.len() != 2 || fields[0] != instance { return None; }
    let pid: u32 = fields[1].strip_prefix("/run/WSL/")?.strip_suffix("_interop")?.parse().ok()?;
    (pid > 2).then(|| fields[1].to_owned())
}

// WSL_LAUNCH has already recorded and durably authorized this process group.
// Select only a socket belonging to our ancestry, excluding init's shared fallback.
// A live socket is insufficient: execute the actual native Bridge with a deadline.
pub(super) const CANARY_FUNCTION: &str = r#"probe_windows() {
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    if version=$(/usr/bin/timeout -k 1 5 "$1" --version 2>/dev/null); then
      case $version in 'browser-bridge '*) return 0;; esac
    fi
    [ "$attempt" -lt 2 ] || return 1
    sleep 1
  done
}"#;

pub(super) const KEEPER_SCRIPT: &str = r#"set -eu
owner=$1; instance=$2; bridge=$3
ancestor=$$
socket=
while [ "$ancestor" -gt 2 ]; do
  candidate=/run/WSL/${ancestor}_interop
  if [ -S "$candidate" ]; then socket=$candidate; break; fi
  stat=$(cat /proc/$ancestor/stat) || exit 1
  rest=${stat##*) }
  ancestor=$(printf '%s\n' "$rest" | awk '{print $2}')
done
[ -n "$socket" ] || exit 1
export WSL_INTEROP=$socket
probe_windows "$bridge" || exit 1
printf '%s %s\n' "$instance" "$socket" > "$owner.ready.tmp"
mv -- "$owner.ready.tmp" "$owner.ready"
exec /bin/sleep infinity"#;

// Check again at every MCP launch. In particular, don't intentionally fall back
// to init or another terminal when a formerly good keeper socket disappears.
pub(super) const MCP_LAUNCH: &str = r#"set -eu
owner=$1; expected=$2; socket=$3; bridge=$4
read -r pid ticks instance boot < "$owner"
[ "$instance" = "$expected" ]
case $pid in ''|*[!0-9]*) exit 1;; esac
[ "$pid" -gt 2 ]
[ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ]
stat=$(cat /proc/$pid/stat); rest=${stat##*) }
[ "$(printf '%s\n' "$rest" | awk '{print $20}')" = "$ticks" ]
[ "$(printf '%s\n' "$rest" | awk '{print $3}')" = "$pid" ]
[ "$(printf '%s\n' "$rest" | awk '{print $1}')" != Z ]
tr '\000' '\n' </proc/$pid/environ | grep -Fqx "AGENT_BROWSER_RUNTIME_ID=$expected"
read -r nonce ready_socket < "$owner.ready"
[ "$nonce" = "$expected" ] && [ "$ready_socket" = "$socket" ] && [ -S "$socket" ]
export WSL_INTEROP=$socket
exec "$bridge" mcp"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeper_readiness_rejects_init_foreign_nonce_and_malformed_paths() {
        assert_eq!(ready_socket("nonce /run/WSL/123_interop\n","nonce"),Some("/run/WSL/123_interop".into()));
        for value in ["other /run/WSL/123_interop","nonce /run/WSL/1_interop","nonce /run/WSL/2_interop","nonce /tmp/123_interop","nonce /run/WSL/123_interop extra"] {
            assert!(ready_socket(value,"nonce").is_none());
        }
    }
}

#[cfg(all(test,windows))]
mod persistence_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Requires local WSL; verifies preflight without starting a runtime"]
    async fn unavailable_opencode_is_rejected_before_keeper_start() {
        let distribution=std::env::var("AGENT_BROWSER_TEST_WSL_DISTRIBUTION").unwrap_or_else(|_|"Ubuntu".into());
        let home=tempfile::tempdir().unwrap();let manager=Manager::new(home.path().into(),54329);
        let instance=uuid::Uuid::new_v4().simple().to_string();
        let profile:Profile=serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"wsl","distribution":distribution,"directory":"/tmp","executable":format!("/tmp/agent-browser-absent-{instance}")})).unwrap();
        let env=BTreeMap::from([("AGENT_BROWSER_RUNTIME_ID".into(),instance.clone()),("OPENCODE_CONFIG_CONTENT".into(),"{}".into())]);
        let error=match manager.launch_wsl(&profile,65531,instance.clone(),"fixture".into(),env,vec![profile.executable.clone().unwrap()]).await {Err(error)=>error,Ok(_)=>panic!("Missing executable launched")};
        assert!(error.message.starts_with("WSL_EXECUTABLE_UNAVAILABLE"),"{}",error.message);
        assert!(manager.store.read().unwrap().runtimes.is_empty());
        assert_eq!(std::fs::read_to_string(home.path().join("runtime").join(format!("{instance}.keeper"))).unwrap(),format!("pending {instance}\n"),"No keeper process may publish ownership before executable validation");
    }
    #[tokio::test]
    #[ignore = "Requires local WSL Ubuntu; only launches isolated failing fixtures"]
    async fn explicit_wsl_user_failed_start_can_stop_delete_and_register_again() {
        let distribution=std::env::var("AGENT_BROWSER_TEST_WSL_DISTRIBUTION").unwrap_or_else(|_|"Ubuntu".into());
        let output=std::process::Command::new(process::wsl_executable()).args(["-d",&distribution,"--exec","id","-un"]).output().unwrap();
        assert!(output.status.success());
        let user=std::env::var("AGENT_BROWSER_TEST_WSL_USER").unwrap_or_else(|_|String::from_utf8(output.stdout).unwrap().trim().to_owned());
        for explicit_user in [None,Some(user)] {
            let home=tempfile::tempdir().unwrap(); let manager=Manager::new(home.path().into(),54329);
            let instance=uuid::Uuid::new_v4().simple().to_string();
            let profile:Profile=serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"wsl","distribution":distribution,"user":explicit_user,"directory":format!("/tmp/agent-browser-absent-{instance}"),"executable":"/bin/false"})).unwrap();
            manager.save(profile.clone(),false).unwrap();
            let env=BTreeMap::from([("AGENT_BROWSER_RUNTIME_ID".into(),instance.clone()),("OPENCODE_CONFIG_CONTENT".into(),"{}".into())]);
            assert!(manager.launch_wsl(&profile,65531,instance,"fixture".into(),env,vec!["/bin/false".into()]).await.is_err());
            manager.stop("fixture").await.expect("Failed start must permit Stop");
            manager.delete("fixture").await.expect("Failed start must permit Delete");
            manager.save(profile,false).expect("Deleted profile must permit registration again");
            assert!(manager.store.read().unwrap().runtimes.is_empty());
        }
    }
    #[tokio::test]
    #[ignore = "Requires local WSL Ubuntu; only creates a delayed fixture"]
    async fn stop_revokes_permission_before_a_delayed_wsl_launch_can_exec() {
        let home=tempfile::tempdir().unwrap(); let manager=Manager::new(home.path().into(),4317);
        let directory=home.path().join("runtime"); std::fs::create_dir(&directory).unwrap();
        let owner=directory.join("fixture.owner"); let executed=directory.join("executed");
        std::fs::write(&owner,"pending fixture\n").unwrap();
        let mapped=process::windows_to_wsl(&owner.to_string_lossy()).unwrap();
        let profile:Profile=serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"wsl","distribution":"Ubuntu","directory":"/tmp","executable":"/bin/sh"})).unwrap();
        let mut args=wsl_args(&profile);
        args.extend(["--exec".into(),"/usr/bin/setsid".into(),"--wait".into(),"/bin/sh".into(),"-c".into(),format!("sleep 1; {WSL_LAUNCH}"),"fixture".into(),"/tmp".into(),mapped.clone(),"fixture".into(),"/bin/sh".into(),"-c".into(),"printf executed > \"$1\"; exec /bin/sleep 10".into(),"fixture".into(),process::windows_to_wsl(&executed.to_string_lossy()).unwrap()]);
        let mut env=BTreeMap::from([("AGENT_BROWSER_RUNTIME_ID".into(),"fixture".into())]); forward_wsl_env(&mut env);
        let launcher=process::spawn(&process::wsl_executable(),&args,None,&env).unwrap();
        let record:RuntimeRecord=serde_json::from_value(json!({"profileId":"fixture","instance":"fixture","baseUrl":"http://127.0.0.1:65531","username":"opencode","password":"fixture","launcher":launcher,"server":null,"wslOwnerFile":mapped,"version":null})).unwrap();
        manager.persist(&record).unwrap(); manager.permit_wsl("fixture","owner").unwrap();
        let stopped=manager.terminate_wsl(&profile,&record).await;
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let late=executed.exists();
        let ended=wsl_control_status(&profile,&record,"state").await == Some(11);
        assert!(stopped.is_some() && ended,"The fixture must be fully stopped");
        assert!(!late,"Stop must revoke an already-persisted permit before a delayed WSL launch executes");
    }
    #[tokio::test]
    #[ignore = "Requires local WSL Ubuntu and AGENT_BROWSER_TEST_EXE set to the real Windows Bridge"]
    async fn keeper_initial_persist_failure_cleans_the_unpermitted_group() {
        let home=tempfile::tempdir().unwrap(); let manager=Manager::new(home.path().into(),4317);
        std::fs::create_dir(home.path().join("runtime.json")).unwrap();
        let instance=uuid::Uuid::new_v4().simple().to_string();
        let profile:Profile=serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"wsl","distribution":"Ubuntu","directory":"/tmp","executable":"/bin/true"})).unwrap();
        let env=BTreeMap::from([("AGENT_BROWSER_RUNTIME_ID".into(),instance.clone()),("OPENCODE_CONFIG_CONTENT".into(),"{}".into())]);
        let result=manager.launch_wsl(&profile,65531,instance.clone(),"fixture".into(),env,vec!["/bin/true".into()]).await;
        let error=result.err().expect("Fixture persistence must fail");
        assert!(!error.message.starts_with("WSL_"),"Fixture must reach persistence, not fail its preflight: {}",error.message);
        let owner=home.path().join("runtime").join(format!("{instance}.keeper"));
        assert!(!home.path().join("runtime").join(format!("{instance}.keeper.ready")).exists());
        let record:RuntimeRecord=serde_json::from_value(json!({"profileId":"fixture","instance":instance,"baseUrl":"http://127.0.0.1:65531","username":"opencode","password":"fixture","launcher":{"pid":0,"created":0,"image":"absent"},"server":null,"wslOwnerFile":process::windows_to_wsl(&owner.to_string_lossy()),"version":null})).unwrap();
        assert_eq!(wsl_control_status(&profile,&record,"state").await,Some(11),"A failed initial persist must leave no permitted keeper");
    }
}
