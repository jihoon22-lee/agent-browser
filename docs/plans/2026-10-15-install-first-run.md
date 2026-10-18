# 설치·첫 사용 경험 개선 (계획 2) Implementation Plan

> **상태: 완료.** [PR #21](https://github.com/jihoon22-lee/agent-browser/pull/21)로 main에 병합했다(`1d004a1`, 2026-10-15). v0.2.0에 포함. 실제 검증 결과와 남긴 항목은 [상태 기록](../status.md)과 PR 본문에 있다. 새 작업의 원장으로 쓰지 않는다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 설치 마법사 하나로 "설치 → Chrome 확장 → 연결 → 실행 환경 → 첫 대화"를 끝낼 수 있게 한다. 각 단계는 실제로 성공했는지 확인해 보여 준다.

**Architecture:**
- **Bridge:** 설치기가 쓸 읽기 전용 상태 조회(`status`)와 짧은 페어링 창(`pair --open`)을 MCP 역할 연결로 제공한다. 확장은 토큰이 없을 때 고정 확장 ID로 토큰을 요청한다.
- **마법사:** Bridge를 폴링해 확장 감지·연결을 표시한다. 프로필 단계는 대화상자 대신 본 화면 안에서 저장·기본 지정·시작·확인을 한 번에 처리한다. 마지막 화면은 실제 점검 결과다.
- **확장:** 업데이트 뒤 자기 자신을 한 번 새로고침한다. 패널은 첫 전송에서 세션을 만든다.

**Tech Stack:** Rust(serve·CLI), TypeScript(MV3 확장, vitest), C# .NET Framework 4 WinForms(마법사, `csc` 컴파일 테스트 하네스), Bash·PowerShell 5.1(Windows 검증).

**Spec:** [`docs/review-2026-10-15.md`](../review-2026-10-15.md). §0 프로필 문제, §A 설치·연결, §C 패널, §E 계획 2를 기준으로 한다. 요구사항 원장은 [`docs/handoff.md`](../handoff.md), 작업 규칙은 [`AGENTS.md`](../../AGENTS.md)다.

## 2번 답변 검토 결과 — 이 계획이 해결하는 문제

사용자 보고: 최신 릴리스로 설치했고 페어링까지는 잘 됐다. 마법사의 프로필 단계에서 추가하고 저장했지만, Chrome의 AgentBrowser 설정에는 프로필이 없어 직접 다시 추가했다.

**확인한 것:**
- Bridge의 저장·조회는 정상이다. 마법사와 같은 CLI 경로로 저장하면, 실행 중인 Bridge에 확장 역할로 인증해 받은 `profile.list`에 바로 나타났다.
  - Linux 빌드에서 확인했다.
  - 실제 Windows에서 게시된 v0.1.11 exe로도 확인했다.
- 기존 GUI 회귀는 `runtime.json`에 문자열이 있는지만 본다. 확장이 보는 목록은 확인하지 않는다.

**확정하지 못한 것:** 사용자 PC에서 실제로 어느 경로로 실패했는지. 그 PC에는 접근하지 않았다.

**마법사 쪽 원인 후보:**
- **저장 버튼이 따로 있다:** [확인]을 누르면 "추가할 프로필: … 저장 후 Chrome Options에서 시작하세요"가 나온다. 완료처럼 읽히지만, 실제 저장은 옆의 [프로필 저장]을 눌러야 한다.
- **결과 확인이 없다:** 저장 실패 문구도 대화상자 안 미리보기 칸에만 나온다. 본 화면은 저장된 프로필을 보여 주지 않는다.
- **배율 미대응:** 대화상자만 화면 배율 대응이 없다. 125~150% 배율에서 잘리거나 겹칠 수 있다.
- **탐색 누락:** 꺼진 배포판, nvm·bun 등으로 설치한 OpenCode는 탐색되지 않는다.

이 계획은 원인을 하나로 단정하지 않는다. 대신 위 경로가 모두 일어날 수 없게 구조를 바꾼다.
- 대화상자를 없애고, 마법사 본 화면에서 [저장하고 연결 확인] 한 번으로 저장·기본 지정·실행·브라우저 연결 확인까지 한다.
- 그 결과와 Bridge가 실제로 보고하는 저장된 프로필 목록을 같은 화면에 표시한다.
- 회귀 테스트는 저장 직후 Bridge가 보고하는 목록에 그 프로필이 있는지 확인한다.


> **2026-10-15 변경(사용자 결정, 보안 검토 반영):** 백그라운드 보안 검토가 Task 2·3의 "창이 열리면 고정 확장 ID origin에 토큰 전달"을 인증 우회로 지적했다. 127.0.0.1은 같은 PC의 다른 Windows 계정도 접속할 수 있고, Origin은 위조할 수 있다. 사용자가 **6자리 코드 입력**을 선택했다.
> - `pairing.open`은 OS CSPRNG로 6자리 코드를 만들어 반환하고, 마법사가 표시한다.
> - `pair.request`는 `code`가 맞을 때만 기존 토큰을 준다. 5회 틀리면 창이 닫힌다. 코드 없는 요청은 "확장이 설치됨" 신호로만 기록된다.
> - 확장은 토큰 없는 주기 요청에서 토큰을 받지 않는다. 설정 페이지의 [코드로 연결] 버튼(`pair-with-code` → `BridgeConnection.pairWithCode`)만 토큰을 저장하며, 그 사이 연결이 중지·재설정되면 저장하지 않는다.
> - Task 8의 [Chrome에 연결]은 코드를 크게 표시하고 "Chrome의 AgentBrowser 설정에서 이 코드를 입력하세요"라고 안내한 뒤 연결을 폴링한다.

## Global Constraints

- **설치 호환성(AGENTS.md "설치 호환성 — 사용자 확정 요구사항"):** 설치 폴더·상위 폴더·드라이브 루트의 소유자 SID·ACL 검사를 차단 조건으로 추가하지 않는다. 기존 폴더의 소유자·ACL을 바꾸지 않는다. 사용자 안내의 스크립트 실행은 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File …` 형식이다.
- **GUI 검증:** 실제 Windows에서 설치 화면과 고급 설정의 한글 표시·잘림·배율을 눈으로 확인한다. 버튼 이벤트 테스트로 화면 검증을 대신하지 않는다.
- **OpenCode:** v1 경로만 쓴다. 사용자의 전역 OpenCode 설정을 수정하지 않는다. 모델 ID를 하드코딩하지 않는다.
- **페어링:** 상호 HMAC 인증을 유지한다. 페어링 토큰을 URL·명령줄 인수·Chrome 방문 기록에 남기지 않는다.
  - 새 페어링 창은 설치기가 연 경우에만 열린다. 최대 300초이고, 한 번 쓰면 닫힌다.
  - 토큰은 manifest `key`로 고정된 확장 ID의 origin에만 준다.
  - 같은 사용자 권한의 로컬 프로세스는 이미 `data\config.json`을 읽을 수 있으므로 위협 모델을 넓히지 않는다.
- **WinForms 코드:** 기존 `SetupForm`의 `Position`/`LabelAt` 배치를 쓴다. `AutoScaleMode.Font`를 상속하므로 배율에 따라 함께 커진다. 새 독립 `Form`을 만들지 않는다.
- **오류 문구:** 사용자에게 보이는 문구는 한국어이고 다음 행동을 담는다. 원문은 괄호 안에 남겨 진단에 쓴다.
- **검증:**
  - Windows exe는 `cargo xwin build --target x86_64-pc-windows-msvc`로 만들어 실제 Windows에서 실행한다. Linux 결과를 Windows 검증으로 보고하지 않는다.
  - 실행하지 않은 검증을 통과로 보고하지 않는다. 결과는 `docs/status.md`에 기록한다.
- **변경 방식:**
  - 과제마다 실패하는 테스트를 먼저 쓴다. 확장 코드를 바꾼 과제는 `pnpm --filter agent-browser-extension exec tsc --noEmit -p .`도 실행한다.
  - 새 의존성을 추가하지 않는다.
  - 커밋은 영어 Conventional Commits다(저장소 로컬 `user.email`이 noreply로 설정돼 있음). push·PR·Release는 사용자 요청이 있을 때만 한다.
- **고정 확장 ID:** `extension/public/manifest.json`의 `key`에서 계산한 값은 `icgmjjcpnaenpfjfoggnaodeaidbnihl`이다.

## Review Focus

1. **이미 페어링된 확장으로 업데이트 설치:** 자동 페어링 창이 기존 연결을 끊거나 다른 토큰으로 바꾸면 안 된다. 페어링 창은 토큰을 새로 만들지 않고 기존 토큰을 넘긴다. → Task 2 `an_open_window_hands_the_existing_token_once_to_the_fixed_extension_only`.
2. **확장 업데이트 직후 자동 새로고침:** 버전 비교가 잘못되면 무한 새로고침에 빠진다. → Task 4 "reloads at most once per newer Bridge version".
3. **마법사에서 저장 후 Chrome 설정을 열었을 때:** 사용자 보고와 같은 상황에서 Bridge가 보고하는 목록에 프로필이 있어야 한다. → Task 9 `saved runtime appears in the Bridge profile list and on the page`.
4. **WSL 배포판이 꺼져 있거나 OpenCode가 nvm·bun 경로에 있음:** 후보가 없다고 끝나면 안 된다. → Task 10 probe 테스트, Task 9 [배포판 켜고 찾기].
5. **125%·150% 배율, 큰 글꼴:** 새 프로필·연결 화면의 한글이 잘리거나 버튼이 화면 밖으로 나가면 안 된다. → Task 12 실제 화면 확인과 `SetupDisplayTests`.

---

### Task 1: 외부 서버 주소가 바뀌면 이전 비밀번호를 유지하지 않기

**Files:**
- Modify: `bridge/src/runtime/profile.rs:182-185`
- Modify: `extension/src/options/profile-form.ts` (새 함수), `extension/src/options/App.tsx:45`
- Test: `bridge/src/runtime/profile.rs` tests, `extension/test/profile-form.test.ts`(없으면 새 파일)

**Interfaces:**
- Produces:
  - `Profile::preserve_secrets`는 kind·`baseUrl`·`username`이 모두 같을 때만 password를 유지한다. env는 지금처럼 유지한다.
  - `export function passwordDropped(original: {kind:string; baseUrl?: string; hasPassword?: boolean} | undefined, payload: Record<string, unknown>): boolean`

- [x] **Step 1: 실패하는 테스트를 쓴다**

`profile.rs` tests에 추가한다.

```rust
    #[test]
    fn a_password_is_never_carried_to_a_different_server() {
        let old: Profile = serde_json::from_value(json!({"id":"ext","name":"Ext","kind":"external","directory":"/w","baseUrl":"https://a.example/","password":"secret-for-a"})).unwrap();
        let mut moved: Profile = serde_json::from_value(json!({"id":"ext","name":"Ext","kind":"external","directory":"/w","baseUrl":"https://b.example/"})).unwrap();
        moved.preserve_secrets(&old);
        assert_eq!(moved.password, None);
        let mut renamed: Profile = serde_json::from_value(json!({"id":"ext","name":"Renamed","kind":"external","directory":"/w","baseUrl":"https://a.example/"})).unwrap();
        renamed.preserve_secrets(&old);
        assert_eq!(renamed.password.as_deref(), Some("secret-for-a"));
    }
```

`extension/test/profile-form.test.ts`가 없으면 만들고, 있으면 끝에 추가한다.

```ts
import { passwordDropped } from "../src/options/profile-form";

it("tells the user when a changed server address dropped the saved password", () => {
  const original = { kind: "external", baseUrl: "https://a.example/", hasPassword: true };
  expect(passwordDropped(original, { kind: "external", baseUrl: "https://b.example/" })).toBe(true);
  expect(passwordDropped(original, { kind: "external", baseUrl: "https://a.example/" })).toBe(false);
  expect(passwordDropped(original, { kind: "external", baseUrl: "https://b.example/", password: "new" })).toBe(false);
  expect(passwordDropped(undefined, { kind: "external", baseUrl: "https://b.example/" })).toBe(false);
});
```

Run: `cargo test --offline --locked -p agent-browser-bridge --lib a_password_is_never_carried`
Run: `pnpm --filter agent-browser-extension exec vitest run test/profile-form.test.ts`
Expected: Rust는 password가 `Some("secret-for-a")`여서 FAIL. TS는 `passwordDropped`가 없어 FAIL.

- [x] **Step 2: 구현한다**

`profile.rs`:

```rust
    pub fn preserve_secrets(&mut self, old: &Profile) {
        // A password belongs to one server: never carry it to another kind, origin or user.
        let same_server = self.kind == old.kind && self.base_url == old.base_url && self.username == old.username;
        if self.password.is_none() && same_server { self.password = old.password.clone(); }
        if self.env.is_none() { self.env = old.env.clone(); }
    }
```

`profile-form.ts` 끝에 추가한다.

```ts
/** The Bridge keeps a saved password only for the same server; say so when an edit dropped it. */
export function passwordDropped(original: { kind: string; baseUrl?: string; hasPassword?: boolean } | undefined, payload: Record<string, unknown>): boolean {
  return !!original?.hasPassword && original.kind === "external" && payload.kind === "external"
    && original.baseUrl !== payload.baseUrl && typeof payload.password !== "string";
}
```

`App.tsx`의 프로필 저장 `onSubmit` 안을 바꾼다. 저장 전에 원래 프로필을 찾고, 저장 후 알림을 정한다. import에 `passwordDropped`를 추가한다.

```tsx
      <form onSubmit={event => { event.preventDefault(); void run(async () => { const payload = profilePayload(form); const original = editing ? profiles.find(item => item.id === form.id) : undefined; await bridgeRequest("profile.save", { profile: payload, makeDefault }); await chrome.runtime.sendMessage({ kind: "profiles-changed", profileId: form.id }).catch(() => {}); setForm(blank); setEditing(false); await refresh(); setNotice(passwordDropped(original, payload) ? "서버 주소가 바뀌어 이전 비밀번호는 지웠습니다. 인증이 필요한 서버라면 새 비밀번호를 입력해 다시 저장하세요." : "실행 프로필을 저장했습니다."); }); }}>
```

`profiles` 상태의 원소 타입에 `kind`, `baseUrl`, `hasPassword`가 없으면 그 타입 선언에 추가한다. Bridge의 `Profile::summary`는 이 필드들을 이미 반환한다.

- [x] **Step 3: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib runtime::profile`
Run: `pnpm --filter agent-browser-extension exec vitest run test/profile-form.test.ts test/options.test.ts`
Run: `pnpm --filter agent-browser-extension exec tsc --noEmit -p .`
Expected: PASS. `test/options.test.ts`가 없으면 그 인자는 뺀다.

- [x] **Step 4: 커밋한다**

```bash
git add bridge/src/runtime/profile.rs extension/src/options extension/test/profile-form.test.ts
git commit -m "fix: never carry a saved password to a different OpenCode server"
```

### Task 2: Bridge 상태 조회와 짧은 페어링 창

**Files:**
- Modify: `bridge/src/server/conn.rs:42-48`(역할 허용), `:51-78`(ServerState), `:207-232`(authenticate 첫 메시지), `:356-419`(serve_mcp)
- Modify: `bridge/src/mcp/client.rs` (새 `admin_request`)
- Modify: `bridge/src/main.rs` (`Status`, `Pair` 옵션), `bridge/src/lib.rs` (`run_pair`, `run_status`)
- Test: `bridge/tests/pairing_window.rs` (새 파일)

**Interfaces:**
- Produces:
  - MCP 역할 메서드 `status.get` → `{"pairedExtensionId": string|null, "extensionSeen": string|null, "browsers": [{clientId, connected, selected}], "serverVersion": string}`. `extensionSeen`은 15초 안에 `pair.request`를 보낸 확장 ID다.
  - MCP 역할 메서드 `pairing.open {extensionId, seconds}` → `{"open": true, "seconds": n}`. seconds는 10~300이고 기본값은 120이다.
  - `/extension` 첫 메시지 `pair.request {clientId}`:
    - 창이 열려 있고 origin의 확장 ID가 일치하면 `{"token": "<기존 64자 토큰>"}`을 반환하고 창을 닫는다.
    - 아니면 `AUTH_REQUIRED`로 거부한다. 어느 경우든 연결은 닫는다.
  - CLI:
    - `browser-bridge status --json`: 한 줄 JSON. serve를 시작하지 않는다.
    - `browser-bridge pair --open --extension-id <id> [--seconds N]`
    - 기존 `browser-bridge pair`(토큰 출력)는 그대로다.
  - `pub async fn admin_request(home:&Path, port:u16, method:&str, params:Value) -> anyhow::Result<Value>` (`mcp/client.rs`)

- [x] **Step 1: 실패하는 통합 테스트를 쓴다**

`bridge/tests/pairing_window.rs`:

```rust
mod common;
use agent_browser_bridge::rpc::Envelope;
use common::*;
use serde_json::json;

const FIXED: &str = "icgmjjcpnaenpfjfoggnaodeaidbnihl";

async fn pair_request(port: u16, extension_id: &str) -> Envelope {
    let mut ws = ws_connect(port, "/extension", Some(&format!("chrome-extension://{extension_id}"))).await.unwrap();
    call(&mut ws, "pair.request", json!({"clientId":"cli-new"})).await
}

#[tokio::test]
async fn an_open_window_hands_the_existing_token_once_to_the_fixed_extension_only() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut installer = ws_connect(serve.port, "/mcp-proxy", None).await.unwrap();
    hello(&mut installer, "mcp", &cfg.token, "installer").await;
    assert!(matches!(pair_request(serve.port, FIXED).await, Envelope::Res { ok: false, .. }), "a closed window must refuse");
    let seen = call(&mut installer, "status.get", json!({})).await;
    let Envelope::Res { ok: true, result: Some(seen), .. } = seen else { panic!("{seen:?}") };
    assert_eq!(seen["extensionSeen"], FIXED, "the wizard can tell the extension was loaded");
    let opened = call(&mut installer, "pairing.open", json!({"extensionId": FIXED, "seconds": 60})).await;
    assert!(matches!(opened, Envelope::Res { ok: true, .. }), "{opened:?}");
    assert!(matches!(pair_request(serve.port, "abcdefghijklmnopabcdefghijklmnop").await, Envelope::Res { ok: false, .. }), "another extension must not get the token");
    let Envelope::Res { ok: true, result: Some(granted), .. } = pair_request(serve.port, FIXED).await else { panic!("the fixed extension did not get the token") };
    assert_eq!(granted["token"], cfg.token, "pairing hands over the existing token, never a new one");
    assert!(matches!(pair_request(serve.port, FIXED).await, Envelope::Res { ok: false, .. }), "the window is one-shot");
    let status = call(&mut installer, "status.get", json!({})).await;
    let Envelope::Res { ok: true, result: Some(status), .. } = status else { panic!("{status:?}") };
    assert!(status["browsers"].is_array());
    assert_eq!(status["serverVersion"], env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn pairing_open_rejects_invalid_ids_and_durations() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut installer = ws_connect(serve.port, "/mcp-proxy", None).await.unwrap();
    hello(&mut installer, "mcp", &cfg.token, "installer").await;
    for params in [json!({"extensionId":"not-an-id"}), json!({"extensionId": FIXED, "seconds": 3600})] {
        assert!(matches!(call(&mut installer, "pairing.open", params).await, Envelope::Res { ok: false, .. }));
    }
}
```

Run: `cargo test --offline --locked -p agent-browser-bridge --test pairing_window`
Expected: FAIL. `pair.request`가 `auth.hello must be the first message`로 거부되고, `status.get`이 `FORBIDDEN_METHOD`다.

- [x] **Step 2: 상태와 페어링 창을 ServerState에 추가한다**

`conn.rs`의 `pub struct ServerState` 위에 추가한다.

```rust
/// A short window the installer opens so a freshly loaded extension can receive the existing token.
pub struct PairingWindow { pub extension_id: String, pub until: std::time::Instant }
```

`ServerState`에 필드 두 개를 추가하고, `new_with_port`에서 `StdMutex::new(None)`으로 초기화한다.

```rust
    pub pairing: StdMutex<Option<PairingWindow>>,
    /// The extension that last asked for pairing, so the installer can show it was loaded.
    pub pair_seen: StdMutex<Option<(String, std::time::Instant)>>,
```

`Role::allows`의 Mcp를 바꾼다.

```rust
            Role::Mcp => matches!(method, "tool.call" | "tool.cancel" | "status.get" | "pairing.open"),
```

- [x] **Step 3: `pair.request`를 처리한다**

`authenticate`의 첫 메시지 match에서 `Ok(Envelope::Req { id, method, params, .. }) if method == "auth.hello" => ...` 다음 arm으로 추가한다.

```rust
        Ok(Envelope::Req { id, method, .. }) if method == "pair.request" => {
            handle_pair_request(ws, role, extension_id.as_deref(), &id, state).await;
            return None;
        }
```

`authenticate` 위에 함수를 추가한다.

```rust
async fn handle_pair_request(ws: &mut Ws, role: Role, extension_id: Option<&str>, id: &str, state: &ServerState) {
    let Some(extension_id) = extension_id.filter(|_| role == Role::Extension) else {
        send_err_and_close(ws, id, ErrorCode::AuthRequired, "pair.request is only for the extension").await;
        return;
    };
    *state.pair_seen.lock().unwrap() = Some((extension_id.to_string(), std::time::Instant::now()));
    let granted = {
        let mut window = state.pairing.lock().unwrap();
        let open = window.as_ref().is_some_and(|w| w.until > std::time::Instant::now() && w.extension_id == extension_id);
        if open { *window = None; }
        open
    };
    if !granted {
        send_err_and_close(ws, id, ErrorCode::AuthRequired, "No pairing window is open. Press [Chrome에 연결] in AgentBrowser setup, or enter the token in Options.").await;
        return;
    }
    let token = state.cfg.lock().await.token.clone();
    let _ = send(ws, &Envelope::ok(id, json!({ "token": token }))).await;
    let _ = ws.close(None).await;
}
```

- [x] **Step 4: MCP 역할의 두 메서드를 처리한다**

`serve_mcp`의 `if method == "tool.cancel" { ... continue; }` 블록 바로 뒤에 추가한다.

```rust
                if method == "status.get" {
                    let paired = state.cfg.lock().await.paired_extension_id.clone();
                    let seen = state.pair_seen.lock().unwrap().as_ref()
                        .filter(|(_, at)| at.elapsed() < Duration::from_secs(15)).map(|(id, _)| id.clone());
                    let reply = Envelope::ok(id, json!({"pairedExtensionId": paired, "extensionSeen": seen,
                        "browsers": state.registry.snapshot(), "serverVersion": env!("CARGO_PKG_VERSION")}));
                    if !send(ws, &reply).await { break; }
                    continue;
                }
                if method == "pairing.open" {
                    let reply = match open_pairing(state, &params) { Ok(value) => Envelope::ok(id, value), Err(error) => Envelope::err(id, error) };
                    if !send(ws, &reply).await { break; }
                    continue;
                }
```

`serve_mcp` 위에 추가한다.

```rust
fn open_pairing(state: &ServerState, params: &Value) -> Result<Value, RpcError> {
    let extension_id = params["extensionId"].as_str().filter(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
        .ok_or_else(|| RpcError::new(ErrorCode::InvalidParams, Retry::Never, "extensionId must be a 32-character Chrome extension id"))?;
    let seconds = params["seconds"].as_u64().unwrap_or(120);
    if !(10..=300).contains(&seconds) { return Err(RpcError::new(ErrorCode::InvalidParams, Retry::Never, "seconds must be 10-300")); }
    *state.pairing.lock().unwrap() = Some(PairingWindow { extension_id: extension_id.into(), until: std::time::Instant::now() + Duration::from_secs(seconds) });
    Ok(json!({ "open": true, "seconds": seconds }))
}
```

- [x] **Step 5: 통합 테스트가 통과하는지 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --test pairing_window --test serve_auth`
Expected: PASS

- [x] **Step 6: CLI를 추가한다**

`mcp/client.rs`의 `probe_authenticated` 아래에 추가한다.

```rust
/// One authenticated request to a running serve for local tools such as the installer. Never starts serve.
pub async fn admin_request(home: &Path, port: u16, method: &str, params: Value) -> anyhow::Result<Value> {
    let cfg = config::load_or_init(home)?;
    let client = ServeClient { port, exe: Path::new("").into(), token: cfg.token, conn: tokio::sync::Mutex::new(None), last_error: std::sync::Mutex::new(None), start_failed_at: std::sync::Mutex::new(None) };
    let mut ws = client.open().await.map_err(|error| anyhow::anyhow!("No authenticated Bridge at 127.0.0.1:{port}: {error}"))?;
    auth_exchange(&mut ws, &Envelope::req(method, params)).await.map_err(|error| anyhow::anyhow!(error))
}
```

`main.rs`의 `Command`에서 `Pair`를 바꾸고 `Status`를 추가한다.

```rust
    /// Print the pairing token, or open a short pairing window for the fixed extension id.
    Pair { #[arg(long)] open: bool, #[arg(long)] extension_id: Option<String>, #[arg(long, default_value_t = 120)] seconds: u64 },
    /// Print the running Bridge's pairing and browser connection state as JSON. Never starts it.
    Status { #[arg(long)] json: bool },
```

dispatch를 바꾼다.

```rust
        Command::Pair { open, extension_id, seconds } => agent_browser_bridge::run_pair(open, extension_id, seconds),
        Command::Status { .. } => agent_browser_bridge::run_status(),
```

`lib.rs`의 `run_pair`를 바꾸고 `run_status`를 추가한다.

```rust
fn bridge_port(cfg: &config::Config) -> u16 {
    std::env::var("AGENT_BROWSER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(cfg.port)
}

pub fn run_pair(open: bool, extension_id: Option<String>, seconds: u64) -> anyhow::Result<()> {
    let home = config::home_dir()?;
    let cfg = config::load_or_init(&home)?;
    if open {
        let extension_id = extension_id.ok_or_else(|| anyhow::anyhow!("--extension-id is required with --open"))?;
        let result = tokio::runtime::Runtime::new()?.block_on(mcp::client::admin_request(&home, bridge_port(&cfg), "pairing.open",
            serde_json::json!({ "extensionId": extension_id, "seconds": seconds })))?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    // The token is printed only on explicit request so the user can paste it into the extension options page.
    println!("{}", cfg.token);
    eprintln!("config: {}", home.join("config.json").display());
    Ok(())
}

pub fn run_status() -> anyhow::Result<()> {
    let home = config::home_dir()?;
    let cfg = config::load_or_init(&home)?;
    let result = tokio::runtime::Runtime::new()?.block_on(mcp::client::admin_request(&home, bridge_port(&cfg), "status.get", serde_json::json!({})))?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
```

`main.rs` 상단의 `log_file` match는 `Command::Serve`만 보므로 바꾸지 않는다.

- [x] **Step 7: CLI 동작을 확인한다**

```bash
cargo build --offline --locked -p agent-browser-bridge
H=$(mktemp -d); P=47411
(target/debug/browser-bridge --home "$H" serve --port $P >/dev/null 2>&1 &); sleep 1.5
AGENT_BROWSER_HOME=$H AGENT_BROWSER_PORT=$P target/debug/browser-bridge status --json
AGENT_BROWSER_HOME=$H AGENT_BROWSER_PORT=$P target/debug/browser-bridge pair --open --extension-id icgmjjcpnaenpfjfoggnaodeaidbnihl --seconds 30
pkill -f "home $H serve"; rm -rf "$H"
```

Expected:
- `status`는 `{"browsers":[],"extensionSeen":null,"pairedExtensionId":null,"serverVersion":"…"}`을 출력한다.
- `pair --open`은 `{"open":true,"seconds":30}`을 출력한다.

Run: `cargo test --offline --locked -p agent-browser-bridge`
Expected: PASS(전체)

- [x] **Step 8: 커밋한다**

```bash
git add bridge/src bridge/tests/pairing_window.rs
git commit -m "feat(bridge): add read-only status and a one-shot pairing window for the installer"
```

### Task 3: 확장이 토큰 없이 페어링을 요청

**Files:**
- Modify: `extension/src/background/bridge-connection.ts:157-222`
- Modify: `extension/src/options/App.tsx:31` (안내 문구)
- Test: `extension/test/bridge-connection.test.ts`

**Interfaces:**
- Consumes: Task 2의 `pair.request` 응답 `{token}`
- Produces:
  - 토큰이 없으면 상태를 `unpaired`로 두고, 3초마다 `pair.request`를 보낸다.
  - 토큰을 받으면 `pairingToken`과 `repairPending=true`를 저장하고 즉시 정상 연결을 시작한다.

- [x] **Step 1: 기존 기대를 바꾸고 실패하는 테스트를 쓴다**

`bridge-connection.test.ts`의 `"reports unpaired without a token and does not connect"` 테스트를 아래 두 테스트로 바꾼다.

```ts
  it("asks the Bridge for a token without one and stores it from an open pairing window", async () => {
    const { conn, store, statuses } = setup({ clientId: "cli-1" });
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    expect(statuses.at(-1)?.state).toBe("unpaired");
    const pairing = FakeWs.last; pairing.open();
    const request = parseEnvelope(pairing.sent[0]!);
    expect(request.type === "req" && request.method).toBe("pair.request");
    pairing.reply(makeOk((request as any).id, { token: "a".repeat(64) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.pairingToken).toBe("a".repeat(64));
    expect(store.repairPending).toBe(true);
    FakeWs.last.open();
    const hello = parseEnvelope(FakeWs.last.sent[0]!);
    expect(hello.type === "req" && hello.method).toBe("auth.hello");
  });

  it("keeps asking every few seconds while no pairing window is open", async () => {
    const { conn } = setup({ clientId: "cli-1" });
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    const first = FakeWs.last; first.open();
    first.reply(makeErr((parseEnvelope(first.sent[0]!) as any).id, { code: "AUTH_REQUIRED", message: "closed", retry: "never" }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeWs.last).not.toBe(first);
    FakeWs.last.open();
    expect(parseEnvelope(FakeWs.last.sent[0]!)).toMatchObject({ method: "pair.request" });
  });
```

Run: `pnpm --filter agent-browser-extension exec vitest run test/bridge-connection.test.ts`
Expected: 두 새 테스트가 FAIL. 토큰이 없으면 소켓을 만들지 않는다.

- [x] **Step 2: 구현한다**

`bridge-connection.ts` 상단 상수에 추가한다.

```ts
const PAIRING_POLL_MS = 3_000;
```

클래스 필드에 추가한다.

```ts
  private pairingSocket?: WebSocket;
```

`connect()`에서 url·clientId 계산을 토큰 확인보다 앞으로 옮기고, 토큰이 없을 때의 처리를 바꾼다.

```ts
      const token = (await this.deps.storage.get("pairingToken")) as string | undefined;
      if (!valid()) return;
      const url = ((await this.deps.storage.get("bridgeUrl")) as string | undefined) ?? DEFAULT_BRIDGE_URL;
      if (!valid()) return;
      let clientId = (await this.deps.storage.get("clientId")) as string | undefined;
      if (!valid()) return;
      if (!clientId) { clientId = `cli-${crypto.randomUUID()}`; await this.deps.storage.set("clientId", clientId); }
      if (!valid()) return;
      if (!token) { this.setStatus({ state: "unpaired" }); this.requestPairing(url, clientId, lifecycle); return; }
```

이어지는 기존의 url·clientId 계산 줄은 지운다. 클래스에 메서드를 추가한다.

```ts
  /** Without a token, ask the Bridge for one. It answers only while the installer has opened a
   * short pairing window, and only to this extension's fixed ID; otherwise retry quietly. */
  private requestPairing(url: string, clientId: string, lifecycle: number) {
    if (this.pairingSocket) return;
    const ws = new this.deps.WebSocketImpl(url);
    this.pairingSocket = ws;
    let settled = false;
    const finish = (paired: boolean) => {
      if (settled) return;
      settled = true; this.pairingSocket = undefined; this.cancelTimer(deadline);
      if (lifecycle !== this.lifecycle || this.stopped) return;
      this.schedule(paired ? 0 : PAIRING_POLL_MS);
    };
    const deadline = this.later(() => { ws.close(); finish(false); }, RESPONSE_TIMEOUT_MS);
    ws.onopen = () => { try { ws.send(JSON.stringify(makeReq("pair.request", { clientId }))); } catch { ws.close(); } };
    ws.onmessage = (event) => {
      let env: Envelope | undefined;
      try { env = parseEnvelope(String(event.data)); } catch { env = undefined; }
      const token = env?.type === "res" && env.ok ? (env.result as { token?: unknown } | undefined)?.token : undefined;
      // Detach onclose first: a synchronous close event must not turn a granted token into a retry.
      ws.onclose = null; ws.close();
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) { finish(false); return; }
      void (async () => {
        await this.deps.storage.set("repairPending", true);
        await this.deps.storage.set("pairingToken", token);
        finish(true);
      })();
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => finish(false);
  }
```

`stop()`에서 `this.clearTimers();` 다음 줄에 추가한다.

```ts
    this.pairingSocket?.close(); this.pairingSocket = undefined;
```

- [x] **Step 3: 설정 페이지 안내를 바꾼다**

`App.tsx`의 `Bridge 페어링` 절 첫 문장을 바꾼다.

```tsx
    <section><h2>Bridge 페어링</h2><p>설치 마법사의 [Chrome에 연결]을 누르면 자동으로 연결됩니다. 직접 연결하려면 설치 폴더의 페어링 안내에 표시된 토큰을 입력하세요.</p>
```

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/bridge-connection.test.ts`
Run: `pnpm --filter agent-browser-extension exec tsc --noEmit -p .`
Expected: PASS(기존 테스트 포함)

- [x] **Step 5: 커밋한다**

```bash
git add extension/src/background/bridge-connection.ts extension/src/options/App.tsx extension/test/bridge-connection.test.ts
git commit -m "feat(extension): request the existing token while an installer pairing window is open"
```

### Task 4: 업데이트 뒤 확장 자동 새로고침

**Files:**
- Modify: `extension/src/background/bridge-connection.ts` (ConnDeps, prove 응답 처리, 새 `compareVersions`)
- Modify: `extension/src/background/index.ts:11-21`
- Test: `extension/test/bridge-connection.test.ts`

**Interfaces:**
- Produces:
  - `ConnDeps.extensionVersion?: string`, `ConnDeps.reload?: () => void`
  - `export function compareVersions(a: string, b: string): number`
  - 인증 응답의 `serverVersion`이 확장 버전보다 높을 때만 reload한다. 같은 Bridge 버전으로는 한 번만 한다(`storage.reloadedForBridge`).

- [x] **Step 1: 실패하는 테스트를 쓴다**

`bridge-connection.test.ts`의 기존 도우미 `finishAuthentication(ws)`(137행)는 마지막 응답을 `{ authVersion: 1, selected: true }`로 고정한다. 응답을 인수로 받게 바꾼다. 기본값이 같으므로 기존 호출은 그대로 동작한다.

```ts
async function finishAuthentication(ws: FakeWs, ack: Record<string, unknown> = { authVersion: 1, selected: true }) {
```

함수 마지막 줄 `ws.reply(makeOk(prove.id, { authVersion: 1, selected: true }));`를 `ws.reply(makeOk(prove.id, ack));`로 바꾼다. `authenticated` 아래에 도우미를 추가한다.

```ts
async function authenticatedWith(conn: BridgeConnection, ack: Record<string, unknown>) {
  conn.start();
  await vi.advanceTimersByTimeAsync(0);
  const ws = FakeWs.last;
  ws.open();
  await finishAuthentication(ws, ack);
  await vi.advanceTimersByTimeAsync(0);
  return ws;
}
```

`describe("BridgeConnection lifecycle", ...)` 안에 테스트를 추가한다.

```ts
  it("reloads at most once per newer Bridge version", async () => {
    const reload = vi.fn();
    const { conn, store } = setup({ pairingToken: "tok", clientId: "cli-1" }, { extensionVersion: "0.1.11", reload });
    await authenticatedWith(conn, { authVersion: 1, serverVersion: "0.1.12" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.reloadedForBridge).toBe("0.1.12");
    conn.stop();
    await authenticatedWith(conn, { authVersion: 1, serverVersion: "0.1.12" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads for an equal or older Bridge", async () => {
    const reload = vi.fn();
    const { conn } = setup({ pairingToken: "tok", clientId: "cli-1" }, { extensionVersion: "0.1.11", reload });
    await authenticatedWith(conn, { authVersion: 1, serverVersion: "0.1.11" });
    expect(reload).not.toHaveBeenCalled();
  });
```

`compareVersions` 단위 테스트도 추가한다.

```ts
  it("compares release versions numerically", () => {
    expect(compareVersions("0.1.12", "0.1.11")).toBeGreaterThan(0);
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.11", "0.1.11")).toBe(0);
    expect(compareVersions("0.2.0-beta", "0.2.0")).toBe(0);
  });
```

import에 `compareVersions`를 추가한다.

Run: `pnpm --filter agent-browser-extension exec vitest run test/bridge-connection.test.ts -t "reload|compares"`
Expected: FAIL

- [x] **Step 2: 구현한다**

`bridge-connection.ts`의 `ConnDeps`에 추가한다.

```ts
  /** This extension's manifest version and a reload hook: an unpacked extension loads from the
   * install folder, so reloading once after an update runs the new files. */
  extensionVersion?: string;
  reload?: () => void;
```

파일 끝에 추가한다.

```ts
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split(/[-+]/)[0]!.split(".").slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
```

클래스에 메서드를 추가한다.

```ts
  private async reloadIfOutdated(serverVersion: unknown) {
    const own = this.deps.extensionVersion, reload = this.deps.reload;
    if (typeof serverVersion !== "string" || !own || !reload || compareVersions(serverVersion, own) <= 0) return;
    if ((await this.deps.storage.get("reloadedForBridge")) === serverVersion) return;
    await this.deps.storage.set("reloadedForBridge", serverVersion);
    reload();
  }
```

prove 응답의 `complete` 안 `this.startHeartbeat(ws);` 다음 줄에 추가한다.

```ts
                  void this.reloadIfOutdated((ack.result as { serverVersion?: unknown } | undefined)?.serverVersion);
```

`index.ts`의 `new BridgeConnection({...})`에 추가한다.

```ts
  extensionVersion: chrome.runtime.getManifest().version,
  reload: () => chrome.runtime.reload(),
```

- [x] **Step 3: 통과를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/bridge-connection.test.ts`
Run: `pnpm --filter agent-browser-extension exec tsc --noEmit -p .`
Expected: PASS

- [x] **Step 4: 커밋한다**

```bash
git add extension/src/background extension/test/bridge-connection.test.ts
git commit -m "feat(extension): reload once after the Bridge is updated to a newer version"
```

### Task 5: 패널 첫 전송에서 세션 만들기, 실행 환경이 없을 때 안내

**Files:**
- Modify: `extension/src/sidepanel/Workbench.tsx:108`(createSession), `:147-170`(send), `:297`, `:327`
- Test: `extension/test/workbench.test.ts` (끝에 추가)

**Interfaces:**
- Produces:
  - 세션 없이 [보내기]를 누르면 세션을 만들고 그 세션을 선택한다. 입력한 초안과 첨부는 새 세션으로 옮겨 그대로 전송한다.
  - 실행 환경이 없으면 대화 화면과 실행 설정에 [실행 환경 추가] 버튼을 보여 준다. 누르면 설정 페이지가 열린다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`workbench.test.ts` 끝에 추가한다.

```ts
it("creates a session and sends the first message when none is selected", async () => {
  sessions.length = 0;
  const storage = await chrome.storage.local.get(); delete (storage as any)["recentSession:native"];
  test.post.mockImplementation(async (path: string) => {
    if (path === "/session") { const created = { id: "ses-new", title: "새 대화", directory: "/fixture", time: { updated: 2 } }; sessions.push(created); return created; }
    return true;
  });
  (chrome as any).windows = { getLastFocused: vi.fn(async () => ({ id: 4, focused: true, tabs: [{ id: 31, active: true, url: "https://mail.test" }] })) };
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(async (message: any) => message.kind === "request-prepare" ? { ok: true, result: { system: "ctx" } } : original(message));
  await render(); await draftValue("첫 요청"); await act(async () => button("보내기").click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const sends = test.post.mock.calls.filter(([path]) => path.endsWith("/prompt_async"));
  expect(sends.map(([path]) => path)).toEqual(["/session/ses-new/prompt_async"]);
  expect(JSON.stringify(sends[0]![1].parts)).toContain("첫 요청");
});

it("offers to add a runtime profile when none exists", async () => {
  const runtime = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>, original = runtime.getMockImplementation() as (message: any) => Promise<any>;
  runtime.mockImplementation(async (message: any) => message.method === "profile.list" ? { ok: true, result: { profiles: [], defaultProfileId: null } } : original(message));
  await render();
  await act(async () => button("실행 환경 추가").click());
  expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
});
```

Run: `pnpm --filter agent-browser-extension exec vitest run test/workbench.test.ts -t "creates a session|offers to add"`
Expected: FAIL. 첫 테스트는 "새 세션을 만들거나 기존 세션을 선택하세요" 오류로 전송하지 않고, 둘째는 버튼이 없다.

- [x] **Step 2: 구현한다**

`Workbench.tsx` 컴포넌트 안 ref 선언부(`const sendLock = useRef(...)` 근처)에 추가한다.

```tsx
  const autoSend = useRef(false);
```

`createSession`을 바꾼다. 선택적 초안을 받아 새 세션의 draftKey에 미리 넣어 두면, 기존 초안 effect가 세션 전환 때 그 초안을 불러온다. 만든 세션을 반환해 호출자가 성공 여부를 알 수 있게 한다.

```tsx
  async function createSession(carry?: { draft: string; attachments: typeof attachments }): Promise<Data | undefined> { const current = wb.captureScope(); const session = await api().post<Data>("/session", { ...(agent ? { agent } : {}), ...(model ? { model: { id: model.id, providerID: model.providerID, ...(variant ? { variant } : {}) } } : {}) }); if (!current()) return undefined; if (carry) draftCache.current.set(JSON.stringify([wb.profileId, wb.directory, session.id]), carry); await wb.refreshSessions(); if (!current()) return undefined; const selection = wb.selectSession(session), destination = wb.captureScope(); await selection; if (destination()) { setNotice(""); onViewChange("chat"); setDrawer(null); } return session; }
```

`send()`에서 UI 명령 처리(`if (ui) {...}`) 바로 뒤, `sendLock.current = true;` 앞에 넣는다.

```tsx
    if (!wb.sessionId) {
      // The first message creates its session; the typed draft moves with it and the effect below sends it there.
      autoSend.current = true;
      let created: Data | undefined;
      await perform(async () => { created = await createSession({ draft, attachments }); });
      if (!created) autoSend.current = false;
      return;
    }
```

초안 effect 아래에 `useEffect`를 추가한다.

```tsx
  useEffect(() => {
    if (!autoSend.current || !wb.sessionId || !draft.trim()) return;
    autoSend.current = false;
    void send();
  }, [wb.sessionId, draft]);
```

`try` 안의 `if (!wb.sessionId) throw new Error("새 세션을 만들거나 기존 세션을 선택하세요.");`는 방어용으로 그대로 둔다. 위 분기 때문에 정상 흐름에서는 도달하지 않는다.

`perform`의 시그니처가 `() => Promise<void>`이면, 기존 호출 `perform(createSession)`은 이제 `Promise<Data | undefined>`를 반환하는 함수를 넘기게 된다. tsc가 거부하면 `perform(async () => { await createSession(); })`로 바꾼다.

실행 환경이 없을 때의 안내를 바꾼다. 297행 문단:

```tsx
      {!wb.profiles.length && <p className="muted">OpenCode 실행 환경이 없습니다. <button onClick={() => void chrome.runtime.openOptionsPage()}>실행 환경 추가</button></p>}
```

327행 빈 대화 안내의 버튼 부분:

```tsx
{!wb.profiles.length ? <button className="primary" onClick={() => void chrome.runtime.openOptionsPage()}>실행 환경 추가</button> : !wb.sessionId && <button className="primary" disabled={!wb.connected} onClick={() => void perform(createSession)}>새 대화 시작</button>}
```

위 버튼의 `perform(createSession)`도 앞 단락의 tsc 규칙을 따른다.

- [x] **Step 3: 통과를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/workbench.test.ts`
Run: `pnpm --filter agent-browser-extension exec tsc --noEmit -p .`
Expected: PASS(기존 테스트 포함). 빈 대화 화면에서 "새 대화 시작"을 찾는 기존 테스트는 프로필이 있으면 그대로 통과한다.

- [x] **Step 4: 커밋한다**

```bash
git add extension/src/sidepanel/Workbench.tsx extension/test/workbench.test.ts
git commit -m "feat(panel): create the session on first send and offer to add a runtime profile"
```

### Task 6: Windows 설치기 테스트 실행 도구

**Files:**
- Create: `scripts/test-installer-windows.sh`
- Modify: `docs/testing.md` (사용법 한 절)

**Interfaces:**
- Produces: `bash scripts/test-installer-windows.sh <TestClass>`
  1. `%LOCALAPPDATA%\AgentBrowser-dev\installer-tests`에 installer·테스트 C# 소스와 최신 `release/agent-browser-*-windows-x64.zip`을 푼다.
  2. Windows .NET Framework `csc`로 `<TestClass>`를 컴파일한다.
  3. `<fixture> <package>` 인수로 실행하고, 종료 코드를 그대로 반환한다.

- [x] **Step 1: 스크립트를 만든다**

```bash
#!/usr/bin/env bash
# Development verification only: compile installer C# tests with Windows' .NET Framework compiler and run one.
# Uses only an isolated %LOCALAPPDATA%\AgentBrowser-dev\installer-tests folder; never the user's installation.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
name="${1:?usage: test-installer-windows.sh <TestClass, e.g. SetupFlowTests>}"
ps=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
local_app="$("$ps" -NoProfile -NonInteractive -Command '[Environment]::GetFolderPath("LocalApplicationData")' | tr -d '\r\n')"
dest_win="$local_app\\AgentBrowser-dev\\installer-tests"
dest="$(wslpath -u "$dest_win")"
rm -rf "$dest"; mkdir -p "$dest/src" "$dest/package"
cp "$repo_dir"/installer/*.cs "$repo_dir"/tests/install/*.cs "$dest/src/"
zip="$(ls -t "$repo_dir"/release/agent-browser-*-windows-x64.zip | head -1)"
unzip -q "$zip" -d "$dest/package"
"$ps" -NoProfile -ExecutionPolicy Bypass -Command "& {
  \$c = Join-Path \$env:WINDIR 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
  \$src = (Get-ChildItem '$dest_win\\src\\*.cs').FullName
  & \$c /nologo /codepage:65001 /target:exe /main:AgentBrowser.Installer.$name '/out:$dest_win\\$name.exe' /r:System.Web.Extensions.dll /r:System.Core.dll /r:System.Management.dll /r:System.IO.Compression.FileSystem.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll @src
  if (\$LASTEXITCODE -ne 0) { exit 1 }
  & '$dest_win\\$name.exe' '$dest_win\\fixture' '$dest_win\\package'
  exit \$LASTEXITCODE
}"
```

- [x] **Step 2: 현재 코드로 기존 마법사 테스트를 실행해 기준선을 잡는다**

```bash
chmod +x scripts/test-installer-windows.sh
bash scripts/build-release-wsl.sh
bash scripts/test-installer-windows.sh SetupFlowTests
```

Expected: 기존 `SetupFlowTests`의 PASS 줄들과 종료 코드 0. 실패하면 이 기준선 결과를 ledger에 그대로 기록하고, 다음 과제에서 바뀌는 실패와 구분한다.

- [x] **Step 3: testing.md에 한 절을 추가하고 커밋한다**

`docs/testing.md`의 "Windows PowerShell 5.1 배포 진입점 회귀" 절 위에 넣는다.

```markdown
## 설치 마법사 C# 회귀 (개발 PC)

`bash scripts/build-release-wsl.sh`로 현재 브랜치의 ZIP을 만든 뒤 `bash scripts/test-installer-windows.sh SetupFlowTests`를 실행한다. `%LOCALAPPDATA%\AgentBrowser-dev\installer-tests`만 사용하며, 운영 설치·Chrome 프로필은 읽거나 바꾸지 않는다. 다른 클래스(`SetupDisplayTests`, `ManagedPathTests`)도 같은 방식으로 실행한다.
```

```bash
git add scripts/test-installer-windows.sh docs/testing.md
git commit -m "test: add a development runner for installer C# regressions on Windows"
```

### Task 7: 설치기 오류를 한국어와 다음 행동으로

**Files:**
- Modify: `installer/SetupForm.cs` (새 `Friendly` 클래스, 모든 `status.Text=error.Message` 계열)
- Test: `tests/install/SetupFlowTests.cs` (Case 추가)

**Interfaces:**
- Produces: `internal static class Friendly { public static string Message(Exception error) }`. 알려진 영어 원문은 한국어 안내와 `(원문: …)`로 바꾸고, 그 밖의 원문은 그대로 둔다.

- [x] **Step 1: 실패하는 Case를 쓴다**

`SetupFlowTests.Main`의 첫 `Case` 앞에 추가한다.

```csharp
   Case("installer errors are shown in Korean with the next action",()=>{
    var text=Friendly.Message(new IOException("Installation ownership marker is invalid."));
    Assert(text.Contains("설치 기록")&&text.Contains("다른 폴더"),text);
    Assert(text.Contains("원문: Installation ownership marker is invalid."),text);
    Assert(Friendly.Message(new IOException("Package checksum mismatch: browser-bridge.exe")).Contains("다시 받아"),"checksum");
    Assert(Friendly.Message(new IOException("Pair the Chrome extension first")).Contains("Chrome 연결"),"pairing");
    Assert(Friendly.Message(new IOException("이미 한국어인 안내"))=="이미 한국어인 안내","Korean text must stay as is");
   });
```

Run: `bash scripts/build-release-wsl.sh && bash scripts/test-installer-windows.sh SetupFlowTests`
Expected: 컴파일 오류(`Friendly` 없음)로 FAIL

- [x] **Step 2: 구현한다**

`SetupForm.cs`의 `internal static class Program` 위에 추가한다.

```csharp
    /// User-facing installer errors: Korean, with the next action. The original stays for diagnosis.
    internal static class Friendly {
        static readonly KeyValuePair<string,string>[] Known={
            new KeyValuePair<string,string>("Choose an absolute dedicated installation folder","설치 폴더는 전체 경로로 지정하세요. 예: C:\\Users\\<사용자>\\AppData\\Local\\AgentBrowser"),
            new KeyValuePair<string,string>("A drive root cannot be an installation folder","드라이브 최상위(C:\\ 등)에는 설치할 수 없습니다. 전용 하위 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Choose a dedicated subfolder","사용자 폴더 자체가 아닌 AgentBrowser 전용 하위 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Bridge installation must be on a Windows local disk","네트워크 경로에는 설치할 수 없습니다. 로컬 드라이브의 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Bridge installation requires a writable Windows local disk","네트워크 드라이브에는 설치할 수 없습니다. 로컬 드라이브의 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Installation ownership marker is invalid","선택한 폴더의 설치 기록이 손상됐거나 다른 프로그램의 것입니다. 다른 폴더를 선택하거나 diagnose.cmd 결과를 확인하세요."),
            new KeyValuePair<string,string>("An installed file was modified","설치된 파일이 수정되어 그대로 보존했습니다. 파일을 원래대로 되돌리거나 새 폴더에 설치하세요."),
            new KeyValuePair<string,string>("No owned installation was found","이 폴더에서 AgentBrowser 설치를 찾지 못했습니다. [설치]를 선택하거나 기존 설치 폴더를 고르세요."),
            new KeyValuePair<string,string>("Extract the package outside the destination","압축은 설치 폴더가 아닌 다른 폴더에 풀어 주세요."),
            new KeyValuePair<string,string>("An unowned file blocks installation","설치 폴더에 AgentBrowser가 만들지 않은 파일이 있습니다. 빈 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Existing unowned data will not be changed","data 폴더에 다른 데이터가 있어 바꾸지 않았습니다. 빈 폴더를 선택하세요."),
            new KeyValuePair<string,string>("Package checksum mismatch","설치 파일이 손상됐습니다. 공식 릴리스에서 ZIP을 다시 받아 압축을 풀고 실행하세요."),
            new KeyValuePair<string,string>("Extract the complete GUI package","ZIP 전체를 압축 해제한 뒤 그 폴더의 AgentBrowser-Setup.exe를 실행하세요."),
            new KeyValuePair<string,string>("Installation changed after preview","미리보기 이후 설치 상태가 바뀌었습니다. [뒤로]를 눌러 다시 미리보기하세요."),
            new KeyValuePair<string,string>("A file changed after preview","미리보기 이후 파일이 바뀌었습니다. [뒤로]를 눌러 다시 미리보기하세요."),
            new KeyValuePair<string,string>("Settings changed during preview","미리보기 중 OpenCode 설정이 바뀌었습니다. [뒤로]를 눌러 다시 미리보기하세요."),
            new KeyValuePair<string,string>("Port must be between 1 and 65535","포트는 1~65535 사이로 입력하세요."),
            new KeyValuePair<string,string>("Pair the Chrome extension first","먼저 Chrome 연결 단계를 완료하세요."),
            new KeyValuePair<string,string>("No authenticated Bridge","Bridge가 실행 중이 아닙니다. [뒤로] 후 다시 [다음]을 누르면 Bridge를 시작합니다."),
            new KeyValuePair<string,string>("Another operation is already managing this profile","같은 실행 환경을 다른 작업이 처리 중입니다. 잠시 후 다시 시도하세요."),
        };
        public static string Message(Exception error) {
            string text=error.Message??"";
            foreach(var item in Known) if(text.IndexOf(item.Key,StringComparison.OrdinalIgnoreCase)>=0) return item.Value+"\r\n(원문: "+text+")";
            return text;
        }
    }
```

`SetupForm.cs` 안의 사용자 표시 지점을 바꾼다: `status.Text=error.Message` → `status.Text=Friendly.Message(error)`, `status.Text=error.Message+"\r\n[뒤로]..."` → `status.Text=Friendly.Message(error)+"\r\n[뒤로]..."`. 대상은 `grep -n "error.Message" installer/SetupForm.cs`로 찾은 모든 곳이다. `Program.Main`의 `MessageBox.Show(error.Message, ...)`도 `Friendly.Message(error)`로 바꾼다.

- [x] **Step 3: 통과를 확인한다**

Run: `bash scripts/build-release-wsl.sh && bash scripts/test-installer-windows.sh SetupFlowTests`
Expected: 새 Case PASS, 기존 Case 기준선과 같음

- [x] **Step 4: 커밋한다**

```bash
git add installer/SetupForm.cs tests/install/SetupFlowTests.cs
git commit -m "feat(installer): show Korean errors with the next action"
```

### Task 8: 마법사의 Chrome 확장 감지와 [Chrome에 연결]

**Files:**
- Modify: `installer/SetupForm.cs:13-20`(필드), `:67-78`(연결·페어링 패널), `:89-90`(다음 버튼 흐름), `:120-129`(SetPage), `:155-160`(PreparePairing)
- Test: `tests/install/SetupFlowTests.cs`

**Interfaces:**
- Consumes: Task 2의 CLI `status --json`, `pair --open --extension-id … --seconds …`
- Produces:
  - `internal static class Pairing`(`SetupForm.cs`):
    - `string ExtensionId(string manifestPath)`
    - `bool Connected(Dictionary<string,object> status,string extensionId)`
    - `bool Seen(Dictionary<string,object> status,string extensionId)`
  - 컨트롤:
    - `OpenExtensions`: Chrome 확장 페이지 열기
    - `ExtensionDetected`: 감지 상태 표시
    - `ConnectChrome`: [Chrome에 연결]
    - `PairingState`: 연결 진행 상태 표시

- [x] **Step 1: 실패하는 Case를 쓴다**

```csharp
   Case("pairing helpers identify the fixed extension and a connected browser",()=>{
    string manifest=Path.Combine(package,"extension","manifest.json");
    Assert(Pairing.ExtensionId(manifest)=="icgmjjcpnaenpfjfoggnaodeaidbnihl","extension id");
    var connected=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"pairedExtensionId\":\"icgmjjcpnaenpfjfoggnaodeaidbnihl\",\"extensionSeen\":null,\"browsers\":[{\"clientId\":\"cli-1\",\"connected\":true,\"selected\":true}]}");
    Assert(Pairing.Connected(connected,"icgmjjcpnaenpfjfoggnaodeaidbnihl"),"connected browser");
    var seen=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"pairedExtensionId\":null,\"extensionSeen\":\"icgmjjcpnaenpfjfoggnaodeaidbnihl\",\"browsers\":[]}");
    Assert(!Pairing.Connected(seen,"icgmjjcpnaenpfjfoggnaodeaidbnihl")&&Pairing.Seen(seen,"icgmjjcpnaenpfjfoggnaodeaidbnihl"),"seen but unpaired");
   });
   Case("the pairing page offers a one-click Chrome connection with a manual fallback",()=>{
    string root=Path.Combine(fixture,"pairing-page");
    try{using(var form=new SetupForm(new[]{"--no-discover","--no-startup","--install-dir",root,"--package-dir",package,"--port",FreePort()})){
     form.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Field<Button>(form,"Preview").PerformClick();Invoke(form,"Prepare");Invoke(form,"Apply");
     Assert(Field<Button>(form,"OpenExtensions").Visible,"no way to open the Chrome extensions page");
     Invoke(form,"PreparePairing");
     Assert(Field<Button>(form,"ConnectChrome").Visible&&Field<Button>(form,"CopyPairingToken").Visible,"pairing page lacks automatic or manual connection");
     form.Close();
    }}finally{Uninstall(root);}
   });
```

`SetupFlowTests`에 `FreePort` 도우미가 없으면 클래스에 추가한다.

```csharp
  static string FreePort(){var listener=new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback,0);listener.Start();string port=((System.Net.IPEndPoint)listener.LocalEndpoint).Port.ToString();listener.Stop();return port;}
```

Run: `bash scripts/build-release-wsl.sh && bash scripts/test-installer-windows.sh SetupFlowTests`
Expected: 컴파일 오류(`Pairing` 없음)로 FAIL

- [x] **Step 2: 도우미를 구현한다**

`Friendly` 위에 추가한다.

```csharp
    internal static class Pairing {
        /// Chrome derives an extension id from the manifest key: SHA-256 of the DER key, first 16 bytes, hex digits mapped to a-p.
        public static string ExtensionId(string manifestPath) {
            var manifest=NativeIO.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(manifestPath,NativeIO.Utf8));
            byte[] hash;using(var sha=System.Security.Cryptography.SHA256.Create())hash=sha.ComputeHash(Convert.FromBase64String((string)manifest["key"]));
            var id=new System.Text.StringBuilder();
            for(int i=0;i<16;i++){id.Append((char)('a'+(hash[i]>>4)));id.Append((char)('a'+(hash[i]&15)));}
            return id.ToString();
        }
        static IEnumerable<Dictionary<string,object>> Browsers(Dictionary<string,object> status){object value;return status.TryGetValue("browsers",out value)&&value is System.Collections.IEnumerable?((System.Collections.IEnumerable)value).OfType<Dictionary<string,object>>():Enumerable.Empty<Dictionary<string,object>>();}
        public static bool Connected(Dictionary<string,object> status,string extensionId){object paired;return status.TryGetValue("pairedExtensionId",out paired)&&paired as string==extensionId&&Browsers(status).Any(b=>b.ContainsKey("connected")&&b["connected"] is bool&&(bool)b["connected"]);}
        public static bool Seen(Dictionary<string,object> status,string extensionId){object seen;return Connected(status,extensionId)||(status.TryGetValue("extensionSeen",out seen)&&seen as string==extensionId);}
        public static Dictionary<string,object> Status(InstallState state){return NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"status","--json"}));}
    }
```

- [x] **Step 3: 확장 추가 화면에 열기 버튼과 감지 표시를 넣는다**

필드 선언에 `openExtensions`, `connectChrome` Button과 `extensionDetected`, `pairingState` Label, `System.Windows.Forms.Timer detect`를 추가한다. connection 패널의 "Chrome에 확장을 추가한 뒤 [다음]을 누르세요." 줄을 아래로 바꾼다.

```csharp
            openExtensions.Text="Chrome 확장 페이지 열기";Position(connection,openExtensions,"OpenExtensions",176,184,220,34);openExtensions.Click+=delegate{OpenChromeExtensions();};
            extensionDetected.ForeColor=Muted;extensionDetected.Text="확장을 추가하면 여기에서 자동으로 확인합니다.";Position(connection,extensionDetected,"ExtensionDetected",0,240,656,42);
```

`SetupForm` 안에 메서드를 추가한다.

```csharp
        void OpenChromeExtensions(){
            try{
                var chrome=Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe","",null) as string
                    ??Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe","",null) as string;
                if(String.IsNullOrEmpty(chrome)||!File.Exists(chrome))throw new IOException("Chrome을 찾지 못했습니다.");
                Process.Start(new ProcessStartInfo(chrome,"chrome://extensions"){UseShellExecute=false});
                Clipboard.SetText(extensionFolder.Text);
                status.Text="Chrome 확장 페이지를 열고 폴더 경로를 복사했습니다. [압축해제된 확장 프로그램 로드]에서 Alt+D 후 붙여 넣으세요.";
            }catch(Exception error){Clipboard.SetText(extensionFolder.Text);status.Text="Chrome을 직접 열고 주소창에 chrome://extensions 를 입력하세요. 폴더 경로는 복사했습니다.\r\n("+error.Message+")";}
        }
        async Task DetectExtension(){
            if(page!=4||detecting)return;detecting=true;
            try{
                var state=Installed();string id=Pairing.ExtensionId(Path.Combine(state.InstallDir,"extension","manifest.json"));
                await Task.Run(()=>BridgeControl.Start(state));
                var current=await Task.Run(()=>Pairing.Status(state));
                if(page==4&&Pairing.Seen(current,id))extensionDetected.Text="✓ Chrome에 AgentBrowser 확장이 추가되었습니다. [다음]을 누르세요.";
            }catch(Exception){/* Detection is a hint only; the next step reports real errors. */}
            finally{detecting=false;}
        }
```

필드에 `bool detecting;`을 추가한다. 생성자 끝(`LoadState();SetPage(0);` 앞)에 타이머를 설정한다.

```csharp
            detect.Interval=1500;detect.Tick+=async delegate{await DetectExtension();};
```

`SetPage` 끝에 추가한다.

```csharp
            detect.Enabled=page==4;
```

- [x] **Step 4: 페어링 화면을 [Chrome에 연결] 중심으로 바꾼다**

pairing 패널의 첫 안내와 배치를 아래로 바꾼다. 기존 주소·토큰·복사 컨트롤은 "직접 입력" 아래로 내린다.

```csharp
            LabelAt(pairing,"[Chrome에 연결]을 누르면 추가한 확장과 자동으로 연결합니다.",0,0,656,30);
            connectChrome.Text="Chrome에 연결";Position(pairing,connectChrome,"ConnectChrome",0,36,220,38);StyleButton(connectChrome,true);connectChrome.Click+=async delegate{await ConnectChrome();};
            pairingState.ForeColor=Muted;Position(pairing,pairingState,"PairingState",0,84,656,48);
            LabelAt(pairing,"직접 입력할 때: 확장의 [확장 프로그램 옵션]에 아래 주소와 토큰을 넣고 [저장 후 연결]",0,140,656,28).ForeColor=Muted;
            pairingUrl.ReadOnly=true;Position(pairing,pairingUrl,"PairingUrl",0,172,656);
            pairingToken.ReadOnly=true;pairingToken.UseSystemPasswordChar=true;Position(pairing,pairingToken,"PairingToken",0,212,480);
            var copyToken=new Button{Text="토큰 복사"};Position(pairing,copyToken,"CopyPairingToken",496,210,160,32);copyToken.Click+=delegate{Clipboard.SetText(pairingToken.Text);status.Text="토큰을 복사했습니다. Chrome 확장 옵션에 붙여 넣으세요.";};
```

기존 pairing 패널의 `LabelAt`·`Position` 줄(74–78행)은 위 블록으로 대체한다. 메서드를 추가한다.

```csharp
        async Task ConnectChrome(){
            if(working)return;working=true;connectChrome.Enabled=false;
            try{
                var state=Installed();string id=Pairing.ExtensionId(Path.Combine(state.InstallDir,"extension","manifest.json"));
                await Task.Run(()=>BridgeControl.Start(state));
                await Task.Run(()=>BridgeControl.Invoke(state,new[]{"pair","--open","--extension-id",id,"--seconds","120"}));
                pairingState.Text="Chrome의 AgentBrowser가 연결되기를 기다리고 있습니다… (최대 2분)";
                for(int i=0;i<120&&!IsDisposed;i++){
                    var current=await Task.Run(()=>Pairing.Status(state));
                    if(Pairing.Connected(current,id)){pairingState.Text="✓ Chrome과 연결되었습니다.";SetPage(6);status.Clear();await EnterRuntimePage();return;}
                    await Task.Delay(1000);
                }
                pairingState.Text="연결을 확인하지 못했습니다. Chrome에서 확장이 켜져 있는지 확인하고 다시 누르거나, 아래 토큰을 직접 입력하세요.";
            }catch(Exception error){pairingState.Text=Friendly.Message(error);}
            finally{working=false;if(!IsDisposed)connectChrome.Enabled=true;}
        }
```

`EnterRuntimePage`는 Task 9에서 만든다. 이 과제에서는 `async Task EnterRuntimePage(){await Task.CompletedTask;}`로 빈 구현을 먼저 두고, Task 9에서 채운다(테스트가 이 메서드 존재에 의존하지 않는다).

페어링 화면의 [다음]은 지금처럼 Task 9의 실행 환경 페이지로 간다. 기존 `prepare.Click`에서 `page==5`일 때 `SetPage(6);status.Clear();` 뒤에 `await EnterRuntimePage();`를 추가한다.

- [x] **Step 5: 통과를 확인한다**

Run: `bash scripts/build-release-wsl.sh && bash scripts/test-installer-windows.sh SetupFlowTests`
Expected: 새 Case 두 개 PASS. 기존 "Chrome pairing and runtime setup occupy separate sequential pages" Case는 `ManagedProfiles` 버튼을 확인하므로, Task 9에서 그 기대를 바꾼다. 이 과제 시점에는 그대로 통과해야 한다.

- [x] **Step 6: 커밋한다**

```bash
git add installer/SetupForm.cs tests/install/SetupFlowTests.cs
git commit -m "feat(installer): detect the loaded extension and connect Chrome with one click"
```

### Task 9: 실행 환경 단계를 본 화면에서 저장·시작·확인

**Files:**
- Modify: `installer/SetupForm.cs:17`(`profiles` 버튼 제거), `:79-82`(runtime 패널), 관련 `profiles.Enabled` 참조, 새 메서드
- Modify: `installer/ProfileForm.cs` (`ProfileForm` Form 클래스 제거, `ManagedProfile`에 `Save(…, makeDefault)`·`Start` 추가)
- Test: `tests/install/SetupFlowTests.cs` (Case 추가, 기존 Case 수정), `tests/install/GuiSmokeTests.cs`(`--profiles` 흐름 수정)

**Interfaces:**
- Consumes:
  - Bridge CLI: `profile list --json`, `profile save --file … --create-only --default`, `runtime start --profile <id>`
  - Task 7의 `Friendly`, Task 8의 `EnterRuntimePage` 자리
- Produces:
  - 컨트롤:
    - `RuntimeKind`(Windows/WSL), `RuntimeDistribution`, `StartDistribution`(배포판 켜고 찾기)
    - `RuntimeCandidates`, `RuntimeExecutable`, `RuntimeDirectory`, `BrowseRuntimeDirectory`
    - `SaveRuntime`(저장하고 연결 확인), `RuntimeResult`, `SavedProfiles`
  - `ManagedProfile.Save(InstallState state, Dictionary<string,object> profile, bool makeDefault=false)`
  - `ManagedProfile.Start(InstallState state, string id) -> string`: 사용자 표시용 결과 문장
  - 테스트용 인수 `--no-runtime-start`: 저장 뒤 시작을 건너뛴다. 실제 OpenCode 없이 화면 흐름을 시험하기 위한 것이다.

- [x] **Step 1: 실패하는 Case를 쓴다**

```csharp
   Case("saved runtime appears in the Bridge profile list and on the page",()=>{
    string root=Path.Combine(fixture,"inline-runtime"),fake=Path.Combine(fixture,"fake-opencode");Directory.CreateDirectory(fake);
    string cmd=Path.Combine(fake,"opencode.cmd");File.WriteAllText(cmd,"@echo off\r\necho 1.18.29\r\n");
    try{using(var form=new SetupForm(new[]{"--no-discover","--no-startup","--no-runtime-start","--install-dir",root,"--package-dir",package,"--port",FreePort()})){
     form.Show();SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());Field<Button>(form,"Preview").PerformClick();Invoke(form,"Prepare");Invoke(form,"Apply");
     Invoke(form,"PreparePairing");Field<Button>(form,"Preview").PerformClick();
     Assert(Field<Panel>(form,"RuntimePanel").Visible,"runtime page missing");
     Assert(!form.Controls.Find("ManagedProfiles",true).Any(),"the separate profile dialog must be gone");
     Field<ComboBox>(form,"RuntimeKind").SelectedIndex=0;Field<TextBox>(form,"RuntimeExecutable").Text=cmd;Field<TextBox>(form,"RuntimeDirectory").Text=fixture;
     Invoke(form,"SaveRuntime");
     var state=InstallerEngine.State(root);
     var listed=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"profile","list","--json"}));
     var profiles=((System.Collections.IEnumerable)listed["profiles"]).OfType<System.Collections.Generic.Dictionary<string,object>>().ToList();
     Assert(profiles.Count==1&&(string)profiles[0]["executable"]==cmd,"the Bridge does not report the saved profile");
     Assert((string)listed["defaultProfileId"]==(string)profiles[0]["id"],"the saved profile is not the default");
     Assert(Field<ListBox>(form,"SavedProfiles").Items.Count==1,"the page does not show what the Bridge saved");
     Assert(Field<Label>(form,"RuntimeResult").Text.Contains("저장했습니다"),Field<Label>(form,"RuntimeResult").Text);
     form.Close();
    }}finally{Uninstall(root);}
   });
```

기존 "Chrome pairing and runtime setup occupy separate sequential pages" Case에서 `ManagedProfiles`를 확인하는 세 assertion을 `SaveRuntime`으로 바꾼다.
- 연결·페어링 화면: `Assert(!Field<Button>(form,"SaveRuntime").Visible, ...)`
- 실행 환경 화면: `Field<Button>(form,"SaveRuntime").Visible`
- 완료 화면: `!Field<Button>(form,"SaveRuntime").Visible`

Run: `bash scripts/build-release-wsl.sh && bash scripts/test-installer-windows.sh SetupFlowTests`
Expected: FAIL. `RuntimeKind` 컨트롤이 없다.

- [x] **Step 2: `ManagedProfile`을 보강하고 대화상자 클래스를 지운다**

`ProfileForm.cs`에서 `internal sealed class ProfileForm : Form { … }` 전체를 지운다. `ManagedProfile`은 남기고 `Save`를 바꾼 뒤 `Start`를 추가한다.

```csharp
        public static void Save(InstallState state,Dictionary<string,object> profile,bool makeDefault=false) {
            if(profile==null) throw new IOException("변경 내용을 먼저 확인하세요.");
            var existing=NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new []{"profile","list","--json"}));
            foreach(var item in (System.Collections.IEnumerable)existing["profiles"])if((string)((Dictionary<string,object>)item)["id"]==(string)profile["id"])throw new IOException("프로필이 이미 생겼습니다. 기존 프로필은 변경하지 않았습니다.");
            string path=Path.Combine(state.DataDir,".installer-profile-"+Guid.NewGuid().ToString("N")+".json");
            var args=new List<string>{"profile","save","--file",path,"--create-only"};if(makeDefault)args.Add("--default");
            try{NativeIO.WriteText(path,NativeIO.Json.Serialize(profile),"missing");BridgeControl.Invoke(state,args.ToArray());}
            finally{if(File.Exists(path))File.Delete(path);}
        }
        /// Starts the managed runtime once and reports the result in words a user can act on.
        public static string Start(InstallState state,string id) {
            string output;
            try{output=BridgeControl.Invoke(state,new []{"runtime","start","--profile",id},90000);}
            catch(IOException error){return "저장했지만 OpenCode를 시작하지 못했습니다. 실행 파일·작업 폴더를 확인한 뒤 [저장하고 연결 확인]을 다시 누르거나, Chrome 설정의 [시작·연결 확인]으로 재시도하세요.\r\n("+error.Message+")";}
            var result=NativeIO.Json.Deserialize<Dictionary<string,object>>(output);
            object stateValue,version;result.TryGetValue("state",out stateValue);result.TryGetValue("version",out version);
            return stateValue as string=="ready"?"✓ 저장했습니다. OpenCode "+(version as string)+"가 시작됐고 브라우저 도구 연결을 확인했습니다.":"저장했지만 OpenCode가 아직 준비되지 않았습니다: "+(stateValue as string);
        }
```

- [x] **Step 3: 실행 환경 화면을 본 화면 안에 만든다**

필드 선언에서 `profiles` Button을 지우고 아래를 추가한다.

```csharp
        readonly ComboBox runtimeKind=new ComboBox(),runtimeDistribution=new ComboBox(),runtimeCandidates=new ComboBox();
        readonly TextBox runtimeExecutable=new TextBox(),runtimeDirectory=new TextBox();
        readonly Button startDistribution=new Button(),browseRuntimeDirectory=new Button(),saveRuntime=new Button();
        readonly Label runtimeResult=new Label();readonly ListBox savedProfiles=new ListBox();
        bool runtimeDiscovered;
```

runtime 패널의 기존 4줄(79–82행)을 아래로 바꾼다.

```csharp
            LabelAt(runtime,"사용할 OpenCode를 확인하고 [저장하고 연결 확인]을 누르세요.",0,0,656,28);
            LabelAt(runtime,"실행 방식",0,40);Position(runtime,runtimeKind,"RuntimeKind",150,36,160);runtimeKind.DropDownStyle=ComboBoxStyle.DropDownList;runtimeKind.Items.AddRange(new object[]{"Windows","WSL"});runtimeKind.SelectedIndex=0;
            LabelAt(runtime,"WSL 배포판",330,40,110);Position(runtime,runtimeDistribution,"RuntimeDistribution",440,36,216);runtimeDistribution.DropDownStyle=ComboBoxStyle.DropDown;
            startDistribution.Text="배포판 켜고 찾기";Position(runtime,startDistribution,"StartDistribution",440,72,216,30);startDistribution.Click+=async delegate{await DiscoverRuntime(runtimeDistribution.Text.Trim());};
            LabelAt(runtime,"찾은 OpenCode",0,112);Position(runtime,runtimeCandidates,"RuntimeCandidates",150,108,506);runtimeCandidates.DropDownStyle=ComboBoxStyle.DropDownList;runtimeCandidates.SelectedIndexChanged+=delegate{UseRuntimeCandidate();};
            LabelAt(runtime,"실행 파일",0,148);Position(runtime,runtimeExecutable,"RuntimeExecutable",150,144,506);
            LabelAt(runtime,"작업 폴더",0,184);Position(runtime,runtimeDirectory,"RuntimeDirectory",150,180,390);
            browseRuntimeDirectory.Text="폴더 선택";Position(runtime,browseRuntimeDirectory,"BrowseRuntimeDirectory",548,178,108,32);browseRuntimeDirectory.Click+=delegate{if(runtimeKind.SelectedIndex==1){status.Text="WSL 작업 폴더는 /home/<사용자>/project 같은 Linux 경로로 입력하세요.";return;}using(var dialog=new FolderBrowserDialog{Description="OpenCode 작업 폴더",SelectedPath=runtimeDirectory.Text})if(dialog.ShowDialog(this)==DialogResult.OK)runtimeDirectory.Text=dialog.SelectedPath;};
            saveRuntime.Text="저장하고 연결 확인";Position(runtime,saveRuntime,"SaveRuntime",0,222,220,36);StyleButton(saveRuntime,true);saveRuntime.Click+=async delegate{await SaveRuntime();};
            runtimeResult.ForeColor=Muted;Position(runtime,runtimeResult,"RuntimeResult",230,222,426,52);
            LabelAt(runtime,"저장된 실행 환경 (Chrome 설정에도 같은 목록이 보입니다)",0,280,656,24).ForeColor=Muted;
            Position(runtime,savedProfiles,"SavedProfiles",0,304,656,64);
```

runtime 패널 높이가 늘었으므로, 패널 생성 루프의 높이 308을 실행 환경 패널에 한해 372로 키운다.

```csharp
            for(int i=0;i<panels.Length;i++)Position(this,panels[i],names[i],32,132,656,panels[i]==runtime?372:308);
```

본문 스크롤 영역의 `AutoScrollMinSize=new Size(720,348)`을 `new Size(720,412)`로 바꾼다.

- [x] **Step 4: 탐색·저장·목록 메서드를 구현한다**

Task 8에서 둔 빈 `EnterRuntimePage`를 아래 구현으로 바꾸고, 나머지 메서드를 추가한다.

```csharp
        async Task EnterRuntimePage(){
            await RefreshSavedProfiles();
            if(!runtimeDiscovered&&!Has(args,"--no-discover")){runtimeDiscovered=true;await DiscoverRuntime(null);}
        }
        async Task RefreshSavedProfiles(){
            try{
                var state=Installed();
                var listed=await Task.Run(()=>NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"profile","list","--json"})));
                savedProfiles.Items.Clear();object def;listed.TryGetValue("defaultProfileId",out def);
                foreach(var item in ((System.Collections.IEnumerable)listed["profiles"]).OfType<Dictionary<string,object>>())
                    savedProfiles.Items.Add((item["id"] as string==def as string?"★ ":"")+item["name"]+" · "+item["kind"]+" · "+item["directory"]);
                if(savedProfiles.Items.Count==0)savedProfiles.Items.Add("아직 없습니다");
            }catch(Exception error){runtimeResult.Text=Friendly.Message(error);}
        }
        async Task DiscoverRuntime(string distribution){
            startDistribution.Enabled=false;runtimeResult.Text="OpenCode 위치를 확인하고 있습니다…";
            try{
                var found=await Task.Run(()=>{
                    if(String.IsNullOrEmpty(distribution))return Discovery.Find();
                    var single=new DiscoveryResult();single.Distributions.Add(distribution);single.OpenCode.AddRange(Discovery.FindWsl(distribution,null));return single;
                });
                foreach(var d in found.Distributions)if(!runtimeDistribution.Items.Contains(d))runtimeDistribution.Items.Add(d);
                runtimeCandidates.Items.Clear();foreach(var c in found.OpenCode)runtimeCandidates.Items.Add(c);
                if(runtimeCandidates.Items.Count>0)runtimeCandidates.SelectedIndex=0;
                runtimeResult.Text=runtimeCandidates.Items.Count>0?"OpenCode "+runtimeCandidates.Items.Count+"개를 찾았습니다. 확인 후 [저장하고 연결 확인]을 누르세요.":"OpenCode를 찾지 못했습니다. 실행 파일 경로를 직접 입력하세요."+(found.Notices.Count>0?"\r\n"+String.Join("\r\n",found.Notices):"");
            }catch(Exception error){runtimeResult.Text=Friendly.Message(error);}
            finally{startDistribution.Enabled=true;}
        }
        void UseRuntimeCandidate(){
            var c=runtimeCandidates.SelectedItem as OpenCodeCandidate;if(c==null)return;
            runtimeKind.SelectedIndex=c.Kind=="wsl"?1:0;runtimeDistribution.Text=c.Distribution??"";runtimeExecutable.Text=c.Executable;if(String.IsNullOrWhiteSpace(runtimeDirectory.Text))runtimeDirectory.Text=c.Home;
        }
        async Task SaveRuntime(){
            if(working)return;working=true;saveRuntime.Enabled=false;runtimeResult.Text="실행 환경을 확인하고 있습니다…";
            try{
                var state=Installed();var chosen=runtimeCandidates.SelectedItem as OpenCodeCandidate;
                var candidate=new OpenCodeCandidate{Kind=runtimeKind.SelectedIndex==1?"wsl":"windows",Distribution=runtimeDistribution.Text.Trim(),Executable=runtimeExecutable.Text.Trim(),
                    User=chosen!=null&&chosen.Kind=="wsl"&&chosen.Executable==runtimeExecutable.Text.Trim()?chosen.User:null};
                string id="managed-"+Guid.NewGuid().ToString("N").Substring(0,8),name=candidate.Kind=="wsl"?"OpenCode ("+candidate.Distribution+")":"OpenCode (Windows)",directory=runtimeDirectory.Text.Trim();
                var profile=await Task.Run(()=>ManagedProfile.Prepare(state,candidate,id,name,directory));
                await Task.Run(()=>ManagedProfile.Save(state,profile,makeDefault:true));
                await RefreshSavedProfiles();
                if(Has(args,"--no-runtime-start")){runtimeResult.Text="✓ 저장했습니다. (시작 확인 생략)";return;}
                runtimeResult.Text="저장했습니다. OpenCode를 시작해 브라우저 연결을 확인하고 있습니다… (최대 1분)";
                runtimeResult.Text=await Task.Run(()=>ManagedProfile.Start(state,id));
            }catch(Exception error){runtimeResult.Text=Friendly.Message(error);}
            finally{working=false;saveRuntime.Enabled=true;}
        }
```

`SaveRuntime`은 `return` 경로에서도 `finally`를 거치므로 버튼이 다시 활성화된다.

- [x] **Step 5: 남은 `profiles` 참조를 정리한다**

Run: `grep -n "profiles\.\|ProfileForm\|ManagedProfiles" installer/*.cs`

- `manage.Enabled=…&&profiles.Enabled` 계열은 `profiles.Enabled` 조건을 빼고 `InstallerEngine.State(folder.Text)!=null` 판단으로 바꾼다. `LoadState`에서 `profiles.Enabled=true`를 설정하던 줄은 지운다.
- `ShowConnection`의 `profiles.Enabled=true;`는 지운다.
- `Apply`의 `manage.Enabled=profiles.Enabled=false;`는 `manage.Enabled=false;`로 바꾼다.
- `folder.TextChanged`의 `manage.Enabled=profiles.Enabled=false;`는 `manage.Enabled=false;`로 바꾼다.

`scripts/build-release.ps1:53`과 `.github/workflows/ci.yml`의 소스 목록에 있는 `ProfileForm.cs`는 파일이 남아 있으므로 바꾸지 않는다.

`tests/install/GuiSmokeTests.cs`의 `--profiles` 흐름(98–116행)을 새 화면에 맞게 바꾼다. 대화상자를 찾는 대신 본 화면에서 아래 순서로 진행한다.
1. `RuntimeKind`에서 WSL을 고른다.
2. `RuntimeDistribution`, `RuntimeExecutable`, `RuntimeDirectory`를 입력한다.
3. `SaveRuntime`을 클릭한다.
4. `RuntimeResult`에 "저장했습니다"가 나올 때까지 기다린다.
5. 설치 폴더의 Bridge로 `profile list --json`을 실행해 `gui-profile-test` 대신 실행 파일 경로가 있는지 확인한다(ID는 이제 자동 생성).

`--async-profile`의 대화상자 전용 검사(입력 변경 중 저장 차단, 대화상자 닫기)는 새 흐름에 대상이 없으므로 지운다. 대신 `SaveRuntime`을 두 번 빠르게 눌러도 프로필이 하나만 생기는지 확인한다. `working` 플래그가 막는다.

- [x] **Step 6: 통과를 확인한다**

Run: `bash scripts/build-release-wsl.sh && bash scripts/test-installer-windows.sh SetupFlowTests`
Expected: 새 Case PASS, 수정한 기존 Case PASS, 나머지는 기준선과 같음

- [x] **Step 7: 커밋한다**

```bash
git add installer tests/install
git commit -m "feat(installer): save, start and verify the runtime profile on the wizard page itself"
```

### Task 10: WSL OpenCode 탐색 보강

**Files:**
- Modify: `installer/Discovery.cs:104-118` (`probe`를 verbatim 상수 `WslProbe`로 분리, 후보 경로·로그인 셸 추가)
- Create: `tests/install/wsl-probe.test.mjs`
- Modify: `docs/testing.md` (node --test 목록), `.github/workflows/ci.yml` (같은 목록이 있으면)

**Interfaces:**
- Produces:
  - `internal const string WslProbe`(`Discovery` 클래스, C# verbatim 문자열)
  - 출력 형식 `USER\t…`, `HOME\t…`, `EXE\t…`, `CFG\t…`는 그대로다.
  - 추가 후보:
    - `~/.bun/bin/opencode`, `~/.npm-global/bin/opencode`, `/usr/local/bin/opencode`
    - `~/.nvm/versions/node/*/bin/opencode`
    - 로그인 셸 `bash -lc 'command -v opencode'`

- [x] **Step 1: 실패하는 테스트를 쓴다**

`tests/install/wsl-probe.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const source = readFileSync(new URL("../../installer/Discovery.cs", import.meta.url), "utf8");
const match = /internal const string WslProbe=@"([\s\S]*?)";/.exec(source);

test("the WSL probe finds OpenCode installed through nvm or bun without a login PATH", () => {
  assert.ok(match, "WslProbe must be a verbatim constant so it can be tested");
  const probe = match[1].replaceAll('""', '"');
  const home = mkdtempSync(join(tmpdir(), "ab-probe-"));
  for (const dir of [".nvm/versions/node/v22.0.0/bin", ".bun/bin"]) {
    mkdirSync(join(home, dir), { recursive: true });
    const exe = join(home, dir, "opencode"); writeFileSync(exe, "#!/bin/sh\necho 1.18.29\n"); chmodSync(exe, 0o755);
  }
  const output = execFileSync("/bin/sh", ["-c", probe], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.match(output, new RegExp(`EXE\\t${home}/\\.nvm/versions/node/v22\\.0\\.0/bin/opencode`));
  assert.match(output, new RegExp(`EXE\\t${home}/\\.bun/bin/opencode`));
  assert.match(output, /^USER\t/m);
});
```

Run: `node --test tests/install/wsl-probe.test.mjs`
Expected: FAIL ("WslProbe must be a verbatim constant")

- [x] **Step 2: 구현한다**

`Discovery` 클래스 안에 상수를 추가하고, `FindWsl`의 `const string probe=...` 줄을 지운 뒤 `probe` 대신 `WslProbe`를 쓴다. C# verbatim 문자열에서 큰따옴표는 `""`로 쓰고, 줄바꿈은 그대로다. 줄 끝은 LF여야 한다. 저장소의 `.gitattributes`·편집기 설정을 확인하고, CRLF가 섞이면 `.Replace("\r\n","\n")`로 정규화한다.

```csharp
        // Runs in the selected distribution without a login shell, so also check common user-level
        // install locations and ask a login shell, where nvm/bun usually extend PATH.
        internal const string WslProbe=@"set -eu
printf 'USER\t%s\n' ""$(id -un)""
printf 'HOME\t%s\n' ""$HOME""
p=$(command -v opencode || true); [ -z ""$p"" ] || printf 'EXE\t%s\n' ""$p""
for p in ""$HOME/.opencode/bin/opencode"" ""$HOME/.local/bin/opencode"" ""$HOME/.bun/bin/opencode"" ""$HOME/.npm-global/bin/opencode"" /usr/local/bin/opencode ""$HOME""/.nvm/versions/node/*/bin/opencode; do [ ! -x ""$p"" ] || printf 'EXE\t%s\n' ""$p""; done
if command -v bash >/dev/null 2>&1; then p=$(bash -lc 'command -v opencode' 2>/dev/null || true); [ -z ""$p"" ] || printf 'EXE\t%s\n' ""$p""; fi
c=${XDG_CONFIG_HOME:-$HOME/.config}/opencode
for p in ""$c/opencode.json"" ""$c/opencode.jsonc""; do [ ! -f ""$p"" ] || printf 'CFG\t%s\n' ""$p""; done
";
```

`FindWsl`의 인수 줄을 바꾼다.

```csharp
            var args=new List<string>{"--distribution",distribution};if(!String.IsNullOrEmpty(user)) args.AddRange(new [] {"--user",user});args.AddRange(new [] {"--exec","/bin/sh","-c",WslProbe.Replace("\r\n","\n")});
```

`executables`는 이미 `HashSet`이라 같은 경로가 여러 번 나와도 하나로 합쳐진다.

`Discovery.Version`은 nvm으로 설치한 `opencode`가 `#!/usr/bin/env node`일 때, PATH에 node가 없으면 실패한다. 실패 문구를 바꿔 원인을 알 수 있게 한다.

```csharp
            if(!System.Text.RegularExpressions.Regex.IsMatch(version,@"^1\.[0-9A-Za-z.+-]+$")) throw new IOException("OpenCode v1 실행파일인지 확인하지 못했습니다. nvm·npm으로 설치한 OpenCode라면 로그인 셸 없이 실행할 수 없을 수 있습니다. ~/.opencode/bin/opencode 같은 독립 실행 파일 경로를 사용하세요.");
```

- [x] **Step 3: 통과를 확인하고 테스트 목록에 넣는다**

Run: `node --test tests/install/wsl-probe.test.mjs`
Expected: PASS

`docs/testing.md:11`의 node --test 줄에 `tests/install/wsl-probe.test.mjs`를 추가한다. `grep -n "node --test" .github/workflows/ci.yml`로 찾은 CI 줄에도 같은 파일을 추가한다.

Run: `bash scripts/build-release-wsl.sh && bash scripts/test-installer-windows.sh SetupFlowTests`
Expected: 기준선과 같음(Discovery 변경으로 인한 컴파일·회귀 없음)

- [x] **Step 4: 커밋한다**

```bash
git add installer/Discovery.cs tests/install/wsl-probe.test.mjs docs/testing.md .github/workflows/ci.yml
git commit -m "feat(installer): find OpenCode installed through nvm, bun or a login shell in WSL"
```

### Task 11: 마지막 화면을 실제 점검 결과로

**Files:**
- Modify: `installer/SetupForm.cs:83-85`(done 패널), `SetPage`, 새 `DoneChecks`
- Test: `tests/install/SetupFlowTests.cs`

**Interfaces:**
- Consumes:
  - Task 2의 `status --json`
  - 기존 `doctor --json`(`Manager::doctor`): `checks:[{id,status,message,profileId?,reason?}]`
- Produces: `internal static class DoneChecks { public static List<string> Lines(Dictionary<string,object> status, Dictionary<string,object> doctor, string extensionId) }`. 컨트롤 `DoneChecks`(ListBox)와 `RunDoneChecks()`.

- [x] **Step 1: 실패하는 Case를 쓴다**

```csharp
   Case("the final page reports real connection checks with next actions",()=>{
    var status=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"pairedExtensionId\":\"icgmjjcpnaenpfjfoggnaodeaidbnihl\",\"browsers\":[{\"clientId\":\"c\",\"connected\":true,\"selected\":true}]}");
    var doctor=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"checks\":[{\"id\":\"opencode\",\"status\":\"warning\",\"message\":\"stopped\",\"profileId\":\"p\"},{\"id\":\"mcp\",\"status\":\"warning\",\"message\":\"MCP was not checked\",\"profileId\":\"p\"}]}");
    var lines=DoneChecks.Lines(status,doctor,"icgmjjcpnaenpfjfoggnaodeaidbnihl");
    Assert(lines.Any(l=>l.StartsWith("✓")&&l.Contains("Chrome")),"chrome check");
    Assert(lines.Any(l=>l.Contains("실행 환경")&&l.Contains("처음 보낼 때")),"stopped runtime explained");
    var none=NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"pairedExtensionId\":null,\"browsers\":[]}");
    Assert(DoneChecks.Lines(none,NativeIO.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>("{\"checks\":[]}"),"icgmjjcpnaenpfjfoggnaodeaidbnihl").Any(l=>l.StartsWith("✗")&&l.Contains("Chrome 연결")),"missing chrome connection");
   });
```

Run: `bash scripts/build-release-wsl.sh && bash scripts/test-installer-windows.sh SetupFlowTests`
Expected: 컴파일 오류(`DoneChecks` 없음)로 FAIL

- [x] **Step 2: 구현한다**

`Pairing` 아래에 추가한다.

```csharp
    internal static class DoneChecks {
        static IEnumerable<Dictionary<string,object>> Checks(Dictionary<string,object> doctor){object value;return doctor.TryGetValue("checks",out value)&&value is System.Collections.IEnumerable?((System.Collections.IEnumerable)value).OfType<Dictionary<string,object>>():Enumerable.Empty<Dictionary<string,object>>();}
        public static List<string> Lines(Dictionary<string,object> status,Dictionary<string,object> doctor,string extensionId){
            var lines=new List<string>{"✓ Bridge가 실행 중입니다."};
            lines.Add(Pairing.Connected(status,extensionId)?"✓ Chrome 확장이 연결되었습니다.":"✗ Chrome 확장이 연결되지 않았습니다. [뒤로]로 Chrome 연결 단계를 다시 진행하세요.");
            var runtimes=Checks(doctor).Where(c=>c["id"] as string=="opencode").ToList();
            if(runtimes.Count==0)lines.Add("✗ 저장된 실행 환경이 없습니다. [뒤로]로 실행 환경을 저장하거나 Chrome 설정에서 추가하세요.");
            foreach(var check in runtimes){
                string state=check["status"] as string;
                lines.Add(state=="ok"?"✓ 실행 환경이 준비되었습니다.":state=="warning"?"• 실행 환경을 저장했습니다. 패널에서 처음 보낼 때 시작합니다.":"✗ 실행 환경 오류: "+check["message"]+" — Chrome 설정의 [시작·연결 확인]으로 확인하세요.");
            }
            foreach(var check in Checks(doctor).Where(c=>c["id"] as string=="mcp"&&c["status"] as string=="ok"))lines.Add("✓ 브라우저 도구(MCP)가 연결되었습니다.");
            return lines;
        }
    }
```

done 패널의 안내 Label 아래에 ListBox를 추가하고, 내용을 채우는 메서드를 만든다.

```csharp
            Position(done,doneChecks,"DoneChecks",76,200,580,100);
```

필드 선언에 `readonly ListBox doneChecks=new ListBox();`를 추가한다. 메서드를 추가한다.

```csharp
        async Task RunDoneChecks(){
            doneChecks.Items.Clear();doneChecks.Items.Add("연결 상태를 확인하고 있습니다…");
            try{
                var state=Installed();string id=Pairing.ExtensionId(Path.Combine(state.InstallDir,"extension","manifest.json"));
                var current=await Task.Run(()=>Pairing.Status(state));
                var doctor=await Task.Run(()=>NativeIO.Json.Deserialize<Dictionary<string,object>>(BridgeControl.Invoke(state,new[]{"doctor","--json"},60000)));
                doneChecks.Items.Clear();foreach(var line in DoneChecks.Lines(current,doctor,id))doneChecks.Items.Add(line);
            }catch(Exception error){doneChecks.Items.Clear();doneChecks.Items.Add("✗ "+Friendly.Message(error));}
        }
```

`prepare.Click`의 `page==6` 분기(`SetPage(7);status.Clear();`) 뒤에 `await RunDoneChecks();`를 추가한다. 완료 문구 "설정이 끝났습니다."는 점검 결과에 ✗가 있으면 "설정을 마무리하세요."로 바꾼다. `RunDoneChecks` 끝에 다음을 넣는다.

```csharp
            if(doneChecks.Items.Cast<object>().Any(item=>item.ToString().StartsWith("✗")))complete.Text="설정을 마무리하세요.";
```

`complete` Label은 생성자 지역 변수다. 필드로 승격해 `readonly Label complete=new Label();`로 선언하고, 생성자에서는 `LabelAt` 결과 대신 이 필드에 `Text`·위치를 설정한다(`Position(done,complete,"CompleteTitle",76,40,560,38);complete.Text="설정이 끝났습니다.";`). 생성자의 `FontChanged`·`Font` 설정 줄도 필드를 쓰도록 바꾼다.

- [x] **Step 3: 통과를 확인한다**

Run: `bash scripts/build-release-wsl.sh && bash scripts/test-installer-windows.sh SetupFlowTests`
Expected: 새 Case PASS, 기존 Case 기준선과 같음

- [x] **Step 4: 커밋한다**

```bash
git add installer/SetupForm.cs tests/install/SetupFlowTests.cs
git commit -m "feat(installer): end the wizard with real connection checks and next actions"
```

### Task 12: 실제 Windows 검증과 문서

**Files:**
- Modify: `README-install.md`, `docs/user-guide.md`, `docs/troubleshooting.md`, `CHANGELOG.md`, `docs/status.md`
- Test: `tests/install/SetupDisplayTests.cs`(새 컨트롤 배율 검사), `tests/install/GuiSmokeTests.cs`(Task 9에서 수정한 흐름)

**Interfaces:**
- Consumes: Task 1~11 전체

- [x] **Step 1: 배율 검사에 새 화면을 포함한다**

`tests/install/SetupDisplayTests.cs`가 페이지별 컨트롤의 잘림을 검사하는 목록을 갖고 있으면 아래를 추가한다.
- 페이지 4: `OpenExtensions`, `ExtensionDetected`
- 페이지 5: `ConnectChrome`, `PairingState`
- 페이지 6: `RuntimeKind`, `RuntimeExecutable`, `RuntimeDirectory`, `SaveRuntime`, `RuntimeResult`, `SavedProfiles`
- 페이지 7: `DoneChecks`

검사 대상 글꼴 크기(10/12.5/15/20pt)와 방식은 기존 그대로 쓴다.

Run: `bash scripts/build-release-wsl.sh && bash scripts/test-installer-windows.sh SetupDisplayTests`
Expected: PASS. 잘리면 해당 과제의 배치 좌표·크기를 고친다.

- [x] **Step 2: 전체 자동 검증을 실행한다**

```bash
cargo test --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-extension test
pnpm --filter agent-browser-extension exec tsc --noEmit -p .
node --test tests/fixtures/*.test.mjs tests/agent/*.test.mjs tests/e2e/runtime.test.ts tests/e2e/interop-check.test.mjs tests/install/wsl-probe.test.mjs
bash scripts/build-release-wsl.sh
for t in SetupFlowTests SetupDisplayTests ManagedPathTests; do bash scripts/test-installer-windows.sh $t; done
```

Expected: 모두 PASS. 통과 개수를 기록한다.

- [x] **Step 3: 실제 GUI로 처음부터 끝까지 확인한다(사용자 보고 시나리오)**

격리 폴더(`%LOCALAPPDATA%\AgentBrowser-dev\gui-check`)와 별도 포트, 개발용 Chrome 프로필 `AgentBrowser-dev`를 쓴다. 운영 설치·사용자 Chrome 프로필은 쓰지 않는다.
1. 새 ZIP의 `AgentBrowser-Setup.exe`로 설치한다.
2. [Chrome 확장 페이지 열기]로 확장 페이지가 열리고 경로가 복사되는지 확인한다. 열리지 않으면 대체 안내 문구가 나오는지 확인하고 결과를 그대로 기록한다.
3. 확장을 로드한 뒤 "✓ 확장이 추가되었습니다"가 나오는지 확인한다.
4. [Chrome에 연결]로 토큰을 입력하지 않고 연결되는지 확인한다.
5. 실행 환경 화면의 자동 탐색 결과를 확인하고 [저장하고 연결 확인]을 누른다. 결과 문장과 저장된 목록을 확인한다.
6. Chrome의 AgentBrowser 설정을 열어 **같은 프로필이 목록에 있는지** 확인한다(사용자 보고와 같은 확인).
7. 마지막 화면의 점검 결과를 확인한다.
8. 패널을 열고 세션 없이 첫 메시지를 보내 응답이 시작되는지 확인한다. 모델 판단 품질은 판정하지 않는다.
9. 화면 배율 100%·125%·150%에서 각 화면의 한글 표시·잘림을 눈으로 확인하고 스크린샷을 남긴다(개발 검증 폴더, 저장소 밖).
10. 업데이트 시나리오: 게시된 v0.1.11을 먼저 설치·페어링한 뒤 새 ZIP으로 업데이트한다. 확장이 한 번 자동으로 새로고침되고 연결이 유지되는지 확인한다.

결과를 PASS·FAIL·미실행으로 구분해 기록한다.

- [x] **Step 4: 문서를 갱신한다**

- **`README-install.md` §2:** 새 흐름으로 바꾼다. [Chrome 확장 페이지 열기] → 로드 → 자동 감지 → [Chrome에 연결]. 토큰 직접 입력은 대체 방법으로 남긴다. §3은 마법사의 [저장하고 연결 확인]과 저장된 목록, 마지막 점검 화면을 설명한다. §4 업데이트의 "확장 새로고침" 단계는 "자동으로 한 번 새로고침된다. 되지 않으면 수동으로 새로고침"으로 바꾼다.
- **`docs/user-guide.md` §1~§3:** 위와 같은 흐름. 첫 메시지 전송 시 세션이 자동으로 만들어진다는 점, 실행 환경이 없으면 [실행 환경 추가] 버튼이 나온다는 점을 반영한다.
- **`docs/troubleshooting.md`:** "마법사에서 저장한 실행 환경이 설정에 없음" 항목을 추가한다. 마법사의 저장된 목록과 마지막 점검 화면을 확인하고, 없으면 Chrome 설정에서 추가한다. "Chrome에 연결이 2분 안에 끝나지 않음" 항목도 추가한다. 확장이 켜져 있는지, 같은 Chrome 프로필인지 확인하고, 안 되면 토큰을 직접 입력한다.
- **`CHANGELOG.md` 미배포 절:** 사용자 관점 변경을 적는다.
- **`docs/status.md` 맨 위:** 실제 실행한 명령·결과·미검증(사용자 배포 PC, 실제 모델 추론)을 구분해 기록한다.

- [x] **Step 5: 커밋한다**

```bash
git add README-install.md docs CHANGELOG.md tests/install
git commit -m "docs: describe the one-pass setup and record Windows GUI verification"
```

push·PR은 사용자 요청이 있을 때만 한다.
