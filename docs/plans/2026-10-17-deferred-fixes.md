# 미뤄 둔 작은 결함 정리(계획 3D) Implementation Plan

> **상태: 완료.** [PR #25](https://github.com/jihoon22-lee/agent-browser/pull/25)로 main에 병합했다(`6a0f685`, 2026-10-17). v0.2.0에 포함. 실제 검증 결과와 남긴 항목은 [상태 기록](../status.md)과 PR 본문에 있다. 새 작업의 원장으로 쓰지 않는다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 계획 2·3A·3B·3C의 최종 리뷰에서 minor로 미룬 20건을 정리한다. 하나하나는 작지만 실제 사용에서 혼란·지연·잘못된 표시로 드러나는 것들이다.

**Architecture:** 새 기능은 없다. 구성 요소별로 과제를 묶었다. 각 결함은 실패하는 테스트로 먼저 재현한 뒤 고친다.
- Bridge 결합·게이트: 5건
- content 스냅샷: 3건
- background 동작 결과: 2건
- 표시·패널: 5건
- 확장 설정: 1건
- 설치기: 4건(대상 5건, 그중 하나는 3개 하위 결함)

**Tech Stack:** Rust, Chrome MV3 TypeScript(vitest), C# .NET Framework 4 WinForms(SetupFlowTests, `scripts/test-installer-windows.sh`), Playwright.

**Spec:** 각 계획의 PR 본문 "Deferred minors"와 [docs/status.md](../status.md)의 해당 항목. 원래 요구는 [docs/review-2026-10-15.md](../review-2026-10-15.md)와 [docs/handoff.md](../handoff.md) §10·§11.

## Global Constraints

- **예산·규칙은 그대로 둔다:** 도구 정의(< 4,800자), 결과 바이트, `REPLY_WAIT` 60초, `HANDOFF_WAIT` 45초, ref 안전 규칙.
- **새 권한을 추가하지 않는다.**
- **설치기 호환성(AGENTS.md):** 경로 소유자·ACL 검사를 추가하지 않는다.
- **동작 의미를 바꾸지 않는다.** 각 수정은 리뷰가 지적한 상황만 고친다.
- **커밋 메시지:** 영어 Conventional Commits, 과제 단위로 쓴다.

## Review Focus

1. **동시 첫 호출(3A):** 둘 다 같은 요청 작업으로 이어져야 한다. 둘째가 BUSY를 받으면 안 된다. → Task 1
2. **넘겨받기 직후 탭 생성(3C):** 대기를 통과한 뒤 큐에 넣기 직전에 사용자가 넘겨받으면, 탭을 만들지 않고 handoff 결과를 돌려준다. → Task 1
3. **query 비용(3B):** 링크 수백 개가 든 긴 article에서도 행 글자를 요소마다 다시 만들지 않는다. → Task 2
4. **감시 중 취소(3B):** content가 실행을 확인한 클릭은 1초 감시 중 취소돼도 "실행됨"으로 남는다. → Task 3
5. **넘겨받은 동안 페이지 이동(3C):** 로그인 리다이렉트 뒤에도 테두리와 "사용자가 조작 중" 라벨이 바로 다시 보인다. → Task 4

---

### Task 1: Bridge — 결합과 게이트의 가장자리

**Files:**
- Modify: `bridge/src/server/router.rs`(`bind_arguments`, `with_checked` 클로저 4곳)
- Modify: `bridge/src/runtime/mod.rs`(`busy_sessions`를 기록 조회와 HTTP로 분리)
- Modify: `bridge/src/server/binding.rs`(`resolve` 순서)
- Test: `bridge/tests/request_binding.rs`, `bridge/tests/tool_router.rs`, `runtime/mod.rs` 테스트

**결함과 수정:**

**(1) 동시 ID 없는 첫 호출**
- 증상: 둘 다 `bound.operation == None`을 보고 암묵 attach를 시도한다. 둘째는 "This request already has an operation" BUSY를 받고, 실패 결과에 `tool:"browser_tabs"`가 붙는다.
- 수정: 암묵 attach가 `BrowserBusy`로 실패하면 `state.ops.bound_request()`를 다시 읽는다. 작업이 생겼으면 그 ID로 진행한다(`created=false`). 그래도 실패하면 `outcome.tool = name`으로 고쳐 돌려준다.

**(2) `null` ID**
- 증상: `{"operationId": null}`을 생략으로 보지 않는다.
- 수정: `wants_request`·`wants_operation` 판정에서 `args.get(k).is_none_or(Value::is_null)`을 쓴다. 채울 때 null 키를 덮어쓴다.

**(3) 상태 조회 순서**
- 증상: 범위 있는 요청이 열린 동안, 다른 디렉터리 프록시의 ID 없는 호출마다 HTTP(최대 3초)를 먼저 부른다.
- 수정: `Manager::runtime_of(instance) -> Option<(profile_id, wsl, record)>`와 `Manager::busy_in(record, directory)`로 나눈다. `resolve`는 프로필·디렉터리 검사가 통과했을 때만 HTTP를 부른다. 기존 `busy_sessions`는 두 함수를 묶은 형태로 남긴다(테스트 호환).

**(4) 비객체 상태 응답**
- 증상: 200이지만 객체가 아닌 응답을 "작업 중 없음"으로 본다.
- 수정: `Err`로 처리한다. 또 `"idle"`이 아닌 모든 `type`을 busy로 센다. 알 수 없는 새 상태도 안전한 쪽으로 간다.

**(5) 큐 직전 `paused` 재확인**
- 수정: `queue_operation_tool`, `run_tabs`의 new·switch·close `with_checked` 클로저에서 `op.paused`이면 handoff BUSY를 돌려준다. `wait_until_resumed`의 시간 초과 오류와 같은 문구·`details.handoff`다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`request_binding.rs`:

```rust
#[tokio::test]
async fn concurrent_id_less_first_calls_share_one_operation() {
    let f = setup(false).await;
    let (mut a, mut b) = (proxy(&f, Some("rid-now"), DIR).await, proxy(&f, Some("rid-now"), DIR).await);
    let (x, y) = tokio::join!(tool(&mut a, "browser_snapshot", json!({})), tool(&mut b, "browser_snapshot", json!({})));
    assert_eq!((x["ok"].clone(), y["ok"].clone()), (json!(true), json!(true)), "{x} {y}");
    assert_eq!(x["operationId"], y["operationId"]);
}

#[tokio::test]
async fn null_ids_count_as_omitted() {
    let f = setup(false).await;
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let read = tool(&mut mcp, "browser_snapshot", json!({"operationId": null})).await;
    assert_eq!(read["ok"], true, "{read}");
}

#[tokio::test]
async fn an_unreadable_status_reply_never_binds() {
    let f = setup(false).await;
    *f.statuses.lock().unwrap() = json!(["ses_cli"]);
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let attached = tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await;
    assert!(message(&attached).contains("Missing requestId"), "{attached}");
}

#[tokio::test]
async fn another_directory_does_not_query_status() {
    // fake_opencode가 받은 요청 수를 세도록 Fixture에 카운터를 추가한다
    // proxy(&f, Some("rid-now"), "C:\\other")로 attach {} → Missing requestId, 카운터 0
}
```

`runtime/mod.rs` 테스트에 추가한다. 가짜 서버 응답 `{"ses_x":{"type":"compacting"}}` → `busy == ["ses_x"]`.

`tool_router.rs`에 추가한다. pause와 enqueue 사이를 재현하기 어려우므로, 게이트 단위 테스트로 대신한다. `queue_operation_tool`이 쓰는 `with_checked` 클로저 판정을 `fn ensure_not_held(op:&Operation)->Result<(),RpcError>`로 빼서 단위 테스트한다. paused 작업이면 `details.handoff == true`인 BrowserBusy다.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --test request_binding --lib`
Expected: 새 테스트들 FAIL

- [x] **Step 3: 위 수정 내용대로 구현한다**

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge`
Expected: PASS

- [x] **Step 5: 커밋한다**

```bash
git add bridge
git commit -m "fix(bridge): share concurrent implicit attaches, accept null ids and recheck holds at enqueue"
```

### Task 2: content 스냅샷 — query의 비용과 범위

**Files:**
- Modify: `extension/src/content/snapshot.ts`(`rowText`, query 필터, `accessibleName` 재사용)
- Modify: `extension/src/background/handlers.ts`(frame 묶음의 query 결과 요약)
- Test: `extension/test/snapshot-query.test.ts`, `extension/test/handlers.test.ts`

**결함과 수정:**

**(1) 비용**
- 수정 내용:
  - 이름을 한 번만 계산해 `e.name`에 재사용한다.
  - 일치 검사는 `||`로 앞에서부터 멈춘다.
  - 행 글자는 `Map<Element,string>`에 캐시한다.
  - `innerText` 대신 `textContent.slice(0, 600)`로 먼저 자른다. 행 전체 직렬화를 피하려는 것이다.
- 정규화(`fold`)는 그대로 둔다.

**(2) 큰 부모를 행으로 보기**
- 증상: 행 선택자가 없을 때 `parentElement`가 `main`·`form`·`section` 같은 큰 영역이면 그 안의 모든 컨트롤이 일치한다.
- 수정: 부모의 글자가 300자를 넘으면 행으로 보지 않는다. 컨트롤 자신의 이름·값·href만 본다.

**(3) frame별 `query-no-match`**
- 증상: iframe에만 일치가 있으면 frame 0에 `query-no-match`가 붙어 모델이 "없음"으로 오해할 수 있다.
- 수정: background 묶음 결과(`handlers.ts`의 snapshot 묶음)에 `queryMatched: boolean`(전체 frame 기준)을 추가한다. 묶음에 일치가 하나라도 있으면 각 frame의 `query-no-match`를 지운다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("does not treat a large parent as a row", () => {
  document.body.innerHTML = `<main><p>${"긴 소개 문단. ".repeat(40)}주문 A-1003</p><button>저장</button><button>닫기</button></main>`;
  const result = takeSnapshot({ ...opts, query: "a-1003" });
  expect(result.elements.filter(e => e.role === "button")).toEqual([]);
});

it("reads each row's text once even for many controls in it", () => {
  document.body.innerHTML = `<article>${Array.from({ length: 300 }, (_, i) => `<a href="#${i}">링크 ${i}</a>`).join(" ")}</article>`;
  const spy = vi.spyOn(HTMLElement.prototype, "textContent", "get");
  takeSnapshot({ ...opts, query: "링크 299" });
  expect(spy.mock.calls.length).toBeLessThan(400);
});
```

`handlers.test.ts`: 두 frame(0: 일치 없음, 7: 일치 있음) 응답을 주입한다. 묶음의 `queryMatched === true`이고 frame 0의 `limits`에 `query-no-match`가 없음을 단언한다. frame 응답 주입은 같은 파일의 `R05 advances iframe text pages…` 테스트 구성을 따른다.

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

Run: `pnpm --filter agent-browser-extension exec vitest run test/snapshot-query.test.ts test/handlers.test.ts`

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "perf(extension): read row text once, ignore large parents and report query matches across frames"
```

### Task 3: background 동작 결과 — 늦은 이동 감시의 두 가장자리

**Files:**
- Modify: `extension/src/background/handlers.ts`(`lateNavigation`)
- Test: `extension/test/handlers.test.ts`

**결함과 수정:**

**(1) 새 탭 클릭의 1초 추가 대기**
- 수정: `children.openedTabs?.length`가 있으면 감시하지 않는다. 클릭이 새 탭을 연 것이 이미 관찰된 결과이기 때문이다.

**(2) 감시 중 취소**
- 증상: content가 실행을 확인한 클릭이 `EXECUTION_UNKNOWN`이 된다.
- 수정: 감시 루프의 `interruptible` 중단은 잡아서 원래 `result`를 그대로 반환한다. 이미 실행된 결과이고, 취소는 다음 명령부터 적용된다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

```ts
it('does not watch for late navigation after a click that opened a new tab', async () => {
  // sendToFrame click 결과 {executed:true, verified:{urlChanged:false, domChanged:false}}
  // trackCreatedTabs가 새 탭을 보고하도록 w.api.onCreatedNavigationTarget을 발화한다(같은 파일의 새 탭 테스트 방식)
  // 결과 시간이 감시 없이 끝나고(LATE_NAVIGATION_MS 미만 추가), openedTabs가 있음
});

it('keeps an executed click when it is cancelled during the late-navigation watch', async () => {
  // 클릭 결과 urlChanged/domChanged false, 200ms 뒤 browser.cancel(같은 요청)
  // 결과가 reject되지 않고 executed:true로 resolve
});
```

두 테스트는 같은 파일의 `reports a JS navigation that starts after the observation window`, 새 탭 감지 테스트, 취소 테스트의 도우미를 조합해 쓴다.

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

Run: `pnpm --filter agent-browser-extension exec vitest run test/handlers.test.ts`

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "fix(extension): skip the late-navigation watch for new tabs and keep executed clicks on cancel"
```

### Task 4: 표시·패널

**Files:**
- Modify: `extension/src/background/index.ts`(탭 이동 시 표시 다시 넣기)
- Modify: `extension/src/background/work-marker.ts`, `extension/src/content/highlight.ts`(`!important`)
- Modify: `extension/src/sidepanel/Workbench.tsx`(clientId 구독, `role="status"`, 버튼 중복 방지)
- Modify: `tests/e2e/reliability.spec.ts`(V01 단언 보강)
- Test: `extension/test/work-marker.test.ts`, `extension/test/workbench.test.ts`

**결함과 수정:**

**(1) 넘겨받은 동안 이동하면 표시가 사라짐**
- 수정: `chrome.webNavigation.onCommitted`(top frame, 권한 있음)에서 `marked`에 있는 탭이면 현재 라벨로 `markerScript`를 다시 실행한다. 판단 함수 `shouldRemark(tabId, frameId, marked)`를 `work-marker.ts`로 빼서 테스트한다.

**(2) 표시 스타일을 페이지 CSS가 덮어씀**
- 수정: host의 각 스타일에 `!important`를 붙인다(`setProperty(name, value, "important")`).

**(3) 패널이 clientId를 한 번만 읽음**
- 수정: `chrome.storage.onChanged`의 `clientId` 변경을 구독한다.

**(4) 안내 낭독·두 번 누름**
- 수정 내용:
  - 넘겨받기 안내 `div`에 `role="status"`를 단다.
  - 버튼은 요청 처리 중 `disabled`로 둔다. 상태 `handoffBusy`를 쓴다.

**(5) V01 보강**
- 수정: 테두리가 있는 탭의 스냅샷에 "필터 열기" 요소가 있음을 단언한다. 빈 스냅샷은 통과하지 못한다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("re-marks a held tab after it navigates", () => {
  expect(shouldRemark(5, 0, new Set([5]))).toBe(true);
  expect(shouldRemark(5, 3, new Set([5]))).toBe(false);
  expect(shouldRemark(6, 0, new Set([5]))).toBe(false);
});

it("marks with important styles so page CSS cannot make it clickable", () => {
  markerScript(true, "x");
  const host = document.getElementById("agent-browser-work-marker") as HTMLElement;
  expect(host.style.getPropertyPriority("pointer-events")).toBe("important");
});
```

`workbench.test.ts`:
- `clientId`가 바뀌면 버튼이 나타난다. 처음 storage에 없다가 `onChanged`로 들어오는 경우다.
- 안내 요소가 `role="status"`를 가진다.
- 클릭 직후 버튼이 `disabled`다.

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

Run: `pnpm --filter agent-browser-extension test && pnpm --filter agent-browser-extension build && pnpm --filter agent-browser-e2e exec playwright test reliability.spec.ts`

- [x] **Step 5: 커밋한다**

```bash
git add extension tests/e2e
git commit -m "fix(extension): keep markers through navigation and page CSS, and follow pairing changes in the panel"
```

### Task 5: 확장 설정 — 사용자 이름만 바꿀 때의 비밀번호 삭제 안내

**Files:**
- Modify: `extension/src/options/profile-form.ts:25-28`(`passwordDropped`), 호출부(`options/App.tsx`)
- Test: `extension/test/profile-form.test.ts`

**결함과 수정:** Bridge(`profile.rs` `preserve_secrets`)는 kind·baseUrl·username이 모두 같아야 비밀번호를 유지한다. 그런데 설정 화면의 안내는 baseUrl만 비교한다. 같은 조건으로 맞춘다.
- `original`에 `username?`을 받는다. 호출부는 Bridge 목록 요약의 `username`을 넘긴다. 실제 필드 이름은 `profile.list` 응답에서 확인한다.
- `kind`가 다르거나 username이 달라도 안내한다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("warns when only the username changes, as the Bridge drops the password then", () => {
  expect(passwordDropped({ kind: "external", baseUrl: "http://a", username: "u1", hasPassword: true },
    { kind: "external", baseUrl: "http://a", username: "u2" })).toBe(true);
  expect(passwordDropped({ kind: "external", baseUrl: "http://a", username: "u1", hasPassword: true },
    { kind: "external", baseUrl: "http://a", username: "u1" })).toBe(false);
});
```

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

Run: `pnpm --filter agent-browser-extension exec vitest run test/profile-form.test.ts`

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "fix(options): warn about a dropped password whenever the Bridge would drop it"
```

### Task 6: 설치기 — 탐색·표시·감지 비용

**Files:**
- Modify: `installer/SetupForm.cs`(`DiscoverRuntime`, `doneChecks`, `DetectExtension`, `pairingState`)
- Modify: `installer/Discovery.cs:117-131`(`FindWsl` 시간 제한)
- Test: `tests/install/SetupFlowTests.cs`

**결함과 수정:**

**(1) 꺼진 WSL 배포판 탐색**
- **배포판 칸이 비었을 때:** [배포판 켜고 찾기]가 아무것도 켜지 않는다. 칸이 비었으면 찾은 배포판 중 첫 번째(`runtimeDistribution.Items[0]`)를 쓴다. 그것도 없으면 "배포판 이름을 입력하세요"를 표시한다.
- **안내가 숨는 경우:** Windows 후보가 있으면 꺼진 배포판 안내(`found.Notices`)가 보이지 않는다. 후보 수와 상관없이 안내를 결과 문장 끝에 붙인다.
- **시간 제한:** 명시적으로 켜고 찾는 경로는 콜드 부팅을 위해 60초 제한을 쓴다. `Discovery.FindWsl(distribution, user, timeout)` 오버로드를 추가하며 기본값은 15초 그대로다.

**(2) 완료 화면의 긴 줄**
- 수정: `doneChecks.HorizontalScrollbar = true`

**(3) 확장 감지 비용**
- 증상: 1.5초마다 `BridgeControl.Start`(해시·WMI)를 실행한다.
- 수정: 4페이지에 들어갈 때 한 번만 시작한다(`ShowConnection`). 틱에서는 `Pairing.Status`만 부른다.

**(4) 긴 페어링 오류 잘림**
- 수정: `pairingState`를 `runtimeResult`와 같은 읽기 전용·여러 줄·세로 스크롤 `TextBox`로 바꾼다. 테스트의 `Field<Label>(form,"PairingState")` 참조를 함께 고친다.

- [x] **Step 1: 실패하는 Case를 쓴다**

`SetupFlowTests.cs`:

```csharp
   Case("long result and check lines stay readable",()=>{
    using(var form=new SetupForm(new[]{"--no-discover","--install-dir",Path.Combine(fixture,"read-lines")})){
     Assert(Field<ListBox>(form,"DoneChecks").HorizontalScrollbar,"final checks cannot scroll sideways");
     var state=Field<TextBox>(form,"PairingState");Assert(state.Multiline&&state.ReadOnly&&state.ScrollBars==ScrollBars.Vertical,"pairing errors are clipped");
    }
   });
```

탐색 동작은 WSL에 의존하므로 판단 부분만 뽑아 테스트한다. 함수는 `static string DistributionToStart(string typed, IEnumerable<string> found)`, `static string DiscoveryMessage(int candidates, IEnumerable<string> notices)`다.

```csharp
   Case("discovery uses the found distribution and always shows its notices",()=>{
    Assert(SetupForm.DistributionToStart("",new[]{"Ubuntu","Debian"})=="Ubuntu","empty field starts nothing");
    Assert(SetupForm.DistributionToStart(" Debian ",new[]{"Ubuntu"})=="Debian","typed name wins");
    Assert(SetupForm.DiscoveryMessage(2,new[]{"Debian is stopped"}).Contains("Debian is stopped"),"notices hidden behind candidates");
   });
```

두 함수는 `internal static`으로 두어 테스트가 접근하게 한다. 테스트 러너가 같은 어셈블리로 컴파일한다.

- [x] **Step 2: 실패를 확인한다**

Run: `bash scripts/test-installer-windows.sh SetupFlowTests`
Expected: 새 Case FAIL(컴파일 오류 포함)

- [x] **Step 3: 구현한다**

- [x] **Step 4: 통과를 확인한다**

Run: `AB_PACKAGE_ZIP=<방금 만든 dev 패키지> bash scripts/test-installer-windows.sh SetupFlowTests && … SetupDisplayTests`
Expected: PASS(배율 4종 포함)

- [x] **Step 5: 커밋한다**

```bash
git add installer tests/install
git commit -m "fix(installer): start the found WSL distribution, show its notices and keep long lines readable"
```

### Task 7: 전체 검증과 문서

- [x] **Step 1: 전체 검증**

```bash
cargo test --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-extension test
pnpm --filter agent-browser-extension exec tsc --noEmit -p .
pnpm --filter agent-browser-extension build && cargo build --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-e2e check
pnpm --filter agent-browser-e2e exec playwright test
bash scripts/test-windows.sh -- journeys.spec.ts reliability.spec.ts board-navigation.spec.ts
bash scripts/test-installer-windows.sh SetupFlowTests
```

실제 OpenCode 검사(Windows·`--wsl`)도 준비된 Windows 작업 폴더에서 다시 돌린다.

- [x] **Step 2: 문서를 갱신한다**

- `docs/status.md` 맨 위에 정리한 20건과 검증 결과를 적는다.
- `CHANGELOG.md` `[미배포]`에는 사용자에게 보이는 것만 한 줄씩 적는다.
  - 꺼진 WSL 배포판 찾기
  - 넘겨받는 동안 이동해도 표시 유지
  - 사용자 이름 변경 시 비밀번호 안내
  - 새 탭 클릭 지연 제거
- `docs/protocol.md`:
  - 묶음 `queryMatched`
  - `/session/status`의 idle 외 상태를 busy로 본다는 점
  - `null` ID 처리

- [x] **Step 3: 커밋한다**

```bash
git add docs CHANGELOG.md
git commit -m "docs: record the deferred fixes"
```

---

## 이후 계획

- **계획 4 — 선택 권한(CDP·tabGroups):** Task 1은 확인 작업이다. 확인할 것은 두 가지다.
  - Playwright가 제어 중인 Chrome에서 `chrome.debugger.attach`가 되는지
  - `optional_permissions`로 요청할 수 있는 권한
