//! WSL launch/control scripts, process-group ownership probes, and distribution helpers.
use super::{process::{self, Identity}, profile::Profile, RuntimeRecord};
use std::{collections::BTreeMap, time::Duration};

pub(super) fn wsl_args(profile: &Profile) -> Vec<String> {
    let mut args = vec!["--distribution".into(), profile.distribution.clone().unwrap_or_default()];
    if let Some(user) = &profile.user { args.extend(["--user".into(),user.clone()]); } args
}

pub(super) fn forward_wsl_env(env: &mut BTreeMap<String, String>) {
    let mut entries: Vec<String> = std::env::var("WSLENV").unwrap_or_default().split(':')
        .filter(|entry| {
            let name = entry.split('/').next().unwrap_or_default();
            !entry.is_empty() && !env.keys().any(|k| k.eq_ignore_ascii_case(name))
        })
        .map(str::to_string).collect();
    entries.extend(env.keys().map(|key| format!("{key}/u")));
    env.insert("WSLENV".into(), entries.join(":"));
}


pub(super) const WSL_LAUNCH: &str = r#"set -eu
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
pub(super) enum WslState { NotStarted, Starting, Running, Stopped, Unknown }
pub(super) struct Inspection { pub(super) owned: bool, pub(super) listener: bool, pub(super) state: WslState, pub(super) probe_code: Option<i32> }
pub(super) fn wsl_state_code(code: Option<i32>, launcher: &Identity) -> WslState {
    match code {
        Some(0|20) => WslState::Running,
        Some(10) if process::exited(launcher) => WslState::NotStarted,
        Some(10) => WslState::Starting,
        Some(11) => WslState::Stopped,
        _ => WslState::Unknown,
    }
}
pub(super) async fn wsl_state(profile: &Profile, record: &RuntimeRecord) -> WslState {
    wsl_state_code(wsl_control_status(profile,record,"state").await,&record.launcher)
}
pub(super) fn wsl_forwarder(record: &RuntimeRecord) -> bool {
    #[cfg(windows)] {
        let Some(port) = reqwest::Url::parse(&record.base_url).ok().and_then(|url| url.port()) else { return false; };
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        // A 32-bit view would name "Program Files (x86)"; WSL is installed in the native one.
        let programs = std::env::var("ProgramW6432").or_else(|_| std::env::var("ProgramFiles")).unwrap_or_else(|_| "C:\\Program Files".into());
        process::listeners(port).iter().any(|listener| wsl_relay_image(&listener.image,&root,&programs))
    }
    #[cfg(not(windows))] { let _ = record; true }
}
/// The Windows process that holds a WSL2 localhost-forwarded port: wslrelay/wslhost of the
/// inbox WSL, the MSI package, or the Store package, on whichever drive Windows is installed.
#[cfg(any(windows,test))]
pub(super) fn wsl_relay_image(image: &str, system_root: &str, program_files: &str) -> bool {
    let image = image.to_ascii_lowercase();
    let under = |directory: String| image.starts_with(&directory.to_ascii_lowercase());
    let (root,programs) = (system_root.trim_end_matches('\\'),program_files.trim_end_matches('\\'));
    (under(format!("{root}\\system32\\")) || under(format!("{programs}\\wsl\\")) || under(format!("{programs}\\windowsapps\\microsoftcorporationii.windowssubsystemforlinux_")))
        && (image.ends_with("\\wslrelay.exe") || image.ends_with("\\wslhost.exe"))
}
/// Stop asks the group to end with SIGTERM while it is seen running this many times (each
/// time costs a probe plus 100 ms), then kills it: a server that ignores or hangs in SIGTERM
/// would otherwise keep its record, and Stop and profile deletion would fail for good.
pub(super) const WSL_TERM_ATTEMPTS: u32 = 10;
pub(super) fn wsl_stop_mode(running: u32) -> &'static str { if running < WSL_TERM_ATTEMPTS { "stop" } else { "kill" } }
pub(super) async fn wsl_control(profile: &Profile, record: &RuntimeRecord, mode: &str) -> bool {
    wsl_control_status(profile, record, mode).await == Some(0)
}
pub(super) const WSL_CONTROL: &str = r#"set -eu
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
  owner_file=$1; owner_instance=$2; owner_mode=${3:-}
  [ -f "$owner_file" ] || return 21
  [ -r "$owner_file" ] || return 22
  read -r pid ticks instance boot < "$owner_file" || return 23
  if [ "$pid" = pending ]; then [ "$ticks" = "$owner_instance" ] && [ -z "$instance$boot" ] || return 24; return 10; fi
  case $pid in ''|*[!0-9]*) return 23;; esac
  case $ticks in ''|*[!0-9]*) return 23;; esac
  [ "$pid" -gt 1 ] || return 23
  [ "$instance" = "$owner_instance" ] || return 24
  if [ -n "$boot" ]; then
    case $boot in *[!0-9a-f-]*) return 12;; esac
    case $boot in ????????-????-????-????-????????????) ;; *) return 12;; esac
    [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] || return 11
  fi
  if [ ! -d /proc/$pid ]; then
    [ "$owner_mode" != leader ] || return 11
    inspect_orphan_group "$pid" "$owner_instance"; return $?
  fi
  stat=$(cat /proc/$pid/stat) || return 12; rest=${stat##*) }; set -- $rest
  state=$1; group=$3; actual=${20}
  [ "$actual" = "$ticks" ] || return 11
  if [ "$state" = Z ]; then
    [ "$owner_mode" != leader ] || return 11
    inspect_orphan_group "$pid" "$owner_instance"; return $?
  fi
  [ "$group" = "$pid" ] || return 12
  tr '\000' '\n' </proc/$pid/environ | grep -Fqx "AGENT_BROWSER_RUNTIME_ID=$owner_instance" || return 12
}
stat_group() { set -- $1; procgroup=$3; }
if validate_owner "$1" "$2"; then code=0; else code=$?; fi
if [ "$code" != 0 ]; then
  case $3 in state|inspect) exit "$code";; *) exit 12;; esac
fi
if [ "$3" = inspect ] && [ -n "${5:-}" ]; then
  ( validate_owner "$5" "$2" leader || exit 12
    read -r nonce socket < "$5.ready" || exit 12
    [ "$nonce" = "$2" ] && [ "$socket" = "${6:-}" ] && [ -S "$socket" ]
  ) || exit 25
fi
if [ "$3" = inspect ]; then
  missing=20
  inode=$(awk -v addr="0100007F:$4" '$2 == addr && $4 == "0A" {print $10; exit}' /proc/net/tcp)
  [ -n "$inode" ] || exit "$missing"
  for fd in /proc/$pid/fd/*; do
    link=$(readlink "$fd" 2>/dev/null) || continue
    [ "$link" = "socket:[$inode]" ] && exit 0
  done
  for statfile in /proc/[0-9]*/stat; do
    procstat=$(cat "$statfile" 2>/dev/null) || continue
    procrest=${procstat##*) }; stat_group "$procrest"
    [ "$procgroup" = "$pid" ] || continue
    procpid=${statfile#/proc/}; procpid=${procpid%/stat}
    for fd in /proc/$procpid/fd/*; do
      link=$(readlink "$fd" 2>/dev/null) || continue
      [ "$link" = "socket:[$inode]" ] && exit 0
    done
  done
  exit "$missing"
fi
if [ "$3" = stop ]; then /bin/kill -TERM -- -$pid; fi
if [ "$3" = kill ]; then /bin/kill -KILL -- -$pid; fi"#;
/// A probe may be the call that boots the WSL VM, which takes well over five seconds when cold.
pub(super) const WSL_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// True only when `wsl.exe --list --quiet` answered and does not name the distribution. A listing that
/// fails, or names it, proves nothing: the record is then kept as before.
pub(super) fn unregistered(listing: &str, name: &str) -> bool {
    let wanted = name.trim();
    !wanted.is_empty() && !listing.lines().any(|line| line.trim().trim_start_matches('\u{feff}').eq_ignore_ascii_case(wanted))
}
pub(super) async fn wsl_distribution_unregistered(profile: &Profile) -> bool {
    let Some(name) = profile.distribution.as_deref().filter(|name| !name.trim().is_empty()) else { return false; };
    let mut command = tokio::process::Command::new(process::wsl_executable());
    command.args(["--list","--quiet"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] { command.creation_flags(0x08000000); }
    let Ok(Ok(output)) = tokio::time::timeout(WSL_PROBE_TIMEOUT,command.output()).await else { return false; };
    if !output.status.success() { return false; }
    listing_lacks(&output.stdout, name)
}
/// `wsl.exe --list` output as text, or None when it cannot be read. Inbox wsl.exe prints UTF-16LE;
/// with WSL_UTF8=1 in the environment it prints UTF-8. Reading UTF-8 as UTF-16 made every name
/// unknown, so a live distribution looked unregistered. Same rule as the installer's DecodeOutput.
pub(super) fn decode_listing(bytes: &[u8]) -> Option<String> {
    let utf16 = |bytes: &[u8]| bytes.len().is_multiple_of(2).then(|| String::from_utf16(&bytes.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect::<Vec<_>>()).ok()).flatten();
    let text = if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) { utf16(rest)? }
        // UTF-8 text has no NUL byte; UTF-16LE has one in every ASCII character, line ends included.
        else if bytes.contains(&0) { utf16(bytes)? }
        else { String::from_utf8(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes).to_vec()).ok()? };
    (!text.chars().any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))).then_some(text)
}
pub(super) fn listing_lacks(bytes: &[u8], name: &str) -> bool {
    decode_listing(bytes).is_some_and(|listing| !listing.trim().is_empty() && unregistered(&listing, name))
}
pub(super) async fn wsl_control_status(profile: &Profile, record: &RuntimeRecord, mode: &str) -> Option<i32> {
    tracing::debug!(profile_id = %profile.id, mode, "WSL control probe");
    let Some(owner) = &record.wsl_owner_file else { return None; };
    let script = WSL_CONTROL;
    let mut args = wsl_args(profile); args.extend(["--exec".into(),"/bin/sh".into(),"-c".into(),script.into(),"agent-browser".into(),owner.clone(),record.instance.clone(),mode.into(),format!("{:04X}",reqwest::Url::parse(&record.base_url).ok().and_then(|url| url.port()).unwrap_or(0)),record.wsl_keeper.as_ref().map(|keeper| keeper.owner_file.clone()).unwrap_or_default(),record.wsl_keeper.as_ref().map(|keeper| keeper.socket.clone()).unwrap_or_default()]);
    let mut command = tokio::process::Command::new(process::wsl_executable()); command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] { command.creation_flags(0x08000000); }
    match tokio::time::timeout(WSL_PROBE_TIMEOUT,command.status()).await {
        Err(_) => Some(-2),
        Ok(Err(_)) => Some(-3),
        Ok(Ok(status)) => status.code(),
    }
}
