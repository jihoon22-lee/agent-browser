# 패널 요청 자동 결합(계획 3A) Implementation Plan

> **상태: 완료.** [PR #22](https://github.com/jihoon22-lee/agent-browser/pull/22)로 main에 병합했다(`9037a81`, 2026-10-16). v0.2.0에 포함. 실제 검증 결과와 남긴 항목은 [상태 기록](../status.md)과 PR 본문에 있다. 새 작업의 원장으로 쓰지 않는다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 관리 런타임에서 패널 요청을 처리하는 모델이 `requestId`·`operationId`를 복사하지 않아도 브라우저 도구가 그 요청에 안전하게 결합되게 한다. 모델이 ID를 빠뜨려 실패하고 다시 시도하는 왕복을 없앤다.

**Architecture:**
- **MCP 프록시 식별:** 관리 런타임이 띄운 MCP 프록시는 hello에 실행 ID와 현재 폴더를 함께 보낸다. 실행 ID는 기동마다 새로 만드는 `AGENT_BROWSER_RUNTIME_ID`, 현재 폴더는 OpenCode가 디렉터리별로 정해 주는 cwd다.
- **요청 범위 기록:** 패널 요청을 시작하는 `request.begin`이 프로필·세션·디렉터리를 함께 기록한다.
- **결합 조건:** 도구 호출마다 Bridge가 그 런타임의 `/session/status?directory=`를 직접 조회한다. 조건이 모두 맞을 때만 생략된 ID를 현재 요청으로 채운다.
  - 실행 ID가 현재 런타임 기록과 같다.
  - 프록시 cwd가 요청 디렉터리와 같다.
  - 작업 중인 세션이 요청 세션 하나뿐이다.
  - 요청에 아직 작업이 없으면 캡처된 탭에 암묵 attach한다.
- **기존 방식 유지:** 조건이 하나라도 어긋나면 지금처럼 명시 ID를 요구한다.

**Tech Stack:** Rust(tokio, reqwest, serde_json), Chrome MV3 TypeScript(vitest), Node 실제 OpenCode 검증 스크립트.

**Spec:**
- [docs/review-2026-10-15.md](../review-2026-10-15.md): B2 "requestId/operationId" 행과 그 아래 "자동 결합의 전제", D절
- [docs/handoff.md](../handoff.md): §10, §11

## Global Constraints

- **요구사항 §11:** 세션을 추측해 결합하지 않는다. MCP 연결만으로 세션을 식별할 수 없으므로 아래 가드가 모두 성립할 때만 결합한다. 그 밖에는 명시 `requestId`/`operationId` 경로를 그대로 쓴다.
- **ref 안전 규칙은 약화하지 않는다:**
  - 새 snapshot 전 쓰기 거부
  - 문서·작업 경계
  - 쓰기 불확실성(`EXECUTION_UNKNOWN`)
  - 정지 후 30초 동안 범위 없는 attach 차단
- **도구 정의 예산:** `bridge/src/mcp/tools.rs`의 `total_schema_size_stays_small_for_free_models`. 설명과 스키마를 합쳐 4,800자 미만이다. 현재 4,685자다.
- **결과 바이트 예산은 그대로 둔다:**
  - 프레임 24,000B, 묶음·extract 28,000B, 최종 MCP 텍스트 40,000B
  - `REPLY_WAIT` 60초, `FOLLOW_UP_TIMEOUT` 8초
- **OpenCode는 v1 경로만 쓴다.** `/session/status`의 `directory` 쿼리는 [OpenAPI 명세](../reference/opencode-1.18.29-openapi.json)에 있다.
- **사용자 전역 OpenCode 설정을 수정하지 않는다.**
- **커밋 메시지:** 영어 Conventional Commits, 과제 단위로 쓴다.

## 확인한 사실 (2026-10-16, 실제 OpenCode 1.18.29, 격리 HOME)

- OpenCode는 `type:"local"` MCP를 **디렉터리마다 별도 프로세스로** 띄운다.
- 각 프로세스의 cwd는 그 디렉터리다. 디렉터리 `a`와 `b`에 세션을 만들면 pid가 다른 두 프로세스가 각자의 cwd로 기동했다.
- OpenCode 프로세스의 환경변수(`AGENT_BROWSER_RUNTIME_ID`)와 설정의 `environment`가 모두 MCP 프로세스에 전달된다.
- **결론:**
  - 같은 실행 ID와 같은 cwd의 프록시를 쓰는 세션은 "그 런타임의 그 디렉터리" 세션뿐이다.
  - 그 디렉터리의 작업 중 세션은 `/session/status?directory=<dir>`로 모두 보인다.
  - 같은 서버에 붙은 CLI(`browser-bridge attach --profile`) 세션도 같은 디렉터리라면 이 조회에 나타난다. 그래서 가드가 막는다.
- **WSL 미확인:** WSL에서 Windows exe로 실행되는 프록시의 cwd 표기는 확인하지 못했다. Task 7에서 실제로 확인한다.
  - `\\wsl.localhost\<배포판>\…`이나 `\\wsl$\…`이면 Linux 경로로 바꿔 비교한다.
  - 그 밖의 값이면 결합하지 않고 명시 경로로 남는다. 안전한 쪽으로 실패하는 것이다.

## Review Focus

1. **CLI가 같은 관리 서버에 붙어 작업 중일 때:** 패널 요청이 열려 있어도 CLI 세션의 ID 없는 attach는 패널 요청을 가로채지 못한다. → Task 6 `busy_cli_session_blocks_implicit_binding`
2. **같은 런타임에서 패널 세션 두 개가 동시에 작업 중일 때:** 결합하지 않는다. → Task 6 `two_busy_sessions_fall_back_to_explicit_ids`
3. **결합은 매 호출마다 다시 판정한다:** 처음 결합한 뒤 다른 세션이 작업을 시작하면 다음 ID 없는 호출은 거부된다. 명시 `operationId` 호출은 계속된다. → Task 6 `guard_is_reevaluated_on_every_call`
4. **이전 기동의 프록시, 외부 서버 프로필, 끝난 요청:** 결합하지 않고 지금의 안내 문구를 그대로 낸다. 정지 후 30초 차단도 유지한다. → Task 6 `stale_runtime_external_profile_and_ended_request_do_not_bind`, `stopped_client_block_still_applies`
5. **ID 없는 첫 페이지 도구 호출:** 캡처된 탭에 attach하고 정식 snapshot 바인딩 규칙을 따른다. 결과의 ref는 다음 쓰기에 쓸 수 있고, 읽지 않은 ref로의 쓰기는 지금처럼 거부된다. → Task 6 `first_page_tool_attaches_the_captured_tab_implicitly`

---

### Task 1: MCP 프록시가 실행 ID와 cwd를 밝힌다

**Files:**
- Modify: `bridge/src/mcp/client.rs:176-180`(hello 매개변수), 테스트 모듈
- Modify: `bridge/src/server/conn.rs:119-129`(`Hello`), `:194-215`(`handle`의 Mcp 분기), `:413`(`serve_mcp` 시그니처), `:473-476`(`router::call_tool` 호출)
- Modify: `bridge/src/server/router.rs`(`Caller`, `call_tool_as`)
- Modify: `bridge/src/runtime/mod.rs:191-202`(`overlay`), `:776-786`(테스트)

**Interfaces:**
- Produces:
  - `pub(crate) fn hello_params(client_id:&str, client_nonce:&str, runtime_id:Option<String>, cwd:Option<String>) -> serde_json::Value` (`mcp/client.rs`)
  - `#[derive(Clone, Debug, Default)] pub struct Caller { pub runtime_id: Option<String>, pub cwd: Option<String> }` (`server/router.rs`)
  - `pub async fn call_tool_as(state:&ServerState, caller:&Caller, name:&str, args:Value) -> ToolOutcome`. 기존 `call_tool(state,name,args)`는 `Caller::default()`로 위임한다.
  - 관리 런타임 MCP 설정의 `environment.AGENT_BROWSER_RUNTIME_ID`. WSL이면 `WSLENV`에 `AGENT_BROWSER_RUNTIME_ID/w`를 추가한다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`bridge/src/mcp/client.rs`의 `#[cfg(test)] mod tests`에 추가한다.

```rust
    #[test]
    fn hello_names_the_runtime_and_directory_only_when_known() {
        let named = super::hello_params("mcp-1","00",Some("rid".into()),Some("/work".into()));
        assert_eq!(named["runtimeId"],"rid"); assert_eq!(named["cwd"],"/work"); assert_eq!(named["role"],"mcp");
        let plain = super::hello_params("mcp-1","00",None,None);
        assert!(plain["runtimeId"].is_null() && plain["cwd"].is_null());
        let oversized = super::hello_params("mcp-1","00",Some("x".repeat(65)),None);
        assert!(oversized["runtimeId"].is_null(),"an implausible runtime id is not sent");
    }
```

`bridge/src/runtime/mod.rs`의 `overlay_preserves_settings_and_uses_actual_bridge_port` 아래에 추가한다.

```rust
    #[test]
    fn overlay_hands_the_runtime_id_to_the_browser_mcp() {
        let home = tempfile::tempdir().unwrap(); let manager = Manager::new(home.path().into(),54321);
        for (kind,wsl) in [("windows",false),("wsl",true)] {
            let profile: Profile = serde_json::from_value(json!({"id":"fixture","name":"Fixture","kind":kind,"distribution":"Ubuntu","directory":"/fixture","executable":"/fixture/opencode"})).unwrap();
            let mut env = BTreeMap::from([("AGENT_BROWSER_RUNTIME_ID".to_string(),"rid-1".to_string())]);
            manager.overlay(&profile,&mut env).unwrap();
            let value: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
            assert_eq!(value["mcp"]["browser"]["environment"]["AGENT_BROWSER_RUNTIME_ID"],"rid-1");
            assert_eq!(value["mcp"]["browser"]["environment"]["WSLENV"].as_str().is_some_and(|v| v.split(':').any(|e| e=="AGENT_BROWSER_RUNTIME_ID/w")),wsl);
        }
    }
```

WSL 프로필은 `overlay`에서 `process::windows_to_wsl(&exe)`를 호출한다. 테스트 실행 파일이 Linux 경로이면 `invalid`가 날 수 있다. 그 경우 이 단계의 ruling으로 WSL 줄을 `#[cfg(windows)]`로 나누고, Linux에서는 Windows 프로필만 검사한다.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- hello_names overlay_hands`
Expected: 컴파일 오류(`hello_params` 없음)로 FAIL

- [x] **Step 3: 구현한다**

`mcp/client.rs`: `open()` 안의 hello JSON을 함수로 뺀다.

```rust
/// A managed runtime starts one proxy per OpenCode directory with that directory as cwd
/// and passes its per-launch id; the server uses both only to bind a guarded panel request.
pub(crate) fn hello_params(client_id: &str, client_nonce: &str, runtime_id: Option<String>, cwd: Option<String>) -> Value {
    json!({
        "authVersion":auth::VERSION,"role":"mcp","clientId":client_id,"clientNonce":client_nonce,
        "clientVersion":env!("CARGO_PKG_VERSION"),"repair":false,
        "runtimeId":runtime_id.filter(|id| !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')),
        "cwd":cwd.filter(|dir| dir.len() <= 4096),
    })
}
```

`open()`에서 다음처럼 쓴다.

```rust
        let hello = Envelope::req("auth.hello", hello_params(&client_id, &client_nonce,
            std::env::var("AGENT_BROWSER_RUNTIME_ID").ok(),
            std::env::current_dir().ok().map(|dir| dir.to_string_lossy().into_owned())));
```

`server/conn.rs`의 `Hello`에 필드를 추가한다.

```rust
    #[serde(default)]
    runtime_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
```

`handle`의 `Role::Mcp` 분기를 바꾼다.

```rust
        Role::Mcp => {
            let caller = router::Caller { runtime_id: hello.runtime_id.clone(), cwd: hello.cwd.clone() };
            if send_hello_ok(&mut ws, hello_id, &connection_id, false, &hello.client_id).await {
                serve_mcp(&mut ws, &state, &caller).await;
            }
        }
```

`serve_mcp(ws: &mut Ws, state: &ServerState, caller: &router::Caller)`로 바꾼다. 그 안의 `router::call_tool(state, &name, arguments)`는 `router::call_tool_as(state, caller, &name, arguments)`로 바꾼다. `async move` 블록이 참조하도록 `let caller = caller.clone();`을 루프 안 push 직전에 둔다.

`server/router.rs`:

```rust
/// Who is calling: a managed runtime's proxy names its launch id and OpenCode directory.
#[derive(Clone, Debug, Default)]
pub struct Caller { pub runtime_id: Option<String>, pub cwd: Option<String> }

pub async fn call_tool(state: &ServerState, name: &str, args: Value) -> ToolOutcome {
    call_tool_as(state, &Caller::default(), name, args).await
}
```

기존 `call_tool` 본문은 `call_tool_as(state, caller, name, args)`로 옮긴다. 이 과제에서는 `caller`를 아직 쓰지 않는다. Task 5에서 `run`에 넘긴다. 사용하지 않는 매개변수 경고는 `let _ = caller;`로 막지 말고 Task 5와 같은 커밋 범위에서 정리한다. 이 과제에서는 `_caller`라는 이름을 쓴다.

`runtime/mod.rs` `overlay`:

```rust
        let mut mcp_env = json!({"AGENT_BROWSER_HOME":self.home.to_string_lossy(), "AGENT_BROWSER_PORT":self.port.to_string()});
        let runtime_id = env.get("AGENT_BROWSER_RUNTIME_ID").cloned();
        if let Some(id) = &runtime_id { mcp_env["AGENT_BROWSER_RUNTIME_ID"] = json!(id); }
        if profile.kind == Kind::Wsl {
            mcp_env["WSLENV"] = json!(if runtime_id.is_some() { "AGENT_BROWSER_HOME/w:AGENT_BROWSER_PORT/w:AGENT_BROWSER_RUNTIME_ID/w" } else { "AGENT_BROWSER_HOME/w:AGENT_BROWSER_PORT/w" });
        }
```

`ensure_inner`은 `overlay` 직전에 이미 `AGENT_BROWSER_RUNTIME_ID`를 넣는다(`:154`). 그래서 실제 기동에서는 항상 전달된다.

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- hello_names overlay`
Expected: PASS. 기존 `overlay_preserves_settings_and_uses_actual_bridge_port` 포함.

Run: `cargo test --offline --locked -p agent-browser-bridge --test tool_router --test mcp_stdio --test serve_auth`
Expected: 기존과 같이 PASS. hello에 필드가 늘어도 인증 transcript는 그대로다.

- [x] **Step 5: 커밋한다**

```bash
git add bridge/src
git commit -m "feat(bridge): let a managed runtime's MCP proxy name its launch and directory"
```

### Task 2: 패널 요청이 프로필·세션·디렉터리를 기록한다

**Files:**
- Modify: `bridge/src/server/operation.rs:50-66`(`RequestTarget`, `begin_request`), 새 메서드, 테스트
- Modify: `bridge/src/server/conn.rs:568-569`(`request.begin` 처리)
- Modify: `extension/src/background/panel-requests.ts:112`
- Test: `extension/test/panel-requests.test.ts:49,57,59,84`

**Interfaces:**
- Produces:
  - `#[derive(Clone, Debug, PartialEq, Eq)] pub struct RequestScope { pub profile: String, pub session: String, pub directory: String }`
  - `OperationGate::begin_scoped_request(&self, id:&str, client:&str, tab:Option<i64>, scope:Option<RequestScope>) -> Result<(),RpcError>`. 기존 `begin_request`는 `scope:None`으로 위임한다.
  - `#[derive(Clone, Debug)] pub struct BoundRequest { pub id:String, pub client:String, pub tab:Option<i64>, pub scope:RequestScope, pub operation:Option<String> }`
  - `OperationGate::bound_request(&self) -> Option<BoundRequest>`. 범위가 있는 활성 요청과, 그 요청 클라이언트의 Active 작업 ID를 돌려준다.
  - `request.begin` 매개변수 `profileId`, `sessionId`, `directory`. 셋 다 있어야 범위로 인정하고, 아니면 기존처럼 범위 없는 요청이다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`operation.rs` 테스트 모듈에 추가한다.

```rust
    #[test]
    fn a_scoped_request_reports_its_scope_and_current_operation() {
        let g=OperationGate::default();
        let scope=RequestScope{profile:"p".into(),session:"ses_1".into(),directory:"/w".into()};
        g.begin_scoped_request("req","browser",Some(12),Some(scope.clone())).unwrap();
        let bound=g.bound_request().unwrap();
        assert_eq!((bound.id.as_str(),bound.tab,&bound.scope,bound.operation.as_deref()),("req",Some(12),&scope,None));
        let op=g.attach_request(12,"browser",Some("req")).unwrap();
        assert_eq!(g.bound_request().unwrap().operation,Some(op.id));
        g.end_request("req","browser").unwrap();
        assert!(g.bound_request().is_none(),"an ended request binds nothing");
        g.begin_request("plain","browser",Some(12)).unwrap();
        assert!(g.bound_request().is_none(),"an unscoped request binds nothing");
    }
```

`extension/test/panel-requests.test.ts`의 네 기대값에 범위 필드를 추가한다. 그 테스트들의 lease 값은 각 테스트 상단의 `lease(...)`/객체 리터럴에서 읽어 그대로 쓴다. 예:

```ts
  expect(call.mock.calls.filter(c=>c[0]==='request.begin')).toEqual([['request.begin',{requestId:'one',clientId:'browser',tabId:11,profileId:'p',sessionId:'s-one',directory:'/w'}]]);
```

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- a_scoped_request`
Expected: 컴파일 오류(`RequestScope` 없음)

Run: `pnpm --filter agent-browser-extension exec vitest run test/panel-requests.test.ts`
Expected: 네 기대값 FAIL

- [x] **Step 3: 구현한다**

`operation.rs`:

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestScope { pub profile: String, pub session: String, pub directory: String }

#[derive(Clone, Debug)]
pub struct BoundRequest { pub id: String, pub client: String, pub tab: Option<i64>, pub scope: RequestScope, pub operation: Option<String> }

#[derive(Clone)]
struct RequestTarget { id: String, client: String, tab: Option<i64>, scope: Option<RequestScope> }
```

`begin_request` 본문을 `begin_scoped_request`로 옮기고 `RequestTarget{…,scope}`로 저장한다. `begin_request(id,client,tab)`는 `self.begin_scoped_request(id,client,tab,None)`이 된다.

```rust
    /// The open panel request and its current operation, when the panel said which
    /// runtime session owns it. Binding still needs the caller-side guard in `binding`.
    pub fn bound_request(&self) -> Option<BoundRequest> {
        let g=self.inner.lock().unwrap();
        let r=g.request.as_ref()?; let scope=r.scope.clone()?;
        let operation=g.current.as_ref().filter(|o| o.state==OpState::Active && o.client_id==r.client).map(|o| o.id.clone());
        Some(BoundRequest{id:r.id.clone(),client:r.client.clone(),tab:r.tab,scope,operation})
    }
```

`conn.rs`의 `request.begin`:

```rust
            let scope=match (params["profileId"].as_str(),params["sessionId"].as_str(),params["directory"].as_str()) {
                (Some(p),Some(s),Some(d)) if !p.is_empty() && p.len()<=128 && !s.is_empty() && s.len()<=128 && !d.is_empty() && d.len()<=4096 =>
                    Some(super::operation::RequestScope{profile:p.into(),session:s.into(),directory:d.into()}),
                _=>None,
            };
            let result=if method=="request.begin" {
                state.ops.begin_scoped_request(request,client,params["tabId"].as_i64().filter(|n|*n>0),scope).map(|_|None)
```

`panel-requests.ts:112`:

```ts
        await call('request.begin',{requestId:lease.requestId,clientId,tabId:target?.tabId??null,profileId:lease.profileId,sessionId:lease.sessionId,directory:lease.directory});
```

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- operation`
Expected: PASS. 새 테스트와 기존 operation 테스트 모두.

Run: `pnpm --filter agent-browser-extension exec vitest run test/panel-requests.test.ts`
Expected: PASS

- [x] **Step 5: 커밋한다**

```bash
git add bridge/src/server extension/src/background/panel-requests.ts extension/test/panel-requests.test.ts
git commit -m "feat: record which runtime session owns a panel request"
```

### Task 3: Bridge가 관리 런타임의 작업 중 세션을 읽는다

**Files:**
- Modify: `bridge/src/runtime/mod.rs`(새 메서드, 테스트 모듈 `tests`)

**Interfaces:**
- Consumes: `Store::read()`의 `config.runtimes: BTreeMap<String,RuntimeRecord>`, 프로필의 `kind`, 기존 `http_client(base)`(3초 제한, 리다이렉트 없음)
- Produces:
  - `pub struct RuntimeSessions { pub profile_id: String, pub wsl: bool, pub busy: Vec<String> }`
  - `pub async fn busy_sessions(&self, instance:&str, directory:&str) -> Result<RuntimeSessions, RpcError>`. `instance`가 현재 기록과 다르면(이전 기동) `Err`. `/session/status?directory=<directory>`의 값 중 `type`이 `busy` 또는 `retry`인 세션 ID만 담는다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`runtime/mod.rs`의 `mod tests`에 추가한다. 가짜 서버는 바로 위 `health_verifies_the_api_document_once_per_server_version`과 같은 방식이다.

```rust
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
        manager.save(serde_json::from_value(json!({"id":"p","name":"P","kind":"windows","directory":"C:\\w","executable":"C:\\o\\opencode.exe"})).unwrap(),false).unwrap();
        manager.persist(&RuntimeRecord{profile_id:"p".into(),instance:"rid-now".into(),base_url:base,username:"opencode".into(),password:"private".into(),launcher:process::identity(std::process::id()).unwrap(),server:None,wsl_owner_file:None,version:None,bridge_port:Some(4317),bridge_executable:None,wsl_keeper:None}).unwrap();
        let found = manager.busy_sessions("rid-now","C:\\w").await.unwrap();
        assert_eq!((found.profile_id.as_str(),found.wsl),("p",false));
        let mut busy = found.busy; busy.sort(); assert_eq!(busy,vec!["ses_a","ses_c"]);
        assert!(seen.lock().unwrap()[0].starts_with("GET /session/status?directory=C%3A%5Cw "),"{:?}",seen.lock().unwrap());
        assert!(manager.busy_sessions("rid-old","C:\\w").await.is_err(),"a previous launch's proxy must not bind");
    }
```

`process::identity`는 Windows·Unix 모두 있다(`process.rs:10,26`). `Manager::save(profile, make_default)`(`mod.rs:74`)가 실행 파일 존재 같은 검증으로 이 가짜 프로필을 거부하면, 같은 모듈의 비공개 `self.store.update`로 `config.profiles`에 직접 넣는다. 이 결정은 ruling으로 기록한다.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- busy_sessions`
Expected: 컴파일 오류(`busy_sessions` 없음)

- [x] **Step 3: 구현한다**

```rust
pub struct RuntimeSessions { pub profile_id: String, pub wsl: bool, pub busy: Vec<String> }

impl Manager {
    /// Busy sessions of one OpenCode directory on the runtime launched as `instance`.
    /// A proxy from an earlier launch finds no record and gets an error.
    pub async fn busy_sessions(&self, instance: &str, directory: &str) -> Result<RuntimeSessions, RpcError> {
        let config = self.store.read()?;
        let record = config.runtimes.values().find(|record| record.instance == instance).cloned()
            .ok_or_else(|| invalid("This MCP proxy does not belong to the current runtime launch"))?;
        let wsl = config.profiles.get(&record.profile_id).is_some_and(|profile| profile.kind == Kind::Wsl);
        let mut url = reqwest::Url::parse(&format!("{}/session/status", record.base_url.trim_end_matches('/'))).map_err(|_| failure("Invalid managed runtime URL"))?;
        url.query_pairs_mut().append_pair("directory", directory);
        let response = http_client(&record.base_url)?.get(url).basic_auth(&record.username, Some(&record.password)).send().await
            .map_err(|_| failure("Cannot read the runtime's session status"))?;
        if !response.status().is_success() { return Err(failure("The runtime refused the session status request")); }
        let statuses = limited_json(response, 1 << 20).await?;
        let busy = statuses.as_object().map(|map| map.iter()
            .filter(|(_, status)| matches!(status["type"].as_str(), Some("busy" | "retry")))
            .map(|(id, _)| id.clone()).collect()).unwrap_or_default();
        Ok(RuntimeSessions { profile_id: record.profile_id, wsl, busy })
    }
}
```

`config.profiles`(`storage.rs:12`)와 `limited_json(response, limit)`(`mod.rs:694`)은 확인한 이름이다.

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- busy_sessions`
Expected: PASS

- [x] **Step 5: 커밋한다**

```bash
git add bridge/src/runtime/mod.rs
git commit -m "feat(bridge): read busy sessions of the current managed runtime launch"
```

### Task 4: 결합 가드

**Files:**
- Create: `bridge/src/server/binding.rs`
- Modify: `bridge/src/server/mod.rs`(`pub mod binding;`)

**Interfaces:**
- Consumes:
  - Task 1의 `Caller`
  - Task 2의 `OperationGate::bound_request() -> Option<BoundRequest>`
  - Task 3의 `Manager::busy_sessions`
- Produces:
  - `pub fn same_directory(cwd:&str, directory:&str, wsl:bool) -> bool`
  - `pub fn only_this_session_busy(busy:&[String], session:&str) -> bool`
  - `pub async fn resolve(state:&ServerState, caller:&Caller) -> Option<BoundRequest>`

- [x] **Step 1: 실패하는 테스트를 쓴다**

`bridge/src/server/binding.rs` 끝:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directories_compare_like_their_platform() {
        assert!(same_directory(r"C:\Work\App\", r"c:\work\app", false), "Windows paths ignore case and a trailing separator");
        assert!(same_directory("C:/Work/App", r"C:\Work\App", false));
        assert!(!same_directory(r"C:\Work\App2", r"C:\Work\App", false));
        assert!(same_directory(r"\\wsl.localhost\Ubuntu\home\u\app", "/home/u/app", true));
        assert!(same_directory(r"\\wsl$\Ubuntu\home\u\app\", "/home/u/app", true));
        assert!(!same_directory(r"\\wsl.localhost\Ubuntu\home\u\App", "/home/u/app", true), "Linux paths keep case");
        assert!(!same_directory(r"C:\Windows\System32", "/home/u/app", true), "an unmapped WSL cwd never binds");
        assert!(!same_directory("", "/home/u/app", true));
    }
    #[test]
    fn only_the_request_session_may_be_busy() {
        assert!(only_this_session_busy(&["ses_a".into()], "ses_a"));
        assert!(only_this_session_busy(&[], "ses_a"), "the request may be between model steps");
        assert!(!only_this_session_busy(&["ses_a".into(), "ses_cli".into()], "ses_a"));
        assert!(!only_this_session_busy(&["ses_cli".into()], "ses_a"));
    }
}
```

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- binding`
Expected: 컴파일 오류(함수 없음)

- [x] **Step 3: 구현한다**

```rust
//! Guarded binding of id-less browser tool calls to the open panel request (handoff §11).
//! It binds only when the caller is the current launch's MCP proxy for the request's
//! OpenCode directory and no other session of that directory is working.
use super::conn::ServerState;
use super::operation::BoundRequest;
use super::router::Caller;

pub fn same_directory(cwd: &str, directory: &str, wsl: bool) -> bool {
    if wsl {
        let linux = ["\\\\wsl.localhost\\", "\\\\wsl$\\"].iter().find_map(|prefix| {
            let rest = cwd.strip_prefix(prefix)?; let (_, path) = rest.split_once('\\')?;
            Some(format!("/{}", path.replace('\\', "/")))
        });
        return linux.is_some_and(|path| path.trim_end_matches('/') == directory.trim_end_matches('/') && !directory.is_empty());
    }
    let normal = |path: &str| path.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    !cwd.is_empty() && normal(cwd) == normal(directory)
}

pub fn only_this_session_busy(busy: &[String], session: &str) -> bool { busy.iter().all(|id| id == session) }

pub async fn resolve(state: &ServerState, caller: &Caller) -> Option<BoundRequest> {
    let (runtime, cwd) = (caller.runtime_id.as_deref()?, caller.cwd.as_deref()?);
    let request = state.ops.bound_request()?;
    let sessions = state.runtime.busy_sessions(runtime, &request.scope.directory).await.ok()?;
    let fits = sessions.profile_id == request.scope.profile
        && same_directory(cwd, &request.scope.directory, sessions.wsl)
        && only_this_session_busy(&sessions.busy, &request.scope.session);
    // The request may have ended while status was read; bind only to what is still open.
    (fits && state.ops.bound_request().is_some_and(|now| now.id == request.id)).then(|| state.ops.bound_request()).flatten()
}
```

`bound_request()`를 다시 읽는 이유: 상태 조회 중 요청이 끝나거나 바뀌었으면 결합하지 않는다. 또 그 사이 만들어진 작업 ID를 반영한다.

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- binding`
Expected: PASS

- [x] **Step 5: 커밋한다**

```bash
git add bridge/src/server/binding.rs bridge/src/server/mod.rs
git commit -m "feat(bridge): guard implicit binding by launch, directory and busy sessions"
```

### Task 5: 라우터가 생략된 ID를 채우고 첫 페이지 도구에서 암묵 attach한다

**Files:**
- Modify: `bridge/src/server/router.rs:162-212`(`call_tool_as`, `run`), `ToolOutcome`
- Modify: `bridge/src/server/conn.rs:470-480`(`attach` 판정을 결과 기반으로)
- Modify: `bridge/src/mcp/tools.rs`(모든 `"required":["operationId",…]`에서 `operationId` 제거, 설명 수정), 테스트
- Modify: `protocol/fixtures/tools-list.json`(`UPDATE_FIXTURES=1`로 재생성)
- Modify: `bridge/src/mcp/mod.rs`(서버 instructions의 requestId 문장)

**Interfaces:**
- Consumes: Task 4 `binding::resolve`
- Produces:
  - `pub const OPERATION_TOOLS: [&str; 10]`. 대상은 snapshot·navigate·click·fill·select·press·scroll·wait·extract·screenshot이다.
  - `ToolOutcome`에 `#[serde(skip)] pub created_operation: bool`. explicit이든 암묵이든 이번 호출이 새 작업을 만들었으면 `true`다.
  - 동작 규칙:
    - `browser_tabs` attach/new에 `requestId`·`operationId`가 둘 다 없으면 결합 시 `requestId`를 채운다.
    - switch/close/release와 `OPERATION_TOOLS`에 `operationId`가 없으면 결합된 요청의 현재 작업 ID를 채운다.
    - `OPERATION_TOOLS`인데 현재 작업이 없으면 `{"action":"attach","requestId":<id>}`로 암묵 attach한 뒤 그 작업 ID를 쓴다.
    - 결합이 안 되면 인수를 바꾸지 않는다. 그러면 기존 오류(`OPERATION_REQUIRED`, "Missing requestId…")가 그대로 난다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`tools.rs` 테스트 모듈:

```rust
    #[test]
    fn page_tools_do_not_require_an_operation_id_in_the_schema() {
        for tool in super::all() {
            let required = tool.schema["required"].as_array().cloned().unwrap_or_default();
            assert!(!required.iter().any(|k| k == "operationId"), "{} still requires operationId", tool.name);
        }
        let tabs = super::all().into_iter().find(|t| t.name == "browser_tabs").unwrap();
        assert!(tabs.description.contains("panel"), "the description must say ids may be omitted in a panel request");
    }
```

`router.rs`의 `mod tests`:

```rust
    #[tokio::test]
    async fn an_unbound_caller_still_needs_an_operation_id() {
        let home = tempfile::tempdir().unwrap();
        let state = ServerState::new(home.path().into(), crate::config::load_or_init(home.path()).unwrap());
        let outcome = call_tool_as(&state, &Caller { runtime_id: Some("rid".into()), cwd: Some("/w".into()) }, "browser_snapshot", json!({})).await;
        assert_eq!(outcome.error.as_ref().map(|e| e.code), Some(ErrorCode::OperationRequired));
        assert!(!outcome.created_operation);
    }
```

이 모듈의 기존 테스트(`:565`)와 같은 생성 방식이다.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- page_tools_do_not an_unbound_caller`
Expected: 첫 테스트 FAIL. 둘째는 `created_operation` 필드가 없어 컴파일 오류.

- [x] **Step 3: 구현한다**

`router.rs`:

```rust
/// Tools that act inside an operation; in a bound panel request their operationId may be omitted.
pub const OPERATION_TOOLS: [&str; 10] = ["browser_snapshot","browser_navigate","browser_click","browser_fill","browser_select",
    "browser_press","browser_scroll","browser_wait","browser_extract","browser_screenshot"];

/// Fills ids a model omitted when the caller is bound to the open panel request.
/// Returns the arguments to run with, or the failed implicit attach.
async fn bind_arguments(state: &ServerState, caller: &Caller, name: &str, args: &Value) -> Result<(Value, bool), ToolOutcome> {
    let action = args["action"].as_str();
    let tabs = name == "browser_tabs";
    let wants_request = tabs && matches!(action, Some("attach" | "new")) && args.get("requestId").is_none() && args.get("operationId").is_none();
    let page_tool = OPERATION_TOOLS.contains(&name);
    let wants_operation = args.get("operationId").is_none() && (page_tool || (tabs && matches!(action, Some("switch" | "close" | "release"))));
    if !wants_request && !wants_operation { return Ok((args.clone(), false)); }
    let Some(bound) = super::binding::resolve(state, caller).await else { return Ok((args.clone(), false)); };
    let mut args = args.clone();
    if wants_request { args["requestId"] = json!(bound.id); return Ok((args, false)); }
    let (operation, created) = match bound.operation {
        Some(operation) => (operation, false),
        None if page_tool => {
            let attached = Box::pin(run(state, caller, "browser_tabs", &json!({"action":"attach","requestId":bound.id}))).await;
            match attached.operation_id.clone() { Some(id) if attached.ok => (id, true), _ => return Err(attached) }
        }
        None => return Ok((args, false)),
    };
    args["operationId"] = json!(operation);
    Ok((args, created))
}
```

`run` 시그니처를 `run(state, caller, name, args)`로 바꾼다. 맨 앞에서 결합한다.

```rust
async fn run(state: &ServerState, caller: &Caller, name: &str, args: &Value) -> ToolOutcome {
    let (args, implicit) = match bind_arguments(state, caller, name, args).await { Ok(bound) => bound, Err(failed) => return failed };
    let args = &args;
    // … 기존 본문 …
```

`needs_operation`은 스키마의 `required`가 아니라 목록으로 판정한다.

```rust
    let needs_operation = OPERATION_TOOLS.contains(&name);
```

반환 직전에 `outcome.created_operation = implicit || (creates && outcome.ok);`를 설정한다. `creates`는 기존 계산이다. `CreatedOperation` drop 가드는 명시 attach에만 걸려 있다. 암묵 attach는 내부 `run` 호출이 자체 가드를 가지므로, 바깥 도구가 취소되면 그 작업도 취소된다.

이 동작은 회귀 테스트로 고정한다. 대상은 `router.rs`의 `cancelling_attach_while_its_snapshot_is_pending_releases_the_new_operation`이다. 그 테스트를 복제한 `cancelling_an_implicit_attach_releases_the_new_operation`은 Task 6 통합 테스트 파일에 둔다.

`conn.rs` `serve_mcp`: 요청 전에 계산하던 `attach` 플래그를 지우고 결과의 `created_operation`을 쓴다.

```rust
                let created = outcome.created_operation;
```

`pending.push`의 튜플에서 `attach`를 빼고, `(id, result)`만 돌려준다.

`tools.rs`:
- `op()`의 설명을 `"From attach/new; omit in a panel request"`로 바꾼다.
- 모든 스키마의 `required`에서 `"operationId"`를 지운다. `required`가 빈 배열이 되면 키 자체를 지운다.
- `browser_tabs` 설명을 바꾼다.

```text
list/windows read tabs. In a panel request attach/new and page tools may omit requestId and operationId; otherwise attach (no tabId = request's tab) or new (url) with the Browser context requestId, then reuse operationId. Results include a snapshot and openTabs. about:blank tabs cannot be closed.
```

- `UPDATE_FIXTURES=1 cargo test --offline --locked -p agent-browser-bridge --lib -- tools_list_matches_contract_fixture`로 `protocol/fixtures/tools-list.json`을 재생성한다. 그다음 `git diff protocol/fixtures/tools-list.json`에서 바뀐 것이 `required`와 위 설명뿐인지 확인한다.

`mcp/mod.rs:60`: 서버 instructions의 첫 문장을 바꾼다. 현재 문장은 "Use browser_tabs attach for the current page or new for a URL, passing the Browser context requestId the first time; reuse the returned operationId afterwards."다.

```text
In a panel request, browser tools bind to it automatically; pass requestId/operationId only when a result asks for them. Otherwise use browser_tabs attach for the current page or new for a URL with the Browser context requestId, then reuse the returned operationId.
```

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib`
Expected: PASS. 아래를 포함한다.
- `total_schema_size_stays_small_for_free_models`(< 4,800)
- `descriptions_say_results_already_include_a_snapshot`
- `blank_tab_close_exception_is_visible_in_the_tool_description`

예산을 넘으면 `browser_tabs` 설명의 "otherwise …" 절을 줄인다. 예산 값은 바꾸지 않는다.

Run: `cargo test --offline --locked -p agent-browser-bridge --test tool_router --test mcp_stdio --test protocol_contract`
Expected: PASS. `mutating_tool_without_operation_is_rejected_without_contacting_browser`는 결합 정보가 없는 연결이므로 그대로 거부된다.

- [x] **Step 5: 커밋한다**

```bash
git add bridge/src protocol/fixtures/tools-list.json
git commit -m "feat(bridge): bind id-less browser tool calls to a guarded panel request"
```

### Task 6: 결합 가드 통합 테스트 (Review Focus)

**Files:**
- Create: `bridge/tests/request_binding.rs`
- Modify: `bridge/tests/common/mod.rs`(`hello_with` 추가)

**Interfaces:**
- Consumes:
  - `common::start_test_serve()`
  - `tool_router.rs`의 가짜 확장 패턴(`fake_extension`, `call_with_socket`)
  - Task 2의 `request.begin` 범위 매개변수
  - Task 3의 런타임 기록
- Produces:
  - `pub async fn hello_with(ws:&mut Ws, role:&str, token:&str, client_id:&str, extra:serde_json::Value) -> Envelope`. hello 매개변수에 `extra` 객체를 합친다. 인증 transcript는 같다.

- [x] **Step 1: 테스트 도우미와 실패하는 테스트를 쓴다**

`common/mod.rs`에 `hello_repair`와 같은 본문으로 `hello_with`를 추가한다. hello JSON을 만든 뒤 `extra`의 키를 덮어쓴다.

`request_binding.rs`의 구성:

1. **`fake_opencode(statuses: Arc<Mutex<Value>>) -> String`**
   - Task 3 테스트와 같은 방식의 가짜 HTTP 서버다.
   - `GET /session/status`에 공유 값을 돌려주고, 기본 URL을 반환한다.
2. **`setup() -> Fixture`**
   - serve를 시작하고, 런타임 저장소에 Windows 프로필 `p`를 기록한다.
   - 실행 ID `rid-now`의 `RuntimeRecord`도 기록한다. `base_url`은 1의 가짜 서버다.
   - 저장은 `agent_browser_bridge::runtime::Manager::new(home, port)`로 하는 공개 경로를 쓴다.
   - `persist`가 비공개라 막히면 `Manager`에 `#[doc(hidden)] pub fn persist_for_tests(&self, record:&RuntimeRecord)`를 추가한다. 이 결정은 ruling으로 기록한다.
   - 가짜 확장을 연결해 선택한다. 응답은 `tool_router.rs`의 `default_reply`와 `snapshot_reply`/`tabs_reply` 규칙을 그대로 쓴다.
   - 확장 소켓으로 `request.begin {requestId:"req", clientId, tabId:11, profileId:"p", sessionId:"ses_panel", directory:"C:\\w"}`을 보낸다.
3. **`proxy(fixture, runtime, cwd) -> Ws`**
   - `/mcp-proxy`에 `hello_with(..., json!({"runtimeId":runtime,"cwd":cwd}))`로 연결한다.

테스트:

```rust
#[tokio::test] async fn first_page_tool_attaches_the_captured_tab_implicitly()
// statuses = {"ses_panel":{"type":"busy"}}
// proxy("rid-now","C:\\w")로 browser_snapshot {} 호출 → ok, operationId 있음, 확장이 받은 첫 명령이 tabs.get(11)과 snapshot
// 이어서 그 결과의 ref로 operationId 없이 browser_click → ok (같은 operationId)
// operationId 없이 읽지 않은 ref "s0f0e9"로 click → 기존과 같은 STALE/invalid ref 오류 (쓰기 안전 규칙 유지)

#[tokio::test] async fn busy_cli_session_blocks_implicit_binding()
// statuses = {"ses_panel":{"type":"busy"},"ses_cli":{"type":"busy"}}
// browser_tabs {action:"attach"} → ok=false, 메시지에 "Missing requestId", 확장에 명령 없음

#[tokio::test] async fn two_busy_sessions_fall_back_to_explicit_ids()
// 위와 같은 상태에서 browser_tabs {action:"attach", requestId:"req"} → ok (명시 경로는 그대로)

#[tokio::test] async fn guard_is_reevaluated_on_every_call()
// busy={ses_panel} → snapshot {} 로 암묵 attach 성공
// statuses에 ses_cli busy 추가 → snapshot {} → OPERATION_REQUIRED
// snapshot {operationId:<앞의 id>} → ok

#[tokio::test] async fn stale_runtime_external_profile_and_ended_request_do_not_bind()
// (a) proxy("rid-old", …) → attach {} → "Missing requestId"
// (b) proxy(None runtime) (hello_with에 runtimeId 없음) → 같은 결과
// (c) cwd "C:\\other" → 같은 결과
// (d) request.end 후 proxy("rid-now") attach {requestId:"req"} → "already ended" 문구 그대로

#[tokio::test] async fn stopped_client_block_still_applies()
// request.end {abort:true} 후 30초 이내 attach {} → CANCELLED "Unscoped attach is blocked"

#[tokio::test] async fn cancelling_an_implicit_attach_releases_the_new_operation()
// 확장이 snapshot에 응답하지 않게 두고 snapshot {} 호출 후 tool.cancel → 이후 browser_tabs attach {requestId:"req"}가 BROWSER_BUSY가 아니라 ok
```

각 테스트의 단언은 위 주석을 그대로 `assert!`/`assert_eq!`로 쓴다. 오류 문구는 `operation.rs`의 현재 문자열(`"Missing requestId"`, `"already ended"`, `"Unscoped attach is blocked"`)과 `ErrorCode::OperationRequired`로 비교한다.

- [x] **Step 2: 실패를 확인하고 통과시킨다**

Run: `cargo test --offline --locked -p agent-browser-bridge --test request_binding`
Expected:
- Task 1~5가 끝난 상태라 대부분 PASS다.
- 실패가 있으면 그것이 이 과제가 찾아야 할 결함이다. 테스트가 아니라 구현을 고친다(systematic-debugging).
- 이 과제의 테스트는 Task 5 구현 뒤에 쓰는 회귀 고정이다. 그래서 RED를 보장하려면 각 테스트의 핵심 단언을 한 번 뒤집어 실패하는 것을 확인한 뒤 되돌린다. 예: `busy_cli_session_blocks_implicit_binding`에서 `only_this_session_busy`가 항상 `true`를 돌려주게 임시로 바꾸면 FAIL해야 한다. 되돌릴 때는 `git checkout`을 쓰지 않고 편집으로 되돌린다.

- [x] **Step 3: 커밋한다**

```bash
git add bridge/tests
git commit -m "test(bridge): pin guarded request binding against CLI sessions, stale launches and stops"
```

### Task 7: 패널 지시문 축소, 실제 OpenCode 검증, 문서

**Files:**
- Modify: `extension/src/sidepanel/request-target.ts:15-19`(`requestInstructions`)
- Test: `extension/test/request-target.test.ts`
- Modify: `tests/fixtures/panel-provider.mjs:58-62`(기본 시나리오), `tests/e2e/opencode-panel.windows.mjs:137-139`
- Modify:
  - `docs/protocol.md`(request.begin 범위 필드, MCP hello의 `runtimeId`/`cwd`, 결합 규칙)
  - `docs/browser-capabilities.md`
  - `CHANGELOG.md`
  - `docs/status.md`

**Interfaces:**
- Consumes: Task 5의 동작 규칙
- Produces: 새 `requestInstructions(requestId, target)` 문자열. 길이는 600자 미만이다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`request-target.test.ts`에 추가한다. 기존 길이 테스트(< 800)는 그대로 둔다.

```ts
it("tells the model ids are optional in a panel request but still names them", () => {
  const text = requestInstructions("req-1", { tabId: 7, windowId: 1 });
  expect(text.length).toBeLessThan(600);
  expect(text).toContain("requestId=req-1");
  expect(text).toMatch(/omit/i);
  expect(text).toContain("7");
});
```

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/request-target.test.ts`
Expected: FAIL(`omit` 없음 또는 길이 초과)

- [x] **Step 3: 구현한다**

```ts
export function requestInstructions(requestId:string,target:RequestTarget|null):string {
  const start=target?`The captured tab is ${target.tabId}; start with browser_snapshot or browser_tabs attach.`:`No tab was captured: call browser_tabs list, then attach an explicit tabId.`;
  return `Browser context: this user request is bound to browser tools, so omit requestId and operationId. ${start} An explicit tab named by the user wins. If a tool result asks for ids, use requestId=${requestId} and the returned operationId. Results include a snapshot and openTabs. Close tabs only when asked. Never reuse ids or refs from earlier requests.`;
}
```

`panel-provider.mjs` 기본 시나리오(`replies.length === 0` 분기 아래)는 이미 첫 attach를 ID 없이 보낸다. 결합되면 그 호출이 성공한다. 따라서 다음 분기(`!attached && … 'latest user request'`)는 결합이 실패한 경우에만 쓰인다. 수정할 것은 없다.

`opencode-panel.windows.mjs:137-138`의 기대를 바꾼다.

```js
    assert.equal(calls[0]?.state.status,'completed','Managed runtime binds the id-less first attach to this panel request');
    assert.equal(calls[0]?.state.input.requestId,undefined);turn.boundWithoutId=true;
```

`:137`의 `attach?.state.input.requestId === lease.requestId` 단언은 지운다.

- [x] **Step 4: 전체 검증**

```bash
cargo test --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-extension test
pnpm --filter agent-browser-extension exec tsc --noEmit -p .
pnpm --filter agent-browser-e2e exec playwright test   # Linux 전체; J12는 결합 정보 없는 MCP라 그대로 통과해야 한다
bash scripts/test-windows.sh -- journeys.spec.ts reliability.spec.ts
```

실제 OpenCode 검증은 Windows 프로필과 WSL 프로필에서 각각 실행한다. 명령과 환경은 `docs/testing.md`의 `opencode-panel.windows.mjs` 절을 따른다.
- **Windows 프로필:** 두 번의 패널 요청 모두 `boundWithoutId=true`이고 13개 점검이 통과해야 한다.
- **WSL 프로필:** 결과를 그대로 기록한다.
  - 결합되면 WSL 프록시의 cwd가 `\\wsl.localhost\…` 형식이라는 뜻이다.
  - 결합되지 않으면 `calls[0]`이 `error`이고 이어서 명시 경로로 복구된다. 이때 프록시가 실제로 보낸 `cwd`를 확인한다(Bridge 로그 또는 임시 `tracing::debug!`). 그 값이 Linux 경로로 바꿀 수 있는 형식이면 `same_directory`에 규칙을 추가하고 Task 4 테스트에 그 형식을 넣는다. 바꿀 수 없으면 WSL은 명시 경로를 유지하고 status.md에 적는다.
  - 두 경우 모두 WSL 단언은 그 결과에 맞춰 분기한다. 이 결정은 ruling으로 남긴다.

- [x] **Step 5: 문서를 갱신한다**

- **`docs/protocol.md`:**
  - request.begin 매개변수 표에 `profileId`·`sessionId`·`directory`(선택, 셋 다 있어야 범위로 인정)를 추가한다.
  - MCP hello에 `runtimeId`·`cwd`를 추가한다.
  - "결합 규칙" 절을 새로 쓴다. 위 Architecture의 네 조건과 실패 시 기존 오류 그대로임을 적는다.
- **`docs/browser-capabilities.md`:** 패널 요청에서는 ID 없이 도구를 쓸 수 있다는 한 줄을 추가한다. 외부 서버·CLI에서는 명시 ID가 필요하다는 점도 적는다.
- **`CHANGELOG.md` `[미배포]`:** "패널에서 보낸 요청은 에이전트가 요청 ID·작업 ID를 옮겨 적지 않아도 브라우저 도구가 그 요청에 연결됩니다. 같은 실행 환경에서 다른 세션이 작업 중이면 기존처럼 ID가 필요합니다."
- **`docs/status.md` 맨 위:** 실행한 명령·결과, WSL 결과, 미검증을 구분해 기록한다.

- [x] **Step 6: 커밋한다**

```bash
git add extension tests docs CHANGELOG.md
git commit -m "feat: bind panel requests without copied ids and record real OpenCode verification"
```

---

## 이후 계획 (이 문서 범위 밖, 순서대로 별도 문서로 작성)

- **계획 3B — 계층형 인라인 스냅샷과 `query`(리뷰 B1):** 3A로 줄어든 도구 설명 예산을 `query` 매개변수에 쓴다. 계획 1에서 미룬 항목을 함께 다룬다.
  - 후속 스냅샷의 요소 수 상한
  - 자체 버튼을 품은 포인터 영역이 요소 칸을 차지하는 문제
  - 500ms 뒤 JS로 이동하는 페이지의 결과 스냅샷 누락
- **계획 3C — 작업 가시성·알림·인계(리뷰 B4, 요구사항 §16):**
  - 확장 아이콘 배지, 작업 탭 테두리, 조작 대상 강조
  - 패널이 닫혀 있을 때 권한·질문 알림
  - [잠시 넘겨받기]/[이어서 진행]
  - 계획 2에서 미룬 설치기 minor 5건
    - 꺼진 WSL 배포판 탐색: 배포판 칸이 비면 진행 불가, Windows 후보가 있으면 안내 숨김, 15초 제한
    - 완료 화면 긴 줄의 가로 스크롤
    - 사용자 이름만 바꿀 때 비밀번호 삭제 안내 누락
    - 확장 감지가 1.5초마다 Bridge 시작까지 반복
    - 긴 페어링 오류 문구 잘림
- **계획 4 — 선택 권한(리뷰 B3, 요구사항 §10 R10):** `debugger`(CDP) 입력 계층과 `tabGroups`. Task 1은 설계가 아니라 확인 작업이다.
  - Playwright가 CDP로 이미 제어하는 Chrome에서 `chrome.debugger.attach`가 되는지 Linux Chromium과 Windows Chrome 154에서 확인한다.
  - `optional_permissions`로 요청할 수 있는 권한을 Chrome 문서에서 확인한다. 대상은 `tabGroups`, 3C 알림에 필요한 `notifications`다.
