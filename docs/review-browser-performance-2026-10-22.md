# 브라우저 제어 성능·정확도 검토 — 2026-10-22

검토 기준: main `e576472b12365cfc457144c372753bb8f9409f46`(v0.2.1 게시 기록까지). **검토 및 재현 결과이며 구현 완료 보고가 아니다.** 제품 소스·설정은 수정하지 않았다.

가장 먼저 개선할 부분은 **대상 식별의 정확성, 조작 후 완료 조건, 조건에 따른 대기**다. 현재 구조를 유지하면서 해결할 수 있다. 다음으로 스냅샷 검색 비용과 모델에 전달하는 관찰량을 줄이고, 마지막으로 실제 모델의 업무 성공률·호출 횟수를 비교해야 한다.

## 1. 이미 갖춘 기반과 이번 검토의 범위

현재 구현에는 문서·프레임·작업에 결합된 ref, DOM 교체/이름/href 변경 검출, 작업 탭 고정, 중복 실행 방지, 취소 세대, `EXECUTION_UNKNOWN`, 페이지 변화 뒤 자동 스냅샷, 검색과 페이지 나누기, UTF-8 결과 예산, 선택적 debugger 입력이 있다. 이 기능들을 새로 만드는 계획으로 되돌리지 않는다.

OpenCode v1 → MCP stdio → Windows Bridge → 확장 → content script 구조를 유지한다. 자체 에이전트 하네스, Playwright MCP로의 교체, Linux 제품 Bridge, 필수 이미지 모델, 다중 작업 병렬 스케줄러는 제안 범위에 넣지 않는다.

이번에 한 일:

- 브라우저 content/background, Rust MCP/router, 도구 스키마, 기존 E2E·모델 평가 코드를 확인했다.
- 현재 동작과 바람직한 동작의 차이를 확인하는 임시 Vitest probe 6개를 작성했다. **6개 모두 기대한 개선 조건을 만족하지 못해 실패**했다. 이는 개선점 재현이며 기존 테스트 회귀 6개가 생겼다는 뜻은 아니다.
- 직접 관련된 기존 `actions`, `snapshot`, `names`, `late-navigation` 테스트 **72개는 통과**했다.
- 현재 소스로 확장을 빌드하고 Linux 개발용 Bridge를 빌드했다.
- 격리한 MCP·Bridge·확장·Chromium으로 측정/재현 시나리오 **2개를 실행해 관측값을 확인**했다. 결함을 고쳤다는 뜻의 통과가 아니다.
- 임시 검사 파일은 제거했고, 수치와 합성 사례만 [측정 JSON](./reference/browser-performance-2026-10-22.json)에 보존했다.

**실제 Windows 실행, 기존 사용자 Chrome 프로필, 실제 LLM 호출은 이번에 하지 않았다.** Windows CI 성공 기록과 이번 Linux 측정은 별개다. [testing.md](./testing.md)의 사용자 WSL 실사용 확인도 인정하되, 모델별 정량 성공률·지연의 비교 자료로 확대 해석하지 않는다.

## 2. 지연 실측

환경: Linux/WSL, Node 24.18.0, Playwright Chromium **156.0.8078.4 headless**, Bridge **0.2.1 debug**, 현재 소스의 production 확장 번들. 기존 E2E 하네스의 합성 localhost 페이지·임시 프로필·인증 WebSocket relay를 사용했다. 제품 경로의 MCP 호출 전부터 결과 수신까지 측정했으며 OpenCode/모델 시간은 포함하지 않는다.

항목별 예열 1회 후 7회 측정했다. 표본이 작아 p95나 제품 SLA로 쓰지 않는다. 서로 다른 단계의 병목 후보를 찾기 위한 기준값이다.

| 동작 | 중앙값 | 최소–최대 | 반환량 평균 |
|---|---:|---:|---:|
| 탭 목록 | 47.2ms | 42.9–48.6ms | 767 bytes |
| 텍스트 입력 | 52.1ms | 49.8–54.1ms | 165 bytes |
| 변화 없는 클릭 | **1,622.2ms** | 1,620.3–1,629.0ms | 172 bytes |
| 즉시 DOM을 바꾸는 클릭 + 자동 스냅샷 | **671.3ms** | 667.5–673.0ms | 별도 집계 안 함 |
| 100행 일반 스냅샷 | 60.1ms | 57.3–65.1ms | 10,358 bytes |
| 100행 검색, 일치 없음 | 63.3ms | 58.7–66.2ms | 1,153 bytes |
| 1,000행 일반 스냅샷 | 59.8ms | 49.1–62.8ms | 16,329 bytes |
| 1,000행 검색, 일치 없음 | 96.4ms | 92.0–110.9ms | 1,153 bytes |
| 5,000행 일반 스냅샷 | **145.0ms** | 120.4–163.8ms | 16,330 bytes |
| 5,000행 검색, 일치 없음 | **892.1ms** | 809.5–1,033.7ms | 1,153 bytes |

합성 큰 페이지는 `main` 아래 `div > span(Record N) + button(Action N)`을 반복했다. 검색어는 존재하지 않는 `missing-record`다. 일반 스냅샷은 요소 예산 때문에 일부만 반환한다. 검색은 거의 빈 결과인데도 5,000행에서 약 6.2배 오래 걸렸다. 이는 **반환량 절감과 페이지에서 실행하는 계산량 절감이 다르다**는 증거다. 모든 페이지/검색에서 같은 비율이라는 뜻은 아니다.

전체 업무 시간은 모델 판단 시간, 도구 왕복, 페이지 계산, 실제 사이트 응답, 대기 및 재시도로 나누어야 한다. 위 표로 모델이 느린지, Windows IPC가 느린지, 전체 업무를 몇 % 줄일지 판단할 수는 없다.

## 3. 정확도 개선: 먼저 고칠 항목

### A. 반복 목록의 ref가 다른 업무 대상을 가리킬 수 있음 — 우선순위 P0

근거: [refs.ts](../extension/src/content/refs.ts) `RefTable.identity`, [snapshot.ts](../extension/src/content/snapshot.ts) `contextOf`.

현재 ref identity는 role/name/href/type/target/formaction 등을 보지만 **상위 행의 주문 번호·문서명은 보지 않는다.** 스냅샷에는 행 문맥이 보이더라도 실행 시 그 문맥이 유지되는지 확인하지 않는다.

재현: 두 행에 각각 `A-1001`, `B-2002`와 같은 이름의 `Cancel` 버튼을 둔다. 첫 버튼 ref를 받은 다음, 같은 DOM을 유지하며 첫 행 번호만 `C-3003`으로 바꾼다. 이전 ref 클릭이 `ok:true, executed:yes`이고 실제 handler는 **C-3003**을 대상으로 실행됐다. jsdom과 실제 Chromium의 전체 MCP 경로 모두 확인했다.

개선:

- 요소 자체와 별도로 가장 가까운 의미 있는 행/카드/폼의 식별 근거를 저장한다. 구분 가능한 링크, 레코드 이름, 명시적 레이블 등을 우선하고 입력 값·시계·진행률 같은 변동값은 제외한다.
- 동일 노드라도 대상 근거가 달라지면 `STALE_ELEMENT`로 중단한다. 유사한 새 버튼으로 자동 대체하지 않는다.
- 근거가 부족한 가상 목록은 관련 영역의 변경을 보수적으로 무효화하되 페이지 전체 mutation마다 모든 ref를 버리지 않는다. 잘못된 클릭과 불필요한 stale 비율을 함께 측정한다.
- 이름은 표시용 80자와 검증용 identity를 분리한다. 현재는 `accessibleName`의 잘린 값이 identity에도 사용되어 공통 접두사가 긴 이름을 구분하기 어렵다. 이 긴 이름 사례는 코드 검토 사항이며 별도 브라우저 재현은 하지 않았다.

완료 기준: 같은 버튼 노드의 행 재사용에서 잘못된 handler 실행 0회, 정렬·페이지 교체·가상 스크롤·긴 공통 이름 회귀 통과, 정상 fill/select로 자기 ref가 무효화되지 않음.

### B. 입력 직후 값이 맞아도 앱 상태가 유지된다는 증거가 부족함 — P0

근거: [actions.ts](../extension/src/content/actions.ts) `fill` 251행 이후, `select` 283행 이후.

입력은 native setter → input/change → 즉시 `el.value` 확인으로 끝난다. `input` handler가 `queueMicrotask`에서 값을 원복하면 결과는 `verified:{matches:true,value:"after"}`지만 **호출 결과를 받은 시점의 실제 값은 `before`**다. jsdom과 전체 Chromium 경로에서 재현했다. 기존 React 유사 테스트는 동기 반영만 검사한다.

개선:

- 최소한 앱 반영 턴 이후 동일 문서·동일 대상의 값/checked/선택 상태를 재검증한다. 실제 React controlled input, 마스킹 입력, debounce 검증, contenteditable 사례를 추가한다.
- 입력 전달과 값 유지 확인을 구분하고, 원복·변환·거부를 결과에 알린다. 페이지가 의도적으로 포맷을 바꾸는 경우 실제 값과 검증 조건을 함께 제공한다.
- 입력 결과 확인 실패를 입력 재실행으로 연결하지 않는다. change handler도 서버 작업을 시작할 수 있다.
- 임의의 미래 원복까지 보장할 수는 없다. 비동기 업무 완료가 필요한 경우 명시적인 기대 조건과 timeout을 사용한다.

### C. 이름·문맥·상태 정보 누락 — P1

근거: [dom.ts](../extension/src/content/dom.ts) `accessibleName`, [snapshot.ts](../extension/src/content/snapshot.ts) 193행 이후, [actions.ts](../extension/src/content/actions.ts) `assertInteractable`.

임시 단위 검사로 다음을 각각 재현했다.

| 사례 | 현재 결과 | 필요한 결과 |
|---|---|---|
| `aria-label="취소"`와 `aria-labelledby`의 `주문 A-1001 취소`가 함께 있음 | `취소`만 반환 | 연결 레이블 우선 |
| open ShadowRoot 안의 span을 같은 root의 input이 `aria-labelledby`로 참조 | 이름이 빈 문자열 | root 안의 레이블 해석 |
| `role=button aria-disabled=true` | click이 `executed:true`로 완료 | 비활성 상태 표시 및 dispatch 전 거부 |
| `query:"A-1001"`로 반복 취소 버튼 중 하나만 남음 | 해당 요소의 `context` 없음 | 검색/페이지 나누기 뒤에도 행 식별 문맥 유지 |

`aria-labelledby` 우선순위는 [W3C Accessible Name 1.1의 계산 순서](https://www.w3.org/TR/accname-1.1/#mapping_additional_nd_te)와도 다르다. DOM 기반 근사치를 완전한 브라우저 Accessibility Tree라고 부를 필요는 없지만, 이름 우선순위와 root 범위는 일관되어야 한다.

현재 문맥은 **반환된 묶음 안에서** 같은 이름이 둘 이상일 때만 붙는다. 검색으로 한 개만 남거나 pagination 경계에서 분리되면 정보가 사라진다. 행/카드 문맥을 후보 수집 시 결정하고, 검색 결과에는 어떤 근거가 일치했는지도 작게 제공하는 편이 좋다.

추가로 검토할 필드: 실제 적용 범위의 `aria-disabled`, `aria-busy`, dialog/landmark/section, `aria-describedby`의 오류 설명, 선택/펼침/현재 항목, viewport와 가려짐. 모든 필드를 매번 내보내지 말고 대상 구분이나 다음 행동에 필요한 정보만 반환한다.

## 4. 대기와 완료 확인을 함께 개선

### D. 고정 관찰 때문에 빠른 동작도 느리며, 늦은 완료는 놓침 — P1

근거: [actions.ts](../extension/src/content/actions.ts) `observeChanges(500)`, [tab-routing.ts](../extension/src/background/tab-routing.ts) `finish`의 100ms, [handlers.ts](../extension/src/background/handlers.ts) `lateNavigation`, [late-navigation.ts](../extension/src/background/late-navigation.ts).

일반 클릭의 변화 관찰은 변화가 즉시 발생해도 500ms를 채운다. 그 뒤 새 탭 이벤트를 위해 100ms를 기다린다. 변화가 없으면 URL을 최대 1,000ms 더 관찰한다. 이것이 측정된 약 0.67초/1.62초와 부합한다. 20번의 변화 없는 클릭이라면 이 경로에만 약 32초를 쓸 수 있지만, 이는 같은 합성 동작 반복의 계산이며 실업무 예상치는 아니다.

반대로 `Loading next page`를 먼저 표시하고 1초 뒤 이동하는 버튼은 **663.8ms에 이전 페이지 스냅샷을 반환**했고, 실제로는 이후 `/detail.html`로 이동했다. `domChanged:true`이면 늦은 이동 감시를 생략하기 때문이다. 현재 결과는 그 시점의 관찰로는 맞지만 다음 행동을 시작해도 되는 완료 상태를 뜻하지 않는다.

개선 방향은 조작 전 준비, 입력 전달, 기대 상태 확인을 분리하는 것이다.

1. 조작 전: ref identity, visibility, enabled/editable, hit test, 필요한 위치 안정성을 제한시간 안에 확인한다. overlay/animation은 아직 입력을 보내지 않았을 때만 짧게 기다려 다시 검사한다.
2. 조작: 한 번 전달한다. 이후 불확실성은 관찰로 풀며 자동 재클릭하지 않는다.
3. 조작 후: 선택 상태, 입력 값, 메뉴 열림, 기대 텍스트, URL/문서 변경, 생성 탭 등 목적에 맞는 상태를 확인한다. 조건이 충족되면 고정 500ms를 모두 기다릴 필요가 없다.
4. 특별한 기대 조건이 없으면 한정된 관찰 결과임을 명시한다. DOM mutation 하나를 업무 완료로 승격하지 않는다.

현재 `browser_wait`는 여러 조건을 주면 **OR**다. 이전 호출 호환성을 유지하고 명시적인 `all`/`any`, role/name 또는 ref의 visible/enabled/value/checked 상태 조건을 추가하는 방안을 권장한다. 단순히 기존 OR를 AND로 바꾸면 안 된다.

우선 기존 action에 작은 typed `expect`/`waitFor` 선택 인수를 더하는 방법을 검토한다. 예를 들어 검색 클릭에 결과 heading 출현 조건을 함께 주면 모델의 별도 wait 호출과 판단 왕복을 줄일 수 있다. 임의 JavaScript 조건, 추론 루프, 사이트별 에이전트 엔진은 필요 없다. timeout 때는 `executed:yes`와 조건 미충족을 함께 반환해야 한다.

[Playwright의 actionability](https://playwright.dev/docs/actionability)는 visibility·안정성·이벤트 수신·enabled를 조작 전에 확인하는 참고 사례다. 이 원칙을 현재 확장 구조에 적용할 수 있다. 브라우저 background 탭에서는 animation frame이 제한될 수 있으므로 rAF 두 번만 무한히 기다리는 구현도 피해야 한다.

### E. 이동·스크롤·좌표의 준비 상태를 통일 — P1

- [tabs.ts](../extension/src/background/tabs.ts)의 navigate/new는 `status=complete`를 기다리며 30초 제한을 갖는다. [tab-routing.ts](../extension/src/background/tab-routing.ts)의 암묵적 새 탭도 complete를 최대 10초 기다린다. follow-up snapshot은 DOM이 읽히면 빠져나오는 다른 정책을 갖는다. 읽을 수 있는 문서 commit/DOM 준비와 업무상 기대 조건을 구분해 일관된 정책으로 만든다. 긴 하위 리소스 로딩이 다음 읽기를 막는지 Windows에서도 측정한다.
- 사이트 전체 `networkidle`은 기본 완료 조건으로 적합하지 않다. [Playwright 공식 API](https://playwright.dev/docs/api/class-page#page-wait-for-load-state)도 준비 여부를 웹 상태 assertion으로 검사하도록 안내한다.
- `assertInteractable`은 이미 보이는 요소도 매번 `scrollIntoView({block:"center",behavior:"instant"})`한다. 현재 hit test가 가능한 위치라면 유지하고, 필요할 때만 가장 가까운 위치로 스크롤하면 화면의 반복적인 점프를 줄일 수 있다. sticky header/중첩 컨테이너/배율은 별도 회귀 조건이다.
- `browser_scroll`은 CSS smooth 설정을 상속하면서 즉시 scrollTop을 반환한다. 합성 페이지에서 반환값은 **0**, 직후 실제 관측은 **318**이었다. 스크롤 완료 또는 안정된 위치를 확인하고, 끝에 도달했는지·움직이지 않았는지도 보고해야 한다. 318은 최종 완료 위치가 아니라 이후 관측값이다.
- 신뢰 클릭은 content script의 좌표 산출 뒤 background/CDP로 왕복한다. 마지막 geometry·문서·대상 검증과 실제 dispatch 사이 경합을 줄이는 경로가 필요하다. 완전한 원자성을 주장하지 않으며 포인터 일부 전달 뒤의 DOM fallback 금지는 유지한다. 이 좌표 경합은 코드/기존 상태 기록으로 확인한 위험이며 이번에 별도 재현하지 않았다.

## 5. 스냅샷을 더 싸고 유용하게 만들기 — P1/P2

근거: [snapshot.ts](../extension/src/content/snapshot.ts), [dom.ts](../extension/src/content/dom.ts), [observe.ts](../extension/src/content/observe.ts), [frames.ts](../extension/src/background/frames.ts), [chrome-api.ts](../extension/src/background/chrome-api.ts), [dedupe.ts](../extension/src/background/dedupe.ts).

지금은 query를 지정해도 전체 본문을 만들고 후보 요소 전체를 훑는다. 일반 snapshot은 앞쪽 반환 후보만 이름을 계산하지만 query는 각 후보의 이름·값·링크·행 텍스트를 판정한다. 요소 예산에 도달해도 전체 개수 계산과 순회를 계속한다. `observePage`는 mutation callback마다 open ShadowRoot를 찾으려고 `querySelectorAll("*")`를 다시 하고, wait도 250ms마다 이 검색과 조건 검사를 반복한다. 고변경 페이지에서 main thread 작업이 커질 가능성이 있다. 이 중 query 지연은 실측했고 observer 비용의 비중은 별도 profile이 필요하다.

권장 순서:

1. **검색 범위 지정:** 현재 dialog/region/ref/frame을 지정해 그 범위부터 읽는다. 기존 query·cursor는 유지하고 일반 페이지 읽기로 돌아갈 수 있게 한다. viewport 우선순위가 화면 밖 목표를 영구적으로 숨기지 않도록 한다.
2. **계산 중복 제거:** 한 번의 snapshot 안에서 role/name/style/행 문맥을 공유한다. observer는 추가된 subtree를 중심으로 새 ShadowRoot를 찾고, 기존 host에 뒤늦게 붙는 root를 위한 제한된 재검사 경로를 둔다. 단순히 전체 스캔을 없애 지원 범위를 줄이지 않는다.
3. **시간 예산:** 큰 순회는 짧게 나누고 취소를 확인한다. 도중 mutation으로 섞인 snapshot을 만들지 않게 문서/관련 변경 세대를 검증한다. 정확한 전체 개수 때문에 계속 전체 순회를 할지, `hasMore`/continuation 계약으로 바꿀지 검토한다.
4. **확장 API 왕복:** 매 명령마다 같은 document에 `content.js`를 다시 executeScript 한다. documentId별 준비 상태와 오류 시 재주입을 검토한다. worker 재시작, 확장 업데이트, BFCache에서 잘못된 준비 캐시를 재사용하지 않는 시험이 먼저다. storage.session 전체 상태의 반복 read/clone/prune도 계측 후 줄인다. 영속 in-flight 마커는 약화하지 않는다.
5. **프레임:** 현재 순차 처리와 20 frame/28KB 한도는 유지 근거가 있다. 프레임 다수 페이지의 실제 대기 비중을 측정한 뒤에만 2–4개 정도의 제한된 병렬 읽기를 검토한다. 결과의 document 일관성·취소·총 바이트 예산은 유지한다.
6. **출력 압축:** 자동 결과는 관련 영역/변경 요약을 우선한다. 현재 press는 모든 키에 snapshot을 붙이고, 일반 DOM 변화는 관계없는 시계·광고 변경도 snapshot 사유가 된다. Tab·커서 이동은 focus/value 같은 작은 결과가 더 적합할 수 있다. diff를 도입한다면 기준 snapshot 식별·누락 시 full 재동기화·ref 수명 계약이 먼저다.

표시 텍스트를 더 짧게 자르거나 최대 요소 개수를 일괄 줄이는 것만으로 해결하지 않는다. 이름과 행 식별 근거를 잃으면 모델의 재질문·추가 snapshot·오클릭이 늘 수 있다. 문서 24KB, 합산 28KB, MCP 40KB의 기존 UTF-8 예산도 유지한다. bytes나 문자 수를 토큰 수라고 부르지 않는다.

현재 [Playwright MCP의 find/snapshot](https://github.com/microsoft/playwright-mcp#tools)은 검색 결과 주변 문맥과 범위 제한을 제공하는 참고 사례다. 이미 있는 query 기능에 필요한 문맥 보존과 범위 제한을 보완하는 근거로만 사용한다.

## 6. 입력 방식과 모델 호출 수 개선 — P2

선택적 신뢰 입력은 이미 구현돼 있으므로 신규 CDP 엔진 도입이 첫 과제가 아니다. 기본 DOM 경로와 선택적 CDP 경로 각각의 성공률을 측정한다. 현재 fill/select는 DOM 경로이며 하위 frame의 click/key는 신뢰 입력 대상이 아니다.

우선순위는 실제 React 입력·커스텀 combobox·popover·가상 목록·키보드 접근 사례다. 그 뒤 필요성이 확인된 iframe 입력을 확장한다. [Chrome debugger 공식 문서](https://developer.chrome.com/docs/extensions/reference/api/debugger#work-with-frames)는 같은 프로세스 frame과 별도 프로세스 frame의 context/target 처리가 다름을 설명한다. 좌표에 iframe offset만 더하는 구현으로 끝내면 안 된다. 권한 기본값과 사용자의 debugger 해제는 존중한다.

호출 수를 줄이는 작은 도구 계약 개선은 다음 순서가 적합하다.

- 이미 반환된 snapshot을 사용하는 흐름을 유지하고, 스키마 설명을 실제 조건과 맞춘다. `browser_snapshot`의 “actions already return one”을 fill/select까지 항상 붙는 것으로 오해하지 않게 한다.
- action + 기대 조건 + 관련 결과를 한 번에 받는다. 이득은 JS 몇 ms보다 모델 왕복 1회를 줄이는 데서 클 수 있다. 실제 모델 측정 전에는 절감률을 확정하지 않는다.
- 여러 필드의 입력이 반복되는 업무가 확인되면 제한된 `fill_form`을 검토한다. 필드마다 순차 실행/검증하고 DOM 교체 시 멈춘다. 개별 결과·부분 완료·취소를 반환하며 제출/삭제/결제와 묶지 않는다. 이것은 작은 복합 도구이며 트랜잭션·자동 롤백·자체 계획 엔진이 아니다.
- 이미지 관찰은 DOM으로 찾기 어려운 사례를 확인하는 보조 수단으로 유지한다. 모든 단계 screenshot이나 좌표 추측을 기본으로 만들지 않는다.

## 7. 측정·평가를 구현과 함께 보강

현재 [timeline.rs](../bridge/src/server/timeline.rs)는 시각/tool/요약/outcome을 보관하지만 단계별 duration이나 payload bytes는 없다. [모델 runner](../tests/agent/runner-lib.mjs)는 fixture 결과를 검사하는 좋은 기반이 있으나 [prompt](../tests/agent/prompt.md)가 도구 순서를 자세히 알려주고, 채점도 attach/new/extract/switch/release라는 특정 경로에 결합돼 있다.

따라서 현재 자동 테스트 통과는 **사용자가 목적만 말했을 때의 수행 정확도**를 충분히 설명하지 못한다. 기존 도구 계약 검사는 유지하고, 목표만 주는 업무 평가를 추가한다. 같은 성공 결과를 더 적은 호출로 만든 합법적인 경로를 실패로 채점해서는 안 된다.

| 측정 대상 | 필요한 지표/판정 |
|---|---|
| 업무 성공 | fixture의 실제 저장/조회/추출 결과를 정답으로 사용. 도구 `ok`나 모델의 완료 문장으로 대신하지 않음 |
| 잘못된 성공 | 입력 원복·잘못된 행·로딩 중 상태를 성공으로 보고한 횟수 |
| 실행 안전성 | 잘못된 대상 실행, 중복 제출, 중단 뒤 실행 횟수 |
| 반응성 | 도구별 p50/p95, 준비/dispatch/검증/snapshot/전송 시간, 최장 main-thread 작업 |
| 모델 효율 | 완료까지 모델 단계 수, 도구 호출 수, 반복 snapshot, 복구 횟수, 실제 보고된 input/cache/output 토큰, 업무 전체 시간 |
| 연결 안정성 | heartbeat 왕복/단절 횟수, worker 재시작 후 복구, unknown 결과의 확인 경로 |

로컬 계측에는 correlation ID, duration, 개수, bytes, 오류 코드를 남기고 페이지 원문·입력 값·실제 대화·토큰/비밀을 넣지 않는다. 원격 telemetry는 필요 없다. 서로 다른 프로세스의 절대 시계를 빼기보다 각 단계의 monotonic duration을 전달한다.

시험 묶음은 검색→결과, 반복 행 작업, 5–10필드 폼, debounce 자동완성, 포털 메뉴/대화상자, 지연 이동/SPA, 가상 스크롤, iframe/open Shadow DOM, 새 탭 복귀, 첨부 업로드, 중단/재연결, 명시적 실패 경계로 구성한다. 정렬·레이블 중복·로딩 지연을 바꾼 합성 변형도 포함한다. 동일 fixture·동일 프로필 설정·동일 모델로 전후를 비교한다.

결정적 검사는 작업별로 실패 테스트를 먼저 추가하고 직접 영향 범위만 실행한다. 마일스톤 끝에는 Windows 실제 Chrome·MSVC Bridge로 통합 검증하고 DOM/CDP 모드를 나눠 확인한다. 지연 p95는 예열 후 충분한 반복(초안 50회 이상)에서 수집하며 표본과 환경을 기록한다. 모델 평가는 기존 Zen 무료 모델 검증/격리 runner를 확장하고, 가격·현재 허용을 확인한 모델만 실행한다. 접근 거부 시 모델 점수는 미측정으로 둔다.

B10 간헐 시간 초과는 여전히 별도 미해결 항목이다. `serve_extension`이 일반 요청 일부를 loop에서 await하지만 runtime/profile/doctor는 이미 별도 task로 처리한다. 따라서 “모든 요청이 heartbeat를 막는다”라고 단정해서는 안 된다. heartbeat 시점을 조절한 재현과 낮은 비용의 계측으로 확인하며 단순 timeout 연장/재시도로 숨기지 않는다.

## 8. 실행 권장 순서와 완료 조건

| 순서 | 작업 묶음 | 기대 효과 | 완료 판단 |
|---|---|---|---|
| 1 | 이번 재현 사례 회귀화 + 로컬 시간/크기 기준선 | 개선이 실제인지 판단 | 동일 환경의 전후 측정 가능, 실제 상태 oracle 마련 |
| 2 | 행 identity, 입력 유지 검증, 이름/root/disabled/context 보완 | 잘못된 대상·성공 보고 감소 | 이번 6개 개선 조건 충족, 행·입력 E2E 실제 상태 일치 |
| 3 | 조작 전 auto-wait + action 기대 조건 + 이동/스크롤 완료 | 빠른 동작의 지연 감소, 느린 상태의 정확도 상승 | no-op/즉시 변화/늦은 변화 구분, 반복 dispatch 없음, 중간 화면 오인 방지 |
| 4 | query 계산/observer/범위/출력/주입 최적화 | 큰 페이지 멈칫함·읽기 비용 감소 | 이름/문맥 보존, 검색 출력량 유지, 5,000행과 고변경 페이지의 전후 시간 개선 |
| 5 | 필요 시 복합 폼·frame 신뢰 입력 + 실제 모델 비교 | 모델 왕복과 복구 횟수 감소 | 목표만 준 업무 성공률 향상 또는 유지, 호출/시간 감소, Windows 회귀 통과 |

처음 성능 목표로는 즉시 완료되는 상호작용의 현재 500ms 고정 대기를 없애고, 5,000행 검색이 현재 약 0.89초를 반복 소비하는 경로를 줄이는 것이 적절하다. 구체적인 제품 SLA는 Windows release 빌드 기준선을 만든 뒤 정한다. 실제 사이트 응답·모델 판단 시간을 포함한 “몇 배 빨라진다”는 약속은 아직 근거가 없다.

이번 검토에서 남긴 변경은 이 문서, 측정 JSON, status 기록뿐이다. 구현·Windows 검증·모델 성능 개선은 후속 작업이다.
