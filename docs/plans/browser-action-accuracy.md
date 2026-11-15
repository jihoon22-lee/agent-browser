# 브라우저 조작 정확도: 성공으로 보고되는 실패 줄이기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 신뢰 입력을 끈 기본 설정에서 도구가 "실행됨"이라고 답했는데 페이지에서는 아무 일도 없었거나 다른 대상에 실행된 경우를 없애고, 멈춘 페이지의 원인을 모델이 알 수 있게 한다.

**Architecture:** 과제마다 문제를 재현하는 fixture와 단언을 먼저 넣는다. 수정은 확장의 content script(`extension/src/content/`)와 service worker(`extension/src/background/handlers.ts`) 안에서 끝내고, MCP 도구 스키마(`bridge/src/mcp/tools.rs`)의 매개변수는 건드리지 않는다. 결과에 붙는 필드는 추가만 한다.

**Tech Stack:** TypeScript, vitest + jsdom(단위), Playwright + Linux Chromium과 Linux 테스트 Bridge(E2E), Rust(Bridge 문구 한 곳).

**Spec:** 이 문서의 "근거" 절. 2026-11-15 검토에서 Linux headless Chromium 156.0.8078.4와 단위 테스트의 임시 프로브로 재현했고 프로브는 삭제했다. Windows와 실제 모델은 실행하지 않았다.

## Global Constraints

- MCP 도구의 이름·매개변수·`additionalProperties`를 바꾸지 않는다. 도구 정의 전체는 8,500자 미만이어야 한다(`bridge/src/mcp/tools.rs:119`, 현재 7,655자). 설명 문구를 고칠 때 이 한도를 확인한다.
- 결과 객체는 필드 추가만 한다. 기존 필드의 의미를 바꾸지 않는다.
- 신뢰 입력(Chrome 디버거)은 기본 꺼짐이다. 모든 과제의 테스트는 신뢰 입력을 끈 상태에서 통과해야 한다.
- 비멱등 동작을 자동 재시도하지 않는다. 실패는 `executed`와 `retry` 값으로 구분해 알린다.
- 과제마다 실패 테스트 먼저, 직접 영향받는 테스트만 실행한다. 전체 E2E(약 8분)는 마지막 과제에서 한 번 돈다.
- E2E는 합성 페이지만 쓴다. 실제 모델 호출 없음. 실제 모델 정확도에 대한 주장을 문서에 쓰지 않는다.
- 품질 gate(`tests/e2e/browser-quality.spec.ts`의 Q01~)는 13/13으로 포화 상태다. 새 문제는 새 fixture로만 측정된다.

## 결정이 필요한 것 (이 계획에 넣지 않았다)

기본안을 적었지만 사용자 답을 받은 뒤 별도 과제로 만든다.

| 항목 | 내용 | 기본안 |
|---|---|---|
| 선언되지 않은 인자 | Bridge가 스키마에 없는 인자를 조용히 버린다(`bridge/src/server/router.rs:92`). `browser_click {button:"right"}`가 일반 클릭으로 실행됐다 | 거부하지 않고 결과에 `ignored:["button"]`을 추가. 거부는 형식이 느슨한 무료 모델의 호출을 깨뜨릴 수 있다. OpenCode가 먼저 걸러 주는지 확인하지 못했다 |
| 결과 스냅샷 순서 | 클릭 결과에 붙는 스냅샷(요소 40개)이 문서 순서라, 클릭이 방금 연 대화상자가 빠진다(`router.rs:553`) | 관찰 구간에 추가된 노드를 먼저 싣는다. `elementOffset` 페이징 의미가 달라져 결정 필요 |
| 스크롤 영역 노출 | 내부 스크롤 영역이 스냅샷에 요소로 나오지 않아 ref가 없다 | `state:"scrollable"`인 요소로 추가. 요소 예산을 쓴다 |
| 새 매개변수 | 좌우 스크롤, 다중 선택, 실제 키 입력 모드, 여러 필드 한 번에 채우기, DOM 안정 대기 | 스키마 예산 845자 안에서 우선순위를 정해야 한다 |

## 근거

모두 신뢰 입력 꺼짐. "재현"은 프로브가 실제로 낸 결과다.

1. **재사용된 행에서 옛 ref 실행 (단위 재현).** `<div class="row"><span>A-1001</span><p><button>Cancel</button></p></div>` 두 행. 스냅샷은 `context:"A-1001…"`을 보여 주지만, 첫 행의 id를 `C-3003`으로 바꾼 뒤 옛 ref로 클릭하면 `C-3003`에서 실행된다. `div>span+span>button`, 글자 300자 초과 카드, div 4단계 아래 버튼도 같다. `tr`·`ul>li`는 `STALE_ELEMENT`로 거부된다. 원인: `extension/src/content/record-context.ts:18-21`의 `div,section`만 허용, 3단계, 300자 제한.
2. **`browser_select`에 `option`이 없을 때 (재현).** `<select><option value="">Choose…</option><option value="kr" selected>Korea</option>…`에 `{ref}`만 보내면 `{"executed":true,"verified":{"value":"","matches":true,"label":"Choose…"}}`. 원인: `extension/src/content/actions.ts:392`의 `String(p.option ?? "")`.
3. **스크롤할 수 없는 문서 (재현).** `html,body{height:100%;overflow:hidden}`에 `#scroller{flex:1;overflow:auto}`(200행). 문서 스크롤은 `{"atEnd":true,"atStart":true,"scrollHeight":720,"scrollTop":0}`, `executed:"yes"`. 영역 안 버튼의 ref로 스크롤하면 버튼 자체를 스크롤한다(`scrollHeight:17`). 실제 위치는 0 그대로. 원인: `actions.ts:498`, `:507`.
4. **`window.open`을 부르는 클릭 (재현).** 팝업 차단을 켠 Chrome에서 `window.open returned null`, 새 탭 0개인데 결과는 `ok:true, executed:"yes"`. E2E 하네스는 Playwright 기본값(`--disable-popup-blocking`)이라 기존 테스트로는 보이지 않는다(`tests/e2e/harness.ts:201`). `target=_blank` 링크는 차단 여부와 무관하게 탭이 열린다.
5. **`confirm()`이 뜬 페이지 (재현, 포그라운드 탭만).** 클릭은 15,004ms 뒤 `EXECUTION_UNKNOWN`("Take a snapshot to check…"), 그 스냅샷은 15,003ms 뒤 `TIMEOUT`("The browser did not answer in time."). 원인 문구는 `bridge/src/server/registry.rs:44-46`. 작업 탭의 기본인 백그라운드 탭은 실행하지 않았다.
6. **고정 헤더·푸터 (재현).** 80px `position:fixed` 헤더·푸터, 3000px 문서. 화면 아래 대상은 `scrollIntoView({block:"nearest"})` 뒤 푸터 밑에 놓여 `"… is covered by another element."`, `retry:"never"`. 원인: `actions.ts:73`.
7. **이벤트가 ref 요소에 전달됨 (재현).** `<div tabindex="0" aria-label="Open panel"><span>Open the panel</span></div>`에서 리스너가 span에 있거나, `<tr style="cursor:pointer">`에서 표의 핸들러가 `e.target.closest('td')`를 볼 때 `executed:"yes"`, 핸들러 미실행. 원인: `actions.ts:293`, `:331`.
8. **CSS `:hover` 메뉴 (에이전트 재현 보고).** `.sub{display:none} #m:hover .sub{display:block}`. hover는 `executed:"yes"`, `domChanged:false`, 하위 메뉴는 그대로 숨어 있다. 원인: `actions.ts:298`. 기존 fixture(`tests/fixtures/site/pointer.html:23`)는 `mouseenter`로 class도 붙여서 통과한다.
9. **contenteditable의 Enter (에이전트 재현 보고).** Enter로 전송하는 `<div contenteditable role="textbox">`. `browser_press Enter`는 키 이벤트를 보내기 전에 `ELEMENT_NOT_INTERACTABLE`("Keyboard editing of rich editable areas is not supported.")로 끝난다. 원인: `extension/src/content/keyboard.ts:79-81`.
10. **대기 텍스트 (에이전트 재현 보고).** `text-transform:uppercase`인 제목, 표의 두 칸, `&nbsp;`가 든 문장에서 눈에 보이는 문구로는 `TIMEOUT`. `query`는 대소문자·공백을 접어서 같은 문구로 찾는다. 원인: `extension/src/content/wait.ts:18`.

낮음(이 계획 밖): 입력 종류 표시 누락과 select의 option 텍스트가 이름·본문에 섞이는 문제, 스냅샷 5회 뒤 ref 만료(`extension/src/content/refs.ts:7`)와 틀린 stale 문구, `browser_fill`의 `maxlength` 무시와 keyup 누락.

## Review Focus

- 묶는 범위를 넓힌 뒤, 값만 바뀌는 폼 필드 래퍼(도움말 문구가 나타나는 `div.field`)에서 같은 ref의 두 번째 입력이 stale로 거부되면 안 된다(Task 1의 음성 테스트).
- 문서와 내부 영역이 모두 스크롤될 때 ref 없는 스크롤은 지금처럼 문서를 스크롤해야 한다(Task 3).
- 응답 제한을 넣은 뒤, 느리지만 정상인 페이지(이동 직후 6초 걸리는 스냅샷)가 "대화상자" 안내로 잘못 끝나면 안 된다(Task 4).
- 백그라운드 탭에서 `confirm()`이 뜬 경우의 동작은 검토에서 실행하지 않았다(Task 4의 E2E가 처음 확인한다).
- 팝업 차단을 켠 뒤 기존 E2E 중 `window.open`에 의존하던 것이 어떻게 실패하는지(Task 6이 목록을 만든다).

---

### Task 1: 스냅샷이 보여 준 문맥에 ref를 묶는다

**Files:**
- Modify: `extension/src/content/record-context.ts`(`recordRoot`), 필요하면 `extension/src/content/refs.ts`(`bindTarget`)
- Test: `extension/test/record-context.test.ts`, `tests/e2e/browser-quality.spec.ts` + `tests/fixtures/site/quality.html`

**Interfaces:**
- Consumes: `recordRoot(el: Element): Element | null`, `recordText`, `resolveRef(ref, allowDetached, scope)`.
- Produces: 규칙 — 스냅샷이 어떤 요소에 `context`를 내보냈다면 그 `context`를 만든 조상이 그 ref의 record root다.

- [ ] **Step 1: 실패하는 단위 테스트** — 근거 1의 네 마크업 각각에 대해 "스냅샷 → 첫 행의 식별 텍스트 교체 → 옛 ref로 click"이 `STALE_ELEMENT`임을 단언한다. `tr`·`ul>li` 대조군도 `STALE_ELEMENT`. 음성 테스트: `<div class="field"><label>Email</label><div><input></div><p class="helper"></p></div>`에서 첫 fill이 helper 문구를 채운 뒤 같은 ref의 두 번째 fill이 성공한다(현재는 `STALE_ELEMENT`). 반대 방향 보호: 식별 텍스트가 바뀐 재사용 행(`tr`과 `div.row`) 안의 `input`에 옛 ref로 fill하면 여전히 `STALE_ELEMENT`다(폼 컨트롤 예외가 행 재사용 보호를 풀면 안 된다).
- [ ] **Step 2: 실패 확인** — Run: `cd extension && pnpm exec vitest run test/record-context.test.ts`. Expected: 네 마크업에서 "EXECUTED" 쪽 단언 실패, 음성 테스트 실패.
- [ ] **Step 3: 구현** — `context`를 계산하는 경로와 `recordRoot`가 같은 조상을 쓰게 한다. 폼 컨트롤(`input`·`textarea`·`select`·contenteditable)은 자기 값과, 같은 필드 래퍼 안의 도움말 문구 변화만으로는 stale이 되지 않게 한다. 행을 식별하는 텍스트(다른 칸의 id·제목)가 바뀐 경우는 폼 컨트롤도 stale이다.
- [ ] **Step 4: 통과 확인** — 같은 명령, 그리고 `pnpm exec vitest run test/refs-format.test.ts test/actions.test.ts test/snapshot.test.ts`.
- [ ] **Step 5: 품질 fixture 추가** — `quality.html`의 Q01 행에 버튼을 `p`로 감싼 변형을 추가하고 `browser-quality.spec.ts`에 `Q01b`를 넣는다. Run: `pnpm --filter agent-browser-e2e exec playwright test browser-quality.spec.ts -g "Q01"`.
- [ ] **Step 6: Commit** — `fix(extension): bind a ref to the record its snapshot context came from`

### Task 2: `<select>`에는 `option`이 필요하다

**Files:**
- Modify: `extension/src/content/actions.ts:392` 부근
- Test: `extension/test/actions.test.ts`

- [ ] **Step 1: 실패하는 테스트** — 근거 2의 select에 `{ref}`만 보내면 `INVALID_PARAMS`, 메시지에 `option`이 들어 있고 실제 `select.value`는 `"kr"` 그대로임을 단언. `{ref, option:""}`(빈 값을 명시)는 지금처럼 빈 항목을 고른다. checkbox·radio 경로는 그대로다.
- [ ] **Step 2: 실패 확인** — Run: `cd extension && pnpm exec vitest run test/actions.test.ts`.
- [ ] **Step 3: 구현** — `HTMLSelectElement`이고 `p.option`이 `undefined`·`null`이면 `ProtocolError("INVALID_PARAMS", "browser_select on a <select> needs option (its value or visible label).")`.
- [ ] **Step 4: 통과 확인 후 Commit** — `fix(extension): require option when selecting in a <select>`

### Task 3: 스크롤은 실제로 움직일 수 있는 영역을 움직이고, 못 움직였으면 그렇게 말한다

**Files:**
- Modify: `extension/src/content/actions.ts:497-508`(`scroll`)
- Create: `tests/fixtures/site/scroll-shell.html`
- Test: `extension/test/actions.test.ts`, `tests/e2e/browser-capabilities.spec.ts`

**Interfaces:**
- Produces: `browser_scroll` 결과의 `verified`에 `moved: boolean`과 `target: "document" | "ancestor" | "region"` 추가. `atStart`·`atEnd`는 실제로 스크롤한 요소 기준.

- [ ] **Step 1: fixture와 실패하는 E2E** — `scroll-shell.html`은 근거 3의 마크업(200행, 영역 안에 버튼 두 개). 단언: (a) ref 없이 `down` → `moved:true`, `target:"region"`, 영역의 `scrollTop > 0`. (b) 영역 안 버튼의 ref로 `down` → `target:"ancestor"`, `moved:true`. (c) `bottom` 뒤 `down` → `moved:false`, `atEnd:true`. (d) 문서도 스크롤되는 기존 페이지에서 ref 없이 `down` → `target:"document"`(기존 동작 유지).
- [ ] **Step 2: 실패 확인** — Run: `pnpm --filter agent-browser-e2e exec playwright test browser-capabilities.spec.ts -g "scroll"`.
- [ ] **Step 3: 구현** — 대상 선택: ref가 있으면 그 요소부터 위로 올라가며 세로로 스크롤 가능한 첫 요소(`scrollHeight > clientHeight`이고 `overflow-y`가 `auto`·`scroll`), 없으면 문서. ref가 없고 문서가 스크롤 불가면 화면에 보이는 스크롤 가능 요소 중 면적이 가장 큰 것. `moved`는 실행 전후 `scrollTop` 비교.
- [ ] **Step 4: 단위 테스트 추가·통과 확인 후 Commit** — `fix(extension): scroll the nearest scrollable area and report whether it moved`

### Task 4: 멈춘 페이지는 대화상자 가능성을 알린다

**Files:**
- Modify: `extension/src/background/handlers.ts:85`(`send`)
- Test: `extension/test/handlers.test.ts`, `tests/e2e/dialog-input.spec.ts`(fixture는 기존 `tests/fixtures/site/trusted.html`의 confirm 버튼)

**Interfaces:**
- Produces: content script가 **그 요청 자신의 대기 기한 + 10,000ms** 안에 답하지 않으면 확장이 직접 오류를 돌려준다. `send`는 `waitFor`(최대 30초)가 붙은 click·press, `browser_wait`, 이동 뒤 스냅샷(`settleMs`)도 나르므로 고정 10초로 끊으면 정상 대기를 오류로 만든다. 대기 기한이 없는 요청은 10,000ms다. 코드는 지금과 같다(쓰기 `EXECUTION_UNKNOWN`/`retry:"unsafe"`, 읽기 `TIMEOUT`/`retry:"safe"`). 메시지: `The page did not answer in time. A page dialog (alert, confirm or prompt) may be open: answer it in Chrome, then take a new browser_snapshot before repeating anything.` `details.reason = "page-unresponsive"`.

- [ ] **Step 1: 실패하는 단위 테스트** — `sendToFrame`이 끝나지 않는 가짜 Chrome API와 가짜 타이머로, 대기 기한이 없는 click이 10초를 넘기면 위 코드·메시지·`details.reason`이 나오고 9.9초에 답한 요청은 정상 결과임을 단언. `waitFor.timeoutMs=20000`인 click은 25초에 답해도 정상 결과이고 30초를 넘겨야 끊긴다. `browser_wait`와 `settleMs`가 있는 스냅샷도 같은 규칙이다(Review Focus 3).
- [ ] **Step 2: 실패 확인** — Run: `cd extension && pnpm exec vitest run test/handlers.test.ts`.
- [ ] **Step 3: 구현** — `send`에 위 규칙의 응답 제한을 건다. Bridge도 명령마다 제한을 둔다(대기 기한이 없는 click·snapshot은 약 15초로 관찰됨). `bridge/src/server/router.rs`에서 명령별 제한 계산을 읽고, 확장의 제한이 모든 명령에서 Bridge보다 먼저 끝나는지 확인한다. 그렇지 않은 명령이 있으면 여유 값을 그 명령에 맞춘다.
- [ ] **Step 4: 실패하는 E2E** — 신뢰 입력 꺼짐, `page.on('dialog')`로 대화상자를 붙잡아 둔다. 대기 기한 없는 click 결과가 12초 안에 오고 메시지에 `dialog`가 들어 있음, 이어지는 snapshot도 같은 안내임을 단언. 같은 테스트를 작업 탭이 백그라운드인 상태로 한 번 더 넣는다.
- [ ] **Step 5: 통과 확인 후 Commit** — `fix(extension): say a page dialog may be open when the page stops answering`

### Task 5: 효과가 없었던 클릭·hover를 표시하고, 포인터 아래 요소에 이벤트를 보낸다

**Files:**
- Modify: `extension/src/content/actions.ts`(클릭 경로 `:73`, `:293`, `:298`, `:331`)
- Create: `tests/fixtures/site/hit-target.html`
- Test: `extension/test/actions.test.ts`, `tests/e2e/pointer-keys-upload.spec.ts`

**Interfaces:**
- Produces: click·hover 결과의 `verified`에 `noEffect: true` 추가(조건: `domChanged:false`, `urlChanged:false`, 이동 없음, 새 탭 없음). 포커스 이동은 조건에 넣지 않는다. 클릭은 mousedown에서 대상에 포커스를 주므로(`extension/src/content/actions.ts:320`의 `focusFromPointer`) 포커스를 조건에 넣으면 클릭에서는 이 표시가 켜지지 않는다. 값이 없으면 효과가 관찰됐다는 뜻이다.

- [ ] **Step 1: fixture와 실패하는 테스트** — `hit-target.html`: 근거 7의 두 마크업, 근거 6의 고정 헤더·푸터와 화면 밖 버튼 두 개, 근거 8의 `:hover` 전용 메뉴. 단언: (a) wrapper 클릭 → span의 리스너가 실행된다. (b) `tr` 클릭 → `td` 위임 핸들러가 실행된다. (c) 푸터 아래·헤더 위 버튼 클릭이 성공하고 페이지가 click을 받는다. (d) `:hover` 메뉴 hover → `noEffect:true`. (e) 아무 리스너도 없는 `<button>` 클릭 → `noEffect:true`, 화면을 바꾸는 버튼 클릭 → `noEffect` 없음.
- [ ] **Step 2: 실패 확인** — Run: `pnpm --filter agent-browser-e2e exec playwright test pointer-keys-upload.spec.ts -g "hit target"`.
- [ ] **Step 3: 구현** — (a)(b) 이벤트 대상은 클릭 지점의 최상위 요소가 ref 요소의 자손일 때 그 자손. (c) `nearest` 스크롤 뒤 모든 후보 지점이 가려졌으면 `block:"center"`로 한 번 더 스크롤하고 다시 판정. (d) 관찰 구간이 끝났을 때 변화가 없으면 `noEffect:true`.
- [ ] **Step 4: 통과 확인 후 Commit** — `fix(extension): click the element under the pointer and flag actions with no effect`

### Task 6: E2E를 팝업 차단을 켠 Chrome으로 돌린다

**Files:**
- Modify: `tests/e2e/harness.ts:201-208`
- Modify: 실패하는 spec(`journeys.spec.ts`의 J23, `new-tabs.spec.ts` 등 — Step 2가 목록을 만든다)
- Modify: `docs/browser-capabilities.md`("링크를 새 탭으로" 행)

- [ ] **Step 1: 하네스 변경** — `ignoreDefaultArgs`에 `--disable-popup-blocking`을 항상 넣는다(기존 조건부 배열과 합친다).
- [ ] **Step 2: 영향받는 spec 확인** — Run: `pnpm --filter agent-browser-e2e exec playwright test journeys.spec.ts new-tabs.spec.ts pointer-keys-upload.spec.ts`. 실패한 테스트 이름을 커밋 메시지에 적는다.
- [ ] **Step 3: 테스트를 실제 동작에 맞춘다** — 신뢰 입력을 끈 상태에서 스크립트가 여는 창은 열리지 않는다는 것이 실제 동작이다. 해당 테스트는 (a) 신뢰 입력을 켠 변형으로 옮기거나 (b) "새 탭 0개, Task 5의 `noEffect:true`"를 단언하도록 고친다. `target=_blank` 링크 테스트는 그대로 통과해야 한다.
- [ ] **Step 4: 문서** — `docs/browser-capabilities.md`에 "스크립트가 `window.open`으로 여는 창은 신뢰 입력을 켜야 열린다"를 실제로 확인한 범위(신뢰 입력 꺼짐에서 열리지 않음)까지만 적는다.
- [ ] **Step 5: Commit** — `test(e2e): run with Chrome's popup blocker on`

### Task 7: 편집기의 Enter, 대기 텍스트 접기

**Files:**
- Modify: `extension/src/content/keyboard.ts:79-81`, `extension/src/content/wait.ts:18-19`
- Modify: `bridge/src/mcp/tools.rs:52` 부근(설명 문구만, 8,500자 한도 확인)
- Test: `extension/test/keyboard.test.ts`, `extension/test/conditions.test.ts`, `tests/e2e/pointer-keys-upload.spec.ts`

- [ ] **Step 1: 실패하는 테스트** — (a) Enter로 전송하는 contenteditable에서 `press Enter`가 `keydown`·`keyup`을 보내고 결과가 `defaultAction:"event-only"`. Backspace·Delete·Space는 지금처럼 거부(`keyboard.test.ts:93`의 기존 단언 유지). (b) 근거 10의 세 문구가 `wait {text}`와 `waitFor`에서 일치한다. `textGone`도 같은 접기 규칙.
- [ ] **Step 2: 실패 확인** — Run: `cd extension && pnpm exec vitest run test/keyboard.test.ts test/conditions.test.ts`.
- [ ] **Step 3: 구현** — (a) rich 편집 영역에서 Enter는 편집 에뮬레이션 없이 키 이벤트만 전달. (b) 대기 비교는 `query`가 쓰는 접기 함수(대소문자, 연속 공백·탭·`&nbsp;`)를 같이 쓴다. `tools.rs`의 `waitFor` 설명을 "클릭한 프레임의 문서에서 확인"으로 맞춘다.
- [ ] **Step 4: 통과 확인 후 Commit** — `fix(extension): deliver Enter to rich editors and fold wait text like query`

### Task 8: 전체 검증과 기록

- [ ] **Step 1** — `cd extension && pnpm exec tsc --noEmit && pnpm exec vitest run`. `cargo test -p agent-browser-bridge`. 통과 수 기록.
- [ ] **Step 2** — 전체 E2E: `pnpm --filter agent-browser-e2e exec playwright test`. 품질 gate: `pnpm bench:browser`.
- [ ] **Step 3** — `docs/protocol.md`에 추가된 결과 필드(`moved`, `target`, `noEffect`, `details.reason`)와 `browser_select`의 `option` 요구를 적고, `docs/browser-capabilities.md`의 scroll·select·hover·keyboard 행, `CHANGELOG.md`, `docs/status.md`를 갱신한다.
- [ ] **Step 4** — push → PR → CI. Windows Chrome E2E는 CI 결과를 따른다. 병합·출시는 `AGENTS.md`의 Git 절. 이 계획 파일은 완료 후 삭제한다.
