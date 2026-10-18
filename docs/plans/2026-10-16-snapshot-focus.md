# 필요한 부분만 읽는 스냅샷(계획 3B) Implementation Plan

> **상태: 완료.** [PR #23](https://github.com/jihoon22-lee/agent-browser/pull/23)로 main에 병합했다(`300bc81`, 2026-10-16). v0.2.0에 포함. 실제 검증 결과와 남긴 항목은 [상태 기록](../status.md)과 PR 본문에 있다. 새 작업의 원장으로 쓰지 않는다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 바쁜 실제 페이지에서 모델이 받는 스냅샷을 작업에 필요한 부분으로 좁혀, 출력 한도와 맥락 낭비로 생기는 실패를 줄인다.

**Architecture:** 스냅샷 형식(JSON 요소 목록)은 그대로 둔다. 바꾸는 것은 네 가지다.
1. `browser_snapshot`에 `query`를 추가한다. 페이지 문장과 요소 중 그 말이 들어간 줄·행만 돌려준다.
2. 동작 결과에 붙는 후속 스냅샷의 요소 수를 40개로 제한한다.
3. 자체 컨트롤을 품은 포인터 영역은 요소 칸을 차지하지 않게 한다.
4. 클릭 뒤 0.5초 넘어 시작되는 JS 이동을 잡는다.

3A의 암묵 attach가 같은 페이지를 두 번 읽던 문제도 함께 고친다.

**Tech Stack:** Rust(Bridge router·tools), Chrome MV3 TypeScript(content snapshot, background handlers), vitest, Playwright E2E.

**Spec:**
- [docs/review-2026-10-15.md](../review-2026-10-15.md): B1 "B1-검색", B2 조작 결과, D절
- [계획 1 status](../status.md)의 "남은 개선(계획 3)"
- [계획 3A](./2026-10-16-request-binding.md)에서 미룬 minor(암묵 attach 이중 읽기)

## 형식 변경을 하지 않는 근거 (2026-10-16 측정)

리뷰 B1-구조는 "계층형 인라인 스냅샷"(본문 안에 ref)을 제안했다. 실행 전에 두 가지를 확인했다.

- **OpenCode 1.18.29의 전달 방식:** 격리 HOME에서 최소 MCP 서버와 합성 provider로 확인했다.
  - 여러 text 블록은 빈 줄로 이어 붙여 모델에 넘긴다.
  - `structuredContent`는 모델에게도, 저장되는 메시지 기록에도 전달되지 않는다.
  - 따라서 OpenCode를 거치는 검증(합성 provider·실제 패널 검사)은 모델이 보는 텍스트만 읽을 수 있다.
- **크기 절감:** 실제 Chromium에서 fixture 8개 페이지의 `browser_snapshot` 결과를 받아 최종 MCP 텍스트 바이트로 비교했다.

| 방식 | 전체 절감 | 문장이 많은 shop.html |
|---|---|---|
| 요소를 한 줄 문자열로 | 8% | 3% |
| 본문+요소를 인라인 outline으로 | 19% | 6% |

- **결론:**
  - 결과 크기를 좌우하는 것은 형식이 아니라 페이지 본문이다. 한글 4,000자가 약 9.5KB다.
  - 형식을 바꾸면 이를 읽는 쪽을 모두 바꿔야 한다. E2E 도우미, 합성 provider의 `$ref` 해석, 실제 패널 검사, 문서가 대상이다.
  - 반복 버튼의 행 구분은 계획 1의 `context`가 이미 맡고 있다.
  - 그래서 이 계획은 형식을 유지하고, 필요한 본문만 받는 `query`와 후속 스냅샷 상한으로 크기를 줄인다. 인라인 outline은 실제 사용에서 `context`로 구분이 안 되는 사례가 확인될 때 다시 검토한다.

## Global Constraints

- **도구 정의 예산:** `tools.rs`의 `total_schema_size_stays_small_for_free_models`, 4,800자 미만. 현재 4,795자로 여유가 없다. Task 1에서 `op()` 설명을 `"From attach/new"`로 되돌려(약 264자 절약) `query`의 자리를 만든다. `browser_tabs` 설명이 이미 패널 요청의 ID 생략을 말하므로 정보는 잃지 않는다.
- **결과 바이트 예산은 그대로 둔다:** 프레임 24,000B, 묶음·extract 28,000B, 최종 MCP 텍스트 40,000B, `REPLY_WAIT` 60초, `FOLLOW_UP_TIMEOUT` 8초.
- **요구사항 §10:**
  - DOM 표현을 Accessibility Tree라고 부르지 않는다. snapshot `note`를 유지한다.
  - 고정 sleep 대신 관찰 가능한 조건으로 기다린다. Task 5의 지연 이동 확인은 탭 URL·`pendingUrl` 변화라는 관찰 조건이고, 상한 시간은 그 조건을 기다리는 최대치다.
- **ref 안전 규칙은 그대로 둔다:** `query`로 받은 ref도 같은 snapshot 바인딩(`store.bind`)으로 등록한다. 결과에 없는 ref로 쓰면 지금처럼 `STALE_ELEMENT`다.
- **커서는 그대로 둔다:** `offset`/`elementOffset`/`frameOffset`. `query`가 있으면 각 커서는 걸러낸 결과 안에서 움직인다.
- **커밋 메시지:** 영어 Conventional Commits, 과제 단위로 쓴다.

## Review Focus

1. **`query`로 받은 ref로 바로 쓰기:** 걸러낸 결과의 ref는 다음 클릭에 그대로 쓸 수 있어야 한다. 걸러져 빠진 요소의 예전 ref는 지금처럼 거부된다. → Task 3 E2E `R07`
2. **행의 다른 칸에만 검색어가 있는 컨트롤:** "A-1002 취소"처럼 버튼 이름에는 없고 같은 행에만 있는 말로도 그 행의 버튼이 나와야 한다. → Task 2 `matches a control by the text of its row`
3. **일치하는 것이 없을 때:** 빈 결과와 "일치 없음"을 분명히 알리고, 페이지 전체를 대신 돌려주지 않는다. → Task 2 `reports no match instead of the whole page`
4. **후속 스냅샷 상한:** 요소가 많은 페이지에서 클릭 결과가 40개로 줄고 `elementsNextOffset`이 이어 읽기를 안내한다. 명시 `browser_snapshot`은 지금처럼 150개까지다. → Task 4
5. **지연 이동이 아닌 클릭의 대기:** 아무 변화가 없는 클릭이 1초 넘게 붙잡히지 않아야 하고, 이동이 늦게 시작되면 결과가 이동 성공과 도착 페이지 스냅샷이어야 한다. → Task 5 단위 테스트 두 개와 E2E `R08`

---

### Task 1: 도구 정의 예산을 되찾고 `query`를 공개한다

**Files:**
- Modify: `bridge/src/mcp/tools.rs:6`(`op()`), `:27-34`(`browser_snapshot`), 테스트 모듈
- Modify: `protocol/fixtures/tools-list.json`(`UPDATE_FIXTURES=1`로 재생성)

**Interfaces:**
- Produces: `browser_snapshot` 스키마의 `"query":{"type":"string","maxLength":80}`. 라우터는 스키마에 선언된 속성만 확장에 넘긴다(`router.rs:280-290`). 따라서 이 선언만으로 확장의 `browser.snapshot` 매개변수에 `query`가 실린다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`tools.rs` 테스트 모듈:

```rust
    #[test]
    fn snapshot_can_be_narrowed_by_a_query() {
        let snapshot = super::all().into_iter().find(|t| t.name == "browser_snapshot").unwrap();
        assert_eq!(snapshot.schema["properties"]["query"]["type"], "string");
        assert!(snapshot.description.contains("query"));
    }
```

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- snapshot_can_be_narrowed`
Expected: FAIL

- [x] **Step 3: 구현한다**

```rust
fn op() -> Value { json!({"type":"string","description":"From attach/new"}) }
```

`browser_snapshot`:

```rust
        ToolDef { name: "browser_snapshot", description:
            "Re-read page text and elements with refs (DOM-based); actions already return one. query keeps only matching lines, rows and elements. Continue with offset/elementOffset/frameOffset.",
            schema: json!({"type":"object","properties":{"operationId":op(),
                "query":{"type":"string","maxLength":80},
                "maxChars":{"type":"integer","minimum":200,"maximum":20000},
```

(나머지 속성은 그대로)

`UPDATE_FIXTURES=1 cargo test --offline --locked -p agent-browser-bridge --lib -- tools_list_matches_contract_fixture`로 fixture를 재생성하고, `git diff protocol/fixtures/tools-list.json`에서 `op` 설명·`query`·snapshot 설명만 바뀌었는지 확인한다.

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --lib -- tools::`
Expected: PASS. `total_schema_size_stays_small_for_free_models`와 `page_tools_do_not_require_an_operation_id_in_the_schema`를 포함한다. 후자는 `browser_tabs` 설명의 "panel"로 통과한다.

Run: `pnpm --filter agent-browser-extension exec vitest run test/protocol-contract.test.ts`
Expected: PASS

- [x] **Step 5: 커밋한다**

```bash
git add bridge/src/mcp/tools.rs protocol/fixtures/tools-list.json
git commit -m "feat(bridge): offer a query to narrow browser_snapshot within the tool budget"
```

### Task 2: content 스냅샷이 `query`로 줄·행·요소를 고른다

**Files:**
- Modify: `extension/src/content/snapshot.ts`(`takeSnapshot` 옵션, 본문·요소 선택)
- Create: `extension/test/snapshot-query.test.ts`

**Interfaces:**
- Consumes: Task 1의 `query`(최대 80자)
- Produces:
  - `takeSnapshot(o: {...; query?: string})`
  - `FrameSnapshot.query?: string`(정규화한 검색어를 되돌려 준다)
  - `limits`에 `"query-no-match"`(일치 없음)
  - 일치 규칙(대소문자·공백 차이 무시): 다음 중 하나라도 검색어를 포함하면 고른다.
    - 요소의 이름·값·href
    - 그 요소가 속한 행의 글자. 행은 `closest("tr,li,[role=row],[role=listitem],article")`, 없으면 부모 요소다. 300자까지만 본다.
  - 본문은 검색어가 들어간 줄만, 줄마다 300자까지 이어 붙인 뒤 `offset`/`maxChars`를 적용한다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`extension/test/snapshot-query.test.ts`:

```ts
import { takeSnapshot } from "../src/content/snapshot";
import { resetRegistry } from "../src/content/refs";
const opts = { snapshotId: 1, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false };
beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });

const orders = `<h1>주문 목록</h1><p>배송 안내 문단입니다.</p><table>
  <tr><td>A-1001</td><td>무선 마우스</td><td><button>취소</button></td></tr>
  <tr><td>A-1002</td><td>키보드</td><td><button>취소</button></td></tr></table>
  <a href="/help">고객센터</a>`;

it("matches a control by the text of its row", () => {
  document.body.innerHTML = orders;
  const result = takeSnapshot({ ...opts, query: "a-1002" });
  const buttons = result.elements.filter(e => e.role === "button");
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.name).toBe("취소");
  expect(result.query).toBe("a-1002");
  expect(result.text.content).toContain("A-1002");
  expect(result.text.content).not.toContain("배송 안내");
});

it("matches names, values and links and keeps refs bound like a full snapshot", () => {
  document.body.innerHTML = orders + `<input aria-label="메모" value="고객센터 문의">`;
  const result = takeSnapshot({ ...opts, query: "고객센터" });
  expect(result.elements.map(e => e.name).sort()).toEqual(["고객센터", "메모"]);
  expect(result.elements.every(e => /^s.+f0e\w+$/.test(e.ref))).toBe(true);
  expect(result.elementsTotal).toBe(2);
});

it("reports no match instead of the whole page", () => {
  document.body.innerHTML = orders;
  const result = takeSnapshot({ ...opts, query: "없는말" });
  expect(result.elements).toEqual([]);
  expect(result.text.content).toBe("");
  expect(result.limits).toContain("query-no-match");
});

it("leaves the snapshot unchanged without a query", () => {
  document.body.innerHTML = orders;
  const plain = takeSnapshot(opts);
  expect(plain.elements.filter(e => e.role === "button")).toHaveLength(2);
  expect(plain.query).toBeUndefined();
});
```

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/snapshot-query.test.ts`
Expected: FAIL. 처음 세 테스트가 실패한다. 넷째는 통과할 수 있다.

- [x] **Step 3: 구현한다**

`snapshot.ts`:

```ts
const fold = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
/** The row or item a control belongs to, so "A-1002 취소" finds the button in that row. */
function rowText(el: Element): string {
  const row = el.closest("tr,li,[role=row],[role=listitem],article") ?? el.parentElement;
  return row ? ((row as HTMLElement).innerText ?? row.textContent ?? "").slice(0, 300) : "";
}
```

`takeSnapshot`의 옵션 타입에 `query?: string`을 더한다. 시작 부분에서 정규화한다.

```ts
  const query = o.query ? fold(o.query).slice(0, 80) : "";
```

본문:

```ts
  const fullText = query
    ? pageText(document).split("\n").filter(line => fold(line).includes(query)).map(line => line.slice(0, 300)).join("\n")
    : pageText(document);
```

요소 순회(`walkDeep` 콜백)에서 `const index = result.elementsTotal++;` 바로 앞에 거른다. 이름은 `accessibleName(el)`을 한 번만 계산해 `e.name`에도 쓴다.

```ts
    if (query) {
      const name = accessibleName(el), value = (el as HTMLInputElement).value ?? "", href = (el as HTMLAnchorElement).href ?? "";
      if (![name, value, href, rowText(el)].some(field => fold(field).includes(query))) return;
    }
```

`walkDeep` 뒤:

```ts
  if (query) { result.query = query; if (!result.elementsTotal && !fullText) limits.add("query-no-match"); }
```

`FrameSnapshot` 타입에 `query?: string`을 추가한다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/snapshot-query.test.ts test/candidates.test.ts test/context.test.ts test/output-bytes.test.ts`
Expected: PASS

- [x] **Step 5: 커밋한다**

```bash
git add extension/src/content/snapshot.ts extension/test/snapshot-query.test.ts
git commit -m "feat(extension): narrow a snapshot to matching lines, rows and elements"
```

### Task 3: `query`를 실제 브라우저로 검증한다

**Files:**
- Modify: `tests/e2e/reliability.spec.ts`(R07)
- Modify: `extension/src/background/handlers.ts:243`(`note`에 query 안내)

**Interfaces:**
- Consumes: Task 1·2

- [x] **Step 1: 실패하는 테스트를 쓴다**

`reliability.spec.ts` 끝에 추가한다. `shop.html` 주문표에는 A-1001·A-1002 두 행과 행마다 "취소" 버튼이 있다(`tests/fixtures/site/shop.html`).

```ts
test("R07 a query returns only the matching row's control, whose ref works at once", async () => {
  const { page, operationId } = await attachShop();
  const found = await world.ok("browser_snapshot", { operationId, query: "A-1002" });
  const cancels = all(found.data).filter(e => e.name === "취소");
  expect(cancels).toHaveLength(1);
  expect(found.data.frames[0].query).toBe("a-1002");
  expect(bytes(found)).toBeLessThan(bytes(await world.ok("browser_snapshot", { operationId })) / 2);
  await world.ok("browser_click", { operationId, ref: cancels[0]!.ref });
  await expect(page.locator("#s2")).toHaveText("취소됨");
  await expect(page.locator("#s1")).toHaveText("배송중");
});
```

`shop.html`의 행 버튼은 `data-order`에 따라 그 행의 상태 칸(`#s1`/`#s2`)을 "취소됨"으로 바꾼다(`tests/fixtures/site/shop.html:20`). fixture는 고치지 않는다.

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm --filter agent-browser-extension build && cargo build --offline --locked -p agent-browser-bridge && pnpm --filter agent-browser-e2e exec playwright test reliability.spec.ts -g R07`
Expected: Task 1·2가 커밋된 상태라 PASS일 수 있다. 이 과제는 실제 브라우저 회귀 고정이므로, 단언 하나(예: `toHaveLength(1)`을 `2`로)를 잠시 바꿔 FAIL을 확인한 뒤 되돌린다.

- [x] **Step 3: `note`에 한 줄을 더한다**

`handlers.ts:243`의 `note` 끝에 다음을 덧붙인다.

```text
 Pass query to read only matching lines, rows and elements.
```

`extension/test/handlers.test.ts`에서 note 전문을 비교하는 단언이 있으면 함께 고친다(`grep -n "accessibility tree" extension/test`).

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm --filter agent-browser-e2e exec playwright test reliability.spec.ts`
Expected: R01~R07 PASS

- [x] **Step 5: 커밋한다**

```bash
git add tests/e2e extension/src/background/handlers.ts extension/test
git commit -m "test(e2e): a snapshot query finds a row's control and its ref acts at once"
```

### Task 4: 후속 스냅샷의 요소 수 상한과 포인터 영역 정리

**Files:**
- Modify: `bridge/src/server/router.rs:405-408`(`follow_up_snapshot`), 테스트
- Modify: `extension/src/content/dom.ts:7-14`(`isPointerTarget`)
- Test: `bridge/tests/tool_router.rs`, `extension/test/candidates.test.ts`

**Interfaces:**
- Produces:
  - `pub(crate) const FOLLOW_UP_MAX_ELEMENTS: u64 = 40` (`router.rs`)
  - `isPointerTarget(el)`은 안에 렌더링된 상호작용 요소(`INTERACTIVE`)가 있으면 `false`다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`tool_router.rs`:

```rust
#[tokio::test]
async fn follow_up_snapshots_ask_for_fewer_elements_than_a_full_read() {
    let (_h, serve, cfg) = start_test_serve().await;
    let mut ext = ws_connect(serve.port, "/extension", Some(EXT)).await.unwrap();
    hello(&mut ext, "extension", &cfg.token, "cli-1").await;
    let mcp = mcp_client(serve.port, &cfg.token, "follow-cap").await;
    let task = tokio::spawn(async move { let mut mcp = mcp; tool(&mut mcp, "browser_tabs", json!({"action":"attach"})).await });
    let mut snapshot_params = None;
    let mut task = task;
    loop {
        tokio::select! {
            done = &mut task => { done.unwrap(); break; }
            env = recv(&mut ext) => if let Envelope::Req { id, method, params, .. } = env {
                if method == "browser.snapshot" { snapshot_params = Some(params.clone()); }
                let reply = default_reply(&method, &params).map(|v| Envelope::ok(id.clone(), v))
                    .unwrap_or_else(|_| Envelope::ok(id.clone(), json!({"tabs": []})));
                send_raw(&mut ext, &reply.to_text()).await;
            },
        }
    }
    assert_eq!(snapshot_params.unwrap()["maxElements"], 40);
}
```

`candidates.test.ts`:

```ts
it("does not spend an element slot on a pointer region that holds its own control", () => {
  document.body.innerHTML = `<div style="cursor:pointer"><span>상품 B</span><button>담기</button></div>`;
  expect(takeSnapshot(opts).elements.map(e => [e.role, e.name])).toEqual([["button", "담기"]]);
});
```

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --test tool_router -- follow_up_snapshots_ask`
Expected: FAIL(`maxElements`가 null)

Run: `pnpm --filter agent-browser-extension exec vitest run test/candidates.test.ts`
Expected: FAIL. 새 테스트에서 clickable이 하나 더 나온다.

- [x] **Step 3: 구현한다**

`router.rs`:

```rust
/// Follow-up snapshots ride on every page-changing action; on busy pages the next step rarely
/// needs more than the first screenful of controls, and elementsNextOffset says how to read on.
pub(crate) const FOLLOW_UP_MAX_ELEMENTS: u64 = 40;
```

`follow_up_snapshot`의 매개변수:

```rust
    let params = json!({ "maxChars": 1500, "settleMs": 6000, "maxElements": FOLLOW_UP_MAX_ELEMENTS }).as_object().cloned().expect("object");
```

`dom.ts`:

```ts
export function isPointerTarget(el: Element): boolean {
  const doc = el.ownerDocument;
  if (!(el instanceof HTMLElement) || el === doc.body || el === doc.documentElement) return false;
  if (getComputedStyle(el).cursor !== "pointer") return false;
  const parent = el.parentElement;
  if (parent && getComputedStyle(parent).cursor === "pointer") return false;
  // A card that holds its own button or link is acted on through that control.
  if (el.querySelector(INTERACTIVE)) return false;
  return !parent?.closest(INTERACTIVE);
}
```

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --test tool_router`
Expected: PASS

Run: `pnpm --filter agent-browser-extension exec vitest run test/candidates.test.ts test/names.test.ts`
Expected: PASS. 기존 첫 테스트의 카드에는 상호작용 요소가 없어 그대로 clickable이다.

- [x] **Step 5: 커밋한다**

```bash
git add bridge extension
git commit -m "feat: cap follow-up snapshot elements and skip pointer regions that hold their own control"
```

### Task 5: 클릭 뒤 늦게 시작되는 JS 이동을 잡는다

**Files:**
- Modify: `extension/src/background/handlers.ts:60-115`(클릭·키 처리 성공 경로)
- Test: `extension/test/handlers.test.ts`(`reports a click that navigated…` 옆)
- Create: `tests/fixtures/site/late-nav.html`
- Modify: `tests/e2e/reliability.spec.ts`(R08)

**Interfaces:**
- Produces:
  - `const LATE_NAVIGATION_MS = 1000` (`handlers.ts`)
  - 클릭·키 입력 결과의 `verified`가 `urlChanged`·`domChanged` 모두 `false`일 때만 적용한다. 탭의 `pendingUrl`이 생기거나 `url`이 동작 전과 달라지는지 최대 1초 지켜본다.
  - 바뀌면 `verified`를 `{...verified, urlChanged:true, navigated:true, lateNavigation:true}`로 바꾼다. 그러면 Bridge의 `wants_snapshot`(`router.rs:394`)이 도착 페이지 스냅샷을 붙인다. 이 스냅샷은 `settleMs`로 commit을 기다린다.
  - 바뀌지 않으면 결과를 그대로 둔다.

- [x] **Step 1: 실패하는 테스트를 쓴다**

`handlers.test.ts`:

```ts
it('reports a JS navigation that starts after the observation window', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    const original = w.api.sendToFrame;
    w.api.sendToFrame = async (tabId, frame, msg: any) => {
        if (msg.kind === 'cmd' && msg.method === 'click') {
            setTimeout(() => { w.tabs.get(1)!.pendingUrl = 'https://example.test/late'; }, 300);
            return { ok: true, result: { executed: true, verified: { urlChanged: false, domChanged: false } } };
        }
        return original(tabId, frame, msg);
    };
    await expect(h(request('browser.click', { ref }))).resolves.toMatchObject({ verified: { urlChanged: true, navigated: true, lateNavigation: true } });
});

it('does not hold a click that changed nothing for long', async () => {
    const w = world(), h = createHandlers(w.api, memorySessionStore());
    const ref = await firstRef(h);
    const original = w.api.sendToFrame;
    w.api.sendToFrame = async (tabId, frame, msg: any) => msg.kind === 'cmd' && msg.method === 'click'
        ? { ok: true, result: { executed: true, verified: { urlChanged: false, domChanged: false } } } : original(tabId, frame, msg);
    const started = Date.now();
    const result: any = await h(request('browser.click', { ref }));
    expect(result.verified).toEqual({ urlChanged: false, domChanged: false });
    expect(Date.now() - started).toBeLessThan(2500);
});
```

테스트 world의 탭 객체 필드(`pendingUrl`, `url`)와 `sendToFrame` 응답 모양은 같은 파일의 `reports a click that navigated…` 테스트와 `world()` 정의를 따른다. 응답 모양이 위와 다르면 그 정의에 맞춘다. `trackCreatedTabs`의 관찰 시간이 1초 이상이면 둘째 테스트의 상한을 그 시간 + 1.2초로 둔다. 실제 값은 `tabs.finish()` 구현에서 읽는다.

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/handlers.test.ts -t "observation window|changed nothing"`
Expected: 첫 테스트 FAIL. 둘째는 PASS일 수 있다(회귀 고정용).

- [x] **Step 3: 구현한다**

`handlers.ts`의 클릭·키 실행 함수(`tracksTabs`가 정의된 함수)에서, 디스패치 전에 시작 URL을 읽는다.

```ts
        const startUrl = tracksTabs ? (await getTab(api, tabId).catch(() => undefined))?.url : undefined;
```

성공 응답을 돌려주기 전(`if (tabs) { … return {...result,...children}; }`와 `return response.result;` 두 경로 모두)에 결과를 보정한다.

```ts
    /** A script may navigate a moment after the click's own observation window closed. */
    async function lateNavigation(tabId: number, startUrl: string | undefined, result: any, signal: AbortSignal) {
        const verified = result?.verified;
        if (!verified || verified.urlChanged || verified.domChanged || startUrl === undefined) return result;
        const deadline = Date.now() + LATE_NAVIGATION_MS;
        while (Date.now() < deadline) {
            const tab = await api.tabsGet(tabId).catch(() => undefined);
            if (!tab) return result;
            if (tab.pendingUrl || tab.url !== startUrl) return { ...result, verified: { ...verified, urlChanged: true, navigated: true, lateNavigation: true } };
            await interruptible(new Promise(r => setTimeout(r, 100)), signal);
        }
        return result;
    }
```

두 반환 경로를 `return lateNavigation(tabId, startUrl, <기존 값>, run.controller.signal);`로 감싼다. `tracksTabs`가 아니면 `startUrl`이 `undefined`라 그대로 반환된다.

`tests/fixtures/site/late-nav.html`:

```html
<!doctype html><meta charset="utf-8"><title>Late navigation</title>
<button onclick="setTimeout(()=>{location.href='detail.html'},800)">잠시 후 이동</button>
```

`reliability.spec.ts`:

```ts
test("R08 a click whose script navigates 0.8s later returns the arrived page", async () => {
  const page = await world.open("late-nav.html");
  const attached = await world.ok("browser_tabs", { action: "attach", tabId: await world.tabId(page) });
  const button = all(attached.data.snapshot).find(e => e.name === "잠시 후 이동")!;
  const clicked = await world.ok("browser_click", { operationId: attached.operationId, ref: button.ref });
  expect(clicked.verified).toMatchObject({ navigated: true, lateNavigation: true });
  expect(clicked.data.snapshot.url).toContain("detail.html");
});
```

`detail.html`은 기존 fixture다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm --filter agent-browser-extension exec vitest run test/handlers.test.ts`
Expected: PASS

Run: `pnpm --filter agent-browser-extension build && pnpm --filter agent-browser-e2e exec playwright test reliability.spec.ts board-navigation.spec.ts`
Expected: PASS

- [x] **Step 5: 커밋한다**

```bash
git add extension tests
git commit -m "feat(extension): report a script navigation that starts after a click's observation window"
```

### Task 6: 암묵 attach가 읽기 도구 앞에서 페이지를 두 번 읽지 않게 한다

**Files:**
- Modify: `bridge/src/server/router.rs`(`run`에 후속 읽기 여부 인자, `bind_arguments`)
- Test: `bridge/tests/request_binding.rs`

**Interfaces:**
- Produces: `async fn run_with(state, caller, name, args, follow_up: bool) -> ToolOutcome`. `run(state, caller, name, args)`는 `run_with(…, true)`다. 암묵 attach는 바깥 도구가 읽기(`class_of == Read`)이면 `follow_up=false`로 부른다. 쓰기 도구는 attach 결과를 그대로 돌려줘야 하므로 `true`다(3A의 I2 수정).

- [x] **Step 1: 실패하는 테스트를 쓴다**

`request_binding.rs`:

```rust
#[tokio::test]
async fn an_implicit_attach_before_a_read_reads_the_page_once() {
    let f = setup(false).await;
    let mut mcp = proxy(&f, Some("rid-now"), DIR).await;
    let read = tool(&mut mcp, "browser_snapshot", json!({})).await;
    assert_eq!(read["ok"], true, "{read}");
    assert_eq!(f.ext.methods().iter().filter(|m| *m == "browser.snapshot").count(), 1);
    assert!(!f.ext.methods().iter().any(|m| m == "browser.tabs.list"), "openTabs of a discarded attach result are not read");
}
```

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --test request_binding -- reads_the_page_once`
Expected: FAIL(snapshot 2회)

- [x] **Step 3: 구현한다**

`run`의 본문을 `run_with(state, caller, name, args, follow_up)`로 옮긴다. `add_follow_up_snapshot`과 `add_open_tabs` 호출을 `if follow_up { … }`로 감싼다. `run`은 `run_with(…, true)`를 부른다.

`bind_arguments`의 암묵 attach:

```rust
            let read = tools::class_of(name, &args) == CommandClass::Read;
            let attached = Box::pin(run_with(state, caller, "browser_tabs", &json!({"action":"attach","requestId":bound.id}), !read)).await;
```

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test --offline --locked -p agent-browser-bridge --test request_binding --test tool_router`
Expected: PASS. `first_id_less_write_returns_the_attached_page_instead_of_running`도 포함하며, 쓰기는 여전히 snapshot을 담는다.

- [x] **Step 5: 커밋한다**

```bash
git add bridge
git commit -m "fix(bridge): read the page once when an implicit attach precedes a read"
```

### Task 7: 전체 검증과 문서

**Files:**
- Modify:
  - `docs/browser-capabilities.md`(query, 후속 스냅샷 상한, 지연 이동)
  - `docs/protocol.md`(snapshot `query`·`maxElements`·`lateNavigation`)
  - `docs/review-2026-10-15.md` §E(형식 변경 보류와 측정값)
  - `CHANGELOG.md`
  - `docs/status.md`

- [x] **Step 1: 전체 검증**

```bash
cargo test --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-extension test
pnpm --filter agent-browser-extension exec tsc --noEmit -p .
pnpm --filter agent-browser-extension build && cargo build --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-e2e exec playwright test
bash scripts/test-windows.sh -- journeys.spec.ts reliability.spec.ts board-navigation.spec.ts
bash scripts/test-windows.sh --prepare-only
```

실제 OpenCode 검사는 준비된 Windows 작업 폴더에서 실행한다. `docs/testing.md`의 "실제 OpenCode와 headed Windows 사이드 패널" 절을 따르며, Windows와 `--wsl`로 각각 돌린다. 패널 연속 작업 12종과 ID 없는 결합이 계속 통과해야 한다.

Expected: 모두 PASS. 개수를 기록한다.

- [x] **Step 2: 문서를 갱신한다**

- **`browser-capabilities.md`:**
  - `browser_snapshot {query}`는 그 말이 들어간 줄, 같은 행에 그 말이 있는 컨트롤, 이름·값·링크가 맞는 요소만 돌려준다.
  - 동작 결과의 스냅샷은 요소 40개까지이고, 더 보려면 `browser_snapshot`의 `elementOffset`을 쓴다.
  - 클릭 후 1초 안에 시작된 스크립트 이동은 이동 성공과 도착 페이지로 보고한다.
- **`protocol.md`:** snapshot 매개변수 표에 `query`(≤80자, 대소문자·공백 무시)와 `maxElements`를 추가한다. `limits`의 `query-no-match`와 click·press `verified.lateNavigation`도 추가한다.
- **`review-2026-10-15.md` §E 계획 3:** "계층형 인라인 스냅샷은 2026-10-16 측정(8개 fixture, 최종 텍스트 19% 절감, 문장이 많은 페이지 6%)에 따라 보류. `query`와 후속 상한으로 대체" 한 줄을 추가한다. 근거는 이 계획 문서로 링크한다.
- **`CHANGELOG.md` `[미배포]`:**
  - 필요한 행·문장만 읽는 스냅샷 검색을 추가했다.
  - 동작 결과의 스냅샷 크기를 줄였다.
  - 클릭 후 조금 늦게 이동하는 페이지도 이동 결과를 돌려준다.
  - 버튼을 품은 카드가 요소 목록을 차지하지 않는다.
- **`status.md` 맨 위:** 실행한 명령·결과·미검증을 기록한다.

- [x] **Step 3: 커밋한다**

```bash
git add docs CHANGELOG.md
git commit -m "docs: describe snapshot queries, follow-up caps and late navigation"
```

---

## 이후 계획

- **계획 3C — 작업 가시성·알림·인계(리뷰 B4, 요구사항 §16):**
  - 확장 아이콘 배지, 작업 탭 테두리, 조작 대상 강조
  - 패널이 닫혀 있을 때 권한·질문 알림
  - [잠시 넘겨받기]/[이어서 진행]
  - 계획 2에서 미룬 설치기 minor 5건
  - 계획 3A에서 미룬 minor 3건: 동시 첫 호출의 BUSY, `null` ID, 비객체 상태 응답
- **계획 4 — 선택 권한(CDP·tabGroups):** Task 1은 확인 작업이다.
