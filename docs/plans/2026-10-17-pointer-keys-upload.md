# 마우스 올리기·끌어다 놓기·키 조합·파일 업로드(계획 5) Implementation Plan

> **상태: 완료.** [PR #27](https://github.com/jihoon22-lee/agent-browser/pull/27)로 main에 병합했다(`ff01ec8`, 2026-10-18). v0.2.0에 포함. 실제 검증 결과와 남긴 항목은 [상태 기록](../status.md)과 PR 본문에 있다. 새 작업의 원장으로 쓰지 않는다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 에이전트가 메뉴를 펼치는 마우스 올리기, 두 번 클릭·오른쪽 클릭, 끌어다 놓기, Ctrl+A·Delete 같은 키 조합을 쓸 수 있게 한다. 사용자가 패널에 첨부한 파일을 웹페이지의 파일 입력에 올릴 수 있게 한다.

**Architecture:**
- **마우스 동작:** `browser_click`에 `mode`(`click`·`double`·`right`·`hover`·`drag`)와 `toRef`(drag 대상)를 더한다. 새 도구 대신 기존 도구의 매개변수로 넣어 정의 크기를 아낀다.
  - DOM 경로는 해당 이벤트 순서를 합성한다.
  - 신뢰 입력(계획 4)이 붙어 있으면 CDP 마우스 이벤트로 보낸다.
- **키 입력:** `browser_press`에 `modifiers`(Control·Shift·Alt·Meta)와 키(Delete·Home·End·PageUp·PageDown·ArrowLeft·ArrowRight, 조합키와 함께 쓰는 영문·숫자 한 글자)를 더한다.
  - DOM 경로는 수정키 플래그가 있는 키 이벤트와 몇 가지 기본 동작(텍스트 칸의 Ctrl+A·Delete·Home·End·좌우 화살표)을 처리한다.
  - 신뢰 입력은 CDP `modifiers` 비트로 실제 기본 동작을 맡긴다.
- **업로드:** 새 도구 `browser_upload {ref, file}`. 올릴 수 있는 파일은 **이 패널 요청에 사용자가 첨부한 파일**뿐이다. 모델은 로컬 경로를 정할 수 없다.
  1. 패널이 요청을 준비할 때 첨부 파일(이름·형식·데이터)을 background 메모리에 요청 ID로 등록한다.
  2. 지시문에 파일 이름을 알린다.
  3. content가 `DataTransfer`로 `<input type=file>`의 `files`를 채운다.
  4. 요청이 끝나면 등록을 지운다.

**Tech Stack:** Rust(Bridge tools·router), Chrome MV3 TypeScript(content·background·sidepanel), vitest, Playwright E2E.

**Spec:**
- [docs/review-2026-10-15.md](../review-2026-10-15.md) B3: hover(호버 메뉴), 조합키(Ctrl+A, Ctrl+Enter), Delete·Home·End·PageDown·좌우 화살표, 더블·우클릭, 드래그, "사용자가 패널에서 고른 파일만 업로드. 경로를 모델이 정하지 않는다"
- 계획 4의 남은 범위
- 사용자 지시 순서(2026-10-17): 이 계획 → WSL 1.19.3 → 남은 결함 → 0.2.0 릴리스

## Global Constraints

- **도구 정의 예산:** 4,800자 미만(`total_schema_size_stays_small_for_free_models`), 현재 4,613자다. 새 매개변수와 `browser_upload`로 넘치는 만큼 기존 설명을 줄인다. 예산 값은 바꾸지 않는다.
- **ref 안전 규칙은 그대로 둔다:**
  - 쓰기 전 스냅샷 바인딩
  - 대상 판정(`assertInteractable`)
  - 일부만 전달된 입력의 미반복
  - hover·drag도 쓰기(Write) 분류다. 페이지 상태를 바꿀 수 있기 때문이다.
- **업로드 범위:**
  - 사용자가 **이 요청에** 첨부한 파일만 올린다. 파일마다 10MB 이하(기존 첨부 한도와 같음)이고, 요청 종료·중단 시 메모리에서 지운다.
  - 대상은 `<input type="file">` 또는 그것을 가리키는 label·버튼이다. 숨겨진 파일 입력은 흔하므로 파일 입력 자체의 가시성은 요구하지 않는다. 대신 ref로 지정한 요소는 지금처럼 판정한다.
  - `accept`·`multiple` 속성에 맞지 않으면 거부한다.
- **커밋 메시지:** 영어 Conventional Commits, 과제 단위로 쓴다. PR 본문은 한국어로 쓴다.

## Review Focus

1. **업로드 파일 출처:** 다른 요청에 첨부한 파일, 이미 끝난 요청의 파일, 존재하지 않는 이름은 거부되고 아무 파일도 올리지 않는다. → Task 5
2. **hover가 클릭으로 바뀌지 않음:** hover는 click·mousedown을 보내지 않는다. 메뉴만 펼쳐지고 링크는 열리지 않는다. → Task 2·E2E P01
3. **drag 대상 판정:** `toRef`도 같은 스냅샷 바인딩·가시성 판정을 거친다. 옛 ref면 STALE이다. → Task 3
4. **조합키의 기본 동작:** DOM 경로에서 Ctrl+A가 텍스트 칸 밖(페이지 전체 선택)으로 번지지 않는다. 지원하지 않는 조합은 INVALID_PARAMS로 거부하고 아무 이벤트도 보내지 않는다. → Task 4
5. **신뢰 입력 경로의 일부 전달:** 더블클릭·드래그 도중 디버거가 끊기면 EXECUTION_UNKNOWN이고 반복하지 않는다. → Task 2·3 단위 테스트

---

### Task 1: 도구 정의와 라우터

**Files:**
- Modify: `bridge/src/mcp/tools.rs`(`browser_click`의 `mode`·`toRef`, `browser_press`의 `modifiers`, 새 `browser_upload`, 설명 줄이기, `class_of`)
- Modify: `bridge/src/server/router.rs`(`validate_action`, `wants_snapshot`, `OPERATION_TOOLS`에 `browser_upload`)
- Modify: `protocol/fixtures/tools-list.json`(재생성)

**Interfaces:**
- Produces:
  - `browser_click` 스키마
    - `"mode":{"type":"string","enum":["click","double","right","hover","drag"]}`
    - `"toRef":{"type":"string"}`(drag 대상)
  - `browser_press` 스키마
    - `"modifiers":{"type":"array","items":{"enum":["Control","Shift","Alt","Meta"]},"maxItems":4}`
  - `browser_upload`
    - 설명: `"Put a file the user attached to this request into a file input (ref of the input or its label/button). file: the attachment name."`
    - 스키마: `operationId`, `ref`, `file`(string, 필수 `ref`·`file`)
  - `class_of`: `browser_upload`는 Write다.
  - `validate_action`:
    - `mode=="drag"`이면 `toRef`가 필수다.
    - `mode!="drag"`이면 `toRef`를 거부한다(INVALID_PARAMS).
  - `wants_snapshot`:
    - `browser_click`이 `mode`와 무관하게 지금 규칙(url·dom 변화)을 따른다.
    - `browser_upload`는 dom 변화가 있으면 스냅샷을 붙인다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`tools.rs` 테스트 모듈:

```rust
    #[test]
    fn pointer_modes_modifiers_and_upload_are_offered() {
        let tools = super::all();
        let find = |name: &str| tools.iter().find(|t| t.name == name).unwrap();
        assert_eq!(find("browser_click").schema["properties"]["mode"]["enum"], serde_json::json!(["click","double","right","hover","drag"]));
        assert!(find("browser_click").schema["properties"]["toRef"].is_object());
        assert!(find("browser_press").schema["properties"]["modifiers"].is_object());
        assert_eq!(find("browser_upload").schema["required"], serde_json::json!(["ref","file"]));
        assert_eq!(super::class_of("browser_upload", &serde_json::json!({})), crate::server::registry::CommandClass::Write);
    }
```

`router.rs` 테스트 모듈:

```rust
    #[test]
    fn drag_needs_a_target_and_only_drag_takes_one() {
        assert!(validate_action("browser_click", &json!({"ref":"a","mode":"drag"})).is_err());
        assert!(validate_action("browser_click", &json!({"ref":"a","mode":"drag","toRef":"b"})).is_ok());
        assert!(validate_action("browser_click", &json!({"ref":"a","toRef":"b"})).is_err());
    }
```

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- pointer_modes drag_needs`
Expected: FAIL

- [x] **Step 3: 구현하고 예산 안으로 줄인다**

스키마를 추가한 뒤 `total_schema_size_stays_small_for_free_models`가 실패하면 줄인다. 설명이 긴 순서(`browser_tabs` 765, `browser_snapshot` 539, `browser_extract` 448, `browser_wait` 404)로 같은 뜻을 짧게 다시 쓴다. 지켜야 할 단언은 다음과 같다.
- `descriptions_say_results_already_include_a_snapshot`: tabs·navigate·click·press 설명에 "snapshot"이 있다.
- `blank_tab_close_exception_is_visible_in_the_tool_description`: tabs 설명에 "about:blank tabs cannot be closed"가 있다.
- `page_tools_do_not_require_an_operation_id_in_the_schema`: tabs 설명에 "panel"이 있다.
- `snapshot_can_be_narrowed_by_a_query`: snapshot 설명에 "query"가 있다.

`UPDATE_FIXTURES=1`로 fixture를 재생성한다.

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib && pnpm --filter agent-browser-extension exec vitest run test/protocol-contract.test.ts`
Expected: PASS. 예산 4,800 미만이다.

- [x] **Step 5: 커밋한다**

```bash
git add bridge protocol
git commit -m "feat(bridge): offer pointer modes, key modifiers and attachment upload within the tool budget"
```

### Task 2: 두 번 클릭·오른쪽 클릭·마우스 올리기

**Files:**
- Modify: `extension/src/content/actions.ts`(click의 `mode`)
- Modify: `extension/src/background/trusted-input.ts`(`click`에 `mode` 인자)
- Modify: `extension/src/background/index.ts`(`trusted-input` 메시지의 `mode` 전달)
- Modify: `extension/src/background/trusted-message.ts`(`mode` 허용 값 검사)
- Test: `extension/test/actions.test.ts`, `extension/test/trusted-input.test.ts`, `extension/test/trusted-message.test.ts`

**Interfaces:**
- DOM 경로(합성 이벤트, 지금과 같은 `base` 좌표)
  - `double`: click 순서 두 번(detail 1, 2) 뒤 `dblclick`(detail 2)
  - `right`: `pointerdown`/`mousedown`(button 2, buttons 2) → `pointerup`/`mouseup` → `contextmenu`. `click`은 보내지 않는다.
  - `hover`: `pointerover`·`pointerenter`·`mouseover`·`mouseenter`·`pointermove`·`mousemove`. 누름·`click`은 보내지 않는다.
- 신뢰 입력 `click(tabId, x, y, mode)`
  - `double`: `mousePressed`/`mouseReleased`를 clickCount 1, 2로 두 번 보낸다.
  - `right`: button `right`
  - `hover`: `mouseMoved`만 보낸다.
- 결과 `verified.mode`. 기본 `click`이면 생략한다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`actions.test.ts`:

```ts
it("hover moves over the element without pressing or clicking it", async () => {
  document.body.innerHTML = '<a href="#go">메뉴</a>';
  const link = document.querySelector('a')!;
  vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30 } as DOMRect);
  const seen: string[] = []; for (const t of ['mouseover','mouseenter','mousemove','mousedown','click']) link.addEventListener(t, () => seen.push(t));
  const result: any = await runAction('click', { ref: refOf('메뉴'), mode: 'hover', generation: 10 });
  expect(seen).toEqual(['mouseover', 'mouseenter', 'mousemove']);
  expect(result.verified.mode).toBe('hover');
});

it("double and right clicks send their own event sequences", async () => {
  document.body.innerHTML = '<div role="button" tabindex="0">항목</div>';
  const el = document.querySelector('div')!;
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30 } as DOMRect);
  const seen: string[] = []; for (const t of ['click','dblclick','contextmenu']) el.addEventListener(t, () => seen.push(t));
  await runAction('click', { ref: refOf('항목'), mode: 'double', generation: 10 });
  expect(seen).toEqual(['click', 'click', 'dblclick']);
  seen.length = 0;
  await runAction('click', { ref: refOf('항목'), mode: 'right', generation: 10 });
  expect(seen).toEqual(['contextmenu']);
});
```

`trusted-input.test.ts`:
- `click(1,1,1,"double")` → `mousePressed` clickCount 1·2 순서가 보인다.
- `"right"` → button `right`.
- `"hover"` → `mouseMoved`만 보낸다.
- 두 번째 `mousePressed`에서 실패 → `PartlyDelivered`.

`trusted-message.test.ts`:
- `mode:"drag"`는 이 메시지로 거부한다. drag는 Task 3의 별도 action이다.
- 알 수 없는 mode도 거부한다.

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

Run: `pnpm --filter agent-browser-extension exec vitest run test/actions.test.ts test/trusted-input.test.ts test/trusted-message.test.ts`

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "feat(extension): double, right and hover pointer modes over DOM events and trusted input"
```

### Task 3: 끌어다 놓기

**Files:**
- Modify: `extension/src/content/actions.ts`(`mode:"drag"`)
- Modify: `extension/src/background/trusted-input.ts`(`drag(tabId, from, to)`)
- Modify: `extension/src/background/trusted-message.ts`, `index.ts`(`action:"drag"`)
- Test: `extension/test/actions.test.ts`, `extension/test/trusted-input.test.ts`

**Interfaces:**
- content:
  - `ref`와 `toRef`를 모두 `resolveRef`하고 `assertInteractable`한다. 둘 다 같은 스냅샷 바인딩 규칙을 따른다.
  - DOM 경로는 두 방식을 차례로 보낸다.
    - **포인터 방식:** source에서 `pointerdown`/`mousedown` → 중간 지점과 target에서 `pointermove`/`mousemove` → target에서 `pointerup`/`mouseup`
    - **HTML5 방식:** 같은 `DataTransfer`로 `dragstart`(source) → `dragenter`·`dragover`(target) → `drop`(target) → `dragend`(source). source가 `draggable`이거나 `<a href>`·`<img>`일 때만 보낸다.
- 신뢰 입력 `drag`:
  1. `mouseMoved`(source) → `mousePressed`
  2. 중간 지점 3개로 `mouseMoved`(buttons 1)
  3. target에서 `mouseMoved` → `mouseReleased`
- 결과 `verified: { mode:"drag", ...changes }`

- [x] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("drag delivers pointer moves and an HTML5 drop on the target", async () => {
  document.body.innerHTML = '<div draggable="true">카드</div><div role="listitem" tabindex="0">완료</div>';
  const [card, done] = [...document.querySelectorAll('div')];
  for (const [el, left] of [[card, 10], [done, 200]] as const) vi.spyOn(el!, 'getBoundingClientRect').mockReturnValue({ left, top: 10, width: 80, height: 20, right: left + 80, bottom: 30 } as DOMRect);
  const seen: string[] = []; for (const t of ['mousedown','dragstart']) card!.addEventListener(t, () => seen.push('card:' + t));
  for (const t of ['mouseup','drop']) done!.addEventListener(t, e => { e.preventDefault(); seen.push('done:' + t); });
  done!.addEventListener('dragover', e => e.preventDefault());
  await runAction('click', { ref: refOf('카드'), toRef: refOf('완료'), mode: 'drag', generation: 10 });
  expect(seen).toEqual(['card:mousedown', 'done:mouseup', 'card:dragstart', 'done:drop']);
});

it("drag refuses a stale target ref", async () => {
  document.body.innerHTML = '<div draggable="true">카드</div><div tabindex="0">완료</div>';
  const card = refOf('카드'), target = refOf('완료');
  document.querySelectorAll('div')[1]!.remove();
  await expect(runAction('click', { ref: card, toRef: target, mode: 'drag', generation: 10 })).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
});
```

`trusted-input.test.ts`: `drag(1,{x:1,y:1},{x:9,y:9})` → `mousePressed` 1회, 중간 `mouseMoved` 3회 이상, `mouseReleased`가 target 좌표다. 누름 뒤 실패면 `PartlyDelivered`다.

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "feat(extension): drag one element onto another with pointer and HTML5 events or trusted input"
```

### Task 4: 키 조합과 추가 키

**Files:**
- Modify: `extension/src/content/keyboard.ts`(`KEYS` 확장, `modifiers`, 기본 동작)
- Modify: `extension/src/background/trusted-input.ts`(`KEYS` 확장, `modifiers` 비트, 한 글자 키)
- Test: `extension/test/keyboard.test.ts`, `extension/test/trusted-input.test.ts`

**Interfaces:**
- **허용 키:**
  - 기존 7개, `Delete`, `Home`, `End`, `PageUp`, `PageDown`, `ArrowLeft`, `ArrowRight`
  - 수정키가 하나 이상 있을 때만 영문 한 글자(a–z, 대소문자 무관)·숫자 한 글자
- **DOM 기본 동작(텍스트 칸·textarea에서만):**
  - `Control+a`(또는 `Meta+a`): 칸 안 전체 선택(`select()`). 칸 밖에서는 이벤트만 보낸다.
  - `Delete`: 선택 영역 또는 커서 뒤 한 글자 삭제(`deleteContentForward`)
  - `Home`/`End`, `ArrowLeft`/`ArrowRight`: 커서 이동. `Shift`가 있으면 선택을 넓힌다.
  - `Control+Enter`: 이벤트만 보낸다. 사이트가 직접 처리한다.
  - 그 밖의 조합: 수정키 플래그가 있는 keydown/keyup만 보낸다. `verified.defaultAction:"event-only"`
- **신뢰 입력:**
  - `modifiers` 비트(Alt 1, Control 2, Meta 4, Shift 8)
  - 수정키 keyDown → 키 keyDown/keyUp → 수정키 keyUp
  - 한 글자 키는 `key`, `code: "Key"+대문자`, `windowsVirtualKeyCode`(대문자 코드)이고, 수정키가 Shift뿐이면 `text`를 넣는다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("Control+A selects only the text field, and unsupported combinations send nothing", async () => {
  document.body.innerHTML = '<input aria-label="메모" value="안녕하세요"><p>본문</p>';
  const input = document.querySelector('input')!;
  await runAction('press', { ref: refOf('메모'), key: 'a', modifiers: ['Control'], generation: 10 });
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
  expect(document.getSelection()?.toString() ?? '').not.toContain('본문');
  const seen = vi.fn(); input.addEventListener('keydown', seen);
  await expect(runAction('press', { ref: refOf('메모'), key: 'a', generation: 10 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  expect(seen).not.toHaveBeenCalled();
});

it("Delete, Home, End and arrows edit and move inside a text field", async () => {
  document.body.innerHTML = '<input aria-label="칸" value="abc">';
  const input = document.querySelector('input')!; input.focus(); input.setSelectionRange(0, 0);
  await runAction('press', { ref: refOf('칸'), key: 'Delete', generation: 10 });
  expect(input.value).toBe('bc');
  await runAction('press', { ref: refOf('칸'), key: 'End', generation: 10 });
  expect(input.selectionStart).toBe(2);
  await runAction('press', { ref: refOf('칸'), key: 'ArrowLeft', modifiers: ['Shift'], generation: 10 });
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 2]);
});
```

`keyboard.test.ts`에 기존 키 테스트가 있으면 같은 파일에 넣는다. `runAction` 대신 `pressKey`를 직접 부르는 방식이 그 파일의 관례면 그것을 따른다.

`trusted-input.test.ts`: `key(1,"a",["Control"])` → `keyDown Control`(modifiers 2) → `keyDown a`(modifiers 2, code `KeyA`) → `keyUp a` → `keyUp Control`.

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "feat(extension): key combinations and editing keys over DOM events and trusted input"
```

### Task 5: 첨부 파일 업로드

**Files:**
- Create: `extension/src/background/uploads.ts`(요청별 첨부 등록부)
- Modify: `extension/src/background/panel-requests.ts`(prepare 때 등록, end·cancel·discard 때 삭제)
- Modify: `extension/src/sidepanel/Workbench.tsx`(request-prepare에 첨부 메타·데이터 전달)
- Modify: `extension/src/sidepanel/request-target.ts`(`requestInstructions`에 파일 이름)
- Modify: `extension/src/background/handlers.ts`(`browser.upload`)
- Modify: `extension/src/content/actions.ts`(`upload` 액션)
- Test: `extension/test/uploads.test.ts`, `extension/test/actions.test.ts`, `extension/test/panel-requests.test.ts`, `extension/test/request-target.test.ts`

**Interfaces:**
- `uploads.ts`
  - `register(requestId, files: Array<{name, mime, dataUrl}>)`
  - `take(requestId, name) -> file | undefined`(복사본)
  - `forget(requestId)`
  - 등록 한도: 파일마다 10MB, 요청당 5개. 넘으면 앞의 것만 받고 지시문에 알린다.
- background `browser.upload`
  1. 현재 패널 요청(`panelBrowserRequest` lease)의 requestId로 `take`한다.
  2. 없으면 `INVALID_PARAMS`("This request has no attachment named …; attach the file in the panel and send the request again.")이고 content를 부르지 않는다.
  3. 있으면 content `upload {ref, name, mime, dataUrl}`을 보낸다.
- content `upload`
  1. ref를 판정한다(`assertInteractable`).
  2. 대상 파일 입력을 찾는다: 자신이 `input[type=file]`이거나 `label.control`이거나, 자신 안 또는 가장 가까운 form의 유일한 file input이다. 못 찾으면 `ELEMENT_NOT_INTERACTABLE`이다.
  3. `accept` 검사를 한다: MIME 패턴(`image/*`)·확장자(`.pdf`) 중 하나라도 맞으면 통과다.
  4. `new File([bytes], name, {type: mime})` → `DataTransfer` → `input.files = dt.files` → `input`·`change` 이벤트
  5. 결과는 `{executed:true, verified:{files:[name], size}}`다.
- `requestInstructions(requestId, target, files?: string[])`: 파일이 있으면 "Attached files you may upload with browser_upload: a.pdf, b.png" 한 문장을 더한다. 지시문 길이 테스트(< 600)는 파일 목록 없이 기준을 유지하고, 목록이 있으면 파일 이름당 80자까지만 더한다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`uploads.test.ts`:
- 요청 A에 등록한 파일은 B에서 `take`되지 않는다.
- `forget(A)` 뒤에는 A에서도 없다.
- 10MB 초과는 등록되지 않는다.

`actions.test.ts`:
- `<label for=f>파일 선택</label><input id=f type=file accept="image/*" hidden>`에서 label ref로 `upload`하면 `input.files[0].name == "a.png"`이고 change 이벤트가 발생한다.
- `accept`에 맞지 않는 `a.pdf`는 `ELEMENT_NOT_INTERACTABLE`이고 files가 비어 있다.

`panel-requests.test.ts`:
- prepare에 `files`를 넘기면 등록된다.
- 그 요청의 end·cancel 뒤 `take`가 undefined다.

`request-target.test.ts`: 파일 이름이 지시문에 포함된다.

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

Workbench의 전송 경로에서 `request-prepare` 메시지에 `files: attachments.filter(a=>a.type==="file").map(a=>({name:a.filename, mime:a.mime, dataUrl:a.url}))`를 더한다. 첨부는 이미 data URL로 들고 있다(`workbench-state.ts` `filePart`).

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "feat: upload a file the user attached to the request into a page's file input"
```

### Task 6: 실제 브라우저 검증과 문서

**Files:**
- Create: `tests/fixtures/site/pointer.html`, `tests/e2e/pointer-keys-upload.spec.ts`
- Modify: `tests/e2e/playwright.config.ts`(testMatch)
- Modify:
  - `docs/browser-capabilities.md`
  - `docs/protocol.md`
  - `docs/user-guide.md`(파일 업로드: 첨부한 파일만)
  - `CHANGELOG.md`
  - `docs/status.md`
  - `docs/review-2026-10-15.md` §E

**`pointer.html`(합성):**
- `:hover`와 `mouseenter`로 펼쳐지는 메뉴
- dblclick·contextmenu 카운터
- 포인터 기반 정렬 목록(mousedown/mousemove/mouseup으로 항목 이동)과 HTML5 드롭 영역
- 텍스트 칸과 Ctrl+Enter 처리
- `accept="image/*"` 숨김 파일 입력과 그 label

**E2E(신뢰 입력 꺼짐과 켬 모두):**
- **P01:** hover로 메뉴가 펼쳐지고 링크는 열리지 않는다.
- **P02:** double·right의 각 카운터
- **P03:** drag로 목록 순서가 바뀌고, HTML5 드롭 영역이 drop을 받는다.
- **P04:** Ctrl+A → Delete로 칸이 비고, Ctrl+Enter가 사이트 처리기를 부른다.
- **P05:** 패널 요청에 첨부한 `a.png`가 업로드된다.
  - 요청은 `journeys.spec.ts`의 `begin`처럼 `request-prepare`에 `files`를 넣어 만든다.
  - 다른 이름은 거부된다.
  - 요청이 끝난 뒤에는 거부된다.

Linux·Windows에서 모두 실행한다. CDP의 hover가 headless에서 `:hover`를 바꾸지 않는 등 환경 차이가 있으면 그 단언만 `mouseenter` 기준으로 바꾸고 ruling으로 남긴다.

- [x] **Step 1: E2E 작성·실행**
- [x] **Step 2: 전체 검증**(계획 4와 같은 명령, 실제 OpenCode Windows 프로필 포함)
- [x] **Step 3: 문서를 갱신하고 커밋한다**

```bash
git add tests docs CHANGELOG.md
git commit -m "docs: describe pointer modes, key combinations and attachment upload with real browser checks"
```
