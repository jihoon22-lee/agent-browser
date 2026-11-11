# 2026-11-11 전체 코드 리뷰 수정 계획

상태: 진행 중. 2026-11-11 전체 코드 리뷰(코드 추적 기준, 실제 Windows·Chrome 재현 없음)에서 나온 항목을 모두 처리하고 v0.4.1로 릴리스한다.
요구사항은 `docs/handoff.md`, 결과는 `docs/status.md`를 따른다. 이 문서는 완료 후 삭제한다.

## 공통 규칙

- 브랜치 `fix/review-2026-11-11`. 작업 묶음(WS)마다 별도 worktree에서 작업하고 영어 Conventional Commits로 항목 단위 커밋한다.
- 항목마다 실패하는 테스트를 먼저 쓰고, 그 테스트와 직접 영향받는 테스트만 실행한다. 전체 검증은 병합 후 한 번 한다.
- **"추정" 항목**: 먼저 전제를 확인한다(Linux Chromium Playwright, 단위 테스트, 가능하면 Windows interop).
  전제가 맞으면 수정한다. 확인할 수 없더라도 전제가 틀렸을 때 해가 없는 수정이면 적용한다.
  확인할 수 없고 동작을 바꾸는 수정이면 적용하지 않고 사유를 보고한다.
- AGENTS.md의 범위 규칙을 지킨다: 설치 폴더 소유자·ACL 검사 추가 금지, 전역 OpenCode 설정 수정 금지, 모델 ID 하드코딩 금지, 의존성 추가 금지.
- 사용자 안내 문구는 한국어, 기존 문체를 따른다. 스크립트 실행 안내는 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\<이름>.ps1` 형식.
- 각 WS는 자기 소유 파일만 고친다. 다른 WS 소유 파일이 필요하면 고치지 말고 보고한다.
- `docs/status.md`, `CHANGELOG.md`, 버전 파일은 병합 담당만 고친다.

## WS-A 브라우저 조작 (확장 content·background)

소유: `extension/src/content/**`, `extension/src/background/**`(단 `bridge-connection.ts` 제외), 대응 `extension/test/**`, `tests/e2e/**`.

- [ ] A1 (높음) 길이 제한이 서로게이트 쌍을 자름. `snapshot.ts:10`(`sliceText`), `:135`(`clip`), `dom.ts:76`, `actions.ts:92`, `keyboard.ts:201-202`, `extract.ts:75`, `background/handlers.ts:310`, `tab-routing.ts:27`, `advanced-browser.ts`의 `message.slice(0,2000)` 등 모든 자르기.
  공용 함수 하나(끝이 상위 서로게이트면 한 칸 줄이고, 시작이 하위 서로게이트면 한 칸 당김)로 통일한다. `sliceText`의 `nextOffset`은 실제 잘린 위치와 일치해야 하고 페이지를 이어 붙이면 원문과 같아야 한다.
  테스트: 79자+이모지 이름, 이모지가 `maxChars` 경계에 걸친 페이지 텍스트 → 결과 JSON에 짝 없는 서로게이트가 없다(`/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/` 불일치).
- [ ] A2 드래그 시작점: `actions.ts:135-136`. 대상 `assertInteractable`(스크롤) 뒤에 시작 좌표를 다시 구한다. 둘이 동시에 화면에 들어올 수 없으면 기존 오류 경로를 따른다. 레이아웃이 필요하므로 Playwright E2E로 검증.
- [ ] A3 고급 모드 다이얼로그: `advanced-browser.ts:27,37`, `handlers.ts:214`, `trusted-input.ts:99-103`. 디버거가 분리되면 닫힘 이벤트가 오지 않으므로 `pending`을 영구 차단 상태로 두지 않는다. 분리 뒤 `browser.dialog`와 읽기(snapshot)가 복구 경로가 되게 하고, `trusted-input`의 `onDetach`에서 `openDialogs`도 정리한다. 기존 "불확실한 입력은 자동 재시도하지 않는다" 계약은 유지한다.
- [ ] A4 `browser.tabs.create`: `handlers.ts:193-197`. 30초 로드 타임아웃이면 탭 ID를 잃지 않게 현재 탭 설명에 로드 미완료 표시를 붙여 반환한다(Bridge가 평소대로 작업에 편입). 중단(Stop)은 기존 동작 유지.
- [ ] A5 표 추출: `extract.ts:12` `cellText`가 `textContent`를 써서 `<br>`·블록 경계가 붙고 숨은 텍스트가 섞인다. `snapshot.ts`의 `renderedText` 계열 로직을 재사용한다. 테스트: `<td>Seoul<br>Korea</td>` → `Seoul Korea`, `<div>12</div><div>34</div>` → `12 34`, `display:none`·`<script>` 제외.
- [ ] A6 (추정) 주입 불가 하위 프레임이 있으면 탭 닫기 불가: `handlers.ts:236-239`. 전제를 Playwright로 확인. 오류 페이지 프레임처럼 사용자 편집이 있을 수 없는 프레임만 건너뛰고, `docs/protocol.md`의 "확인 불가 → 중단" 계약은 일반 프레임에 유지한다.
- [ ] A7 (추정) 접힌 `<details>` 내부가 조작 가능으로 나옴: `dom.ts:35-42`. `Element.checkVisibility()`(있을 때)로 보강.
- [ ] A8 포커스가 iframe 안일 때 ref 없는 `press`가 무동작 성공: `actions.ts:372-385`. 기본 경로에도 trusted 경로와 같은 `ELEMENT_NOT_INTERACTABLE` 검사를 둔다.
- [ ] A9 (추정) 접속 불가 호스트 `goto`가 성공으로 보고: `handlers.ts:325`. `webNavigation.onErrorOccurred`(권한 이미 있음) 또는 오류 페이지 판별로 실패를 알리고, 이후 snapshot 오류는 재시도를 부르지 않게 한다.
- [ ] A10 변하는 텍스트가 있는 keyed 레코드의 ref가 계속 stale: `refs.ts:59-60`. `dispatch` 범위에만 있는 keyed-row 허용을 첫 resolve에도 적용한다(키 없는 레코드의 기존 차단은 유지).
- [ ] A11 (추정) 뷰포트 밖 요소 클릭: `actions.ts:68-75`. `elementFromPoint`가 null이고 좌표가 뷰포트 밖이면 `ELEMENT_NOT_INTERACTABLE`.
- [ ] A12 합성 클릭이 포커스를 옮기지 않음: `actions.ts:265-279`. `mousedown`이 취소되지 않았으면 가장 가까운 포커스 가능 조상에 포커스를 준다(실제 브라우저 순서: pointerdown → mousedown → focus).
- [ ] A13 라벨로 고른 옵션이 값 중복 시 다른 옵션 선택: `actions.ts:339,350`. 값 대입 대신 해당 `option`을 직접 선택하고, `<select multiple>`의 다른 선택을 지우지 않는다.
- [ ] A14 iframe 안 `target=_top` 링크 클릭이 `EXECUTION_UNKNOWN`: `handlers.ts:92-93,68-69`. `waitFor` 없이도 상위 문서 ID를 잡아 이동으로 판정한다.
- [ ] A15 컨트롤의 라벨 텍스트가 바뀌면 입력이 `EXECUTION_UNKNOWN`: `actions.ts:124-125`, `refs.ts:42`. 입력 후 확인에서는 컨트롤 자체 신원(요소·레코드 키)으로 판정한다.
- [ ] A16 (추정) 변화 관찰 창이 trusted 왕복 전에 시작: `actions.ts:226-231,374-379`. 관찰 종료 시점을 입력 전달 완료 기준으로 잡는다.
- [ ] A17 (추정) 작업 표시를 상태 이벤트마다 지웠다 붙임: `background/index.ts:85`, `work-marker.ts`. 이미 같은 표시가 있으면 DOM을 건드리지 않는다.
- [ ] A18 개선: `snapshot.ts:26-35` 조상 텍스트 정규화 캐시, `frames.ts:25,61` `injected` 정리, `handlers.ts:276` 페이징 offset을 프레임별로 적용, `snapshot.ts:155` PDF 등 읽을 수 없는 문서 표시, `actions.ts:329-330` 여러 줄 rich-editor 입력의 `matches` 비교.

## WS-B 사이드 패널·옵션·연결 (확장 UI)

소유: `extension/src/sidepanel/**`, `extension/src/options/**`, `extension/src/agents/**`, `extension/src/protocol/**`, `extension/src/background/bridge-connection.ts`, 대응 `extension/test/**`.

- [ ] B1 연결 중 입력한 초안 유실: `Workbench.tsx:105`. 초안 키의 디렉터리가 확정되기 전(`wb.directory === ""`)에 입력한 글이 연결 완료 후 입력창에 남아야 한다. 확정 전 키로 세션 저장소에 쓰지 않는다.
- [ ] B2 전송 잠금 고착: `Workbench.tsx:306`. `send()`의 `finally`가 범위 변경과 무관하게 자기 시도가 건 잠금을 푼다(다른 시도가 건 잠금은 건드리지 않는다). 테스트: 커맨드 전송 중 같은 세션 재선택 → 전송 가능.
- [ ] B3 서버 중지·재시작 후 패널 미복구: `use-workbench.ts:240,261-279`, `options/App.tsx:60-61`, `Workbench.tsx:453`. SSE가 401/403/404로 끝나거나 서버 연결이 끊긴 상태가 이어지면 `runtime.ensure`를 다시 실행해 새 접속 정보로 재연결하고 현재 세션 선택을 유지한다(무한 재시도 금지: 실패하면 오류와 함께 멈춤). 옵션의 "서버 중지"·"시작·연결 확인"은 `profiles-changed`와 같은 방식으로 패널에 알린다. 대화가 있어도 "다시 시도"를 누를 수 있어야 한다.
- [ ] B4 `/new`가 이전 세션 초안으로 저장: `Workbench.tsx:217-224`. UI 커맨드는 실행 전에 초안을 비운다(실패하면 복원).
- [ ] B5 프로필 입력 trim: `options/profile-form.ts:18`. `executable`·`distribution`·`user`·`username`은 trim한 값을 보낸다(`password`는 그대로).
- [ ] B6 잘못된 URL·JSON의 영어 예외 노출: `profile-form.ts:3,17,20`. 한국어 안내로 바꾼다(주소 형식 예시, JSON 객체 예시 포함).
- [ ] B7 개선: 실행 중 2초 폴링이 전체 메시지를 다시 받음(`use-workbench.ts:136,168`). 상태만 가볍게 확인하고 메시지는 상태 변화·새 메시지가 있을 때만 받는다. 스트림이 끊긴 동안의 정합성(기존 테스트)은 유지한다.
- [ ] B8 개선: 리듀서의 `seen` 5000개 배열 제거(`workbench-state.ts:5,23-24`). SSE 클라이언트 중복 제거로 충분한지 테스트로 고정한다.
- [ ] B9 개선: `bridgeRequest`가 오류 `code`·`retry`를 보존(`workbench-state.ts:95`)하고 `error-text.ts`·`bridgeUnavailable`은 코드가 있으면 코드로 분류한다. 메시지 정규식은 코드 없는 오류(OpenCode HTTP·네트워크)에만 남긴다.
- [ ] B10 개선: `availableModels` 중복 제거(`agents/opencode-v1/usage.ts:59` 삭제, 테스트는 제품 함수로).
- [ ] B11 개선: `authHello`의 `clientVersion: "0.1.0"` 하드코딩 제거(`protocol/auth.ts:18`) — 매니페스트 버전 전달. 인증 벡터(`protocol/auth-vectors.json`)와의 호환을 확인한다.
- [ ] B12 개선: `BridgeConnection.schedule()`이 모든 타이머를 지움(`bridge-connection.ts:82`). 재연결 타이머만 교체하도록 분리한다.

## WS-C Bridge 서버·MCP 출력

소유: `bridge/src/server/**`, `bridge/src/rpc/**`, `bridge/src/mcp/mod.rs`, `bridge/src/mcp/tools.rs`, `bridge/src/auth.rs`, 새 `bridge/tests/*.rs`, `docs/protocol.md`, `protocol/**`.

- [ ] C1 (높음, A1의 방어) 파싱 못 한 `res`가 대기 명령을 타임아웃까지 붙잡음: `rpc/mod.rs:92`, `conn.rs:150,396-407`. 짝 없는 서로게이트 이스케이프(`\ud83d` 등)는 U+FFFD로 바꿔 받아들인다. 그래도 파싱할 수 없지만 `id`를 얻을 수 있으면 해당 대기 명령을 즉시 실패시킨다.
- [ ] C2 `browser_tabs list` 40KB 초과: `mcp/mod.rs:31-39`, `router.rs:575`. 목록 항목의 `url`·`title`을 `openTabs`와 같은 방식으로 제한하고, 그래도 넘치면 앞에서부터 들어가는 만큼만 반환하며 생략 개수와 `windowId`로 좁히라는 안내를 붙인다. "too large" 안내문은 그 도구에 실제로 있는 인자만 말한다.
- [ ] C3 없는 탭 `switch`가 ID를 영구 "닫힘" 처리: `router.rs:675-678`, `operation.rs:305`. 작업이 보유하지 않은 탭의 `TAB_NOT_FOUND`는 `closed_tabs`에 넣지 않는다.
- [ ] C4 `switch`가 "새 스냅샷 필요"를 해제: `operation.rs:282-288`. `select_tab`은 `needs_observation`·`handed_back`을 건드리지 않고, 실제 관찰(스냅샷 성공) 때만 해제한다. `docs/protocol.md`와 일치.
- [ ] C5 취소 교차·응답 전송 실패 시 `browser.cancel` 누락: `conn.rs:441-444,488`. 다른 중단 경로와 같이 소유 확장에 통지한다.
- [ ] C6 취소된 단독 `new`의 예약 해제에 상태 브로드캐스트 누락: `router.rs:614-615`.
- [ ] C7 `browser.use` 저장 실패를 성공으로 응답: `conn.rs:112-115,622-624`. 선택은 유지하되 응답에 저장 실패를 알린다(`persisted:false`와 사유).
- [ ] C8 인자 검증이 암묵적 attach 뒤에 실행: `router.rs:313-328`. 검증을 바인딩 앞으로 옮긴다.
- [ ] C9 accept 루프: `server/mod.rs:80-81`, `conn.rs:188`. accept 오류는 로그 후 짧게 쉬고, WebSocket 업그레이드에 타임아웃(hello와 같은 5초)을 둔다.
- [ ] C10 개선: 스키마 `LazyLock`(`router.rs:227,315`), `delivered` 계산 통일(`router.rs:337,453,567,674`), 죽은 코드 제거(`conn.rs:375-378`, `not_available`, 테스트 전용 `pub` 메서드는 `#[cfg(test)]`/`pub(crate)`로), `adopt_children`이 편입한 탭이 없을 때의 결과(`router.rs:429-432`).
- [ ] C11 문서: `docs/protocol.md:31,70-72`와 `auth.rs:1`을 실제 동작(MCP 역할의 `status.get`·`pairing.open`, 페어링 코드로 토큰을 돌려주는 `pair.request`)에 맞춘다.

## WS-D Bridge 런타임·설정

소유: `bridge/src/runtime/**`, `bridge/src/config/**`, `bridge/src/mcp/client.rs`, `bridge/src/main.rs`, `bridge/tests/runtime_management.rs`, `bridge/tests/windows-runtime.mjs`, 새 런타임 테스트.

- [ ] D1 Windows 중지가 PID 2개만 종료: `runtime/mod.rs:291-310`, `process.rs`. 런처가 살아 있고 신원이 확인될 때 그 자손 프로세스 전체(기존 `descendant()` 판정 재사용)를 종료한 뒤 런처를 종료한다. 엉뚱한 프로세스를 죽이지 않도록 생성 시각·신원 재확인을 유지한다. `windows-runtime.mjs`에 `.cmd` 런처 + 리스너 미기록 중지 시나리오 추가.
- [ ] D2 MCP 프록시가 되살린 serve가 런타임 환경·cwd 상속: `mcp/client.rs:76-82,120-123`, `runtime/mod.rs:206-`. serve를 시작할 때 cwd를 Bridge 홈으로 두고, 런타임이 주입한 변수(`OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME`, `OPENCODE_CONFIG_CONTENT`, `AGENT_BROWSER_RUNTIME_ID`, 프로필 `env` 키)를 제거한다. 프로필 `env` 키 목록은 런타임이 MCP 환경에 넘기는 변수 하나로 전달한다.
- [ ] D3 (추정) WSL mirrored 네트워킹 준비 판정: `runtime/mod.rs:605-613`. 전제를 확인할 수 없으면 판정 로직은 바꾸지 않고, `c:\program files\wsl\` 하드코딩만 `%ProgramFiles%` 기준으로 고친다. 결과를 보고한다.
- [ ] D4 바로 종료한 Windows 실행 파일도 60초 대기: `runtime/mod.rs:197-199`. 런처가 종료됐고 소유 리스너도 없으면 즉시 실패로 끝낸다.
- [ ] D5 재부팅 뒤 죽은 런타임 기록이 프로필 편집을 막음: `runtime/mod.rs:95,400`. 상태 조회가 "소유 프로세스 없음"을 확정하면 기록을 지운다(WSL은 Stopped/NotStarted로 확정된 경우만, Unknown은 유지).
- [ ] D6 (추정) WSL 프로브 타임아웃 5초: `runtime/mod.rs:707`, `interop.rs:40`. 콜드 부팅을 감당하도록 늘린다(프로브 15초, 프리플라이트 20초).
- [ ] D7 (추정) 리스너를 포트만으로 첫 행 사용: `process.rs:189-195`. 같은 포트의 모든 행을 보고 런처의 자손인 행을 고른다. 테이블 크기 변동 시 한 번 재시도.
- [ ] D8 읽기 경로가 `runtime.json`을 다시 씀: `runtime/mod.rs:236-241,459-464`. 값이 바뀔 때만 쓰고, doctor의 `inspect`는 프로필 잠금 안에서 한다.
- [ ] D9 상대 경로 홈: `config/mod.rs:20-23`. 홈을 절대 경로로 정규화해 MCP 프록시에 넘긴다.
- [ ] D10 개선: WSL 마커 파일(`.keeper`, `.keeper.ready`, `.owner`) 정리(`interop.rs:54,63`), 죽은 코드 제거(`mod.rs:246-251`, `WSL_CONTROL`의 `dead`·`listener` 모드), OS 오류를 버리지 말고 `tracing`으로 기록(`mod.rs:176`, `interop.rs:70`, `storage.rs`), `installation_check` stdout 상한(`mod.rs:562`), `Store::update`의 블로킹 sleep(`storage.rs:49`), `Config.version` 확인·빈 토큰 거부(`config/mod.rs:35-41`), `mcp/client.rs:17` 주석.
- [ ] D11 (추정, 개선) WSL 중지의 SIGKILL 단계(`mod.rs:276-289,699`)와 등록 해제된 배포판의 복구 경로. 전제를 확인할 수 없으면 적용하지 않고 보고한다.

## WS-E 설치·스크립트·CI

소유: `scripts/**`, `installer/**`, `tests/install/**`, `.github/workflows/ci.yml`, `docs/testing.md`.

- [ ] E1 (높음) 낡은 Bridge 마커의 PID 재사용: `scripts/installer-common.ps1:375-388`, `installer/InstallerEngine.cs:342`(`BridgeControl.Verify`). 기록된 PID의 프로세스가 다른 신원이면 종료하지 않고 "실행 중 아님"으로 처리하며 낡은 마커를 정리한다. `ExecutablePath`가 null인 프로세스도 같은 경로. 시작·중지·업데이트·제거가 이 상태에서 정상 진행해야 한다. PS·C# 테스트 추가.
- [ ] E2 업데이트가 이전 파일을 남김: `scripts/setup.ps1:37`, `InstallerEngine.cs:177`. 먼저 `docs/installation.md`(이전 `app/<버전>` exe는 관리 OpenCode의 MCP 경로 유지를 위해 의도적으로 남김)를 읽는다. 새 패키지에 없는 `app/` 밖 소유 파일(옛 확장 해시 자산 등)은 해시가 기록과 같을 때만 트랜잭션으로 삭제하고 소유 목록에서 뺀다(사용자가 고친 파일은 보존). 이전 `app/` exe는 현재·직전 버전과 실행 중이거나 `runtime.json`이 참조할 수 있는 것을 남기고, 안전하게 판정할 수 없으면 그대로 둔다. 문서도 맞춘다.
- [ ] E3 안내 문구: `show-pairing.ps1:6`, `start-bridge.ps1:7`의 "Run setup.ps1"을 AGENTS.md 형식으로.
- [ ] E4 설치 마법사가 1.5초마다 UI 스레드에서 전체 해시: `SetupForm.cs:121,172,304`. 감지 타이머는 해시 검증 없이 필요한 값만 읽고, 전체 검증은 단계 전환 때 백그라운드에서 한 번 한다.
- [ ] E5 WSL 후보 선택 시 작업 폴더가 Windows 경로로 남음: `SetupForm.cs:279,285-286`. 사용자가 직접 고치지 않은 값이면 후보의 홈으로 바꾸고, `chosen.User`는 배포판이 같을 때만 재사용.
- [ ] E6 (추정) 고급 설정 대화상자 DPI: `SetupForm.cs:314-318`. 크기를 실제 글꼴 높이(`Font.Height`/TextRenderer 측정) 기준으로 계산한다. `SetupDisplayTests`에 버튼 높이 ≥ 텍스트 높이 검사 추가.
- [ ] E7 (추정) `wsl.exe` 출력 디코딩: `NativeIO.cs:88,112,118`, `Discovery.cs:85-87`. 엄격 UTF-8 실패 시 예외 대신 UTF-16LE/대체 문자로 읽고, `--list`는 `WSL_UTF8=1`도 처리(BOM/NUL 패턴으로 판별).
- [ ] E8 (추정) 설정 파일 교체 시 ACL 복사 무효: `NativeIO.cs:206`. Windows에서 확인할 수 있으면 `File.Replace` 또는 보안 설명자 명시 복사로 고치고 테스트 추가, 확인 불가면 보고.
- [ ] E9 마법사 반복 실행 시 `managed-<guid>` 프로필 누적: `SetupForm.cs:288`. 같은 실행 방식·실행 파일·디렉터리의 기존 프로필이 있으면 재사용.
- [ ] E10 `tests/install/wsl-probe.test.mjs:21-22` 정규식 이스케이프.
- [ ] E11 CI: Windows `cargo test`에 `pairing_window`, `request_binding`, `snapshot_paging` 추가(Windows에서 돌 수 없는 사유가 있으면 주석으로 남김). 툴체인 버전은 `rust-toolchain.toml` 한 곳에서 읽는다.
- [ ] E12 실행되지 않는 테스트 정리: `tests/install/recovery-package.tests.ps1`, `wsl-settings.tests.ps1`, `NativeCoreTests.cs`, `GuiSmokeTests.cs`, `wsl-auth-check.mjs`. 호스팅 러너에서 돌 수 있으면 CI에 연결, 실제 WSL·화면이 필요하면 `docs/testing.md`에 수동 절차로 기록, 더 이상 유효하지 않으면 삭제.
- [ ] E13 (개선) `Discovery.cs:36-40,75` 재분석 지점 때문에 OpenCode shim(nvm-windows, winget Links)을 못 찾음. 실행 파일 탐색(읽기 전용)에 한해 허용할 수 있는지 판단하고, 설치·삭제 경로의 보호는 바꾸지 않는다.

## 병합·검증·릴리스 (병합 담당)

- [ ] WS 브랜치 병합, 충돌 해소, 전체 diff 검토.
- [ ] 전체 검증: `tsc`, 확장 단위 테스트, `cargo test`, clippy, Playwright E2E, 합성 Node 회귀. Windows: `cargo xwin build` 후 실제 Windows 프로세스 검증(`docs/testing.md`), 설치 스크립트·GUI 회귀.
- [ ] 버전 0.4.1(`Cargo.toml`, `Cargo.lock`, `extension/public/manifest.json`, `README-install.md`), `CHANGELOG.md`, 사용/문제 해결 문서, `docs/status.md`(실행한 것과 미검증 구분, 적용하지 않은 추정 항목과 사유).
- [ ] push → PR → CI(Linux·Windows) → 병합 → 태그 `v0.4.1` → Release 게시 → 게시본 검증.
- [ ] 정리: 이 계획 문서 삭제, worktree·브랜치 삭제, 임시 파일 삭제.
