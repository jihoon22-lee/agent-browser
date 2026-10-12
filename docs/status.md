## 후속 통합 작업 — 활성 탭·iframe·WSL 통합

GUI PR #5와 분리된 Windows 작업 복사본에서 진행한다. 운영 설치와 사용자 Chrome 프로필은 변경하지 않았다. iframe 제품 변경은 현재 권한(tabs/scripting/webNavigation 등) 내에서 수행하며 debugger 권한을 추가하지 않았다.

- 활성 탭 독립 리뷰: 준비 중 Stop 이후 제출, HTTP admission 거절 후 예약 누수, OpenCode 중단 오류가 예약 종료를 가리는 문제를 실패 회귀로 재현하고 수정했다(`9ced9eb`). 늦은 동일 세션 취소는 정확한 requestId로 구분하고, 중단 API 실패 시 재시도할 신원을 보존한다.
- 완료 판정 추가 리뷰: 이전의 terminal 단계 뒤에 미완료 단계가 생겼을 때 자동 해제하지 않는다. 최신 matching assistant의 time.completed와 서버 idle을 함께 확인하고 명시적인 tool-calls/unknown finish는 제외한다. v1의 선택 필드 finish가 없어도 정상 완료를 인정한다.
- iframe: 합성 클릭의 로컬 viewport 좌표·버튼 상태, 명시적 이벤트/키보드 초점 후보, snapshot 문서에 결합된 frameRef 대기를 구현했다. 본문 DOM 교체는 허용하고 문서 이동·닫힌 프레임은 오래된 참조를 거부한다.
- Extension 전체 32 suites / 317 tests, 타입 검사·빌드 통과. Rust 전체 143 tests 통과(1 ignored), Windows MSVC debug 빌드 성공. 실제 Windows Chrome 154.0.8037.99에서 같은 출처·다른 출처·중첩 iframe과 OOPIF 2개 전체 경로 통과. 좌표 조건·체크박스·새 탭·프레임 범위·stale 참조를 확인했다.
- PR #6 첫 코드 리뷰의 예약 복구·완료 후 Stop·선택적 finish·삭제된 세션 404 결함을 실패 회귀로 재현하고 수정했다. 예약 신원은 Chrome 재시작에도 남는 local storage에 보존한다. 관련 최종 회귀 91개와 실제 패널 12개 검사, 실제 WSL OpenCode→MCP→Windows Chrome iframe 경로를 통과했다. 자체 WSL 런타임의 stopped 상태와 프로세스 정리를 확인했다.
- 합성 입력은 isTrusted=false이며 trusted 입력을 요구하는 fixture는 열리지 않는다. 사내 서비스와 실제 LLM 호출은 이번 검증에 포함하지 않는다.
- WSL 원본 748f8d5, dad0216을 cd872f2, f2b0403으로 순서대로 통합했다. 문서 충돌은 양쪽 시험 구간을 유지했다. GUI main 통합과 게시판 안정성 최종 인계를 기다리며, 같은 PR에서 통합·최종 배포 검증을 진행한다.

## 활성 탭 기본 선택 — 초기 독립 로컬 검증 기록

`feat/request-active-tab`, 기준 `fb2bcdbb4672a09395c7d7cc2ee75e6796e897c1`. 운영 설치에 적용하지 않았으며 push/PR/릴리스하지 않았다.

- 패널 요청마다 제출 시점의 포커스된 Chrome 창(normal/popup)의 활성 HTTP(S) 탭을 캡처한다. 모호한 포커스·이동 중·제한 페이지에서는 기본 대상을 만들지 않는다.
- 요청 ID로 Bridge에 예약하고, attach에서 해당 ID를 요구한다. 명시적 tabId가 기본 대상보다 우선한다. 실행 중 포커스 이동은 operation을 변경하지 않는다.
- 다른 요청의 예약, 오래된 operation, 닫힌 대상에서 다른 탭으로 대체하지 않는다. 완료된 같은 messageID의 응답과 서버 idle 확인 후 예약을 해제한다. 패널/worker 재시작 시 durable local storage로 식별자를 복원하며 다음 제출에서도 완료를 재검증한다.
- 일반 프롬프트는 OpenCode v1 system 필드로 요청 문맥을 전달한다. 커맨드는 v1 계약의 file part로 전달한다. 기존 CLI의 요청 ID 없는 attach는 패널 예약이 없을 때 기존 동작을 유지한다.
- 수정 전 새 Rust 게이트 API 및 TypeScript 모듈 부재로 회귀 검사가 실패하는 것을 확인했다. Rust operation 15개 및 도구 계약 2개 통과. 관련 Extension 회귀·타입 검사·빌드와 Windows 통합 결과는 아래 실행 명령으로 재현한다.
- Windows Chrome 154.0.8037.99 + 새 MSVC debug Bridge + 빌드 확장 + 합성 OpenCode로 9개 통합 검사 통과: 탭 전환 중 고정, 동시 예약 거부, 명시 대상 우선, 이전 operation 무효화, 새 탭 편입/종료, 닫힌 기본 대상, 모호한 기본 대상, 실제 패널의 두 번째 창/팝업 캡처, 완료 해제. 실제 모델 호출 0회. 결과는 ignored `tests/agent/results/request-target.json`.
- iframe 조사는 별도 조사 폴더에서 v0.1.4 전체 경로로 수행했다. iframe 제품 수정은 이 브랜치에 포함하지 않는다.

# 진행 상태

## 현재 단계

**v0.1.4 Windows PowerShell 5.1 설치 진입점 로컬 검증 완료. PR CI·코드/보안 리뷰 후 릴리스한다.**
기준은 main `ef444ce`이며 `feat/ps51-installer`의 별도 worktree에서 작업한다. 승인 범위는 정식 수정·PR·CI/코드/보안 리뷰·병합·v0.1.4 태그/Release까지다. 운영 설치본은 v0.1.3을 유지하며 이번 작업에서 업데이트하지 않는다.
다음 개선 후보(검토 backlog): [M5 계획](./plans/2026-10-11-m5-usability-polish.md)의 "다음 개선 후보".

**사용자 확인(2026-10-11)**: 사용자가 개인 PC의 WSL OpenCode로 실제 대화와 브라우저 제어가 동작함을 확인했다.
이후 실제 사용 검증(실제 모델 반복 시연, 사내·다른 PC 환경, 로그인 후 자동 실행 등)은 별도의 남은 항목으로 두지 않는다.
실제 사용 중 발견한 문제는 이슈로 받아 처리한다. 이 결정은 이전 Zen 무료 모델 파일럿(HTTP 403, 도구 0건)을 통과로 바꾸지 않는다.

이전 단계의 계획·재개 기록은 git 이력에 있다(M1 계획, M2–M4 계획, 배포 준비 계획, `m1-resume.md`).

## v0.1.4 설치 진입점 회귀

- Windows PowerShell 5.1.26100.9444에서 원본 v0.1.3 ZIP의 README `-File` 설치 오류를 재현했다. GitHub asset digest와 ZIP/SHA256SUMS가 일치했다.
- `[CmdletBinding()]` + `-File`에서는 param의 `$PSScriptRoot`가 비고, 본문과 직접 `&` 호출에서는 정상이다. 실패 경로는 setup → Read-VerifiedPackage → Get-FullPath다. 프로세스 조회 전에 실패하며 CIM 빈 경로 후보는 이번 수정에서 제외했다.
- 기존 package 테스트에 실제 자식 `powershell.exe -File` 설치·제거를 추가했다. setup 수정 전 설치 실패, setup만 수정한 뒤 uninstall 실패를 각각 확인하고 두 기본값을 본문으로 옮겼다. 명시한 경로 인수는 그대로 유지한다.
- 제품 로직 변경은 `scripts/setup.ps1`, `scripts/uninstall.ps1`의 기본 경로 초기화뿐이다. 버전은 Cargo workspace/lockfile·Extension manifest에서 함께 0.1.4로 갱신한다.
- 최종 로컬 0.1.4 Windows exe로 package 5개 그룹(실제 ZIP·생략/명시 -File 수명주기 포함), 기존 installer 12개가 통과했다. Extension 타입 검사/빌드, 제3자 고지 생성, 문서 helper 3개·Markdown 링크 20개, `git diff --check`도 통과했다. 로컬 Windows exe SHA-256은 `c36b17f1401adbeb044b3b8bcae58480eaf66078720859440849980b3de819e9`다. PR 최신 head의 CI/코드/보안 리뷰를 완료한 뒤 병합하고, main CI 패키지를 재다운로드·실설치 검증한 후 게시한다. 사내 PC 직접 실행·실제 모델 요청·운영 설치 업데이트는 수행하지 않는다.

## PR #3 3차 리뷰 수정 · v0.1.3

기준 head는 `55d17987316823323660217e3891ac6b7d11953b`다. 세 P2 모두 수정 전 회귀 테스트 실패를 확인했다. 버전은 Cargo workspace·lockfile·Extension manifest를 함께 0.1.3으로 갱신했다.

| 리뷰 | 확인·결과 |
|---|---|
| [삭제 후 페이지 탐색](https://github.com/jihoon22-lee/agent-browser/pull/3#discussion_r4242062801) | 원래 서버 페이지 길이로 더 보기 여부를 판단한다. 삭제 항목은 숨기면서 다음 페이지의 나머지 69개 루트를 모두 탐색하는 회귀가 실패 → 통과했다. |
| [상태 조회 잠금](https://github.com/jihoon22-lee/agent-browser/pull/3#discussion_r4242062805) | 조회 전체에 메모리 잠금과 프로필 파일 잠금을 유지한다. HTTP 조회를 중간에 멈춰 같은 manager의 Stop 잠금과 다른 manager의 프로필 수정이 차단되고, 조회 후 다시 수정 가능한지 검증했다. 잠금 획득 후 프로필도 다시 읽는다. |
| [전송 전 취소](https://github.com/jihoon22-lee/agent-browser/pull/3#discussion_r4242062810) | sink가 메시지를 받았는지 기록한다. send 분기 첫 poll 전 취소는 `CANCELLED`, delivered=false, executed=no이며 소켓에 call/cancel을 보내지 않는다. 같은 연결의 다음 요청은 성공한다. 이미 큐에 들어간 쓰기의 `EXECUTION_UNKNOWN` 정책은 유지한다. |
| [attach 완료 취소 P1](https://github.com/jihoon22-lee/agent-browser/pull/3#discussion_r4242062800) | 오탐. FuturesUnordered는 router를 백그라운드 task로 실행하지 않는다. 마지막 reply await 뒤 ops.attach부터 결과·attached 기록까지 suspension이 없다. 실제 router를 poll하는 테스트에서 reply 준비만으로 작업이 생성되지 않음, poll 전 abort는 생성 안 함, 생성 poll에서는 outcome까지 즉시 반환함을 고정했다. 기존 응답 후 취소·대체 작업 보호 통합 테스트도 통과했다. |

검증:

- `cargo test --offline --locked -p agent-browser-bridge`: 131 통과, 자식 프로세스 helper 1 기본 제외.
- `cargo clippy --offline --locked -p agent-browser-bridge --all-targets`: 통과, 기존 경고 7건. 새 테스트의 `unused_io_amount` 오류는 `read_exact`로 수정 후 재검증했다.
- `pnpm --filter agent-browser-extension test`: 280/280. workbench 단독 65/65.
- Extension build, E2E `tsc --noEmit`, `node scripts/ci-checks.mjs`(문서 20개), `git diff --check`: 통과.
- 최종 소스의 실제 Windows Rust lib exe: 51 통과, 로컬 WSL 전용 1 기본 제외. 해당 WSL 실패 복구 테스트를 `--ignored --exact`로 명시 실행해 1/1 통과했다.
- 추가 검증은 PR 최신 head의 Linux·Windows CI에서 실행한다. CI의 Chrome/Chromium·설치·패키지 검증과 코드·보안 리뷰가 완료된 head만 병합한다. main CI 산출물의 버전·체크섬을 확인한 뒤 기존 관례대로 Windows x64 prerelease를 게시한다.

코드·테스트 diff 식별: `git diff --binary 55d1798 -- bridge/src extension/src extension/test | sha256sum` = `d572e1be0a44a3bf292d930e13d9621ba78e0bad2737648d61ff382633323bc7`.
처음 구현 중 Rust `Cell<bool>`의 Send 제약 컴파일 실패는 지역 bool로 수정했다. 최종 테스트 실패는 없다. 실제 모델 호출·전역 OpenCode 설정 변경·운영 설치 업데이트는 수행하지 않았다. 아래 과거 절의 승인 제한은 해당 시점 기록이며, 현재 승인 범위는 위에 적었다.

## PR #3 2차 리뷰 수정 — 로컬 검증 완료

- 기준 head: `60303431e70e947ec83d42f3535daed2bef860cf`. 원격/로컬 일치와 두 체크아웃의 clean 상태를 확인하고 시작했다. PR은 사용자가 전환한 일반 리뷰 상태를 유지한다.
- 기존 [PR #3](https://github.com/jihoon22-lee/agent-browser/pull/3)의 네 P2 지적 모두 수정 전 실패를 확인한 실제 결함이다. 원본 main, 운영 설치, 전역 설정을 변경하지 않았다. 리뷰 스레드 댓글/해결 처리는 하지 않는다.

| 리뷰 | 재현·수정 |
|---|---|
| [pending WSL owner](https://github.com/jihoon22-lee/agent-browser/pull/3#discussion_r4241916760) | 실제 Windows Rust 테스트에서 owner 게시를 늦춘 WSL 자식을 시작하고 초기 runtime.json 저장을 실패시켰다. 수정 전 terminate 반환 후 자식이 실행됨 → 수정 후 신원 게시를 기다려 정확한 group을 종료한다. 저장 성공 뒤에만 nonce별 start permit을 기록하며, WSL shell은 일치하는 permit 전에는 OpenCode를 exec하지 않는다. permit 없음/잘못된 nonce도 실패 테스트 후 통과했다. |
| [삭제와 목록 응답](https://github.com/jihoon22-lee/agent-browser/pull/3#discussion_r4241916763) | 초기/검색/더 보기 응답 중 무관한 child 삭제가 오면 결과 전체가 버려지는 3개 실패를 확인했다. 삭제 시 목록 revision을 바꾸지 않고 tombstone으로 삭제 ID만 거른다. 로딩 상태도 진행 중 조회가 끝날 때 갱신한다. |
| [연결 완료와 선택 저장](https://github.com/jihoon22-lee/agent-browser/pull/3#discussion_r4241916768) | provider 조회를 지연한 상태에서 다른 세션 선택/현재 세션 삭제를 각각 수행하면 connect의 이전 restored 값이 저장되는 2개 실패를 확인했다. 연결 완료 시 selected.current를 저장한다. |
| [하위 조회 동시성 상한](https://github.com/jihoon22-lee/agent-browser/pull/3#discussion_r4241916773) | 미완료 child 조회를 둔 채 반복 SSE 재연결/프로필 전환 시 4개 제한을 넘는 2개 실패를 확인했다. freshness 세대는 결과 유효성만 제어하고 실제 미완료 요청 수는 세대와 무관하게 유지·감소시킨다. 이전 응답을 버리면서 슬롯이 비면 새 세대 queue를 실행한다. |

WSL 정리는 제한된 재시도 뒤에도 신원을 확인할 수 없으면 확인되지 않은 프로세스를 강제로 죽이지 않는다. 초기 저장이 실패한 경우 start permit이 없어 늦게 시작한 shell도 OpenCode를 실행하지 못하며 permit 대기는 약 60초 후 종료된다. 정상 저장/시작, cd 실패, unknown marker 보존도 함께 검사했다.

| 최종 로컬 검사 | 결과 |
|---|---|
| `pnpm --filter agent-browser-extension exec vitest run test/workbench.test.ts` | 64/64 통과. 새 UI 7개는 수정 전 모두 실패했다. |
| `pnpm --filter agent-browser-extension test` | 279/279 통과. 첫 전체 실행은 동시 빌드 중 기존 snapshot-bounds의 5초 timeout 1건(278 pass)이 있었고, 코드/timeout 변경 없이 단독 5/5와 전체 279/279 재실행이 통과했다. |
| `cargo test --offline --locked -p agent-browser-bridge` | 128 통과, 기존 별도 프로세스 helper 1 ignored. 기존 MCP 취소·router·runtime 회귀 포함. |
| Windows lib 테스트 exe | 48 통과, WSL 필요 테스트 1 ignored. 해당 WSL 테스트는 아래 명령으로 별도 실행했다. |
| Windows lib `--ignored --exact runtime::wsl_persist_failure_tests::review_pending_wsl_owner_is_cleaned_after_initial_persist_failure` | 수정 전 실패 → 최종 1/1 통과. 실제 Windows→WSL이며 합성 shell/sleep만 사용한다. |
| Windows mcp_stdio 테스트 exe, Unix 전용 cleanup 1개 제외 | 최종 release exe로 7/7 통과. |
| `AGENT_BROWSER_WINDOWS_TEST_DIR=<isolated-directory> bash scripts/test-windows.sh` | release/Extension 빌드 및 Windows Chrome E2E 48/48 통과. |
| `xvfb-run -a pnpm --filter agent-browser-e2e test` | WSL Chromium E2E 48/48 통과. |
| 기존 Windows/WSL 합성 runtime 7시나리오 | 모두 통과: .cmd health 실패, WSL cd 실패/unknown marker, 양쪽 doctor env 및 정상 재시작/재사용/Stop. |
| `pnpm --filter agent-browser-e2e check`, Clippy, 문서 링크, `git diff --check` | 통과. Clippy의 기존 7곳 경고는 동일하며 새 경고는 없다. |

검증한 Windows release SHA-256: `20e0fcea3f5526bd61d91909cd5fe375cac63e1eda787ed77754b354686ad7d5`.
코드/테스트 diff SHA-256: `1f616a4076737fbab32412a7df06f404ac8204a90f54aeea3f4b0817c0b3327e` (기준 6030343, `bridge/src extension/src extension/test`).
테스트 중 한 번의 합성 runtime 실행은 호출 환경변수가 누락되어 제품 시작 전에 중단됐으며, 명시적 환경으로 다시 실행한 위 7개 결과만 제품 검증으로 집계했다.

변경 파일: `bridge/src/runtime/mod.rs`, `extension/src/sidepanel/use-workbench.ts`, `extension/test/workbench.test.ts`, `CHANGELOG.md`, `docs/status.md`, `docs/testing.md`.
실제 모델·OpenCode CLI 전체 통합·사내 환경은 미검증이다. 새 Windows→WSL 테스트는 WSL 없는 hosted CI에서 기본 제외하며 로컬에서 명시적으로 실행했다. 원격 CI 결과는 PR의 해당 head 실행을 별도로 확인한다. 병합·배포·release·설치본 업데이트는 수행하지 않는다.

## 리뷰 1차 수정 — 6030343 로컬 검증 (2026-10-11)

- 기준: 로컬·원격 main `c3243f8419d54e87c073082f9fb6d4fbee150f49`. 시작 시 원격 main과 같았으며 기존 v0.1.2 Stop 수정도 확인했다.
- 격리 worktree의 검토 브랜치: `feat/review-regressions`.
- R01–R11 및 D01 모두 수정·회귀 검증 완료. 원본 main 체크아웃은 변경하지 않았다. 사용자가 승인한 24개 파일을 커밋·푸시하고 main 대상 draft PR로 제출한다. 병합·release·운영 설치 업데이트는 승인 범위에 없다.
- 최종 Windows release exe SHA-256: `212e2f92f70530f3ad0afbfb3469a49df41a16dc187931fb7b0ecdd4fa074d06`.
- 최종 코드·테스트 diff SHA-256: `4f26d4137d173be624d10c8fb0da41d2e3d280c39e62c05d1a2a1dcd6d704de2` (`git diff --binary c3243f8 6030343 -- bridge/src bridge/tests extension/src extension/test | sha256sum`). 아래는 6030343 제출 당시의 기록이다.
- 아래 Windows MCP 취소·런타임 7시나리오·정리·Chrome E2E는 위 최종 release exe로 실행했다. Rust lib/router는 최종 소스에서 만든 Windows 테스트 exe 자체를 실행했다.

| 결함 | 수정과 회귀 근거 |
|---|---|
| R01 P1 | `RequestContext.ct`를 mutex 대기·인증/연결·send·응답 대기에 전달. 같은 연결에서 요청 ID별 `tool.cancel`로 downstream future를 drop하여 `browser.cancel` 전달. attach 완료 경합도 요청/operation ID로 제한한다. 수정 전 stdio 3개 실패 → 최종 Windows 3개 통과. 인증 중 취소와 attach 응답 경합/대체 operation 보호도 통과. 이미 전달된 쓰기는 실행 여부 불명으로 유지한다. |
| R02 P2 | 복원 세션을 먼저 조회한 후 `session.directory`로 API/SSE를 생성한다. 패널 재개·프로필 왕복 2개 수정 전 실패 → 통과. 추가 검토에서 삭제된 최근 세션(404)은 선택을 비우고 연결을 유지하며 500은 숨기지 않도록 실패 테스트 후 보완했다. |
| R03 P2 | `.cmd` 자식 listener의 검증된 신원을 health 이전에 저장한다. 실제 Windows 합성 503 서버: 수정 전 listener=true/신원 미저장/자식 생존 → 최종 listener=true/신원 저장/자식 종료/기록 제거 통과. 추가 실패 테스트로 status/reuse의 저장 오류가 기존 런타임을 종료하지 않도록 보완했다. |
| R04 P2 | nonce pending marker, owner-before-cd, launcher 종료 증거로 미시작·시작 중·실행 중·종료 확인·검사 불가를 구분한다. marker 없음은 종료 증거가 아니다. Windows→WSL cd 실패에서 수정 전 Stop/기록 정리 실패 → 최종 Stop·편집·삭제 통과. unknown marker 보존, 정상 재사용/종료, 정확한 shell의 실행/nonce/종료 경계도 통과. |
| R05 P2 | iframe snapshot에도 호출자의 offset/maxChars를 전달한다. 다음 커서가 진전하는 회귀 테스트 수정 전 실패 → 통과. |
| R06 P2 | refGone은 시작할 때 확보한 노드의 isConnected를 검사한다. 6번째 snapshot의 캐시 만료를 DOM 제거로 오인하지 않는다. 이미 만료된 ref는 STALE_ELEMENT를 반환한다. 만료·분리 회귀 통과. |
| R07 P2 | Enter는 기본 submitter의 click을 실행하여 click handler/preventDefault를 존중한다. image/external form-associated submitter와 submitter 없는 복수 입력도 검사한다. 새 회귀 4개 수정 전 실패 → 통과. |
| R08 P2 | disabled option/optgroup을 값 변경 및 input/change 이전에 거부한다. 새 회귀 2개 수정 전 실패 → 통과. |
| R09 P2 | 삭제 tombstone과 목록 revision으로 오래된 목록/하위 목록 응답의 행 부활을 막는다. 수정 전 실패 → 통과. |
| R10 P2 | SSE online 시 child cache generation을 갱신하고 이전 세대 응답을 버린다. 실패 요청의 requested 기록을 해제한다. 빈 목록/실패 후 재연결 2개 수정 전 실패 → 통과. |
| R11 P2 | 성공한 authoritative status snapshot에서 이전 busy/retry 키가 사라지면 idle 전이로 처리하여 최종 todo/children/diff를 조회한다. absent 회귀 수정 전 실패 → 통과, 실패한 GET은 idle로 바꾸지 않는 대조군 통과. |
| D01 P3 | doctor가 profile.env·작업 디렉터리·WSLENV 전달을 같은 helper로 적용한다. Windows .cmd와 Windows→WSL 모두 수정 전 실패 → 최종 통과. |

다른 디렉터리 세션의 rename/fork/export/delete는 session-ID middleware가 실제 디렉터리를 우선하는 오탐으로 유지했다. R02의 instance API/SSE 범위만 수정했다.

| 최종 명령/검증 | 결과 |
|---|---|
| `cargo test --offline --locked -p agent-browser-bridge` | 127 통과, 1 ignored. ignored는 다중 프로세스 테스트가 별도로 호출하는 기존 helper다. |
| `cargo clippy --offline --locked -p agent-browser-bridge --all-targets` | exit 0. 기존 7곳 경고, 새 경고 0. 아래 출처 참조. |
| `cargo xwin test --offline --locked --target x86_64-pc-windows-msvc --no-run --lib --test mcp_stdio --test tool_router` | 교차 빌드 통과. 빌드만으로 Windows 실행 통과를 주장하지 않았다. |
| Windows `agent_browser_bridge-*.exe` | 48/48 통과. |
| Windows `mcp_stdio-*.exe --skip starts_serve_when_missing_and_serve_outlives_mcp` (`AGENT_BROWSER_TEST_EXE`=최종 exe) | 7/7 통과, Unix 전용 kill/진단을 요구하는 기존 1개는 Windows 미실행. 같은 테스트는 WSL 전체에서 통과했다. |
| Windows `tool_router-*.exe` | 18/18 통과. |
| `pnpm --filter agent-browser-extension test` | 30파일 272/272 통과. workbench 57개, R05–R08 관련 4파일 69개 포함. |
| `pnpm --filter agent-browser-extension build` | tsc + Vite 두 빌드 통과. |
| `pnpm --filter agent-browser-e2e check` | 타입 검사 통과. |
| `node --test tests/fixtures/server.test.mjs tests/fixtures/opencode.test.mjs tests/agent/runner.test.mjs tests/agent/runner-process.test.mjs tests/e2e/interop-check.test.mjs tests/e2e/runtime.test.ts scripts/ci-checks.test.mjs` | 28/28 통과. |
| `AGENT_BROWSER_WINDOWS_TEST_DIR=<isolated-directory> bash scripts/test-windows.sh` | Windows Node 24.18.1 / Chrome 154.0.8037.99, 별도 headless 프로필에서 48/48 통과. |
| `xvfb-run -a pnpm --filter agent-browser-e2e test` | WSL Chromium, 48/48 통과. |
| Windows `node bridge/tests/windows-runtime.mjs` | RUNTIME_SCENARIO 7회: cmd health-failure, wsl wsl-start-failure/wsl-unknown-marker, cmd/wsl doctor-env 및 healthy-fixture 모두 통과. 정확한 환경변수는 [검증 문서](./testing.md) 참조. |
| PowerShell 5.1 `tests/install/runtime-cleanup.tests.ps1 -BridgeExe <final-exe>` | 임시 설치의 소유권 정리 3/3 통과. 기존 운영 설치는 건드리지 않았다. |
| `node scripts/ci-checks.mjs`, `git diff --check` | 로컬 Markdown 링크 20파일 통과, 공백 오류 없음. |

Clippy의 남은 경고는 기준 main의 동일 코드와 대조했다. `conn.rs:152`의 `type_complexity`, `conn.rs:155`의 `result_large_err`, `conn.rs:457`, `operation.rs:148`, `registry.rs:110`, `router.rs:94`, `tests/common/mod.rs:52`의 `collapsible_if`다. lib 6곳 + 공용 테스트 helper 1곳이며 여러 테스트 target의 duplicate 출력은 별도 결함이 아니다. 이번 수정의 attach nested-if와 수정한 startup nested-if 경고는 제거했다. 기준 main의 Clippy 전체 재실행은 하지 않았고 해당 경고 소스가 동일함을 git으로 확인했다.

검증 과정의 실패도 최종 결과와 구분한다. 새 회귀는 먼저 실패를 확인했고 수정 후 통과했다. 초기 Extension 빌드의 tuple 타입 오류도 수정했다. 첫 .cmd 합성 fixture는 한글 경로를 batch에 직접 넣어 시작하지 못했으므로 재현 근거에서 제외하고 env 경로 및 listening assertion으로 수정 후 전/후를 다시 측정했다. Windows lib의 최초 47 pass/1 fail은 compile-time WSL 경로를 Windows에서 읽는 기존 테스트 문제였다. 고정 fixture를 테스트 바이너리에 포함시켜 최종 48/48을 확인했다. 수정 전 Node fixture의 강제 exit 뒤 libuv assertion은 exitCode로 보완했으며 최종 7회에 재발하지 않았다.

변경 파일(24개):

- Bridge: `bridge/src/mcp/client.rs`, `bridge/src/mcp/mod.rs`, `bridge/src/mcp/tools.rs`(test fixture만), `bridge/src/runtime/mod.rs`, `bridge/src/runtime/process.rs`, `bridge/src/server/conn.rs`.
- Bridge 회귀: `bridge/tests/mcp_stdio.rs`, `bridge/tests/tool_router.rs`, `bridge/tests/windows-runtime.mjs`.
- Extension: `extension/src/background/handlers.ts`, `extension/src/content/actions.ts`, `extension/src/content/keyboard.ts`, `extension/src/content/refs.ts`, `extension/src/content/wait.ts`, `extension/src/sidepanel/use-workbench.ts`.
- Extension 회귀: `extension/test/actions.test.ts`, `extension/test/content-cancellation.test.ts`, `extension/test/handlers.test.ts`, `extension/test/keyboard.test.ts`, `extension/test/workbench.test.ts`.
- 문서: `CHANGELOG.md`, `docs/protocol.md`, `docs/status.md`, `docs/testing.md`.

남은 구현 blocker는 없다. 검증 범위는 Windows 11 + WSL Ubuntu 26의 합성 서버/API/DOM 및 실제 격리 Chrome이다. 실제 OpenCode CLI→모델 end-to-end, 실제 모델 추론, 사내 Windows/Ubuntu 24, RHEL, 원격 CI는 이번 작업에서 실행하지 않았다. Windows Rust의 나머지 integration target·일반 설치/패키징 전체도 이번 최종 실행에는 포함하지 않았다. R01은 고정 SDK/rmcp 취소 경로의 소스 확인 + 실제 MCP stdio 취소 프로토콜 검사이며, 실제 OpenCode 세션 취소 시연과 혼동하지 않는다. 요청하지 않은 배포·전역 OpenCode 설정 변경·무관한 프로세스 종료는 하지 않았다.

로컬 검증 로그와 합성 결과 JSON은 별도 검증 작업 폴더에 보존했다. 테스트 exe·확장도 격리된 Windows 검증 폴더에만 생성했다. 운영 설치의 v0.1.2 파일은 대체하지 않았다.

## 실측 환경 (2026-10-11)

| 항목 | 값 |
|---|---|
| WSL | Ubuntu 26.04.1 LTS, kernel 6.18.33.2-microsoft-standard-WSL2, NAT 네트워킹. WSL PATH에 Windows 경로 없음 → `/mnt/c/...` 절대 경로 |
| Windows | Windows 11 `10.0.26200.9457` AMD64, PowerShell 5.1(pwsh 없음), node·git 있음, Rust 없음 |
| Chrome | 154.0.8037.99 |
| OpenCode | WSL `~/.opencode/bin/opencode` 1.18.29. Windows 검증용 portable 1.18.29는 `AgentBrowser-dev/opencode/1.18.29` |
| WSL 툴체인 | node 24.18.0, pnpm 9.15.9, rustc 1.98.1/1.97.1, cargo-xwin, target `x86_64-pc-windows-msvc` |

## 최신 검증 기준선 (v0.1.2, main `1b8f012`)

| 범위 | 결과 |
|---|---|
| Extension Vitest | 30파일 253/253 통과. TypeScript/Vite 빌드 통과. 전체 실행 중 기존 snapshot 경계 테스트가 1회 7.5초 시간 초과했고, 단독·전체 재실행에서 통과 |
| Linux Chromium 실제 확장 E2E | 48/48 통과(새 탭 9 + 브라우저 26 + 작업 UI 13). 최종 수정 후 작업 UI 13/13 재실행 |
| 실제 Windows Chrome E2E | `scripts/test-windows.sh` 48/48 통과(최종 코드). Windows Node 24.18.1, Chrome 154.0.8037.99, MSVC release exe, 격리 headless 프로필 |
| Node fixture/runner/interop/문서 helper | 28/28 통과 |
| Windows 런타임 정리·패키징 | 0.1.2 exe로 런타임 정리 3/3, 패키징 3/3 통과 |
| Rust 전체(Linux) | 0.1.2에서 로직 변경 없음, 로컬 재실행 안 함(0.1.1 기준 117/117). PR·main CI에서 실행 |
| 원격 CI | [PR CI](https://github.com/jihoon22-lee/agent-browser/actions/runs/38132152869), [main CI](https://github.com/jihoon22-lee/agent-browser/actions/runs/38132545391) Linux·Windows 성공 |

실제 모델 호출은 하지 않았다. 합성 HTTP/SSE fixture만 사용했다.

## 배포

- [v0.1.2 Release](https://github.com/jihoon22-lee/agent-browser/releases/tag/v0.1.2)(비공개 저장소 prerelease, [PR #2](https://github.com/jihoon22-lee/agent-browser/pull/2)). 태그는 main 병합 커밋 `1b8f012`.
  ZIP `agent-browser-0.1.2-windows-x64.zip` 3,414,050 bytes, 파일 31개,
  SHA-256 `5628213c31ad3154de89591636377adbbfa1ce2a38bb5c06745f67be8af2260b`(GitHub asset digest 일치). exe SHA-256 `0cfaec2978cb29a59873d50c412ca303c3706ae671848c944ab64a8d069fb9f1`.
  ZIP의 exe·Extension 파일이 실제 Windows 48개 검사에 사용한 파일과 같음을 확인.
- v0.1.1·v0.1.0 태그와 ZIP은 변경하지 않았다. v0.1.1 ZIP SHA-256 `11eb24028a265fa24d0a76d60bc725f32c195e20100d3e4c7ff0127da7304efd`, v0.1.0 `909021621dbf3c578496f760524c233f5a51556ec480adbfb1ccee16cd57ac0f`.
- 이 PC 설치: 관리 OpenCode의 실행 중 세션이 없음을 두 번 확인한 뒤, `%LOCALAPPDATA%\AgentBrowser`를 0.1.2로 업데이트했다(`Downloads\AgentBrowser-0.1.2\setup.ps1`).
  - 첫 실행은 원인 미확인 `GetFullPath` 경로 형식 오류로 변경 없이 중단됐다(설치 상태 0.1.1 유지 확인). 같은 인수로 다시 실행해 성공했다.
  - 새 Bridge PID 45552, 포트 4317. 관리 OpenCode 서버(127.0.0.1:4096)는 유지됐다.
  - 업데이트 후 doctor 결과: Bridge 0.1.2 인증, OpenCode 1.18.29 ready, browser MCP 연결 정상. 모델 추론 검사는 하지 않았다.
  - 프로필 `wsl-main`(Ubuntu, `/home/jihoon/projects/agent-browser`), 페어링 토큰, 전역 OpenCode 설정은 보존됐다.

## 알려진 제한

- 인증: Extension·MCP는 토큰을 전송하지 않는 HMAC-SHA256 상호 인증을 쓴다. 구형 인증 클라이언트와 호환되지 않으므로 Bridge와 Extension을 함께 갱신한다.
- 지원하지 않는 대상: Chrome 내부 페이지, OS 대화상자, 닫힌 Shadow DOM, canvas 내부, 백그라운드 전체 페이지 캡처.
- Clippy의 기존 스타일/복잡도 경고가 남아 있다.

## 참고 사항

- 전역 `~/.cargo/config.toml`의 `build.target-dir`이 다른 프로젝트 캐시를 가리킨다. 이 저장소는 `.cargo/config.toml`로 `target/`을 쓴다.
- 전역 OpenCode 설정에는 기존 MCP(playwright 등)가 있다. 수정하지 않고 테스트는 별도 설정으로 격리한다.
- 실제 사용자 설치의 Bridge는 사용을 위해 실행 상태로 유지한다. 검증용 프로세스는 테스트가 끝나면 종료한다.

## 2026-10-12 WSL interop 방어 수정

`v0.1.4` 기반의 `fix/wsl-interop-compat` 별도 worktree에서 keeper 소유·수명 관리,
동일 소켓 Windows canary, WSL 검사 통합, HTTP와 browser MCP의 준비 판정 분리를 구현했다.
keeper 없는 기존 런타임은 보존하고 명시적인 Stop/재시작으로 구성을 갱신한다.
늦게 실행되는 WSL 명령이 Stop 뒤 시작 허가를 소비하는 경합도 실패 테스트로 재현하고 수정했다.

Linux Bridge 전체 135개 및 후속 runtime 관련 회귀, 실제 Windows/WSL의 OpenCode 1.18.29,
canary·MCP initialize·합성 첫 도구 응답, caller/Bridge 종료 후 재사용, keeper 종료,
소켓 부재·handshake 정지, 저장 실패·시작 허가 취소, MCP 지연·실패 정리를 검증했다.
동일 조건의 status 5회에서 WSL 제어 프로브가 15회에서 5회로 감소했다.
구현·실행 근거와 재현 한계는 [WSL interop 검증 기록](./wsl-interop-validation.md)에 정리했다.

현재 WSL 2.7.12에도 공식 #41252의 timeout 수정이 없다는 소스 근거를 확인했다.
정상 시험 통과를 런타임 결함 부재로 해석하지 않는다. 별도 구형 WSL 패키지 VM 시험과
커널 vsock 결함의 직접 재현은 미실행이며, 응용 계층 fault injection과 구분한다.
운영 설치, GUI 작업 브랜치, 기존 사용자 세션, 전역 OpenCode 설정을 변경하지 않았다.

## 2026-10-12 WSL interop follow-up review

Review of `748f8d5` found and fixed two additional lifecycle defects: an exited
server group leader hid a live owned child, and a missing keeper obscured a
positively previous-boot server record. The former failed with the old native
Windows binary while its child still returned HTTP 401; both new regressions
pass with the fix. Foreign nonce ownership remains unknown and is never adopted.

Final Linux Bridge suite: 139 passed, 0 failed, 1 ignored. Three targeted native
Windows persistence/Stop tests passed. Actual Windows/WSL fixtures passed for
orphan cleanup, previous-boot metadata, startup crash, ready-state crash/reuse,
two independent concurrent CLI callers, keeper/socket faults, existing settings,
real OpenCode 1.18.29 MCP initialize failure/recovery, protocol initialize, and
the first synthetic browser_tabs response. A repeat status comparison measured
15 versus 5 WSL control probes for five calls. Actual fixture `/usr/bin/node`
is v22.22.1; other host Node versions are not the fixture executable version.

See [review findings, exact observations and limits](./wsl-interop-review.md)
and [sanitized results](./reference/wsl-interop-review-results.json).
No actual WSL shutdown, separate older-package VM, kernel leak reproduction,
real Chrome/model request, operating install update, or remote Git action was
performed. Integration should carry the implementation and its follow-up commit.
