# M1 구현 인수인계 (2026-10-11 세션 종료 시점)

**현재 업데이트: Task 1–13 구현·Linux 검증 완료. 전체 브랜치 검토와 Task 14–15 Windows 검증이 다음 작업이다. 아래 과거 인수인계/검토 내용은 당시 기록이며, 최신 완료 상태는 docs/status.md를 우선한다.**

새 세션은 이 문서 → `docs/status.md` → 계획서 `docs/plans/2026-10-11-m1-browser-control.md`의 **Task 11**부터 읽고 이어간다.
계획서의 체크박스는 갱신하지 않았다. 진행의 근거는 이 문서와 `git log`다.

## 한눈에 보기

| 항목 | 값 |
|---|---|
| 브랜치 | `feat/m1-browser-control` (main `f156c33`에서 분기), 구현 마지막 커밋 `d0cbc1e`, 인수인계 추가 커밋 `7ca563e` |
| 완료 | Task 1–10 |
| 남음 | Task 11 → 12 → 13 → (전체 브랜치 코드 리뷰) → 14 → 15 |
| push·PR | 하지 않았다. 사용자가 요청할 때만 한다 |
| 작업 트리 | 이전 세션 종료·이번 검토 시작 시 깨끗함. 이번 검토에서는 `docs/status.md`와 이 문서만 갱신 |

## 기준선 (이 시점에 실제로 실행한 결과)

| 명령 | 결과 |
|---|---|
| `cargo test -p agent-browser-bridge` | lib 21, mcp_stdio 5, protocol_contract 4, serve_auth 18, serve_port_conflict 2, tool_router 13 — 모두 통과 |
| `pnpm --filter agent-browser-extension exec vitest run` | 6 파일 39 테스트 통과 |
| `node --test tests/fixtures/server.test.mjs` | 3 통과 |
| `pnpm --filter agent-browser-extension build` | 성공(`extension/dist`) |
| `cargo xwin build -p agent-browser-bridge --release --target x86_64-pc-windows-msvc` | 성공(Task 7 시점). **exe 실행은 한 번도 하지 않았다** |

전부 Linux에서의 결과다. Windows 실행·실제 Chrome 로드·OpenCode 연동은 **미검증**이며 Task 14·15의 몫이다.

## 이어서 하는 방법

1. `git status`, `git log --oneline main..HEAD`로 위 상태와 일치하는지 확인한다.
2. `superpowers:executing-plans`로 Task 11부터 순서대로 진행한다. 서브에이전트에 나누지 않는다(사용자 지시).
   과제 시작은 `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/executing-plans/scripts/task-start <plan> N`,
   종료는 같은 디렉터리의 `task-done <plan> N <BASE> -- <테스트 명령>`.
   - 원장은 `.superpowers/sdd/2026-10-11-m1-browser-control/progress.md`(git 무시 대상). 사라졌다면 아래 "계획 대비 변경"과 `git log`로 복구한다.
   - `task-done`에 `bash -c '...'` 래퍼를 쓰면 안전 점검에 막힌다. 테스트 명령을 직접 넘기고 둘 이상이면 따로 실행한다.
   - **테스트가 통과한 것을 확인한 뒤에만 커밋한다.** `| grep`으로 결과를 가리면 실패해도 커밋이 진행된다.
   - `pkill -f`·`pgrep -f` 패턴이 자기 셸 명령줄과 일치해 셸이 종료된 적이 있다. `pgrep -af '^[^ ]*browser-bridge serve'`처럼 앵커를 쓴다.
3. 과제 단위: 실패 테스트 → 실패 확인 → 구현 → 통과 확인 → 커밋. 전체 검증은 마일스톤 끝에 한 번.
4. 커밋은 영어 Conventional Commits, 저장소 로컬 GitHub noreply 작성자 설정을 사용한다. 이전 세션의 에이전트 attribution을 다른 작성 환경에 그대로 복사하지 않는다.
5. 결과는 `docs/status.md`의 "실제 실행한 검증" 표에 과제마다 행을 추가한다(Linux 결과를 Windows 결과로 쓰지 않는다).

## 남은 작업과 멈출 지점

| 과제 | 내용 | 비고 |
|---|---|---|
| 11 | Service Worker 명령 처리(탭·프레임·이동·스크린샷·중복 방지) | `extension/src/background/handlers.ts`의 임시 본문 교체 |
| 12 | 최소 Side Panel | `extension/src/sidepanel/main.tsx`의 임시 본문 교체 |
| 13 | LLM 없는 결정적 E2E(Linux bridge + Playwright Chromium + 실제 확장) | 끝나면 **브랜치 전체를 한 번 검토**(`superpowers:requesting-code-review`) 후 14로 |
| 14 | 실제 Windows Chrome + WSL OpenCode 시연 | **사용자를 부를 지점**: Step 1 개발용 프로필 'AgentBrowser-dev'에 압축해제 확장 로드, Step 2 페어링 토큰 입력, 실행 중인 `browser-bridge.exe`를 종료해야 할 때 |
| 15 | Windows 네이티브 OpenCode 검증 | **설치 직전에 사용자 확인**. 설치 버전은 v1.18.29 |

그 밖에 무료 모델을 확인할 수 없거나 한도에 걸리면 사용자를 부른다. 이미 정해진 것(다시 묻지 않는다): OpenCode는 v1 경로만,
전역 `~/.config/opencode/opencode.json` 수정 금지, 개발 확장은 'AgentBrowser-dev' 프로필.

## Task 11이 소비하는 계약 (이미 구현된 쪽)

- serve → Extension 명령: `browser.tabs.list`, `browser.tabs.get {tabId?}`, `browser.tabs.create {url, operationId, generation}`,
  `browser.snapshot`, `browser.navigate`, `browser.click`, `browser.fill`, `browser.select`, `browser.press`, `browser.scroll`,
  `browser.wait`, `browser.extract`, `browser.screenshot`, 그리고 `browser.cancel`.
- 작업 명령의 params는 항상 `{operationId, generation, tabId, ...스키마에 선언된 인수}`. 선언되지 않은 인수는 serve가 버린다.
- 결과 규약: 성공 결과의 `verified` 필드는 serve가 따로 떼어 `ToolOutcome.verified`로 낸다. 오류의 `details.executed === true`면 serve가 `executed:"yes"`로 분류한다.
- `browser.tabs.get/create`의 결과는 평평한 `{tabId, url, title, active}` 형태여야 한다(serve가 `result.tabId`를 읽는다).
- `browser.cancel`은 두 형태가 있다: 타임아웃 시 `{requestId}`, 사용자 중단 시 `{operationId, generation}`.
- Extension → serve 요청: `heartbeat`, `status.get`, `operation.abort`, `browser.use`. serve가 보내는 `evt status.changed`의 data는
  `{operation, browsers, timeline}`(`status.get` 결과와 같은 모양).
- content script는 `{kind:"cmd", method, params, generation}` 메시지를 받는다. 스냅샷 method 이름은 `"snapshot"`이고 나머지는
  `click|fill|select|press|scroll|wait|extract`. **`{kind:"cancel", generation}` 처리는 아직 `content/index.ts`에 없다** — Task 11에서
  추가하고 `actions.ts`의 `cancelUpTo`를 호출한다.
- 같은 `requestId`를 다시 받아도 쓰기 명령을 재실행하지 않는 캐시(Review Focus 2)와, 캡처 전후 활성 탭 확인(Review Focus 5)이 Task 11의 핵심 테스트다.

## 계획 대비 변경 (Ruling)

구현은 계획의 동작 규칙과 테스트를 유지하고 아래만 바꿨다. 근거는 원장과 각 커밋 메시지에 있다.

- Task 2: `results.html`은 만들지 않음. `table.html`·`index.html`은 계약 문구대로 작성.
- Task 3: `tokens_equal` 누적 변수를 `usize`로. `config.json`은 Unix에서 0600으로 생성(보안 리뷰 반영, Windows ACL은 미검증).
- Task 4: `ServeHandle`에 `Debug`. repair·heartbeat·미지 경로 테스트 추가. 포트 점검 `probe(port)`는 **토큰을 보내지 않고**
  `AUTH_FAILED.details.serverName`으로 식별한다 — 그 결과 다른 토큰의 인스턴스도 `PortInUse`가 아니라 "already running"으로 보고된다.
  확장 `auth.hello`는 비어 있지 않은 `clientId`를 요구한다.
- Task 5: 같은 `clientId`가 둘 이상이면 **가장 새 연결**로 명령을 보낸다. `operation.abort`는 선택 브라우저에 `browser.cancel`을 알린다.
- Task 6: `operationId` 누락은 스키마 오류보다 먼저 `OPERATION_REQUIRED`. 스키마에 없는 인수는 거부하지 않고 버린다.
  http(s) 이외 URL은 브리지에서 `UNSUPPORTED_PAGE`(보안 리뷰 반영). 계획의 abort 테스트가 쓰던 패널 `clientId`를 `panel-1`로 변경.
- Task 7: `spawn_detached_serve`에 `--port`를 넘김. 시작 실패 후 30초간은 호출마다 10초씩 기다리지 않고 한 번만 접속을 시도.
  serve는 `home/serve.pid`·`home/logs/serve.log`(토큰 미기록)를 쓴다.
- Task 8: 송신자 검사를 `sender.tab`이 아니라 `sender.url`의 확장 origin으로(options 페이지가 탭으로 열리기 때문).
  `@types/node` 추가. hello 승인 전에 온 서버 명령은 `AUTH_REQUIRED`로 거절(보안 리뷰 반영).
  확장 ID `icgmjjcpnaenpfjfoggnaodeaidbnihl`(`docs/architecture.md`).
- Task 9: 라벨 없는 입력의 `value`를 이름으로 쓰지 않음(비밀번호 누출 방지, 보안 리뷰 반영).
- Task 10: Enter 제출은 텍스트형 input에만 적용.

## 알려진 위험 — 사용자 결정 필요

포트 선점 시 서버가 자신을 증명하지 않는다. 같은 PC의 다른 사용자·프로그램이 `127.0.0.1:4317`을 먼저 점유하면 Extension·mcp가
페어링 토큰을 보내고, 그 프로그램이 hello를 승인하면 `browser.*` 명령으로 Chrome을 조작할 수도 있다(`docs/status.md` "알려진 위험").
토큰을 보내지 않는 챌린지-응답(HMAC) 핸드셰이크로 `auth.hello` 계약을 바꾸면 해결되지만 계획의 인증 규약이 달라진다.
**개인 PC 단일 사용자 전제인지 사용자에게 한 번 확인**한 뒤, 그대로 둘지 M1 마무리 전에 바꿀지 정한다. 확인 전에는 바꾸지 않는다.

## 알아 둘 점

- 자동 "보안 리뷰" 알림이 커밋 직후 여러 번 왔다. 사용자 입력이 아니라 자동 알림이며, 지적은 테스트 우선으로 처리해 별도 커밋으로 남겼다
  (config 권한, probe 토큰, router 입력 검증, hello 전 명령, 비밀번호 이름 누출). 포트 선점 항목만 위 결정 대기 상태다.
- `serve_mcp`는 연결당 요청을 하나씩 처리한다(긴 `browser_wait` 동안 같은 연결의 다음 호출이 대기). rmcp가 동시 호출을 내면 재검토.
- jsdom에는 레이아웃·`innerText`·스크롤이 없다. 가시성 판정·클릭 가림·실제 스크롤·키 이벤트는 Task 13·14에서만 검증된다.
- WSL은 NAT 모드라 WSL에서 Windows 127.0.0.1로 접속할 수 없다. Linux E2E는 Linux bridge 빌드 + Playwright Chromium으로 돌린다.
- WSL PATH에 Windows 경로가 없다. Windows 명령은 `/mnt/c/Windows/System32/...` 절대 경로로 호출한다.

## 재개 검토 (2026-10-11)

검토 기준은 `7ca563e`다. 요구사항·M1 계획·커밋 이력·진행 원장과 실제 소스/테스트를 대조했다.
Task 1–10의 구현 파일과 커밋은 존재한다. Task 11의 `background/handlers.ts`는 모든 명령에
`INTERNAL`을 반환하는 임시 본문이고, Task 12의 패널은 이름만 표시한다. `tests/e2e/`,
`tests/agent/`, Windows 개발 설치 스크립트는 아직 없다. **개별 구성요소 구현 완료를 실제 브라우저 제어 완료로 해석하면 안 된다.**

전체 단계는 M0 환경/계약 확인 완료 → M1 진행 중 → M2 자동 실행/진단 → M3 전체 작업 UI → M4 배포다.
M2–M4는 handoff의 범위와 완료 조건만 있으며 별도 상세 실행 계획은 아직 없다.
현재 미완료 실행 계획은 M1 한 개다. 그 계획의 체크박스는 과거 완료 과제까지 미체크 상태이므로
체크 개수로 진척을 판단하지 않는다. 이번 검토는 Task 13 뒤에 예정된 전체 브랜치 검토를 대체하지 않는다.

### 이번 세션에서 다시 확인한 기준선

- node `24.18.0`, pnpm `9.15.9`, rustc `1.98.1`, cargo-xwin `0.23.0` 확인.
- Extension 선별 테스트(actions/extract/bridge-connection) 22/22 통과, TypeScript 검사·Vite 빌드 성공.
- Bridge operation 단위 테스트 5/5, tool_router 통합 테스트 13/13 통과.
  통합 테스트 최초 실행은 샌드박스의 소켓 생성 제한으로 실패했고, 제한 밖 재실행은 통과했다.
- 위쪽 전체 기준선은 **이전 세션의 결과**다. 이번에는 관련 범위만 재실행했다.
- 아래 재현은 임시 코드에서 기존 Rust 라이브러리와 TS 소스를 직접 호출한 결과다. 회귀 테스트를
  저장소에 추가하거나 제품 코드를 수정하지 않았다. Windows exe 실행·실제 Chrome·LLM 호출은 하지 않았다.
- M0의 Windows 실행 증거는 도구체인 확인용 probe이며 M1 제품 exe 검증과 다르다.

### Task 11에 반영할 발견 사항

| 우선 | 항목 | 확인 근거와 영향 | 이어서 할 일 |
|---|---|---|---|
| 높음 | 현재 탭 종료 후 복구 경로가 막힘 | `server/operation.rs`의 `check`는 현재 탭이 닫히면 `TAB_CLOSED`. `switch_tab`과 `release`도 이를 선행 호출한다. 탭 1 attach → 탭 2 추가 → 탭 1 제거 → switch(2)/release 모두 `TAB_CLOSED` 재현. 오류 메시지가 제시하는 복구 방법이 동작하지 않는다 | 유효한 작업 검사와 현재 탭 생존 검사를 분리. 닫힌 현재 탭에서 다른 연결 탭으로 전환/해제하는 실패 테스트를 먼저 추가하고 router의 선행 검사도 수정 |
| 높음 | 취소가 실행 중인 대기에 도달하지 않음 | `content/index.ts`에는 cancel 메시지 분기가 없고, `actions.ts`는 시작 때만 generation 검사. 시작한 wait에 `cancelUpTo`를 호출해도 종료 때 `TIMEOUT` 반환을 재현 | cancel 메시지 수신뿐 아니라 실행 중 wait의 observer/timer 정리와 즉시 `CANCELLED` 응답 연결. requestId 취소와 generation 취소를 각각 검증 |
| 높음 | Bridge 재시작과 취소 세대의 수명이 다름 | `ServerState::new`는 generation을 0부터 다시 시작. 중단 세대 2 후 새 Gate의 첫 작업 세대는 1로 재현. 계획의 SW session 저장소와 기존 content의 취소 숫자가 살아 있으면 새 작업까지 거절될 수 있음. 아직 전체 연결 경로는 미구현 | 서버 실행 구간 또는 operation별 취소 범위를 식별하고 오래된 명령을 허용하지 않으면서 새 작업을 복구. **중단 → Bridge 재시작 → 재연결 → 새 attach/조작** 회귀 시나리오 추가 |
| 높음 | 탭마다 같은 요소 ref가 생성될 수 있음 | ref는 `s{snapshot}f{frame}e{index}`, 계획은 탭별 snapshot 카운터. 독립 레지스트리 둘에서 첫 요소가 모두 `s1f0e1`이며 A의 문자열을 B에서 해석하면 B 요소가 반환됨을 재현. 탭 전환 후 옛 ref를 보내면 다른 요소로 해석될 설계 위험. SW를 통한 오조작은 아직 미검증 | snapshot/ref를 탭·문서와 결합하거나 충돌 없는 ID와 소유 정보로 검증. A/B 첫 snapshot 후 A ref를 B에서 사용하면 `STALE_ELEMENT`인지 테스트. 문서 이동/SW 재시작도 포함 |
| 높음 | 계획 예제의 중복 검사와 저장이 원자적이지 않음 | `getResult` → `markInFlight` 사이 await, 저장소 전체를 load/set하는 구조. 현재 BridgeConnection은 들어온 명령을 비동기로 병행 처리하므로 같은 ID 두 개가 함께 미실행으로 판단하거나 서로의 저장을 덮을 수 있음. 이는 **미구현 계획의 정적 검토 결과** | 동시 동일 ID 호출이 한 번만 실행되도록 잠금/직렬화. 취소 통지는 긴 작업 뒤에 대기하지 않게 분리. 다른 ID 병행 저장과 snapshot 카운터 증가도 검증 |
| 중간 | 단절 시 패널의 요청 Promise가 끝나지 않음 | `BridgeConnection.onClose`는 `pending.clear()`만 하며 `request`에 timeout/reject 경로가 없음. 인증 후 `status.get` 요청 중 소켓을 닫아도 Promise가 미종결인 것을 재현 | close/stop/timeout에서 대기 요청을 구조화된 오류로 종료. Task 12의 로딩/중단 상태가 고정되지 않도록 테스트 |

### 계획 예제를 적용할 때 맞춰야 할 계약

- `browser.tabs.create`는 Task 11 Interfaces에 적힌 `{tab}` 대신 **평평한 `{tabId, ...}`**를 반환해야 한다.
  실제 router는 `result.tabId`를 읽는다(위 인수인계 계약과 동일).
- 계획의 `conn.send(makeEvt(...))`에 해당하는 공개 API는 현재 `BridgeConnection`에 없다.
  `tab.closed` 송신 경로와 serve의 이벤트 처리(현재 이벤트 무시)를 함께 구현하고 테스트한다.
- content 실행은 `runAction(method, msg.params)`다. generation을 메시지 최상위에만 넣으면 검사에 전달되지 않는다.
  snapshot의 번호/frame/maxChars/offset 기본값도 SW에서 명시적으로 공급해야 한다.
- 새 탭의 계획상 로드 대기는 30초지만 Bridge의 tabs.create 응답 제한은 15초다.
  navigate도 양쪽이 30초라 완료 직전 경합이 생길 수 있다. 실행/응답 제한의 여유와 취소 전달을 일관되게 정한다.
- `Operation.client_id`는 저장되지만 명령은 현재 선택 브라우저로 전송된다. 작업 중 `browser.use`로 선택을 바꾸면
  다른 프로필의 같은 tabId로 향할 수 있는 정적 검토상 위험이 있다. 기존 작업을 종료해야 전환할 수 있게 하거나
  작업 소유 브라우저로 라우팅하는 규칙을 테스트한다.

### E2E·Windows 검증에서 빠뜨리면 안 되는 점

- open Shadow DOM 요소는 snapshot에 나오지만 실제 클릭 가림 검사는 jsdom에서 검증되지 않았다.
  `actions.ts`의 `document.elementFromPoint`와 shadow host의 `contains` 조건은 실제 Chromium에서 검증해야 한다.
- S13의 fixture HTTP 응답 지연은 2초지만 content click은 500ms 관찰 뒤 응답한다.
  2초 지연 자체가 Bridge 응답 전 단절을 보장하지 않는다. 제출 기록 확인과 Bridge 응답 차단 시점을
  명시적으로 동기화해 중복 제출 방지 검증이 우연한 타이밍에 의존하지 않게 한다.
- Windows 계획은 breakaway/fallback 선택을 serve.log에서 확인하도록 되어 있으나 현재 spawn 함수에는
  그 선택의 로그가 없다. Task 14 전에 검증 가능한 기록 방식을 추가하거나 직접 관찰 근거를 마련한다.
- localhost 포트 선점 인증 위험은 기존 미결 사항이다. **단일 사용자 PC여도 다른 로컬 프로그램에 대한
  서버 인증 문제는 남는다.** 위 구현/계획 검토와 별개로 M1 마무리 전 위협 전제와 HMAC 적용 여부를 결정한다.
  이번 준비 작업에서는 인증 계약을 변경하지 않았다.

### 재개 순서

1. Task 11의 정상 핸들러 테스트와 위 회귀 테스트를 실패 상태로 작성한다. 계획/기존 구현의 필요한 수정도
   같은 과제 범위에서 근거를 남기며 진행한다. 과거에 통과한 단위 테스트만으로 해당 위험이 해결됐다고 보지 않는다.
2. Task 11 → Task 12 최소 패널 → Task 13의 17개 결정적 시나리오와 추가 회귀 시나리오를 완성한다.
3. 전체 브랜치 검토와 수정 후 Task 14로 넘어간다. 확장 로드/페어링 등 수동 단계에 필요한 빌드와 안내를 먼저 준비한다.
4. 실제 Windows Chrome + WSL OpenCode 증거를 남긴 뒤 Task 15의 Windows 네이티브 설치/검증을 진행한다.
   설치 직전 확인 등 기존 합의된 사용자 참여 지점은 위 표를 따른다.

이번 검토에서 제품 구현, 커밋, push, PR, Release, 전역 OpenCode 설정 변경은 수행하지 않았다.
