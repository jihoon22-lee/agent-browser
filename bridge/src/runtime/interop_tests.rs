use super::*;

#[test]
fn keeper_canary_uses_selected_socket_and_bounds_a_stalled_child() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap(); let probe = home.path().join("canary");
    let script = format!("{}\nprobe_windows \"$1\"",interop::CANARY_FUNCTION);
    let run = || std::process::Command::new("/bin/sh").args(["-c",&script,"fixture",probe.to_str().unwrap()])
        .env("WSL_INTEROP","/tmp/only-this-fixture-socket").status().unwrap();
    std::fs::write(&probe,"#!/bin/sh\n[ \"$WSL_INTEROP\" = /tmp/only-this-fixture-socket ] && [ \"$1\" = --version ] || exit 1\nsleep 0.2\nprintf 'browser-bridge fixture\\n'\n").unwrap();
    std::fs::set_permissions(&probe,std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(run().success());
    std::fs::write(&probe,"#!/bin/sh\nexec /bin/sleep 60\n").unwrap();
    let began=std::time::Instant::now(); let result=run(); let elapsed=began.elapsed();
    assert!(!result.success());
    assert!(elapsed >= Duration::from_secs(10) && elapsed < Duration::from_secs(16),"canary deadline: {elapsed:?}");
}

#[test]
fn keeper_stale_identity_cannot_signal_a_live_group() {
    let home=tempfile::tempdir().unwrap(); let owner=home.path().join("owner");
    let mut child=std::process::Command::new("/usr/bin/setsid").args(["--wait","/bin/sh","-c",WSL_LAUNCH,"fixture",home.path().to_str().unwrap(),owner.to_str().unwrap(),"fixture","/bin/sleep","20"])
        .env("AGENT_BROWSER_RUNTIME_ID","fixture").spawn().unwrap();
    let control=|mode| std::process::Command::new("/bin/sh").args(["-c",WSL_CONTROL,"fixture",owner.to_str().unwrap(),"fixture",mode,"0000"]).status().unwrap().code();
    for _ in 0..100 {if owner.exists(){break;} std::thread::sleep(Duration::from_millis(10));}
    let original=std::fs::read_to_string(&owner).unwrap();
    let mut fields:Vec<_>=original.split_whitespace().map(str::to_string).collect(); fields[1]="0".into();
    std::fs::write(&owner,format!("{}\n",fields.join(" "))).unwrap();
    let refused=control("stop") != Some(0); let alive=child.try_wait().unwrap().is_none();
    std::fs::write(&owner,&original).unwrap(); control("stop"); child.wait().unwrap();
    assert!(refused && alive,"Stale start ticks must never authorize a signal");
}

#[test]
fn interop_regression_inspection_distinguishes_owned_without_listener() {
    let home = tempfile::tempdir().unwrap();
    let owner = home.path().join("owner");
    let mut child = std::process::Command::new("/usr/bin/setsid")
        .args(["--wait", "/bin/sh", "-c", WSL_LAUNCH, "fixture", home.path().to_str().unwrap(), owner.to_str().unwrap(), "fixture", "/bin/sleep", "20"])
        .env("AGENT_BROWSER_RUNTIME_ID", "fixture").spawn().unwrap();
    let control = |mode| std::process::Command::new("/bin/sh")
        .args(["-c", WSL_CONTROL, "fixture", owner.to_str().unwrap(), "fixture", mode, "0000"])
        .stderr(std::process::Stdio::null()).status().unwrap().code();
    for _ in 0..100 { if owner.exists() { break; } std::thread::sleep(Duration::from_millis(10)); }
    let inspected = control("inspect");
    control("stop"); child.wait().unwrap();
    assert_eq!(inspected, Some(20), "One inspection must verify identity and report the absent listener");
    assert_eq!(control("inspect"), Some(11));
}

#[tokio::test]
async fn interop_regression_http_health_without_browser_mcp_is_not_ready() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let home = tempfile::tempdir().unwrap();
    let manager = Manager::new(home.path().into(), 4317);
    let process = process::spawn("/bin/sleep", &["20".into()], None, &BTreeMap::new()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096]; let n = stream.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..n]);
            let (code, body) = if !request.to_ascii_lowercase().contains("authorization:") { (401, "{}".to_owned()) }
                else if request.starts_with("GET /doc") { (200, json!({"paths":{"/session":{},"/provider":{},"/event":{},"/mcp":{}}}).to_string()) }
                else if request.starts_with("GET /mcp") { (200, json!({"browser":{"status":"failed","error":"synthetic failure"}}).to_string()) }
                else { (200, json!({"healthy":true,"version":"1.18.29"}).to_string()) };
            let response = format!("HTTP/1.1 {code} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    let profile: Profile = serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"windows","directory":home.path(),"executable":"/bin/sleep"})).unwrap();
    manager.save(profile, false).unwrap();
    let record: RuntimeRecord = serde_json::from_value(json!({"profileId":"fixture","instance":"fixture","baseUrl":url,"username":"opencode","password":"fixture","launcher":process,"server":null,"wslOwnerFile":null,"version":null,"bridgePort":4317,"bridgeExecutable":std::env::current_exe().unwrap()})).unwrap();
    manager.persist(&record).unwrap();
    let status = manager.status("fixture").await;
    process::terminate(&process); server.abort();
    assert_ne!(status.unwrap()["state"], "ready", "HTTP readiness must not hide a failed browser MCP connection");
}
