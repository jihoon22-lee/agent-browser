# M1 구현 인수인계 (2026-10-11 세션 종료 시점)

새 세션은 이 문서 → `docs/status.md` → 계획서 `docs/plans/2026-10-11-m1-browser-control.md`의 **Task 11**부터 읽고 이어간다.
계획서의 체크박스는 갱신하지 않았다. 진행의 근거는 이 문서와 `git log`다.

## 한눈에 보기

| 항목 | 값 |
|---|---|
| 브랜치 | `feat/m1-browser-control` (main `f156c33`에서 분기), 마지막 커밋 `d0cbc1e` |
| 완료 | Task 1–10 |
| 남음 | Task 11 → 12 → 13 → (전체 브랜치 코드 리뷰) → 14 → 15 |
| push·PR | 하지 않았다. 사용자가 요청할 때만 한다 |
| 작업 트리 | 깨끗함(미커밋 변경 없음) |

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
4. 커밋은 영어 Conventional Commits, 끝에 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
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
