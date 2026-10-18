# 작업 표시·응답 알림·잠시 넘겨받기(계획 3C) Implementation Plan

> **상태: 완료.** [PR #24](https://github.com/jihoon22-lee/agent-browser/pull/24)로 main에 병합했다(`aee5eae`, 2026-10-17). v0.2.0에 포함. 실제 검증 결과와 남긴 항목은 [상태 기록](../status.md)과 PR 본문에 있다. 새 작업의 원장으로 쓰지 않는다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 사용자가 에이전트가 어느 탭에서 무엇을 하는지 보고, 응답이 필요할 때 알고, 로그인·캡차처럼 사람이 할 단계에서 잠시 브라우저를 넘겨받았다가 이어서 진행할 수 있게 한다.

**Architecture:** 새 권한 없이 구현한다.
- **Bridge(작업 게이트):** 작업 단위 `paused` 상태를 둔다. 멈춘 동안 들어온 도구 호출은 최대 45초 기다린다. 그래도 멈춰 있으면 "사용자가 조작 중"이라는 BROWSER_BUSY를 돌려준다. 재개하면 다음 쓰기 전에 새 스냅샷을 요구한다(기존 `needs_observation`).
- **확장 background:** `status.changed`와 15초 reconcile로 세 가지를 맡는다.
  - 아이콘 배지(작업 중 ●, 응답 필요 !, 넘겨받음 ‖)
  - 작업 탭의 테두리 표시(닫힌 shadow DOM, `pointer-events:none`)
  - 응답 대기(질문·권한) 감지
- **content:** 클릭·입력 직전에 대상 요소를 0.7초 강조한다.
- **사이드 패널:** [잠시 넘겨받기]/[이어서 진행] 버튼을 둔다.

**Tech Stack:** Rust(Bridge operation gate·router·conn), Chrome MV3 TypeScript(background·content·sidepanel React), vitest, Playwright E2E.

**Spec:**
- [docs/review-2026-10-15.md](../review-2026-10-15.md) B4(작업 가시성과 사람 개입)
- [docs/handoff.md](../handoff.md) §16("전체 중단과 수동 인계"는 초기 필수), §10(관찰 가능한 조건으로 대기), §11

## Global Constraints

- **새 확장 권한을 추가하지 않는다.** 현재 권한: `tabs`, `scripting`, `storage`, `sidePanel`, `alarms`, `webNavigation`, 선택 `bookmarks`, host `<all_urls>`.
  - 배지는 `chrome.action`을 쓰며 권한이 필요 없다.
  - 테두리는 기존 `scripting`·host 권한으로 넣는다.
  - 시스템 알림(`notifications`)은 쓰지 않는다. 배지와 아이콘 제목으로 알린다.
- **페이지 동작에 영향을 주지 않는다:**
  - 표시 요소는 닫힌 shadow root 안에 둔다. 스냅샷 본문·요소(열린 shadow만 읽음)와 이름 계산에 나타나지 않는다.
  - `pointer-events:none`이라 클릭 판정(`elementFromPoint`)을 가리지 않는다.
  - 페이지 이벤트를 듣지 않는다.
- **ref 안전 규칙은 그대로 둔다.** 넘겨받은 동안 사용자가 페이지를 바꿨을 수 있으므로, 재개 뒤 첫 쓰기는 새 스냅샷 전 `STALE_ELEMENT`다(`router.rs:315`의 `needs_observation`).
- **결과 예산·도구 정의 예산(4,800자)은 그대로 둔다.** 이 계획은 도구 스키마를 바꾸지 않는다.
- **대기 시간:** 넘겨받은 동안 도구 호출은 `HANDOFF_WAIT` 45초까지 기다린다. MCP 응답 한도 `REPLY_WAIT` 60초보다 짧다.
- **커밋 메시지:** 영어 Conventional Commits, 과제 단위로 쓴다.

## Review Focus

1. **넘겨받은 동안 모델이 계속 호출할 때:** 바로 오류를 돌려주면 모델이 짧은 간격으로 재시도하며 토큰을 쓴다. 호출은 재개까지 최대 45초 기다렸다가 진행해야 하고, 시간을 넘기면 "사용자가 조작 중이니 기다리라"는 BROWSER_BUSY(retry safe)를 받아야 한다. → Task 1 `paused_calls_wait_then_continue_after_resume`, `paused_calls_time_out_with_a_handoff_message`
2. **넘겨받은 상태에서 [중단]:** 기다리던 호출이 즉시 CANCELLED로 끝나고, 게이트가 정리된다. → Task 1 `abort_releases_calls_waiting_on_a_handoff`
3. **재개 뒤 예전 ref로 쓰기:** 사용자가 바꾼 페이지에 옛 ref로 쓰지 않는다. 새 스냅샷 전 쓰기는 거부된다. → Task 1 `resume_requires_a_fresh_snapshot_before_writing`
4. **표시 요소가 스냅샷·클릭을 오염시키지 않음:** 테두리가 있는 탭의 스냅샷 본문·요소에 표시 문구가 없고, 클릭 판정이 그대로 통과한다. → Task 4 E2E `V01`
5. **다른 브라우저(프로필)의 작업:** 이 브라우저가 소유하지 않은 작업에는 배지·테두리·넘겨받기 버튼을 보이지 않는다. → Task 3 `badge_ignores_another_browsers_operation`, Task 5 패널 테스트

---

### Task 1: Bridge 작업 게이트의 넘겨받기·재개

**Files:**
- Modify: `bridge/src/server/operation.rs`(`Operation.paused`, `pause`/`resume`, 대기 알림)
- Modify: `bridge/src/server/router.rs`(작업 도구 실행 전 대기)
- Modify: `bridge/src/server/conn.rs:45`(Extension 허용 메서드), `request.begin` 근처 처리부(새 RPC)
- Test: `operation.rs` 테스트 모듈, `bridge/tests/tool_router.rs`

**Interfaces:**
- Produces:
  - `Operation`에 `pub paused: bool`. 직렬화되어 `status.changed`의 `operation.paused`로 나간다.
  - `OperationGate::pause(&self, op_id:&str, client:&str) -> Result<Operation,RpcError>`
  - `OperationGate::resume(&self, op_id:&str, client:&str) -> Result<Operation,RpcError>`. 재개 시 `target_epoch += 1; needs_observation = true`.
  - `OperationGate::wait_until_resumed(&self, op_id:&str, limit:Duration) -> impl Future<Output=Result<(),RpcError>>`. 멈추지 않았으면 즉시 `Ok`, 재개되면 `Ok`, 작업이 끝나면 기존 `check` 오류(CANCELLED 등), 시간이 넘으면 `BrowserBusy`(retry safe, details `{"handoff":true}`)다.
  - Extension RPC `operation.pause {operationId}`, `operation.resume {operationId}`. 호출한 브라우저가 작업 소유자여야 한다.
  - `pub(crate) const HANDOFF_WAIT: Duration = Duration::from_secs(45)` (`router.rs`)

- [x] **Step 1: 실패하는 테스트를 쓴다**

`operation.rs` 테스트 모듈:

```rust
    #[tokio::test]
    async fn paused_calls_wait_then_continue_after_resume() {
        let g=std::sync::Arc::new(OperationGate::default());
        let op=g.attach(12,"browser").unwrap();
        assert!(g.pause(&op.id,"browser").unwrap().paused);
        let waiting={let g=g.clone();let id=op.id.clone();tokio::spawn(async move{g.wait_until_resumed(&id,std::time::Duration::from_secs(5)).await})};
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!waiting.is_finished(),"a call waits while the user holds the browser");
        let resumed=g.resume(&op.id,"browser").unwrap();
        assert!(!resumed.paused && resumed.needs_observation);
        assert!(waiting.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn paused_calls_time_out_with_a_handoff_message() {
        let g=OperationGate::default();let op=g.attach(12,"browser").unwrap();g.pause(&op.id,"browser").unwrap();
        let error=g.wait_until_resumed(&op.id,std::time::Duration::from_millis(50)).await.unwrap_err();
        assert_eq!((error.code,error.retry),(ErrorCode::BrowserBusy,Retry::Safe));
        assert_eq!(error.details["handoff"],true);
    }

    #[tokio::test]
    async fn abort_releases_calls_waiting_on_a_handoff() {
        let g=std::sync::Arc::new(OperationGate::default());let op=g.attach(12,"browser").unwrap();g.pause(&op.id,"browser").unwrap();
        let waiting={let g=g.clone();let id=op.id.clone();tokio::spawn(async move{g.wait_until_resumed(&id,std::time::Duration::from_secs(5)).await})};
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        g.abort(Some(&op.id));
        let error=tokio::time::timeout(std::time::Duration::from_secs(1),waiting).await.expect("abort wakes the waiter").unwrap().unwrap_err();
        assert_eq!(error.code,ErrorCode::Cancelled);
    }

    #[test]
    fn only_the_owner_pauses_or_resumes() {
        let g=OperationGate::default();let op=g.attach(12,"browser").unwrap();
        assert!(g.pause(&op.id,"other").is_err());
        assert!(g.resume(&op.id,"browser").is_err(),"resume needs a pause");
    }
```

`abort`의 실제 시그니처와 끝난 작업의 `check` 오류 코드는 같은 파일의 기존 테스트(`request_end_invalidates_its_operation_and_late_request_ids`)를 따른다. CANCELLED가 아니라 다른 코드가 맞다면, 기존 규칙 쪽으로 단언을 맞추고 ruling으로 남긴다.

`tool_router.rs`:

```rust
#[tokio::test]
async fn resume_requires_a_fresh_snapshot_before_writing() {
    // attach → snapshot(정상) → 확장 소켓에서 operation.pause / operation.resume
    // → ref로 browser_fill → error.code == "STALE_ELEMENT"(새 스냅샷 요구), 확장에 browser.fill 전달 없음
    // → browser_snapshot → browser_fill → ok
}
```

본문은 같은 파일의 `selected_extension_tab_closed_allows_switch_and_release`처럼 확장 소켓을 직접 다루고 `call_with_socket`으로 명령에 응답하는 방식으로 쓴다. `operation.pause`/`operation.resume`은 `call(&mut ext, "operation.pause", json!({"operationId": op}))`로 보낸다.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- paused_calls abort_releases only_the_owner`
Expected: 컴파일 오류(`pause` 없음)

- [x] **Step 3: 구현한다**

`operation.rs`:
- **필드:**
  - `Operation`에 `pub paused: bool`을 추가한다. 생성 시 `false`이고 `target_epoch` 옆에 둔다.
  - `OperationGate`에 `resumed: tokio::sync::Notify`를 추가한다. `#[derive(Default)]`가 유지되도록 `Notify::default()`를 쓴다.
- **`pause`:** 현재 Active 작업이고 id·client가 맞으면 `paused = true`.
- **`resume`:** `paused`일 때만 `paused = false; target_epoch += 1; needs_observation = true;` 후 `self.resumed.notify_waiters()`.
- **`finish`/`abort` 경로:** 작업을 끝내는 곳(`fn finish`)에서 `self.resumed.notify_waiters()`를 호출한다. `finish`는 연관 함수(`Self::finish(&mut g, …)`)이므로, 그 함수를 부르는 공개 메서드(`abort`, `release`, `finish_request` 등)의 끝에서 알린다.
- **`wait_until_resumed`:**

```rust
    pub async fn wait_until_resumed(&self, op_id: &str, limit: std::time::Duration) -> Result<(), RpcError> {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let notified = self.resumed.notified();
            match self.check(op_id) {
                Ok(op) if !op.paused => return Ok(()),
                Ok(_) => {}
                Err(error) => return Err(error),
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(RpcError::new(ErrorCode::BrowserBusy, Retry::Safe,
                    "The user has taken over this tab. Wait, then try again; take a fresh snapshot before acting.")
                    .with_details(json!({"handoff": true})));
            }
        }
    }
```

`check`의 실제 이름·반환형(`Result<Operation,RpcError>`)은 `router.rs:315`와 `operation.rs:468`에서 쓰는 것과 같다.

`router.rs`: `run_operation_tool`과 `run_tabs`의 switch/close/release/`new`(operationId 있음) 경로에서, 작업을 큐에 넣기 전에 대기한다.

```rust
pub(crate) const HANDOFF_WAIT: Duration = Duration::from_secs(45);
```

```rust
    if let Err(error) = state.ops.wait_until_resumed(op_id, HANDOFF_WAIT).await { return ToolOutcome::rejected(name, Some(op_id), error); }
```

`conn.rs`:
- `Role::Extension` 허용 목록에 `"operation.pause" | "operation.resume"`을 추가한다.
- 처리부(`"operation.abort"` 옆)를 추가한다. 매개변수 `operationId` 문자열, 호출한 연결의 `client_id`, 성공 시 `state.broadcast_status()`, 결과는 갱신된 작업이다.
- 호출한 연결의 클라이언트 ID는 `operation.abort` 처리부와 같은 방식으로 얻는다.

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge`
Expected: PASS. 새 테스트와 기존 전체를 포함한다. `protocol_contract`가 Extension 메서드 목록을 고정하면 `protocol/` 계약 문서와 fixture에 두 메서드를 추가한다.

- [x] **Step 5: 커밋한다**

```bash
git add bridge protocol
git commit -m "feat(bridge): let the user hold an operation and resume with a fresh snapshot"
```

### Task 2: 응답 필요 감지(패널이 닫혀 있어도)

**Files:**
- Modify: `extension/src/background/panel-requests.ts`(`attention()`)
- Test: `extension/test/panel-requests.test.ts`

**Interfaces:**
- Consumes: 저장된 lease(`panelBrowserRequest`), 기존 `client(lease)`. 런타임이 준비됐을 때만 API를 준다.
- Produces: `attention(): Promise<{ waiting: boolean; kind?: "question" | "permission" }>`
  - 저장된 패널 요청이 있고, 그 세션에 대기 중인 `/question` 또는 `/permission`(`sessionID === lease.sessionId`)이 있으면 `waiting:true`다.
  - 런타임을 확인할 수 없거나 오류면 `{waiting:false}`다. 알림은 힌트일 뿐이라 오류를 던지지 않는다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`panel-requests.test.ts`에 추가한다. `api.get`은 같은 파일의 기존 mock(경로별 응답)을 쓴다.

```ts
it('reports a pending question or permission of the saved request session only', async () => {
  await panelRequests(call).prepare(lease('one'), { tabId: 11, windowId: 1 });
  api.get.mockImplementation(async (path: string) => path === '/question' ? [{ id: 'q1', sessionID: 'session-other' }]
    : path === '/permission' ? [{ id: 'p1', sessionID: 'session-one' }] : {});
  await expect(panelRequests(call).attention()).resolves.toEqual({ waiting: true, kind: 'permission' });
  api.get.mockImplementation(async () => []);
  await expect(panelRequests(call).attention()).resolves.toEqual({ waiting: false });
});

it('treats an unreachable runtime as nothing to report', async () => {
  await panelRequests(call).prepare(lease('one'), { tabId: 11, windowId: 1 });
  call.mockImplementation(async (method: string) => { if (method === 'runtime.status') throw Error('offline'); return {}; });
  await expect(panelRequests(call).attention()).resolves.toEqual({ waiting: false });
});
```

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/panel-requests.test.ts`
Expected: FAIL(`attention` 없음)

- [x] **Step 3: 구현한다**

`panelRequests`가 돌려주는 객체에 추가한다.

```ts
    attention:async():Promise<{waiting:boolean;kind?:'question'|'permission'}>=>{
      try {
        const saved=(await chrome.storage.local.get(KEY))[KEY] as RequestLease|undefined;
        if(!saved)return {waiting:false};
        const api=await client(saved);
        if(!api)return {waiting:false};
        const [questions,permissions]=await Promise.all([api.get<any[]>('/question'),api.get<any[]>('/permission')]);
        const mine=(items:any[])=>Array.isArray(items)&&items.some(item=>item?.sessionID===saved.sessionId);
        if(mine(questions))return {waiting:true,kind:'question'};
        if(mine(permissions))return {waiting:true,kind:'permission'};
        return {waiting:false};
      } catch { return {waiting:false}; }
    },
```

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/panel-requests.test.ts`
Expected: PASS

- [x] **Step 5: 커밋한다**

```bash
git add extension/src/background/panel-requests.ts extension/test/panel-requests.test.ts
git commit -m "feat(extension): notice a panel request waiting for an answer"
```

### Task 3: 아이콘 배지

**Files:**
- Create: `extension/src/background/badge.ts`
- Modify: `extension/src/background/index.ts`(`onEvent`, reconcile)
- Test: `extension/test/badge.test.ts`

**Interfaces:**
- Consumes:
  - `status.changed`의 `operation`(`clientId`, `paused`)
  - Task 2 `attention()`
  - 저장된 `clientId`
- Produces:
  - `badgeFor(input:{operation:{clientId:string;paused?:boolean}|null; clientId?:string; waiting:boolean}): {text:string; color:string; title:string}`
  - 우선순위는 다음과 같다. 다른 브라우저의 작업은 없는 것으로 본다.
    1. `waiting`: `"!"` 주황, "AgentBrowser — 응답이 필요합니다"
    2. 이 브라우저의 작업이 `paused`: `"‖"` 회색, "AgentBrowser — 사용자가 조작 중"
    3. 이 브라우저의 작업: `"●"` 파랑, "AgentBrowser — 작업 중"
    4. 그 밖: `""`, "AgentBrowser"
  - `applyBadge(state)`: `chrome.action.setBadgeText`·`setBadgeBackgroundColor`·`setTitle` 호출

- [x] **Step 1: 실패하는 테스트를 쓴다**

```ts
import { badgeFor } from "../src/background/badge";

it("shows work, a hand-over and a needed answer in that priority", () => {
  const op = { clientId: "me" };
  expect(badgeFor({ operation: null, clientId: "me", waiting: false }).text).toBe("");
  expect(badgeFor({ operation: op, clientId: "me", waiting: false }).text).toBe("●");
  expect(badgeFor({ operation: { ...op, paused: true }, clientId: "me", waiting: false }).text).toBe("‖");
  expect(badgeFor({ operation: op, clientId: "me", waiting: true }).text).toBe("!");
  expect(badgeFor({ operation: op, clientId: "me", waiting: true }).title).toContain("응답이 필요");
});

it("badge_ignores_another_browsers_operation", () => {
  expect(badgeFor({ operation: { clientId: "other" }, clientId: "me", waiting: false }).text).toBe("");
});
```

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/badge.test.ts`
Expected: FAIL(모듈 없음)

- [x] **Step 3: 구현한다**

`badge.ts`:

```ts
export type BadgeInput = { operation: { clientId: string; paused?: boolean } | null; clientId?: string; waiting: boolean };
export type Badge = { text: string; color: string; title: string };

export function badgeFor({ operation, clientId, waiting }: BadgeInput): Badge {
  const mine = operation && clientId && operation.clientId === clientId ? operation : null;
  if (waiting) return { text: "!", color: "#d97706", title: "AgentBrowser — 응답이 필요합니다" };
  if (mine?.paused) return { text: "‖", color: "#6b7280", title: "AgentBrowser — 사용자가 조작 중" };
  if (mine) return { text: "●", color: "#2563eb", title: "AgentBrowser — 작업 중" };
  return { text: "", color: "#2563eb", title: "AgentBrowser" };
}

export async function applyBadge(badge: Badge) {
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  await chrome.action.setTitle({ title: badge.title });
}
```

`index.ts`:
- 모듈 상태로 `let lastOperation: any = null, waiting = false;`를 둔다.
- `onEvent`에서 `event === "status.changed"`이면 `lastOperation = data.operation ?? null`로 저장한 뒤 `refreshBadge()`를 호출한다.
- `reconcile`(15초 타이머·1분 알람)에서 `requests.attention()` 결과로 `waiting`을 갱신하고 `refreshBadge()`를 호출한다.
- `refreshBadge`는 `chrome.storage.local.get('clientId')`로 클라이언트 ID를 읽어 `applyBadge(badgeFor(...))`를 실행한다. 실패는 무시한다.
- Bridge 연결이 끊기면(`onStatus`의 `state !== 'connected'`) `lastOperation = null`로 두고 배지를 비운다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/badge.test.ts && pnpm --filter agent-browser-extension exec tsc --noEmit -p .`
Expected: PASS

- [x] **Step 5: 커밋한다**

```bash
git add extension/src/background/badge.ts extension/src/background/index.ts extension/test/badge.test.ts
git commit -m "feat(extension): show work, hand-over and needed answers on the toolbar icon"
```

### Task 4: 작업 탭 테두리와 조작 대상 강조

**Files:**
- Create: `extension/src/background/work-marker.ts`
- Modify: `extension/src/background/index.ts`(status 변화 때 표시 갱신)
- Modify: `extension/src/content/actions.ts`(click·fill·select 직전 강조)
- Test: `extension/test/work-marker.test.ts`, `extension/test/actions.test.ts`(강조), `tests/e2e/reliability.spec.ts`(V01)

**Interfaces:**
- Produces:
  - `markerScript(on: boolean, label: string): void`. 페이지에서 실행되는 순수 함수이며 `chrome.scripting.executeScript`의 `func`로 쓴다.
    - id `agent-browser-work-marker` host 하나를 `document.documentElement`에 붙이거나 지운다.
    - host는 `attachShadow({mode:"closed"})`, `aria-hidden="true"`, `style="position:fixed;inset:0;pointer-events:none;z-index:2147483647"`이다.
    - shadow 안에 3px 테두리와 우상단 라벨(`label`)을 둔다.
    - 이미 있으면 라벨만 바꾼다.
  - `syncMarkers(api, previous:Set<number>, next:{tabs:number[]; paused:boolean}|null): Promise<Set<number>>`
    - 새 작업 탭에는 표시를 넣고, 빠진 탭에서는 지운다.
    - 라벨은 `paused`면 "AgentBrowser · 사용자가 조작 중", 아니면 "AgentBrowser 작업 중"이다.
    - `api`는 `executeScript(tabId, func, args)`만 가진 얇은 인터페이스라 테스트에서 가짜로 바꿀 수 있다.
  - `highlight(el: Element)`(content): 요소 영역에 0.7초 동안 2px 외곽선을 그린다. 같은 방식(닫힌 shadow, `pointer-events:none`)이다. 시간이 지나면 스스로 지운다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`work-marker.test.ts`(jsdom):

```ts
import { markerScript, syncMarkers } from "../src/background/work-marker";

it("adds one invisible-to-snapshot marker and removes it", () => {
  markerScript(true, "AgentBrowser 작업 중");
  markerScript(true, "AgentBrowser · 사용자가 조작 중");
  const hosts = document.querySelectorAll("#agent-browser-work-marker");
  expect(hosts).toHaveLength(1);
  expect(hosts[0]!.shadowRoot).toBeNull();
  expect((hosts[0] as HTMLElement).style.pointerEvents).toBe("none");
  expect(hosts[0]!.getAttribute("aria-hidden")).toBe("true");
  markerScript(false, "");
  expect(document.querySelector("#agent-browser-work-marker")).toBeNull();
});

it("marks new operation tabs and clears tabs that left", async () => {
  const calls: Array<[number, boolean]> = [];
  const api = { executeScript: async (tabId: number, _f: unknown, args: [boolean, string]) => { calls.push([tabId, args[0]]); } };
  let marked = await syncMarkers(api, new Set(), { tabs: [1, 2], paused: false });
  marked = await syncMarkers(api, marked, { tabs: [2], paused: false });
  await syncMarkers(api, marked, null);
  expect(calls).toEqual([[1, true], [2, true], [2, true], [1, false], [2, false]]);
});
```

`actions.test.ts`: 클릭 테스트 하나에 단언을 추가한다. 클릭 직후 `document.querySelector('#agent-browser-target')`가 존재하고, 0.8초 뒤(가짜 타이머) 사라지는지 확인한다. 같은 파일의 기존 클릭 테스트 구성(`generation:10` 등)을 따른다.

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/work-marker.test.ts test/actions.test.ts`
Expected: FAIL

- [x] **Step 3: 구현한다**

`work-marker.ts`:

```ts
/** Runs in the page: a fixed, click-through, closed-shadow frame that snapshots cannot read. */
export function markerScript(on: boolean, label: string): void {
  const id = "agent-browser-work-marker";
  const existing = document.getElementById(id) as (HTMLElement & { __label?: HTMLElement }) | null;
  if (!on) { existing?.remove(); return; }
  if (existing?.__label) { existing.__label.textContent = label; return; }
  const host = document.createElement("div") as HTMLElement & { __label?: HTMLElement };
  host.id = id; host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const frame = document.createElement("div");
  frame.style.cssText = "position:absolute;inset:0;border:3px solid #2563eb;box-sizing:border-box";
  const tag = document.createElement("div");
  tag.style.cssText = "position:absolute;top:0;right:0;background:#2563eb;color:#fff;font:12px sans-serif;padding:2px 8px";
  tag.textContent = label;
  root.append(frame, tag); host.__label = tag;
  document.documentElement.append(host);
}

export type MarkerApi = { executeScript(tabId: number, func: typeof markerScript, args: [boolean, string]): Promise<unknown> };

export async function syncMarkers(api: MarkerApi, previous: Set<number>, next: { tabs: number[]; paused: boolean } | null): Promise<Set<number>> {
  const label = next?.paused ? "AgentBrowser · 사용자가 조작 중" : "AgentBrowser 작업 중";
  const now = new Set(next?.tabs ?? []);
  for (const tab of now) await api.executeScript(tab, markerScript, [true, label]).catch(() => {});
  for (const tab of previous) if (!now.has(tab)) await api.executeScript(tab, markerScript, [false, ""]).catch(() => {});
  return now;
}
```

`index.ts`의 `onEvent(status.changed)`에서 이 브라우저의 작업이면 `syncMarkers`를 부른다. 탭 목록은 `operation.tabs`이고, 실제 필드 이름은 `operation.rs`의 `Operation.tabs`와 같다. 실제 `api`는 `chrome.scripting.executeScript({target:{tabId}, func, args})`다.

`markerScript`는 직렬화되어 페이지에서 실행되므로, 바깥 변수나 import를 참조하지 않는다. `__label`은 다시 그릴 때 라벨만 바꾸기 위한 host 속성이다. 확장 격리 세계에서 실행되므로 페이지 스크립트에는 보이지 않는다.

`actions.ts`: click·fill·select에서 `assertInteractable` 통과 직후, 실제 이벤트 전에 `highlight(el)`을 호출한다. 구현은 `markerScript`와 같은 방식이다. id `agent-browser-target`, 요소 `getBoundingClientRect()` 위치에 `position:fixed`, 0.7초 뒤 제거한다. 이벤트·포커스·스크롤을 바꾸지 않는다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm --filter agent-browser-extension test`
Expected: PASS

E2E `reliability.spec.ts`에 V01을 추가한다.

```ts
test("V01 the work marker shows on the operation tab but never in snapshots or clicks", async () => {
  const { page, attached, operationId } = await attachShop();
  await expect(page.locator("#agent-browser-work-marker")).toHaveCount(1);
  const read = await world.ok("browser_snapshot", { operationId });
  expect(JSON.stringify(read.data)).not.toContain("작업 중");
  const filter = all(attached.data.snapshot).find(e => e.name === "필터 열기")!;
  await world.ok("browser_click", { operationId, ref: filter.ref });
  await world.ok("browser_tabs", { action: "release", operationId });
  await expect(page.locator("#agent-browser-work-marker")).toHaveCount(0);
});
```

Run: `pnpm --filter agent-browser-extension build && pnpm --filter agent-browser-e2e exec playwright test reliability.spec.ts`
Expected: PASS. `V01`과 기존 R01~R08을 포함한다.

- [x] **Step 5: 커밋한다**

```bash
git add extension tests/e2e
git commit -m "feat(extension): frame operation tabs and flash the target, invisible to snapshots and clicks"
```

### Task 5: 패널의 [잠시 넘겨받기]/[이어서 진행]

**Files:**
- Modify: `extension/src/background/index.ts:69`(bridge 메서드 허용 목록에 `operation.pause`, `operation.resume`)
- Modify: `extension/src/sidepanel/status-store.ts`(`Operation.paused`)
- Modify: `extension/src/sidepanel/Workbench.tsx`(응답 중단 버튼 옆, `:384` 부근)
- Test: `extension/test/workbench.test.ts`

**Interfaces:**
- Consumes: Task 1 RPC, `status.changed`의 `operation.paused`
- Produces:
  - 이 브라우저의 작업이 있을 때만 버튼이 보인다.
  - `paused`가 아니면 [잠시 넘겨받기], `paused`면 [이어서 진행]이다.
  - 넘겨받은 동안 대화 위에 "브라우저를 직접 조작하는 중입니다. 끝나면 [이어서 진행]을 누르세요. 에이전트는 기다립니다." 안내를 표시한다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`workbench.test.ts`에 추가한다. 같은 파일의 작업 상태 주입 방식(`status.changed` 메시지 또는 store 디스패치)을 따른다.

```ts
it("lets the user take over the browser and hand it back", async () => {
  // operation {id:'op-1', clientId:<이 브라우저>, paused:false}를 주입한다
  // button("잠시 넘겨받기").click() → chrome.runtime.sendMessage({kind:'bridge',method:'operation.pause',params:{operationId:'op-1'}})
  // paused:true 상태를 주입한다 → "이어서 진행" 버튼과 안내 문구가 보인다
  // button("이어서 진행").click() → operation.resume 메시지
});

it("offers no take-over for another browser's operation", async () => {
  // clientId가 다른 operation을 주입하면 "잠시 넘겨받기" 버튼이 없다
});
```

이 파일의 기존 `render()`·`button()` 도우미와 상태 주입 도우미를 쓴다. 주입 도우미가 없으면 테스트 상단에 `status.changed` bridge-event를 보내는 작은 함수를 추가한다.

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/workbench.test.ts`
Expected: FAIL

- [x] **Step 3: 구현한다**

- `status-store.ts`: `Operation` 타입과 `isOperation`이 `paused?: boolean`을 허용하게 한다.
- `index.ts`: bridge 허용 목록에 `"operation.pause", "operation.resume"`을 추가한다.
- `Workbench.tsx`: 응답 중단 버튼 옆에 버튼을 둔다. 조건은 `operation && operation.clientId === ownClientId`다. 이 브라우저의 clientId는 기존 코드가 작업 소유 판단에 쓰는 값과 같은 출처(`chrome.storage.local`의 `clientId`)를 쓴다. 클릭 시 `chrome.runtime.sendMessage({kind:'bridge',method: paused?'operation.resume':'operation.pause',params:{operationId:operation.id}})`를 보내고, 실패하면 기존 오류 표시(`wb.setError`)를 쓴다. 안내 문구는 대화 영역 상단 알림 자리(`notice`)를 쓴다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm --filter agent-browser-extension test && pnpm --filter agent-browser-extension exec tsc --noEmit -p .`
Expected: PASS

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "feat(panel): take over the browser for a moment and hand it back to the agent"
```

### Task 6: 실제 브라우저 넘겨받기 E2E, 전체 검증, 문서

**Files:**
- Modify: `tests/e2e/reliability.spec.ts`(H01)
- Modify:
  - `docs/user-guide.md`(작업 표시·배지·넘겨받기)
  - `docs/browser-capabilities.md`
  - `docs/protocol.md`(`operation.pause`/`resume`, `paused`, handoff 대기)
  - `CHANGELOG.md`
  - `docs/status.md`
  - `docs/review-2026-10-15.md` §E(3C 반영 표시)

- [x] **Step 1: H01을 쓴다**

```ts
test("H01 a held operation makes the agent wait, then continue only after a fresh read", async () => {
  const { attached, operationId } = await attachShop();
  await world.admin("operation.pause", { operationId });
  const pending = world.mcp.call("browser_snapshot", { operationId });
  await new Promise(r => setTimeout(r, 500));
  await world.admin("operation.resume", { operationId });
  expect((await pending).ok).toBe(true);
  const filter = all(attached.data.snapshot).find(e => e.name === "필터 열기")!;
  // pending snapshot이 새 관찰이므로 이 클릭은 허용된다. 관찰 없이 쓰는 경우는 Task 1 Rust 테스트가 고정한다.
  expect((await world.mcp.call("browser_click", { operationId, ref: filter.ref })).ok).toBe(true);
});
```

`world.admin`이 확장 관리 RPC를 보내는 실제 경로와 허용 메서드는 `tests/e2e/harness.ts`에서 확인한다. 허용 목록이 고정돼 있으면 두 메서드를 추가한다.

- [x] **Step 2: 전체 검증**

```bash
cargo test --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-extension test
pnpm --filter agent-browser-extension exec tsc --noEmit -p .
pnpm --filter agent-browser-extension build && cargo build --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-e2e exec playwright test
bash scripts/test-windows.sh -- journeys.spec.ts reliability.spec.ts board-navigation.spec.ts
bash scripts/test-windows.sh --prepare-only
```

실제 OpenCode 검사를 준비된 Windows 작업 폴더에서 Windows와 `--wsl`로 각각 돌린다(`docs/testing.md`). 배지·테두리는 headed Chrome 화면에서 결과 PNG(`tests/agent/results`, 저장소 밖으로 내보내지 않음)로 확인할 수 있으면 확인한다. 화면이 잠겨 있으면 미실행으로 기록한다.

Expected: 모두 PASS

- [x] **Step 3: 문서를 갱신한다**

- **`user-guide.md`:**
  - 확장 아이콘의 ●(작업 중)·!(응답 필요)·‖(사용자가 조작 중)
  - 작업 탭의 파란 테두리와 클릭 대상 강조
  - [잠시 넘겨받기] → 로그인·캡차 등을 직접 처리 → [이어서 진행]. 에이전트는 기다렸다가 페이지를 다시 읽고 이어 간다.
- **`browser-capabilities.md`:** 표시 요소는 스냅샷·클릭 판정에 나타나지 않는다.
- **`protocol.md`:**
  - Extension RPC `operation.pause`/`operation.resume`
  - `operation.paused`
  - 멈춘 동안 도구 호출 45초 대기, 시간 초과 시 BROWSER_BUSY `details.handoff`
  - 재개 뒤 첫 쓰기 전 스냅샷 요구
- **`CHANGELOG.md` `[미배포]`:** 사용자 관점 세 줄을 쓴다. 아이콘 상태 표시, 작업 탭 표시와 대상 강조, 잠시 넘겨받기·이어서 진행.
- **`review-2026-10-15.md` §E 계획 3:** 가시성·알림·인계 항목에 "계획 3C로 반영" 표시를 단다.
- **`status.md` 맨 위:** 실행한 명령·결과·미검증을 기록한다.

- [x] **Step 4: 커밋한다**

```bash
git add tests/e2e docs CHANGELOG.md
git commit -m "docs: describe work markers, the toolbar badge and taking over the browser"
```

---

## 이후 계획

- **계획 3D — 미뤄 둔 작은 결함 정리:**
  - 계획 2 설치기 5건: 꺼진 WSL 배포판 탐색, 완료 화면 가로 스크롤, 사용자 이름만 바꿀 때 비밀번호 삭제 안내, 1.5초마다 Bridge 시작 반복, 긴 페어링 오류 잘림
  - 계획 3A 3건: 동시 첫 호출 BUSY, `null` ID, 비객체 상태 응답
  - 계획 3B 5건: query 행 글자 계산 비용, 큰 부모를 행으로 보는 문제, 새 탭 클릭의 1초 추가 대기, 감시 중 취소의 EXECUTION_UNKNOWN, frame별 `query-no-match`
- **계획 4 — 선택 권한(CDP·tabGroups):** Task 1은 확인 작업이다. 확인할 것은 두 가지다.
  - Playwright가 제어 중인 Chrome에서 `chrome.debugger.attach`가 되는지
  - `optional_permissions`로 요청할 수 있는 권한
