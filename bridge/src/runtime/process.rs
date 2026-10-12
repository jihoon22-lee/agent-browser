use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(unix)]
use std::process::{Command,Stdio};

#[derive(Clone, Serialize, Deserialize)]
pub struct Identity { pub pid: u32, pub created: u64, pub image: String }

#[cfg(windows)]
pub fn identity(pid: u32) -> Option<Identity> {
    use windows_sys::Win32::{Foundation::{CloseHandle, FILETIME}, System::Threading::*};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() { return None; }
        let mut created: FILETIME = std::mem::zeroed(); let mut exit = created; let mut kernel = created; let mut user = created;
        let mut image = vec![0u16; 32768]; let mut len = image.len() as u32; let mut code = 0;
        let okay = GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) != 0
            && QueryFullProcessImageNameW(handle, 0, image.as_mut_ptr(), &mut len) != 0
            && GetExitCodeProcess(handle, &mut code) != 0 && code == 259;
        CloseHandle(handle);
        okay.then(|| Identity { pid, created: ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64, image: String::from_utf16_lossy(&image[..len as usize]) })
    }
}

#[cfg(unix)]
pub fn identity(pid: u32) -> Option<Identity> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let tail: Vec<_> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    if tail.first() == Some(&"Z") { return None; }
    Some(Identity { pid, created: tail.get(19)?.parse().ok()?, image: std::fs::read_link(format!("/proc/{pid}/exe")).ok()?.to_string_lossy().into_owned() })
}

pub fn matches(owner: &Identity) -> bool { identity(owner.pid).is_some_and(|now| now.created == owner.created && now.image == owner.image) }

/// Unlike a failed ownership lookup, this is positive evidence that the original
/// launcher exited. Access-denied and other inspection failures remain unknown.
#[cfg(windows)]
pub fn exited(owner: &Identity) -> bool {
    use windows_sys::Win32::{Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, FILETIME}, System::Threading::*};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, owner.pid);
        if handle.is_null() { return GetLastError() == ERROR_INVALID_PARAMETER; }
        let mut code = 0;
        let mut created: FILETIME = std::mem::zeroed(); let mut exit = created; let mut kernel = created; let mut user = created;
        let known = GetExitCodeProcess(handle, &mut code) != 0 && GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) != 0;
        CloseHandle(handle);
        known && (code != 259 || owner.created != ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }
}
#[cfg(unix)]
pub fn exited(owner: &Identity) -> bool {
    match std::fs::read_to_string(format!("/proc/{}/stat", owner.pid)) {
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        Ok(stat) => stat.rsplit_once(')').is_some_and(|(_, rest)| {
            let fields: Vec<_> = rest.split_whitespace().collect();
            fields.first() == Some(&"Z") || fields.get(19).and_then(|ticks| ticks.parse::<u64>().ok()).is_some_and(|ticks| ticks != owner.created)
        }),
    }
}

#[cfg(unix)]
fn capture_spawn_identity(
    pid: u32,
    parent_image: &str,
    executable_is_parent: bool,
    mut inspect: impl FnMut(u32) -> Option<Identity>,
    mut pause: impl FnMut(),
) -> std::io::Result<Identity> {
    let mut created = None;
    for attempt in 0..200 {
        let current = inspect(pid).ok_or_else(|| std::io::Error::other("Started process exited before ownership could be recorded"))?;
        let birth = *created.get_or_insert(current.created);
        if current.pid != pid || current.created != birth {
            return Err(std::io::Error::other("Started process identity changed before exec completed"));
        }
        // A /proc snapshot immediately after spawn can still expose the fork's
        // inherited parent image. Never persist that transient identity. An
        // intentional self-exec has the same image before and after exec.
        if executable_is_parent || current.image != parent_image { return Ok(current); }
        if attempt < 199 { pause(); }
    }
    Err(std::io::Error::other("Started process did not publish its post-exec identity"))
}

#[cfg(windows)]
pub fn terminate(owner: &Identity) -> bool {
    use windows_sys::Win32::{Foundation::{CloseHandle, FILETIME}, System::Threading::*};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, owner.pid);
        if handle.is_null() { return false; }
        let mut created: FILETIME = std::mem::zeroed(); let mut exit = created; let mut kernel = created; let mut user = created;
        let mut image = vec![0u16; 32768]; let mut len = image.len() as u32;
        let okay = GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) != 0
            && QueryFullProcessImageNameW(handle, 0, image.as_mut_ptr(), &mut len) != 0
            && owner.created == ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64
            && owner.image == String::from_utf16_lossy(&image[..len as usize]);
        let stopped = okay && TerminateProcess(handle, 0) != 0; CloseHandle(handle); stopped
    }
}
#[cfg(unix)]
pub fn terminate(owner: &Identity) -> bool {
    matches(owner) && Command::new("/bin/kill").args(["-TERM", &owner.pid.to_string()]).status().is_ok_and(|status| status.success())
}

pub fn spawn(executable: &str, args: &[String], directory: Option<&str>, env: &BTreeMap<String,String>) -> std::io::Result<Identity> {
    #[cfg(windows)] { spawn_windows(executable,args,directory,env) }
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        let parent = identity(std::process::id()).ok_or_else(|| std::io::Error::other("Cannot inspect the parent process identity"))?;
        let executable_is_parent = std::fs::canonicalize(executable).ok().is_some_and(|path| path.to_string_lossy() == parent.image);
        let mut command = Command::new(executable);
        command.args(args).envs(env).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0);
        if let Some(directory) = directory { command.current_dir(directory); }
        let mut child = command.spawn()?;
        let mut birth = None;
        let result = capture_spawn_identity(child.id(), &parent.image, executable_is_parent, |pid| {
            let current = identity(pid);
            if birth.is_none() { birth = current.clone(); }
            current
        }, || std::thread::sleep(std::time::Duration::from_millis(5)));
        if result.is_err() {
            // Only our original child can be cleaned up. terminate() re-checks
            // the current PID, birth time, and image immediately before acting.
            if let (Some(birth),Some(current)) = (birth,identity(child.id()))
                && birth.created == current.created { terminate(&current); }
            let _ = child.try_wait();
        }
        result
    }
}

#[cfg(windows)]
fn spawn_windows(executable: &str, args: &[String], directory: Option<&str>, env: &BTreeMap<String,String>) -> std::io::Result<Identity> {
    use std::{io,os::windows::ffi::OsStrExt,ptr};
    use windows_sys::Win32::{Foundation::CloseHandle,System::Threading::*};
    if !std::path::Path::new(executable).is_absolute() || executable.contains(['\0','"']) || args.iter().any(|arg| arg.contains('\0')) || directory.is_some_and(|path| path.contains('\0')) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput,"Invalid runtime executable, argument, or directory"));
    }
    let mut application: Vec<u16> = executable.encode_utf16().chain([0]).collect();
    let mut command = windows_quote(executable);
    let raw_cmd_tail = executable.to_ascii_lowercase().ends_with("\\cmd.exe") && args.len() == 4 && args[2] == "/c";
    for (index,arg) in args.iter().enumerate() { command.push(' '); command.push_str(&if raw_cmd_tail && index == 3 { arg.clone() } else { windows_quote(arg) }); }
    let command: Vec<u16> = command.encode_utf16().chain([0]).collect();
    let directory: Option<Vec<u16>> = directory.map(|path| path.encode_utf16().chain([0]).collect());
    // Environment keys are case-insensitive on Windows. Preserve inherited Unicode
    // values, then apply validated profile values and managed credentials exactly.
    let mut merged = BTreeMap::new();
    for (key,value) in std::env::vars_os() { merged.insert(key.to_string_lossy().to_ascii_uppercase(),(key,value)); }
    for (key,value) in env { merged.insert(key.to_ascii_uppercase(),(std::ffi::OsString::from(key),std::ffi::OsString::from(value))); }
    let mut block = Vec::<u16>::new();
    for (key,value) in merged.values() { block.extend(key.encode_wide()); block.push(b'=' as u16); block.extend(value.encode_wide()); block.push(0); }
    block.push(0);
    // DETACHED_PROCESS makes Windows ignore CREATE_NO_WINDOW. Its console-less
    // descendants may then allocate visible consoles (including WSL launchers).
    let flags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
    for extra in [CREATE_BREAKAWAY_FROM_JOB,0] {
        let mut line = command.clone(); let startup = STARTUPINFOW { cb:std::mem::size_of::<STARTUPINFOW>() as u32,..Default::default() }; let mut process = PROCESS_INFORMATION::default();
        // No inherited handles: in particular, keep caller/WSL/Node pipe handles out
        // of detached runtimes so short-lived CLI start/attach can actually exit.
        let created = unsafe { CreateProcessW(application.as_mut_ptr(),line.as_mut_ptr(),ptr::null(),ptr::null(),0,flags | extra,block.as_ptr().cast(),directory.as_ref().map_or(ptr::null(),|path| path.as_ptr()),&startup,&mut process) };
        if created != 0 {
            let owner = identity(process.dwProcessId);
            unsafe { CloseHandle(process.hThread); CloseHandle(process.hProcess); }
            return owner.ok_or_else(|| io::Error::other("Started runtime exited before ownership could be recorded"));
        }
        if extra == 0 { return Err(io::Error::last_os_error()); }
    }
    unreachable!()
}

#[cfg(any(windows,test))]
fn windows_quote(value: &str) -> String {
    if !value.is_empty() && !value.contains([' ','\t','\n','\r','"']) { return value.into(); }
    let mut result = String::from("\""); let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' { slashes += 1; continue; }
        if character == '"' { result.extend(std::iter::repeat_n('\\',slashes * 2 + 1)); }
        else { result.extend(std::iter::repeat_n('\\',slashes)); }
        slashes = 0; result.push(character);
    }
    result.extend(std::iter::repeat_n('\\',slashes * 2)); result.push('"'); result
}

#[cfg(windows)]
pub fn listener(port: u16) -> Option<Identity> {
    use windows_sys::Win32::{NetworkManagement::IpHelper::*, Networking::WinSock::AF_INET};
    unsafe {
        let mut len = 0u32;
        GetExtendedTcpTable(std::ptr::null_mut(), &mut len, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_LISTENER, 0);
        let mut buffer = vec![0u64; (len as usize).div_ceil(8)];
        if GetExtendedTcpTable(buffer.as_mut_ptr().cast(), &mut len, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_LISTENER, 0) != 0 { return None; }
        let table = &*(buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
        for row in std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) {
            if u16::from_be(row.dwLocalPort as u16) == port { return identity(row.dwOwningPid); }
        }
        None
    }
}
#[cfg(windows)]
pub fn descendant(child: &Identity, parent: &Identity) -> bool {
    use windows_sys::Win32::{Foundation::{CloseHandle, INVALID_HANDLE_VALUE}, System::Diagnostics::ToolHelp::*};
    if !matches(parent) || child.created < parent.created { return false; }
    if child.pid == parent.pid { return child.created == parent.created && child.image == parent.image; }
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0); if snapshot == INVALID_HANDLE_VALUE { return false; }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed(); entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut parents = BTreeMap::new(); let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more { parents.insert(entry.th32ProcessID, entry.th32ParentProcessID); more = Process32NextW(snapshot, &mut entry) != 0; }
        CloseHandle(snapshot);
        let mut pid = child.pid;
        for _ in 0..64 { let Some(next) = parents.get(&pid) else { return false }; if *next == parent.pid { return true; } if *next == pid { break; } pid = *next; }
        false
    }
}

pub fn wsl_executable() -> String {
    #[cfg(windows)] { format!("{}\\System32\\wsl.exe", std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())) }
    #[cfg(not(windows))] { "/mnt/c/Windows/System32/wsl.exe".into() }
}

pub fn windows_to_wsl(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    (bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':').then(|| format!("/mnt/{}/{}", (bytes[0] as char).to_ascii_lowercase(), path[2..].trim_start_matches(['\\','/']).replace('\\', "/")))
}

#[cfg(test)]
mod quoting_tests {
    use super::windows_quote;
    #[test]
    fn structured_windows_arguments_preserve_unicode_quotes_and_trailing_backslashes() {
        assert_eq!(windows_quote("plain"),"plain");
        assert_eq!(windows_quote(""),"\"\"");
        assert_eq!(windows_quote("한글 space\\"),"\"한글 space\\\\\"");
        assert_eq!(windows_quote("a\"b"),"\"a\\\"b\"");
        assert_eq!(windows_quote("a\\\" b"),"\"a\\\\\\\" b\"");
    }
}

#[cfg(all(test, windows))]
mod hidden_console_tests {
    use super::*;
    const HELPER: &str = "runtime::process::hidden_console_tests::console_child_fixture";

    #[test]
    #[ignore = "subprocess fixture for background_launch_keeps_descendant_console_hidden"]
    fn console_child_fixture() {
        let Ok(report) = std::env::var("AGENT_BROWSER_CONSOLE_REPORT") else { return };
        if std::env::var_os("AGENT_BROWSER_CONSOLE_LEAF").is_some() {
            #[link(name = "kernel32")]
            unsafe extern "system" { fn GetConsoleWindow() -> *mut std::ffi::c_void; }
            #[link(name = "user32")]
            unsafe extern "system" { fn IsWindowVisible(window: *mut std::ffi::c_void) -> i32; }
            let visible = unsafe { IsWindowVisible(GetConsoleWindow()) != 0 };
            std::fs::write(report, if visible { "visible" } else { "hidden" }).unwrap();
        } else {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", HELPER])
                .env("AGENT_BROWSER_CONSOLE_LEAF", "1").status().unwrap();
            assert!(status.success());
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }

    #[test]
    fn background_launch_keeps_descendant_console_hidden() {
        let temp = tempfile::tempdir().unwrap();
        let report = temp.path().join("console.txt");
        let owner = spawn(std::env::current_exe().unwrap().to_str().unwrap(),
            &["--ignored".into(), "--exact".into(), HELPER.into()], None,
            &BTreeMap::from([("AGENT_BROWSER_CONSOLE_REPORT".into(), report.to_string_lossy().into_owned())])).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !report.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let observed = std::fs::read_to_string(report);
        terminate(&owner);
        assert_eq!(observed.unwrap(), "hidden", "Background launcher descendants must not open a console window");
    }

    #[test]
    #[ignore = "Requires local WSL Ubuntu and Windows interop; launches only this synthetic helper"]
    fn wsl_background_launch_keeps_interop_console_hidden() {
        let temp = tempfile::tempdir().unwrap();
        let report = temp.path().join("wsl-console.txt");
        let helper = windows_to_wsl(std::env::current_exe().unwrap().to_str().unwrap()).unwrap();
        let env = BTreeMap::from([
            ("AGENT_BROWSER_CONSOLE_REPORT".into(), report.to_string_lossy().into_owned()),
            ("WSLENV".into(), "AGENT_BROWSER_CONSOLE_REPORT".into()),
        ]);
        let args = ["--distribution", "Ubuntu", "--exec", &helper, "--ignored", "--exact", HELPER].map(str::to_owned);
        let owner = spawn(&wsl_executable(), &args, None, &env).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !report.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let observed = std::fs::read_to_string(report);
        terminate(&owner);
        assert_eq!(observed.unwrap(), "hidden", "WSL interop descendants must keep their console hidden");
    }
}

#[cfg(all(test,unix))]
mod spawn_identity_tests {
    use super::{Identity,capture_spawn_identity};

    fn snapshot(created: u64, image: &str) -> Identity { Identity { pid: 42, created, image: image.into() } }

    #[test]
    fn waits_for_child_exec_instead_of_recording_the_inherited_parent_image() {
        let mut samples = [Some(snapshot(100,"/test-parent")),Some(snapshot(100,"/test-parent")),Some(snapshot(100,"/node"))].into_iter();
        let mut pauses = 0;
        let result = capture_spawn_identity(42,"/test-parent",false, |_| samples.next().flatten(), || pauses += 1).unwrap();
        assert_eq!(result.image,"/node");
        assert_eq!(result.created,100);
        assert_eq!(pauses,2);
    }

    #[test]
    fn changed_start_identity_is_never_adopted_during_exec_wait() {
        let mut samples = [Some(snapshot(100,"/test-parent")),Some(snapshot(101,"/node"))].into_iter();
        assert!(capture_spawn_identity(42,"/test-parent",false, |_| samples.next().flatten(), || {}).is_err());
    }

    #[test]
    fn intentionally_launching_the_same_executable_keeps_its_stable_identity() {
        let result = capture_spawn_identity(42,"/test-parent",true, |_| Some(snapshot(100,"/test-parent")), || panic!("same executable needs no image transition")).unwrap();
        assert_eq!(result.image,"/test-parent");
    }

    #[test]
    fn an_exited_child_is_not_replaced_by_a_later_snapshot() {
        let mut samples = [Some(snapshot(100,"/test-parent")),None,Some(snapshot(101,"/node"))].into_iter();
        assert!(capture_spawn_identity(42,"/test-parent",false, |_| samples.next().flatten(), || {}).is_err());
    }

    #[test]
    fn a_parent_image_that_never_transitions_fails_with_bounded_probes() {
        let mut probes = 0;
        let result = capture_spawn_identity(42,"/test-parent",false, |_| { probes += 1; Some(snapshot(100,"/test-parent")) }, || {});
        assert!(result.is_err());
        assert_eq!(probes,200);
    }
}
