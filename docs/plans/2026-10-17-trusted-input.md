# 신뢰 입력(CDP)과 작업 탭 묶음(계획 4) Implementation Plan

> **상태: 완료.** [PR #26](https://github.com/jihoon22-lee/agent-browser/pull/26)로 main에 병합했다(`8bd87a5`, 2026-10-17). v0.2.0에 포함. 실제 검증 결과와 남긴 항목은 [상태 기록](../status.md)과 PR 본문에 있다. 새 작업의 원장으로 쓰지 않는다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 합성 이벤트를 무시하는 사이트에서도 클릭·키 입력이 실제 사용자 입력처럼 동작하게 한다. 이를 위해 사용자가 설정에서 켜는 "신뢰 입력"(Chrome 디버거 입력)을 추가한다. 함께 처리하는 것:
- 작업 중 뜬 alert/confirm이 작업을 멈추지 않게 한다.
- 비활성 작업 탭도 화면을 캡처한다.
- 선택 권한으로 작업 탭을 "AgentBrowser" 탭 그룹에 묶는다.

**Architecture:**
- **권한:** `debugger`는 manifest 기본 권한에 넣는다. Chrome이 선택 권한으로 허용하지 않기 때문이다(공식 permissions 문서, 2026-10-17 확인).
- **설정:** 설정의 [신뢰 입력 사용](`chrome.storage.local.trustedInput`, 기본 꺼짐)을 켰을 때만 이 브라우저의 작업 탭에 붙이고, 작업이 끝나면 바로 뗀다.
- **클릭·키 입력:** 구조는 지금과 같다.
  1. content가 대상 판정·강조·변화 관찰을 맡는다.
  2. 실제 입력 순간에만 background에 "이 좌표를 눌러 달라"고 요청한다.
  3. background는 그 요청이 지금 실행 중인 명령(requestId)·탭·최상위 frame의 것인지 확인한 뒤 `Input.dispatchMouseEvent`/`dispatchKeyEvent`를 보낸다.
- **대체 경로:** 디버거를 쓸 수 없으면 지금의 DOM 합성 입력으로 돌아간다. 꺼져 있을 때, iframe 안일 때, 사용자가 디버깅 표시줄에서 [취소]를 눌렀을 때가 해당한다.
- **Bridge·도구 스키마:** 바꾸지 않는다. 결과의 `verified.trusted`가 어느 경로였는지 알린다.
- **탭 묶음:** `tabGroups` 선택 권한을 설정에서 허용하면 이 브라우저의 작업 탭을 그룹으로 묶고, 작업이 끝나면 직접 묶은 탭만 푼다.

**Tech Stack:** Chrome MV3 TypeScript(background·content·options React), `chrome.debugger`(CDP 1.3), `chrome.tabGroups`, vitest, Playwright E2E(Linux Chromium·Windows Chrome).

**Spec:**
- [docs/review-2026-10-15.md](../review-2026-10-15.md) B3(입력 충실도 — 선택형 CDP 입력 계층)와 B4(작업 탭 묶음)
- [docs/handoff.md](../handoff.md) §10 R10("DOM 방식으로 시작하고, 실제 대상 페이지에서 막히는 사례가 확인되면 선택적 chrome.debugger/CDP 제어를 검토한다")
- 사용자 결정(2026-10-17): debugger는 기본 권한에 넣고 설정으로 켠다.

## 확인한 사실 (2026-10-17)

- **선택 권한 여부:** Chrome 공식 문서의 "선택 권한으로 지정할 수 없는 권한" 목록에 `debugger`가 있다. `tabGroups`는 목록에 없으므로 선택 권한으로 둘 수 있다.
- **설치 시 경고:** 이 제품은 압축해제 확장으로 설치하므로 설치·업데이트 때 권한 확인 창이 뜨지 않는다.
- **Playwright와의 공존:** Playwright가 CDP로 제어 중인 Linux Chromium에서 확장의 `chrome.debugger.attach(tab, "1.3")`와 `Input.dispatchMouseEvent`가 동작했다. 실제로 버튼이 눌렸고(`aria-expanded` 변경) detach도 정상이었다. Windows Chrome에서는 Task 6에서 확인한다.
- **디버깅 표시줄:** 디버거를 붙이면 Chrome이 "AgentBrowser가 이 브라우저를 디버깅하는 중" 표시줄을 띄운다. 사용자가 [취소]를 누르면 `chrome.debugger.onDetach`(reason `canceled_by_user`)가 온다.

## Global Constraints

- **기본은 꺼짐.** 신뢰 입력을 켜지 않은 사용자의 동작은 지금과 한 글자도 다르지 않아야 한다. 기존 E2E 전체가 그대로 통과해야 한다.
- **디버거 범위:** 이 브라우저가 실행 중인 작업의 탭에만 붙인다. 작업이 끝나거나 탭이 작업에서 빠지면 즉시 뗀다. 사용자가 [취소]하면 그 작업 동안 다시 붙이지 않는다.
- **입력 요청 검증:** background는 content의 입력 요청을 다음이 모두 맞을 때만 수행한다. 페이지 스크립트는 확장 메시지를 보낼 수 없지만, 그래도 명령 단위로 묶는다.
  - 보낸 쪽이 이 확장의 content script다(`sender.id`, `sender.tab.id`, `sender.frameId === 0`).
  - 같은 탭에서 지금 실행 중인 click·press 명령의 requestId와 일치한다.
  - 신뢰 입력이 켜져 있다.
- **ref 안전 규칙·관찰 규칙은 그대로 둔다.** 대상 판정(`assertInteractable`)과 변화 관찰(`observeChanges`)은 content가 지금처럼 수행한다.
- **대화상자:**
  - 신뢰 입력으로 붙어 있는 동안 뜬 alert은 확인한다.
  - confirm·prompt·beforeunload는 취소한다. 결정은 사람이 해야 하기 때문이다.
  - 둘 다 결과 `verified.dialog {type, message(200자)}`로 알린다.
- **도구 정의 예산(< 4,800자)·결과 예산은 그대로 둔다.** 도구 스키마를 바꾸지 않는다.
- **새 권한:** `debugger`(기본), `tabGroups`(선택)만 추가한다.
- **커밋 메시지:** 영어 Conventional Commits, 과제 단위로 쓴다.

## Review Focus

1. **꺼진 상태의 무변화:** `trustedInput`이 없거나 false면 디버거를 한 번도 붙이지 않는다. → Task 2 `never_attaches_when_off`와 기존 E2E 전체 통과
2. **다른 출처의 입력 요청:** 실행 중이 아닌 requestId, 다른 탭, 하위 frame, 다른 확장의 요청은 거부되고 아무 입력도 보내지 않는다. → Task 3 단위 테스트 4개
3. **사용자가 [취소]:** 그 작업 동안 다시 붙지 않고 DOM 입력으로 계속하며, 결과에 `trusted:false`와 이유가 남는다. → Task 2 `user_cancel_falls_back_for_the_rest_of_the_operation`
4. **작업 종료·탭 이탈:** 붙인 디버거가 남지 않는다. 표시줄이 계속 떠 있으면 사용자가 불안해한다. → Task 2 `detaches_when_the_operation_ends_or_the_tab_leaves`, E2E `T03`
5. **confirm 대화상자:** 자동으로 확인하지 않는다. 취소하고 결과로 알린다. → Task 3 단위 테스트, E2E `T02`

---

### Task 1: 권한과 설정 토글

**Files:**
- Modify: `extension/public/manifest.json`(`permissions`에 `debugger`, `optional_permissions`에 `tabGroups`)
- Create: `extension/src/options/TrustedInputSetting.tsx`
- Create: `extension/src/options/TabGroupsPermission.tsx`(`BookmarksPermission.tsx`와 같은 형태)
- Modify: `extension/src/options/App.tsx`(두 섹션 추가)
- Test: `extension/test/options-trusted.test.ts`, `extension/test/manifest.test.ts`(있으면 보강, 없으면 생성)

**Interfaces:**
- Produces:
  - `chrome.storage.local.trustedInput: boolean`(기본 없음 = 꺼짐)
  - `TrustedInputSetting` 체크박스: 라벨 "신뢰 입력 사용(디버거)". 켤 때 경고 문장을 보여 준다.
    - 작업 중인 탭 위에 "AgentBrowser가 이 브라우저를 디버깅하는 중" 표시줄이 뜬다.
    - [취소]를 누르면 그 작업은 일반 입력으로 계속한다.
  - `TabGroupsPermission`: `chrome.permissions.request({permissions:['tabGroups']})`를 사용자 클릭 안에서 요청·해제한다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

```ts
import manifest from "../public/manifest.json";
it("asks for the debugger permission and offers tab groups only as optional", () => {
  expect(manifest.permissions).toContain("debugger");
  expect(manifest.optional_permissions).toContain("tabGroups");
  expect(manifest.permissions).not.toContain("tabGroups");
});
```

`options-trusted.test.ts`는 jsdom + React로 `TrustedInputSetting`을 렌더링한다. `chrome.storage.local` mock은 `workbench.test.ts`와 같은 방식이다.
- 처음에는 체크가 꺼져 있다.
- 클릭하면 `storage.local.set({trustedInput:true})`가 호출되고, 표시줄 경고 문장이 보인다.
- 다시 클릭하면 `false`가 된다.

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

Run: `pnpm --filter agent-browser-extension exec vitest run test/manifest.test.ts test/options-trusted.test.ts`

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "feat(extension): add an off-by-default trusted input setting and optional tab groups"
```

### Task 2: 디버거 세션 관리

**Files:**
- Create: `extension/src/background/trusted-input.ts`
- Test: `extension/test/trusted-input.test.ts`

**Interfaces:**
- Produces:

```ts
export type DebuggerApi = {
  attach(tabId: number): Promise<void>;          // chrome.debugger.attach({tabId}, "1.3")
  detach(tabId: number): Promise<void>;
  send<T = unknown>(tabId: number, method: string, params?: object): Promise<T>;
  onDetach(listener: (tabId: number, reason: string) => void): () => void;
  onEvent(listener: (tabId: number, method: string, params: any) => void): () => void;
};
export type TrustedState = { enabled: boolean; operationTabs: number[] };  // 이 브라우저의 작업 탭
export function trustedInput(api: DebuggerApi): {
  /** 붙일 수 있으면 붙이고 true. 꺼짐·작업 탭 아님·사용자 취소면 false. */
  ensure(tabId: number, state: TrustedState): Promise<boolean>;
  /** 작업 탭에서 빠진 탭과 꺼진 상태의 탭을 떼고, 작업이 바뀌면 취소 기록을 지운다. */
  sync(state: TrustedState & { operationId: string | null }): Promise<void>;
  click(tabId: number, x: number, y: number): Promise<{ dialog?: { type: string; message: string } }>;
  key(tabId: number, key: string): Promise<{ dialog?: { type: string; message: string } }>;
  screenshot(tabId: number): Promise<string>;       // data:image/png;base64,…
  cancelledReason(tabId: number): string | undefined;
}
```

- 붙인 직후 `Page.enable`을 보낸다. 대화상자 이벤트(`Page.javascriptDialogOpening`)를 받기 위해서다.
- 대화상자가 뜨면 `Page.handleJavaScriptDialog`로 응답한다. alert이면 `accept:true`, 그 밖은 `accept:false`다. 같은 탭의 다음 `click`/`key` 결과에 `dialog`로 한 번 싣는다.
- `onDetach` reason이 `canceled_by_user`면 그 작업 동안 `ensure`가 false다. 다른 이유(탭 닫힘, 대상 소멸)면 다음 `ensure`에서 다시 붙인다.
- 키 매핑:
  - `Enter` → `{key:"Enter", code:"Enter", windowsVirtualKeyCode:13, text:"\r"}`
  - `Tab`·`Escape`·`Backspace`·`ArrowUp`·`ArrowDown` → 해당 key/code/VK(9, 27, 8, 38, 40)
  - `Space` → `{key:" ", code:"Space", windowsVirtualKeyCode:32, text:" "}`
  - `keyDown`(text가 있으면 `type:"keyDown"`에 text 포함) 뒤 `keyUp`을 보낸다.
- 클릭은 `mouseMoved` → `mousePressed`(button left, clickCount 1) → `mouseReleased` 순서다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

가짜 `DebuggerApi`(호출 기록, onDetach·onEvent를 수동으로 발화)로 쓴다.

```ts
it("never_attaches_when_off", async () => { /* enabled:false → ensure false, attach 호출 0 */ });
it("attaches once to an operation tab and enables page events", async () => { /* ensure 두 번 → attach 1회, send("Page.enable") 1회 */ });
it("refuses a tab outside this browser's operation", async () => { /* operationTabs:[1], ensure(2) → false */ });
it("detaches_when_the_operation_ends_or_the_tab_leaves", async () => { /* ensure(1),ensure(2) → sync({operationTabs:[2]}) → detach(1); sync(null op) → detach(2) */ });
it("user_cancel_falls_back_for_the_rest_of_the_operation", async () => {
  /* ensure(1) → onDetach(1,"canceled_by_user") → ensure(1) false, cancelledReason(1)=="canceled_by_user"
     → sync({operationId:"op-2", …}) 뒤 ensure(1) true(새 작업은 다시 허용) */
});
it("accepts an alert, dismisses a confirm and reports each once", async () => {
  /* onEvent(1,"Page.javascriptDialogOpening",{type:"confirm",message:"삭제할까요?"}) → send("Page.handleJavaScriptDialog",{accept:false}) 기록
     → click(1,10,10) 결과 dialog {type:"confirm", message:"삭제할까요?"}, 다음 click은 dialog 없음 */
});
it("sends a full mouse click and key strokes", async () => { /* click → Input.dispatchMouseEvent 3회 순서, key("Enter") → keyDown(text "\r") keyUp */ });
```

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

Run: `pnpm --filter agent-browser-extension exec vitest run test/trusted-input.test.ts`

- [x] **Step 5: 커밋한다**

```bash
git add extension/src/background/trusted-input.ts extension/test/trusted-input.test.ts
git commit -m "feat(extension): manage debugger sessions for trusted input on operation tabs"
```

### Task 3: content의 신뢰 입력 요청과 background 검증

**Files:**
- Modify: `extension/src/content/actions.ts`(click), `extension/src/content/keyboard.ts`(press)
- Create: `extension/src/content/trusted.ts`(content → background 요청)
- Modify: `extension/src/background/handlers.ts`(실행 중 명령 조회 함수 노출: `isRunning(tabId, requestId, method)`)
- Modify: `extension/src/background/index.ts`(`trusted-input` 메시지 처리, 상태 연결)
- Test: `extension/test/actions.test.ts`, `extension/test/trusted-message.test.ts`

**Interfaces:**
- Consumes: Task 2 `trustedInput`, `chrome.storage.local.trustedInput`, Bridge `status.changed`(작업 탭)
- Produces:
  - content `requestTrusted(kind:"click"|"key", payload): Promise<{ok:true; dialog?:{…}} | {ok:false; reason:string}>`
    - `chrome.runtime.sendMessage({kind:"trusted-input", requestId, action, …})`를 보낸다.
    - 응답이 없거나 실패면 `{ok:false}`다.
  - click 흐름:
    1. 지금처럼 판정·강조·관찰을 시작한다.
    2. 이 frame이 최상위(`window === window.top`)이고 명령 매개변수 `trusted === true`면 `requestTrusted("click",{x,y})`를 보낸다.
    3. `ok`면 합성 이벤트를 보내지 않는다.
    4. 결과는 `verified: {...changes, trusted: true, dialog?}`다. `ok:false`면 지금처럼 합성 이벤트를 보내고 `trusted:false, trustedReason`을 붙인다.
  - press 흐름:
    1. 대상에 포커스를 준다(`ref`가 있으면 `focus()`).
    2. `requestTrusted("key",{key})`를 보낸다.
    3. `ok`면 결과는 `{key, trusted:true, ...observeChanges(500)}`다. 기본 동작 재구현(`defaultApplied` 등)은 하지 않는다. 브라우저가 실제로 수행하기 때문이다.
  - background:
    - click·press를 content에 보내기 전에 `trustedInput.ensure(tabId, state)`를 호출한다.
    - `true`면 명령 매개변수에 `trusted:true`를 넣는다. 꺼져 있으면 넣지 않으므로 content는 지금과 똑같이 동작한다.
  - `trusted-input` 메시지 검증(전부 만족해야 수행):
    - `sender.id === chrome.runtime.id`, `sender.tab?.id`가 있고 `sender.frameId === 0`
    - `handlers.isRunning(sender.tab.id, msg.requestId, "browser.click" | "browser.press")`
    - 신뢰 입력 켜짐, 그리고 그 탭이 붙어 있음

- [x] **Step 1: 실패하는 테스트를 쓴다**

`trusted-message.test.ts`는 검증 함수 `acceptTrustedRequest(msg, sender, ctx)`를 순수 함수로 빼서 테스트한다.

```ts
it("accepts only a running click or press of this tab's top frame", () => {
  const ctx = { runtimeId: "ext", running: (tab: number, id: string, m: string) => tab === 1 && id === "r1" && m === "browser.click", enabled: true, attached: (t: number) => t === 1 };
  const ok = { kind: "trusted-input", requestId: "r1", action: "click", x: 1, y: 2 };
  expect(acceptTrustedRequest(ok, { id: "ext", tab: { id: 1 }, frameId: 0 }, ctx)).toBe(true);
  expect(acceptTrustedRequest(ok, { id: "other", tab: { id: 1 }, frameId: 0 }, ctx)).toBe(false);
  expect(acceptTrustedRequest(ok, { id: "ext", tab: { id: 2 }, frameId: 0 }, ctx)).toBe(false);
  expect(acceptTrustedRequest(ok, { id: "ext", tab: { id: 1 }, frameId: 3 }, ctx)).toBe(false);
  expect(acceptTrustedRequest({ ...ok, requestId: "old" }, { id: "ext", tab: { id: 1 }, frameId: 0 }, ctx)).toBe(false);
  expect(acceptTrustedRequest(ok, { id: "ext", tab: { id: 1 }, frameId: 0 }, { ...ctx, enabled: false })).toBe(false);
});
```

`actions.test.ts`에 추가한다.
- `trusted:true` 클릭에서 `chrome.runtime.sendMessage` mock이 `{ok:true}`를 돌려주면, 합성 `click` 이벤트가 페이지에 가지 않고 결과에 `trusted:true`가 있다.
- mock이 `{ok:false, reason:"canceled_by_user"}`면 합성 이벤트가 가고 결과에 `trusted:false, trustedReason:"canceled_by_user"`가 있다.

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

Run: `pnpm --filter agent-browser-extension test`
Expected: 새 테스트 PASS, 기존 전체 PASS(꺼진 상태 무변화)

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "feat(extension): send clicks and keys as trusted input when enabled, falling back to DOM events"
```

### Task 4: 비활성 탭 캡처

**Files:**
- Modify: `extension/src/background/handlers.ts:287-300`(`browser.screenshot`)
- Test: `extension/test/handlers.test.ts`

**Interfaces:**
- Consumes: Task 2 `screenshot(tabId)`
- Produces: 탭이 비활성이고 신뢰 입력이 붙을 수 있으면, 지금의 `NEEDS_TAB_ACTIVATION` 대신 `Page.captureScreenshot` 결과를 돌려준다. 붙을 수 없으면 지금처럼 `NEEDS_TAB_ACTIVATION`이다.

`createHandlers`에 선택 의존성 `trusted?: { ensure(tabId): Promise<boolean>; screenshot(tabId): Promise<string> }`을 추가한다. 테스트에서 가짜로 넣을 수 있다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

```ts
it('captures an inactive operation tab through trusted input when available', async () => {
  // w.tabs.get(1).active=false; trusted {ensure:async()=>true, screenshot:async()=>'data:image/png;base64,AAAA'}
  // browser.screenshot → 결과 base64 'AAAA', captureVisibleTab 미호출
});
it('still asks for activation when trusted input is unavailable', async () => {
  // ensure:async()=>false → NEEDS_TAB_ACTIVATION
});
```

결과 형식은 같은 파일의 기존 screenshot 테스트(`browser.screenshot` 결과 필드)를 따른다.

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "feat(extension): capture an inactive operation tab through trusted input"
```

### Task 5: 작업 탭 묶음

**Files:**
- Create: `extension/src/background/tab-groups.ts`
- Modify: `extension/src/background/index.ts`(status 변화 때 동기화)
- Test: `extension/test/tab-groups.test.ts`

**Interfaces:**
- Produces: `syncGroup(api, state:{granted:boolean; tabs:number[]; windowGroup?:number}, previous): Promise<GroupState>`
  - 권한이 있고 이 브라우저의 작업이 있으면 작업 탭을 하나의 그룹("AgentBrowser", 파란색)에 넣는다. 사용자가 이미 다른 그룹에 둔 탭은 옮기지 않는다.
  - 작업에서 빠진 탭, 작업이 끝난 탭 중 **우리가 넣은 탭만** 그룹에서 뺀다.
  - `api`는 `tabs.group`, `tabs.ungroup`, `tabGroups.update`, `tabs.get`만 가진 얇은 인터페이스다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("groups operation tabs and ungroups only the tabs it grouped", async () => { /* … */ });
it("leaves tabs the user already grouped alone", async () => { /* groupId !== -1인 탭은 group 호출 없음, 끝날 때 ungroup 없음 */ });
it("does nothing without the permission", async () => { /* granted:false → 호출 0 */ });
```

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "feat(extension): group operation tabs when the optional tab groups permission is granted"
```

### Task 6: 실제 브라우저 검증과 문서

**Files:**
- Create: `tests/e2e/trusted-input.spec.ts`(T01~T04), `tests/fixtures/site/trusted.html`
- Modify: `tests/e2e/playwright.config.ts`(testMatch에 추가)
- Modify:
  - `docs/user-guide.md`(신뢰 입력·탭 묶음)
  - `docs/browser-capabilities.md`
  - `docs/protocol.md`(`verified.trusted`·`trustedReason`·`dialog`)
  - `docs/troubleshooting.md`(디버깅 표시줄)
  - `CHANGELOG.md`
  - `docs/status.md`
  - `docs/review-2026-10-15.md` §E(계획 4 반영)

**`trusted.html`(합성 fixture):**
- `isTrusted`가 false인 click을 무시하고, true일 때만 `#result`에 "눌림"을 쓰는 버튼
- alert을 띄우는 버튼, confirm을 띄우고 결과를 쓰는 버튼

**E2E(신뢰 입력은 `adminPage`에서 `chrome.storage.local.set({trustedInput:true})`로 켠다):**
- **T01:** 꺼진 상태에서는 isTrusted 버튼이 반응하지 않는다(`verified.trusted` 없음). 켠 상태에서는 반응하고 `verified.trusted === true`다.
- **T02:**
  - alert 버튼 클릭: 결과 `verified.dialog.type === "alert"`이고 다음 snapshot이 정상이다(작업이 막히지 않음).
  - confirm 버튼 클릭: `dialog.type === "confirm"`이고 페이지 결과는 "취소"다.
- **T03:** release 뒤 탭에 디버거가 붙어 있지 않다. 이는 `chrome.debugger.getTargets()`의 해당 탭 `attached === false`로 확인한다(adminPage에서 조회).
- **T04:** 비활성 작업 탭의 `browser_screenshot`이 이미지를 돌려준다(켠 상태).

Linux와 Windows에서 모두 실행한다. Windows에서 Playwright 제어 중 `chrome.debugger`가 동작하지 않으면 그 사실을 status.md에 적고 T 테스트를 Windows에서 건너뛴다(`test.skip(process.platform==='win32', 이유)`). 이 결정은 ruling으로 남긴다.

- [x] **Step 1: E2E를 쓰고 실패를 확인한다**(Task 1~5 이후라 대부분 통과한다. 꺼진 상태 단언으로 회귀를 고정한다)
- [x] **Step 2: 전체 검증**

```bash
cargo test --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-extension test && pnpm --filter agent-browser-extension exec tsc --noEmit -p .
pnpm --filter agent-browser-extension build && cargo build --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-e2e check && pnpm --filter agent-browser-e2e exec playwright test
bash scripts/test-windows.sh -- journeys.spec.ts reliability.spec.ts board-navigation.spec.ts trusted-input.spec.ts
```

실제 OpenCode 검사(Windows·`--wsl`)도 다시 돌린다(꺼진 상태 무변화 확인).

- [x] **Step 3: 문서를 갱신하고 커밋한다**

```bash
git add tests docs CHANGELOG.md
git commit -m "docs: describe trusted input and operation tab groups with real browser checks"
```
