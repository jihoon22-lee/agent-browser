mod common;
use common::*;
use agent_browser_bridge::{rpc::{Envelope,ErrorCode},runtime::{Manager,profile::Profile}};
use serde_json::json;

#[tokio::test]
async fn management_is_extension_only_and_redacts_persisted_secrets() {
    let (_home,serve,cfg) = start_test_serve().await;
    let mut extension = ws_connect(serve.port,"/extension",Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop")).await.unwrap();
    hello(&mut extension,"extension",&cfg.token,"browser").await;
    let profile = json!({"id":"external","name":"External","kind":"external","directory":"/fixture","baseUrl":"https://example.test","password":"private-auth","env":{"PRIVATE_ENV":"private-value"}});
    let saved = call(&mut extension,"profile.save",json!({"profile":profile})).await;
    assert!(matches!(saved,Envelope::Res {ok:true,..}));
    let listed = call(&mut extension,"profile.list",json!({})).await.to_text();
    assert!(!listed.contains("private-auth") && !listed.contains("private-value"));
    let mut mcp = ws_connect(serve.port,"/mcp-proxy",None).await.unwrap();
    hello(&mut mcp,"mcp",&cfg.token,"agent").await;
    for method in ["profile.list","profile.save","profile.delete","runtime.ensure","runtime.status","runtime.stop","doctor.run"] {
        assert_eq!(err_code(&call(&mut mcp,method,json!({})).await),Some(ErrorCode::ForbiddenMethod));
    }
    let stopped = call(&mut extension,"runtime.stop",json!({"profileId":"external"})).await;
    assert!(matches!(stopped,Envelope::Res {ok:true,result:Some(ref result),..} if result["stopped"] == false));
    let _ = serve.shutdown.send(());
}

#[tokio::test]
async fn occupied_requested_port_never_adopts_or_authenticates_an_unowned_server() {
    let home = tempfile::tempdir().unwrap();
    let manager = Manager::new(home.path().into(),4317);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let profile: Profile = serde_json::from_value(json!({"id":"collision","name":"Collision","kind":"windows","directory":home.path(),"executable":std::env::current_exe().unwrap(),"port":listener.local_addr().unwrap().port()})).unwrap();
    manager.save(profile,false).unwrap();
    let result = manager.ensure("collision","chrome-extension://abcdefghijklmnopabcdefghijklmnop").await.unwrap();
    assert_eq!(result["state"],"error");
    assert!(result["error"].as_str().unwrap().contains("occupied"));
    assert!(tokio::time::timeout(std::time::Duration::from_millis(50),listener.accept()).await.is_err());
    assert_eq!(manager.status("collision").await.unwrap()["state"],"stopped");
}

#[tokio::test]
async fn doctor_does_not_claim_missing_bridge_is_healthy_or_start_processes() {
    let home = tempfile::tempdir().unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let manager = Manager::new(home.path().into(),port);
    let result = manager.doctor(None).await.unwrap();
    let bridge = result["checks"].as_array().unwrap().iter().find(|check| check["id"] == "bridge").unwrap();
    assert_ne!(bridge["status"],"ok");
    assert!(!home.path().join("serve.pid").exists());
}

#[tokio::test]
async fn doctor_separates_api_mcp_and_model_metadata_without_leaking_provider_fields() {
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new())); let seen = requests.clone();
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut stream,_)) = listener.accept().await else {break}; let seen = seen.clone();
            tokio::spawn(async move {
                let mut request = vec![0;8192]; let length = stream.read(&mut request).await.unwrap();
                let text = String::from_utf8_lossy(&request[..length]); let line = text.lines().next().unwrap().to_string(); seen.lock().unwrap().push(line.clone());
                let value = if line.contains("/global/health") { json!({"healthy":true,"version":"1.18.29"}) }
                else if line.contains("/doc") {json!({"paths":{"/session":{},"/provider":{},"/event":{},"/mcp":{}}})}
                else if line.contains("/mcp") {json!({"browser":{"status":"connected","error":"private-mcp-detail"}})}
                else if line.contains("/provider") {json!({"connected":["fixture"],"all":[{"id":"fixture","options":{"apiKey":"private-api-key"},"models":{"model":{"headers":{"Authorization":"private-header"}}}},{"id":"unavailable","models":{"hidden":{}}}]})}
                else {json!({})};
                let body = value.to_string(); let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                stream.write_all(response.as_bytes()).await.unwrap();
            });
        }
    });
    let home = tempfile::tempdir().unwrap(); let manager = Manager::new(home.path().into(),0);
    let profile: Profile = serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":"external","directory":"/synthetic space","baseUrl":format!("http://127.0.0.1:{port}"),"password":"private-password"})).unwrap();
    manager.save(profile,false).unwrap(); let result = manager.doctor(Some("fixture")).await.unwrap(); let text = result.to_string();
    for secret in ["private-api-key","private-header","private-password","private-mcp-detail"] { assert!(!text.contains(secret)); }
    let checks = result["checks"].as_array().unwrap();
    assert!(checks.iter().any(|check| check["id"] == "mcp" && check["status"] == "ok"));
    assert!(checks.iter().any(|check| check["id"] == "model" && check["status"] == "warning" && check["modelCount"] == 1 && check["inferenceTested"] == false));
    assert!(requests.lock().unwrap().iter().any(|request| request.contains("/provider?directory=%2Fsynthetic+space")));
    server.abort();
}

#[tokio::test]
async fn slow_runtime_management_keeps_extension_heartbeats_responsive() {
    use tokio::io::{AsyncReadExt,AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = listener.local_addr().unwrap().port();
    let http = tokio::spawn(async move {
        loop {
            let Ok((mut stream,_)) = listener.accept().await else {break};
            tokio::spawn(async move {
                let mut bytes = [0;4096]; let len = stream.read(&mut bytes).await.unwrap();
                let request = String::from_utf8_lossy(&bytes[..len]);
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                let body = if request.contains("/global/health") {json!({"healthy":true,"version":"1.18.29"})} else {json!({"paths":{"/session":{},"/provider":{},"/event":{},"/mcp":{}}})}.to_string();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    let (_home,serve,cfg) = start_test_serve().await;
    let mut extension = ws_connect(serve.port,"/extension",Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop")).await.unwrap(); hello(&mut extension,"extension",&cfg.token,"browser").await;
    let profile = json!({"id":"slow","name":"Slow","kind":"external","directory":"/fixture","baseUrl":format!("http://127.0.0.1:{port}")});
    call(&mut extension,"profile.save",json!({"profile":profile})).await;
    let ensure = Envelope::req("runtime.ensure",json!({"profileId":"slow"})); send_raw(&mut extension,&ensure.to_text()).await;
    let heartbeat = Envelope::req("heartbeat",json!({})); send_raw(&mut extension,&heartbeat.to_text()).await;
    loop {
        let reply = tokio::time::timeout(std::time::Duration::from_millis(200),recv(&mut extension)).await.unwrap();
        if matches!(reply,Envelope::Res {..}) { assert_eq!(reply.id(),heartbeat.id()); break; }
    }
    let _ = serve.shutdown.send(()); http.abort();
}

#[tokio::test]
async fn successful_custom_bind_persists_port_without_losing_pairing_or_later_reverting_it() {
    use agent_browser_bridge::{config,server::{self,ServeOptions}};
    let home = tempfile::tempdir().unwrap(); let mut cfg = config::load_or_init(home.path()).unwrap();
    cfg.paired_extension_id = Some("abcdefghijklmnopabcdefghijklmnop".into()); cfg.selected_client_id = Some("original".into()); config::save(home.path(),&cfg).unwrap();
    let serve = server::start(ServeOptions {home:home.path().into(),port:0}).await.unwrap();
    let stored = config::load_or_init(home.path()).unwrap();
    assert_eq!(stored.port,serve.port); assert_eq!(stored.token,cfg.token); assert_eq!(stored.paired_extension_id,cfg.paired_extension_id); assert_eq!(stored.selected_client_id,cfg.selected_client_id);
    let mut extension = ws_connect(serve.port,"/extension",Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop")).await.unwrap(); hello(&mut extension,"extension",&cfg.token,"replacement").await;
    call(&mut extension,"browser.use",json!({"clientId":"replacement"})).await;
    let updated = config::load_or_init(home.path()).unwrap(); assert_eq!(updated.port,serve.port); assert_eq!(updated.selected_client_id.as_deref(),Some("replacement")); assert_eq!(updated.token,cfg.token);
    let _ = serve.shutdown.send(());
}

#[test]
fn external_profiles_reject_prefixes_and_accept_only_origin_root() {
    for url in ["https://example.test/opencode","https://example.test/v1/","http://localhost:4096/prefix"] {
        let profile: Profile = serde_json::from_value(json!({"id":"external","name":"External","kind":"external","directory":"/fixture","baseUrl":url})).unwrap();
        assert!(profile.validate().is_err(),"Unexpected accepted path prefix: {url}");
    }
    for url in ["https://example.test","https://example.test/","http://127.0.0.1:4096/"] {
        let profile: Profile = serde_json::from_value(json!({"id":"external","name":"External","kind":"external","directory":"/fixture","baseUrl":url})).unwrap(); assert!(profile.validate().is_ok());
    }
}

#[tokio::test]
async fn cli_doctor_honors_explicit_bridge_port_environment() {
    use agent_browser_bridge::config;
    let (home,serve,mut cfg) = start_test_serve().await;
    cfg.port = 1; config::save(home.path(),&cfg).unwrap();
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_browser-bridge")).args(["doctor","--json"]).env("AGENT_BROWSER_HOME",home.path()).env("AGENT_BROWSER_PORT",serve.port.to_string()).output().await.unwrap();
    assert!(output.status.success()); let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(report["checks"].as_array().unwrap().iter().any(|check| check["id"] == "bridge" && check["status"] == "ok"));
    let _ = serve.shutdown.send(());
}

#[cfg(unix)]
#[tokio::test(flavor="multi_thread",worker_threads=4)]
async fn concurrent_profiles_reserve_distinct_ports_and_changed_bridge_port_refuses_reuse() {
    use std::{os::unix::fs::PermissionsExt,sync::Arc};
    let home = tempfile::tempdir().unwrap(); let executable = home.path().join("fixture-opencode");
    let node = std::process::Command::new("node").args(["-p","process.execPath"]).output().unwrap(); assert!(node.status.success()); let node = String::from_utf8(node.stdout).unwrap();
    std::fs::write(&executable,format!("#!{}\n{}",node.trim(),include_str!("fixtures/opencode-server.cjs"))).unwrap(); std::fs::set_permissions(&executable,std::fs::Permissions::from_mode(0o700)).unwrap();
    let manager = Arc::new(Manager::new(home.path().into(),54321));
    for id in ["first","second"] { let profile: Profile = serde_json::from_value(json!({"id":id,"name":id,"kind":"windows","directory":home.path(),"executable":executable})).unwrap(); manager.save(profile,false).unwrap(); }
    let one = manager.clone(); let two = manager.clone();
    let first = tokio::spawn(async move { one.ensure("first","chrome-extension://abcdefghijklmnopabcdefghijklmnop").await });
    let second = tokio::spawn(async move { two.ensure("second","chrome-extension://abcdefghijklmnopabcdefghijklmnop").await });
    let first_abort = first.abort_handle(); let second_abort = second.abort_handle();
    let results = tokio::time::timeout(std::time::Duration::from_secs(8),async { tokio::join!(first,second) }).await;
    if results.is_err() { first_abort.abort(); second_abort.abort(); tokio::time::sleep(std::time::Duration::from_millis(50)).await; manager.stop_all().await.unwrap(); panic!("Concurrent delayed runtimes did not become ready on distinct ports"); }
    let (first,second) = results.unwrap(); let first = first.unwrap().unwrap(); let second = second.unwrap().unwrap();
    let changed = Manager::new(home.path().into(),54322);
    let refused = changed.ensure("first","chrome-extension://abcdefghijklmnopabcdefghijklmnop").await.unwrap();
    let still_running = manager.status("first").await.unwrap();
    let stopped = manager.stop_all().await.unwrap();
    assert_eq!(first["state"],"ready"); assert_eq!(second["state"],"ready"); assert_ne!(first["baseUrl"],second["baseUrl"]);
    assert_eq!(refused["state"],"error"); assert_eq!(refused["owned"],true); assert!(!refused.to_string().contains(first["password"].as_str().unwrap()));
    assert_eq!(still_running["state"],"ready"); assert_eq!(stopped["errors"],json!([]));
}
