# 남은 작은 결함 정리(계획 6) Implementation Plan

> **상태: 완료.** [PR #29](https://github.com/jihoon22-lee/agent-browser/pull/29)로 main에 병합했다(`e133531`, 2026-10-18). v0.2.0에 포함. 실제 검증 결과와 남긴 항목은 [상태 기록](../status.md)과 PR 본문에 있다. 18건 중 2건(늦은 이동 감시 중 연결 끊김, 신뢰 클릭 좌표 재확인)은 고치지 않고 판단으로 남겼다. 새 작업의 원장으로 쓰지 않는다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 계획 3D·4·5의 최종 리뷰에서 minor로 미룬 18건을 0.2.0 전에 정리한다. 요청 순서 "3, 2, 4, 1"의 ④다.

**Architecture:** 새 기능은 없다. 구성 요소별로 과제를 묶었다. 각 결함은 실패하는 테스트로 먼저 재현한 뒤 고친다. 18건 가운데 2건은 프로토콜 변경이 필요해 이 계획에서 고치지 않고 판단으로 남긴다(Task 6).

**Tech Stack:** Rust, Chrome MV3 TypeScript(vitest), C# .NET Framework 4 WinForms(SetupFlowTests, `scripts/test-installer-windows.sh`), Playwright.

**Spec:** PR #25·#26·#27 본문의 "Remaining minors"·"Deferred minors"·"미뤄 둔 작은 결함", [docs/status.md](../status.md)의 해당 항목. 원래 요구는 [docs/review-2026-10-15.md](../review-2026-10-15.md)와 [docs/handoff.md](../handoff.md).

## Global Constraints

- **예산·규칙은 그대로 둔다:** 도구 정의(< 4,800자), 결과 바이트, `REPLY_WAIT` 60초, `HANDOFF_WAIT` 45초, ref 안전 규칙.
- **새 권한을 추가하지 않는다.**
- **설치기 호환성(AGENTS.md):** 경로 소유자·ACL 검사를 추가하지 않는다.
- **동작 의미를 바꾸지 않는다.** 각 수정은 리뷰가 지적한 상황만 고친다.
- **버전을 올리지 않는다.** 0.2.0은 이 계획 다음의 별도 단계다.
- **커밋 메시지:** 영어 Conventional Commits, 과제 단위로 쓴다.

## Review Focus

1. **신뢰 입력 단축키:** Shift 단독 조합도 브라우저 단축키(Shift+Esc 작업 관리자)를 실제 입력으로 보내지 않는다. 글자·편집 키는 그대로 간다. → Task 1
2. **같은 이름 첨부:** 두 파일 모두 올릴 수 있고, 지시문에 서로 다른 이름으로 나온다. → Task 1
3. **null 선택 필드:** `mode:null`·`toRef:null`을 생략으로 본다. 필수 필드의 null은 계속 거부한다. → Task 2
4. **query 페이지 넘김:** elementOffset으로 다음 쪽을 읽어도 `queryMatched`가 false로 바뀌지 않는다. → Task 3
5. **서비스 워커 재시작:** 확장이 직접 묶은 탭 그룹을 재시작 뒤에도 풀 수 있다. → Task 4

---

### Task 1: 입력 — 계획 5의 minor 5건

**Files:**
- Modify: `extension/src/content/actions.ts`(upload 변화 관찰, drag 원본, drop 결과)
- Modify: `extension/src/background/handlers.ts`(`tracksTabs`에 `browser.upload`)
- Modify: `extension/src/background/trusted-input.ts`(`trustedShortcut`의 Shift 단독)
- Modify: `extension/src/background/uploads.ts`(같은 이름)
- Test: `extension/test/actions.test.ts`, `extension/test/handlers.test.ts`, `extension/test/trusted-input.test.ts`, `extension/test/uploads.test.ts`

**Interfaces:**
- upload:
  - `observeChanges(500, signal)`로 감싸 `verified`에 `domChanged`·`urlChanged`를 넣는다. Bridge의 `wants_snapshot`이 이미 이 값을 본다.
  - background는 click·press처럼 응답이 끊기면 `navigatedAway`로 판정한다.
- `trustedShortcut(key, modifiers)`:
  - Shift 단독일 때 허용하는 키는 영문·숫자 한 글자, Enter, Tab, Space, Backspace, Delete, Home, End, PageUp, PageDown, 화살표다.
  - Escape 등 그 밖의 키는 거부한다.
- drag 원본:
  - `el.closest('[draggable=true], a[href]:not([draggable=false]), img:not([draggable=false])')`가 있으면 그 요소가 HTML5 원본이다.
  - dragstart·dragend는 그 원본에 보낸다. 포인터 이벤트는 그대로 ref 요소에 보낸다.
- drag 결과: `verified.dropped: boolean`. HTML5 원본이 아니면 넣지 않는다.
- 같은 이름 첨부: 등록할 때 두 번째부터 확장자 앞에 ` (2)`, ` (3)`를 붙인다. 예: `a.png`, `a (2).png`. 그 이름이 지시문과 `take`에 쓰인다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

```ts
// actions.test.ts
it("upload reports a page change made by the input's change handler", async () => { /* change → 미리보기 요소 추가, verified.domChanged === true */ });
it("drag from a link inside a draggable card starts the card's HTML5 drag and reports the drop", async () => {
  // <li draggable="true"><a href="#x">제목</a></li> + drop zone: dragstart target === li, verified.dropped === true
});
// trusted-input.test.ts
it("Shift alone still never sends Escape as real input", async () => { /* t.key(1,"Escape",["Shift"]) rejects, no dispatchKeyEvent */ });
// uploads.test.ts
it("two attachments with the same name both stay uploadable under distinct names", () => { /* accepted ["a.png","a (2).png"] */ });
// handlers.test.ts
it("an upload whose document went away reports the navigation instead of an unknown outcome", async () => { /* sendToFrame rejects + documentId changes → verified.navigated */ });
```

- [x] **Step 2~4: 실패 확인 → 구현 → 통과**

Run: `pnpm --filter agent-browser-extension test`
Expected: 새 테스트가 먼저 실패하고, 구현 뒤 전체 통과

- [x] **Step 5: 커밋한다**

```bash
git add extension
git commit -m "fix(extension): observe uploads, bind HTML5 drags to the draggable source and close the Shift shortcut gap"
```

### Task 2: Bridge — null 선택 필드와 타임라인 요약

**Files:**
- Modify: `bridge/src/server/router.rs`(`validate`, `summarize`)
- Test: `bridge/src/server/router.rs` tests

**Interfaces:**
- `validate`:
  - 스키마의 `required`에 없는 속성이 `null`이면 검사 전에 지운다. 확장에도 보내지 않는다.
  - 필수 속성의 null은 지금처럼 거부한다.
- `summarize`:
  - `mode`·`toRef`·`modifiers`·`file`(80자)을 요약 키에 넣는다.
  - 기존 요약 형식(`key=value` 나열)을 따른다.

- [x] **Step 1: 실패하는 테스트**

```rust
#[test]
fn null_optional_fields_are_omitted_but_required_ones_still_fail() {
    // browser_click {ref:"a", mode:null, toRef:null} → Ok, 전달 인수에 mode·toRef 없음
    // browser_click {ref:null} → Err
}
#[test]
fn timeline_names_the_pointer_mode_target_keys_and_file() { /* summarize에 mode=drag toRef=… file=a.png modifiers=Control */ }
```

- [x] **Step 2~4:** `cargo test --offline --locked -p agent-browser-bridge`
- [x] **Step 5:** `git commit -m "fix(bridge): treat null optional fields as omitted and name pointer modes, keys and files in the timeline"`

### Task 3: 스냅샷 — 행 글자와 query 일치 판정

**Files:**
- Modify: `extension/src/content/snapshot.ts`(`rowText`)
- Modify: `extension/src/background/handlers.ts`(`queryMatched`)
- Test: `extension/test/snapshot.test.ts`, `extension/test/handlers.test.ts`

**Interfaces:**
- `rowText`:
  - `textContent` 대신 script·style·template·숨김 요소를 건너뛴 글자를 쓴다.
  - 셀·항목 사이에는 공백을 넣고, 연속 공백은 하나로 줄인다.
  - 행마다 한 번 읽는 캐시는 그대로 둔다.
- `queryMatched`: 돌려준 쪽이 아니라 전체 일치 수로 판정한다. `elementsTotal > 0 || text.totalChars > 0`이다.

- [x] **Step 1: 실패하는 테스트**
  - `<tr><td>A-1002</td><td>취소</td><script>/* A-1002 */</script></tr>`: 스크립트만 일치하는 행에서는 버튼이 나오지 않는다.
  - `<td>A</td><td>1002</td>`는 "A 1002"로 일치한다.
  - 일치 요소가 3개인 페이지를 `elementOffset:5`로 읽으면 요소 0개지만 `queryMatched: true`다.
- [x] **Step 2~4:** `pnpm --filter agent-browser-extension test`
- [x] **Step 5:** `git commit -m "fix(extension): read rendered row text for query and judge queryMatched across pages"`

### Task 4: background 상태 — 탭 표시, 탭 그룹, 권한, 비활성 캡처

**Files:**
- Modify: `extension/src/background/index.ts`(탐색 뒤 표시 재적용을 `marking` 대기열로, `chrome.permissions.onAdded`·`onRemoved`)
- Modify: `extension/src/background/tab-groups.ts`(묶은 탭 목록을 `chrome.storage.session`에 보관)
- Modify: `extension/src/background/handlers.ts`(비활성 캡처 재확인에 최상위 documentId)
- Test: `extension/test/work-marker.test.ts`, `extension/test/tab-groups.test.ts`, `extension/test/handlers.test.ts`

**Interfaces:**
- 탐색 뒤 표시 재적용: `refreshMarkers`와 같은 `marking` 사슬에서 실행한다. 사슬 안에서 표시가 여전히 그 탭에 있어야 하는지 다시 확인한다.
- 탭 그룹:
  - `syncGroup`의 상태(`grouped`)를 `chrome.storage.session`의 `agentGroups`에 저장한다.
  - 시작할 때 읽어 온다. 재시작 뒤에도 직접 묶은 탭만 푼다.
- 권한: 사용자가 설정에서 tabGroups를 허용하거나 취소하면 다음 상태 변화를 기다리지 않고 `syncGroups()`를 부른다.
- 비활성 캡처: 캡처 전후로 최상위 frame의 documentId를 비교한다. 같은 URL을 다시 읽어도 결과를 버린다.

- [x] **Step 1: 실패하는 테스트**
  - 탐색 재적용과 동시에 작업이 끝나면 표시가 남지 않는다.
  - 저장된 `agentGroups`로 시작한 상태에서 작업이 끝나면 그 탭의 그룹을 푼다.
  - 같은 URL로 다시 읽히는 동안 찍은 비활성 캡처는 버린다(`NEEDS_TAB_ACTIVATION`).
  - 권한 변화 이벤트에서 `syncGroups`가 불린다(index의 연결 함수를 테스트 가능한 모듈로 뺄 때만).
- [x] **Step 2~4:** `pnpm --filter agent-browser-extension test`
- [x] **Step 5:** `git commit -m "fix(extension): queue re-marking, keep tab-group ownership across worker restarts and recheck inactive captures by document"`

### Task 5: 설정·설치기와 E2E 단언

**Files:**
- Modify: `extension/src/options/profile-form.ts`(`passwordDropped`)
- Modify: `installer/SetupForm.cs`(`DistributionToStart`)
- Modify: `tests/e2e/trusted-input.spec.ts`(T03·T04)
- Test: `extension/test/profile-form.test.ts`, `tests/install/SetupFlowTests.cs`

**Interfaces:**
- `passwordDropped`: 비밀번호가 저장된 external 프로필을 다른 종류로 바꿔도 true다. 저장 뒤 안내가 나온다.
- `DistributionToStart(typed, found, stopped)`:
  - 칸이 비어 있으면 꺼진 배포판 중 첫 번째를 고른다.
  - 꺼진 배포판이 없으면 null을 돌려준다. 그러면 "켜고 찾을 WSL 배포판 이름을 입력하세요" 안내가 나온다.
  - 실행 중인 배포판을 다시 켜지 않는다.
  - 꺼진 목록은 Discovery가 이미 만드는 정지 안내의 근거에서 가져온다. 그런 목록이 없으면 Ruling으로 남기고 안내만 바꾼다.
- T03: 분리 뒤 디버거가 다시 붙지 않는지 2초 동안 확인한다.
- T04: 캡처한 PNG의 크기가 0보다 크고, 다른 탭이 여전히 활성인지 확인한다.

- [x] **Step 1: 실패하는 테스트** — profile-form, SetupFlowTests(`DistributionToStart`).
- [x] **Step 2~4:**
  - `pnpm --filter agent-browser-extension test`
  - `bash scripts/test-installer-windows.sh SetupFlowTests`
  - `bash scripts/test-windows.sh -- trusted-input.spec.ts`
- [x] **Step 5:** `git commit -m "fix: notice dropped passwords on kind changes, never restart a running distribution and tighten trusted E2E checks"`

### Task 6: 판단으로 남기는 2건, 문서와 전체 검증

이 계획에서 고치지 않는 2건과 이유:
- **감시 중 Bridge 연결이 끊긴 클릭:** content가 실행을 확인한 클릭인데, 1초 늦은 이동 감시 중 Bridge 연결이 끊기면 `EXECUTION_UNKNOWN`이 된다. 확장은 결과를 `store`에 저장하지만, Bridge가 다시 연결한 뒤 그 요청의 결과를 되묻는 경로가 없다. 그러려면 프로토콜에 재조회 RPC가 필요해 범위를 넘는다. 모델은 "페이지를 확인하라"는 안전한 안내를 받는다.
- **신뢰 클릭 지점의 왕복 뒤 재확인:** content가 판정한 좌표를 background가 디버거로 보내는 몇 ms 사이에 요소가 움직일 수 있다. 재확인하려면 CDP `DOM.getNodeForLocation`과 ref 대응이 필요하다. 클릭 직전의 판정·관찰과 결과 스냅샷이 이미 있다.

- [x] **Step 1:** docs/status.md·CHANGELOG.md에 기록한다. 0.2.0 전 남은 항목도 정리한다.
- [x] **Step 2: 전체 검증**
  - Rust, 확장, tsc, E2E 타입 검사
  - Linux E2E
  - Windows Chrome E2E(journeys·reliability·trusted-input·pointer-keys-upload)
  - 실제 OpenCode Windows·WSL 패널 검사
- [x] **Step 3:** `git commit -m "docs: record plan 6"`
