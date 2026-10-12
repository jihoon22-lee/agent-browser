# v0.1.5 단일 통합 릴리스 준비

사용자의 최신 지시에 따라 GUI·WSL·iframe·요청별 활성 탭·게시판 개선을 하나의 PR #6과 한 번의 v0.1.5 릴리스로 묶는다. 게시된 최신 버전은 v0.1.4이며, GUI 단독 릴리스는 하지 않는다. 기존 GUI PR #5의 커밋·검증 이력은 merge로 보존한다. 운영 설치·사용자 Chrome 프로필·전역 OpenCode 설정은 변경하지 않았다.

- 통합: GUI 61a116c, WSL 원본 748f8d5/dad0216, 게시판 원본 3c6de97/5e50f63 및 이 브랜치의 iframe·활성 탭 수정. 클릭의 실제 표시 조각 좌표와 실행 직전 ref/상호작용 재검사를 모두 보존했다.
- 확장 전체 32 suites / 329 tests, 타입 검사·빌드와 E2E 타입 검사가 통과했다. 도구 설명의 합산 크기는 기존 6,000자 제한을 유지한다. Rust 계약·서버·WSL 회귀와 실제 Windows 빌드를 수행했으며, 최종 조합의 전체 결과는 PR CI에서 확인한다. 시험 자식이 exec하기 전 image를 캡처하던 경합은 시험 준비 단계에서 보정하고 관련 3개 회귀를 통과했다.
- 최종 v0.1.5 Windows Chrome 154.0.8037.99 핵심 경로: 실제 패널/요청 예약 13개, 게시판 8개 통과. 생성 탭 닫기 뒤 요청 유지·원래 탭 보호·명시적 복귀·iframe 대기·href 변경 참조 거부를 하나의 시나리오에서 확인했다. 실제 BFCache persisted=true와 beforeunload 취소 후 소유권/URL 보존을 확인했다.
- 격리 WSL OpenCode 1.18.29가 구성한 MCP 명령→Windows Bridge 0.1.5→실제 Chrome 확장→same/cross/nested iframe·OOPIF 2개 경로가 통과했다. HTTP/MCP 준비, 자체 런타임 stopped 및 프로세스 정리를 확인했다. 모델 호출은 0회다.
- PR 첫 리뷰의 Chrome 재시작 예약 유실, 완료 후 Stop 누락, 선택적 finish 미처리, 삭제 세션 404 고착을 실패 회귀로 재현하고 수정했다. 예약은 durable local storage에 보존하며 busy/retry 및 명시적 비종료 finish는 계속 보류한다. 선택 경합은 같은 selection lock으로 보호한다.
- 합성 입력 isTrusted=false, 비표준 편집기의 저장 상태, 검사 뒤 동시 편집의 한계는 유지한다. 사내 서비스·구형 WSL VM·실제 WSL shutdown·커널 자원고갈을 검증했다고 주장하지 않는다. debugger 권한이나 Chrome 보안 설정을 추가하지 않는다.
- 사용자가 추가 요청한 새 탭 생성·즐겨찾기 점검은 별도 게시판 담당의 후속 인계를 기다린다. 최종 게시 전에 결과를 통합하고 필요한 권한 확인을 따른다. 이후 최종 PR CI/유의미한 리뷰, 병합, 게시본 재다운로드·격리 설치/업데이트 검증까지 수행한다.

아래는 각 독립 작업과 이전 릴리스의 검증 이력이다. 당시의 승인·배포 상태는 위 현재 상태와 구분한다.

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

## 게시판 탐색 안정성 — 별도 작업 로컬 검증 완료 (2026-10-12)

- 시작 시 `git ls-remote origin HEAD refs/heads/main`으로 확인한 기준은 `fb2bcdbb4672a09395c7d7cc2ee75e6796e897c1`이다. 독립 브랜치 `fix/board-navigation-stability`, worktree `/home/jihoon/projects/agent-browser-board-navigation`에서 작업했다. 관련 `AGENTS.md`를 읽었으며 이 기준 저장소에 `.agents/skills`는 없었다.
- 다른 GUI/WSL interop/iframe·활성 탭 작업은 합치지 않았다. 기존 체크아웃, 운영 설치, 사용자 Chrome 프로필, 전역 OpenCode 설정을 수정하지 않았다. 이번 승인 범위는 제품 코드·로컬 테스트·로컬 커밋이며 push/PR/병합/릴리스는 수행하지 않았다.

### 확인한 결함과 수정

1. 실제 Windows Chrome에서 합성 클릭 뒤 `tabs.goBack`이 목록을 건너뛰어 `about:blank`로 이동했다(history.length=3). SPA back도 첫 실행에서 같은 실패가 있었다. 문서 ID를 고정한 isolated-world history.back/forward로 정확히 한 항목씩 이동하도록 수정한 뒤 hard 왕복 4회와 SPA 지연 목록 시험이 통과했다.
2. Chrome 탐색 API 승인 직후 이전 문서의 complete를 읽고 돌아올 수 있었다. 문서 ID/URL/탐색 이벤트의 실제 변화와 완료를 기다리며, 타임아웃/취소 시 자동 재실행하지 않는다.
3. snapshot 도중 문서가 바뀌면 오래된 읽기 결과를 바인딩할 수 있었다. 반환 전 live document와 URL을 확인하고 읽기만 총 3번까지 반복한다. 읽기 교체/반복 상한 테스트 2개와 연결 DOM의 href/접근 가능한 이름 변경 테스트 2개는 수정 전 실패를 확인했다.
4. 연결된 노드라도 이름·role·링크 대상 등이 바뀌면 옛 ref를 거부한다. pagehide에서 ref registry를 비우므로 실제 BFCache 복원 후에도 옛 refs는 STALE_ELEMENT다. index 자동 재선택은 없다.
5. `browser_tabs action=close`를 추가했다. 작업에서 생성/채택한 현재 탭만 허용하며 최초 attach 탭은 보호한다. 현재 문서 snapshot과 모든 frame의 폼 검사를 요구한다. close는 한 번만 전달하며 Chrome onRemoved만 성공으로 확인한다. 3초 내 확인이 없으면 EXECUTION_UNKNOWN, 강제 닫기/자동 재시도 없음. 결과 operationTabs에서 원래 목록 tabId로 명시적으로 switch하고 새 snapshot을 읽는다.

### 독립 검토 후속 · GUI 이후 통합 인계

초기 커밋 `3c6de97b39b2f89eb96ac74dd101dfb9d0696a40`의 짧은 독립 검토에서 실제 dispatch 경계의 세 결함을 실패 테스트로 확인하고 보완했다.

- top document가 없는 동안 과거 snapshot만으로 history 이동이 dispatch되어 새 top 문서로 fallback할 수 있었다. 현재 문서가 없으면 FRAME_UNAVAILABLE로 실행 전에 거부한다.
- 닫기 폼 검사 중 iframe이 교체되면 미검사 문서를 포함한 탭을 닫을 수 있었다. 검사한 frame/document 집합을 고정하고 닫기 전달 전에 다시 비교한다.
- mousedown 등 포인터 처리기가 같은 DOM 링크의 href를 변경하면 이미 검사한 ref가 다른 글을 클릭할 수 있었다. 실제 click 직전에 identity와 상호작용 가능 여부를 재검사한다. B08 실제 Chrome에서 주소 변경 후 click이 차단되고 원래 목록이 유지됨을 확인했다.

snapshot 재시도는 같은 request의 tabId/operationId를 유지하고 읽기만 반복하며, 최종 정상 읽기의 bindings만 게시하는 것을 확인했다. 탭 소유권 제한은 Bridge의 operation lock 안에서 검증한다. beforeunload 취소 후 실제 탭 존재뿐 아니라 operationTabs/currentTab/currentTabClosed 및 원래 목록 URL 보존도 B06에 명시적으로 검사했다. 비표준 편집기 한계는 기존 문서와 일치하며, 여러 frame 폼 검사는 원자적 저장 판정이 아니므로 검사 뒤 동시 편집까지 보장하지 않는다는 제한을 추가했다.

후속 최종 검증: 영향 단위 테스트 4파일 **62/62**, 확장 빌드/E2E 타입 검사, 실제 Windows Chrome의 게시판·새 탭·브라우저 시나리오 **43/43** 통과(AB_TEST_BFCACHE=1, 실제 persisted=true). 아래의 초기 전체 55/55 및 289/289 결과와 구분한다. Rust 코드는 후속 검토에서 변경하지 않았다. 로그는 `review-red.log`, `review-click-red.log`, `review-green.log`, `review-windows.log`다.

사용자 후속 지시로 별도 PR/릴리스 대신 GUI 이후 통합 작업에 넘긴다. 이 worktree에서는 초기 커밋 뒤 후속 수정 커밋을 순서대로 적용할 수 있게 유지하며, 다른 작업 폴더·운영 설치 수정이나 별도 push/PR/병합/릴리스는 하지 않는다. 통합 시 겹칠 가능성이 큰 파일은 background handlers/chrome-api, content actions/refs, MCP tools/router/operation 및 문서다. 통합한 최종 코드의 회귀는 통합 담당이 별도 실행해야 하며 여기 결과로 대체하지 않는다.

### 초기 커밋의 전체 실행 결과

| 검사 | 관찰 결과 |
|---|---|
| Extension 전체 Vitest | 30파일, 289/289 통과 |
| Extension TypeScript/Vite, E2E TypeScript | 통과 |
| Rust 전체 `cargo test --offline --locked -p agent-browser-bridge` | 132 통과, 기존 프로세스 helper 1 ignored |
| Windows Rust tool_router 테스트 exe 직접 실행 | 19/19 통과(새 close 작업 경계 포함) |
| 실제 Windows Chrome 전체 E2E, AB_TEST_BFCACHE=1 | 55/55 통과: 기존 48 + 게시판 7 |
| BFCache 별도 B07 | pageshow.persisted=true, notRestoredReasons=null. 복원된 연결 노드의 옛 ref 거부와 새 snapshot 성공 확인 |
| 실제 닫기 경고 B06 | 합성 페이지의 beforeunload dialog를 관찰하고 dismiss; 탭 보존, EXECUTION_UNKNOWN 반환 |
| Node fixture/runtime/interop/문서 helper | 14/14 통과 |
| Clippy, Markdown 링크, git diff --check | 통과. Clippy는 기존 7곳의 경고 유지(원래 operation.rs 경고의 줄 번호만 이동) |

실측 환경은 Windows Node 24.18.1, Chrome 154.0.8037.99, Windows MSVC release Bridge 0.1.4 소스 기반 로컬 빌드다. 최종 exe SHA-256: `8c0c90c3dded2e61b646ab9165490b36d06005ccd2f3b68ed79b80e092ad1300`. 버전·운영 설치·release asset은 변경하지 않았다.

격리 Windows 시험 산출물은 `C:/Users/USER/Documents/Codex/2026-10-12/task-3/windows-test`, 로그는 그 상위 task-3의 `windows-full-final.log`, `windows-rust-tests.log`, `extension-final.log`, `rust-final.log`, `red-tests.log`, `back-diagnosis.log`, `clippy.log`에 있다. 하네스는 시험별 임시 profile/HOME와 자체 포트를 생성하고 자신이 시작한 프로세스만 정리한다.

초기 게시판 실행은 2 실패/4 통과였고, 진단에서 실제 기록 건너뛰기를 확인한 뒤 수정했다. WSL에서만 환경변수를 설정한 최초 Windows 실행은 BFCache opt-in이 Windows 자식에 전달되지 않아 restored=false였다. 이를 통과로 집계하지 않고 Windows PowerShell에서 직접 환경을 설정한 최종 실행에서 실제 복원을 assert했다. 초기 E2E 타입 오류 한 건도 최종 실행 전에 수정했다.

### 동작 검토와 남은 한계

| 동작 | 지원/결정 |
|---|---|
| 탭 목록·새 탭·작업 탭 전환 | 기존 지원, 이번 실제 회귀 통과 |
| back/forward/reload | 기존 도구를 보완, 정확한 한 항목 이동과 실제 완료 확인 |
| 새 탭 글 읽기 → 닫기 → 원래 목록 복귀 | close 추가 + 기존 switch + fresh snapshot 조합을 실제 검증 |
| 정렬·pagination·SPA·iframe 교체 | 옛 ref는 거부; 예상 텍스트 wait 후 새 snapshot으로 이름/href를 다시 확인 |
| 닫기 경고·편집된 폼 | 경고 자동 승인은 없음. input/textarea/select/open Shadow DOM/iframe 편집 검사 실패 시 보존 |
| 탭 전경 활성화 | switch는 작업 대상만 변경한다. 진행 중인 별도 활성 탭 작업과 중복 구현하지 않음 |
| 향후 검토 | close-and-return 복합 동작, 안정된 목록 조건을 표현하는 wait 개선. 이번 검증된 명시적 조합으로 수행 가능 |

실제 모델/OpenCode 판단, 사내 환경, 다른 Chrome 버전, 일반 사용자 사이트 데이터는 이번 시험에 포함되지 않았다. 닫힌 Shadow DOM/canvas 및 사이트 자체 메모리에만 있는 미저장 데이터는 일반 DOM 검사로 저장 여부를 보장할 수 없다. beforeunload 경고의 허용/거부 정책은 Chrome에 맡기며 우회하지 않는다. 같은 URL·같은 문서의 무관측 no-op history 이동은 timeout일 수 있다. DOM의 의미 정보가 동일한 채 JS closure만 바뀌는 임의 사이트의 논리까지 검증하지 않는다. load 완료가 지연 목록 준비를 뜻하지 않으므로 browser_wait와 새 snapshot이 계속 필요하다.

현재 범위의 구현 blocker는 없다. 배포·다른 작업과의 통합은 별도 승인 범위다.

## 기준 브랜치의 이전 단계

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
## Windows GUI installer — 2026-10-12 02:41 UTC (in progress)

Native WinForms entry point selected; GUI flows are not implemented or tested yet. WSL existing-JSONC replacement regression: 4 PASS; native cmd quoting/discovery smoke: 2 PASS; existing JSONC tests and diff check: PASS. Full installer regression invocation was blocked by Windows signature policy and did not run; no policy was changed. Details: [active plan](./plans/2026-10-12-windows-setup-ui.md). Production remains the separately verified v0.1.4 installation.

### 02:54 UTC checkpoint

Native WinForms GUI and transactional engine compile. Eight isolated native engine tests pass (install/update/uninstall, JSONC/identity/data preservation, concurrency and cancellation rollback). Actual mouse-click tests did not reach preview because Windows is locked; no GUI flow passed. The company no-mcp WSL fixture is prepared but its registration/auth checks are pending. Generic MCP warning classification is confirmed in source; missing registration is not established. See [checkpoint](./plans/2026-10-12-windows-setup-ui-checkpoint-0254.md) for remaining work and edge-case review.

### 03:04 UTC checkpoint

Native integration: 12 PASS, including actual WSL no-mcp JSONC add/repeat/remove and OpenCode 1.18.29 plus authenticated Bridge round trip. GUI remains unverified: Windows now reports Default input desktop, but owned-window foreground activation failed and no mouse input was sent. MCP classification regression fails as expected before implementation. See [checkpoint](./plans/2026-10-12-windows-setup-ui-checkpoint-0304.md).

### 03:22 UTC checkpoint

Five actual native GUI click flows passed from local candidate ZIP: preview/back/cancel, WSL install, managed profile save, repeat/update, uninstall with settings/data preservation. Native integration remains 12 PASS; Rust runtime suite 22 PASS; fresh Windows Bridge and GUI package build PASS. Foreground issue resolved with verified own-window mouse selection. Cross-version GUI update, duplicate-click/failure GUI checks, CI integration and final validation remain. See [checkpoint](./plans/2026-10-12-windows-setup-ui-checkpoint-0322.md).

### 03:40 UTC checkpoint

Local version 0.1.5: actual GUI v0.1.4 published-binary upgrade, duplicate Apply, startup failure rollback/retry and uninstall PASS; native v0.1.5/actual WSL auth integration 13 PASS. Extension build/typecheck and 280 tests PASS; full Rust tests and clippy (existing warnings) PASS; package reproducibility PASS. Native tests added to Windows CI but no push/run. Installed-GUI self-uninstall, discovery/profile async UX review and final docs remain. See [checkpoint](./plans/2026-10-12-windows-setup-ui-checkpoint-0340.md).

### Final local completion — 2026-10-12

Native Windows GUI implementation and final isolated verification complete; local/unpublished candidate 0.1.5. Installed-GUI self-uninstall, automatic discovery/selection/stale-response handling, pending profile validation close, duplicate ID rejection, double Apply/Save, occupied-port failure rollback/retry, masked pairing and existing Bridge start all passed actual GUI clicks from the final ZIP. Published 0.1.4 binary-based isolated upgrade to 0.1.5 and self-uninstall passed.

Final native integration: 14 PASS including simultaneous Windows+WSL registrations and actual OpenCode 1.18.29 authentication; discovery/cmd probe: 2 PASS. Full Rust and extension verification from this same source cycle passed (extension 280 tests); actionlint, CI helpers, document links and package reproducibility passed. Final ZIP SHA256: `fb3cb446410f74b097e47ffbaaa622f68215b150e6251630a930ac9415e035ec`.

Production v0.1.4 PID 74680 remains running; identity, pairing, data owner, profile definitions and global WSL settings preserved. Legacy PowerShell execution and native Windows OpenCode/company/nondefault-user/Chrome end-to-end limitations are explicitly recorded, not claimed as passed. No push, commit, PR, release, model call or operational update. See [final validation](./plans/2026-10-12-windows-setup-ui-final.md).

### v0.1.5 release authorized — 2026-10-12 04:07 UTC

User authorized commit/PR/review/CI/merge/tag/release and published-asset validation. Remote main is still `fb2bcdbb4672a09395c7d7cc2ee75e6796e897c1`; no intervening main changes or existing v0.1.5 release/tag were found. Personal operational v0.1.4 is excluded from the update. Earlier candidate hash and local-only status remain historical evidence, not the published artifact identity.

### PR #5 review fixes — 2026-10-12 04:54 UTC

All seven d3859a2 review findings were reproduced before changes. Windows native regressions now cover missing owned Startup shortcuts (enable/disable and preview races), Unicode Shell links, removal of installer-created empty settings while preserving user comments, persistent exact settings backups (including immediately before uninstall), committed cleanup warnings, unsupported .cmd profile paths, and PID-publication failure cleanup. Settings backups and source-path/hash metadata remain under the private data/settings-backups directory after uninstall; byte-identical registration retries add no backups.

Bridge startup now assigns the suspended launcher to a non-breakaway Windows Job before it can create children. Failure cleanup owns that exact tree independently of PID-file/WMI success; healthy startup, marker-write failure, PID-publication failure, retry and later uninstall passed. No interop behavior or Rust runtime was changed in this review follow-up.

Native Windows + actual WSL integration: 24 PASS (`native-review-final.log`), including OpenCode 1.18.29 MCP connection and authenticated Bridge 0.1.5 reply without a model/page operation. Latest ZIP GUI tests passed preview/Back/cancel, occupied-port rollback/retry, WSL registration, repeat update, and retained root-GUI handoff/self-uninstall (`gui-review5.log`). These tests use real WinForms controls via owned HWND button/selection events, with UI Automation reads; they are not physical mouse-click claims. Initial UI Automation focus errors and a WM_COMMAND-only test input that failed to toggle checkboxes were test-driver failures, and the incomplete fixtures were removed using their ownership records. Full profile-dialog automation did not complete during those failed attempts; prior physical-click coverage and the new native .cmd validation regression are separate evidence.

Windows CI's new compiler step failed on relative slash-separated source paths in run 38202783136; preceding native Rust, isolated Chrome, PowerShell installer/package checks and package build passed. The workflow now resolves absolute Windows source paths and includes the review tests. Local actionlint, CI helper tests (3), Markdown links (26 tracked files) and diff checks pass. Latest-head remote CI/code/security review remain release gates.

Review candidate ZIP has 32 files, SHA256 `0e9b447be1be8f36b1138d5ff5456a5b5b54d220c670b49caa381ef301a42630`. This is local validation evidence, not a published release identity. The company WSL interop issue remains explicitly excluded and unconfirmed. Personal operational v0.1.4 is not updated.
### Second review and complete profile GUI verification — 2026-10-12 05:10 UTC

Head 092979d passed Linux/Windows CI 38205663406 and completed code/security reviews; the code review found four additional P2 issues. All four failed isolated regressions before fixes (`review2-red.log`): discovery executed an unselected synthetic PATH candidate, an owned startup worker killed before commit left its Bridge alive, uninstall dropped a comment inside the created MCP object, and cancellation during Bridge startup committed instead of rolling back.

The fixes defer candidate execution until explicit profile confirmation, set JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE until the process marker has been written, retain JSONC comments from removed owned spans, and check cancellation after startup before commit. Native regression 23 PASS (`review2-green.log`), then final Windows/WSL integration 28 PASS (`native-review3-wsl.log`), including actual OpenCode authentication and all 14 review regressions; native discovery plus explicitly selected WSL version probe 2 PASS (`native-core-review3.log`). No Rust runtime or company interop change is included.

Complete latest GUI profile flow now PASS (`gui-profile-complete.log`): automatic discovery/input freshness, preview/Back/cancel, WSL registration, stale validation discarded, profile confirmation and actual save, duplicate ID rejection, close during validation, existing Bridge reuse, masked pairing, repeat update, retained-GUI handoff and uninstall/data preservation. Validation uses real WinForms controls with owned HWND BM_CLICK/selection events and UI Automation reads. Physical mouse delivery again failed at preview in this desktop session and is not claimed as passed. The earlier profile automation clicked while the Save button was still disabled; waiting for both validation completion and Save enabled resolved it. The application saved successfully when the enabled button was clicked directly, so no product save fix was needed.

GUI candidate before this documentation update: 32 files, SHA256 `d8c482acec0968f23c9d9e467ee6f80ccbd71f095b449bfe5740ef838e673d10`. New-head CI and code/security reviews must pass before release; operational v0.1.4 stays unchanged.

### Third review and final candidate verification — 2026-10-12 05:49 UTC

Head c3b88ca passed Linux/Windows CI 38206765416 and completed code/security reviews. Seven further P2 findings were reproduced by eight failing cases on the old product (`review4-red2.log`): unowned CurrentExe launch, explicitly restoring a deleted MCP entry/file, automatic UNC PATH probing, recovery skipping later profiles, startup through a data junction, shared-writable application roots, and a lost registry failure warning. Earlier fixture-only ACL/quoting setup failures are not counted as product reproductions.

Bridge launches now require an exact owned path/hash and a plain data directory. Discovery excludes network/device/relative PATH candidates before filesystem probes. Explicit re-registration can restore missing owned settings while preserving new user content; changed existing entries still conflict. Rollback attempts every stopped profile. New roots receive private ACLs before files, existing shared-writable roots are rejected, and registry errors remain visible in the committed result. The UNC regression checks the path filter without contacting an SMB server.

Final Windows/WSL integration: **36 PASS**, comprising 14 existing cases and 22 review regressions (`review4-wsl-full.log`). Actual WSL OpenCode 1.18.29 and Bridge 0.1.5 authentication passed without models/page access. The new ZIP also passed complete native-control GUI verification (`gui-review4-complete.log`): discovery/input freshness, preview/Back/cancel, occupied-port rollback/retry, WSL registration, stale profile validation, confirmed save, duplicate ID rejection, pending-validation close, masked pairing, repeat update, retained-GUI handoff and self-uninstall with data/settings preserved. Physical mouse delivery is still not claimed as passed.

Candidate ZIP before these documentation edits: 32 files, SHA256 `34ba8f9d1a702019f23b19f86a278c1bce12123aebea06b208e21c8907a097df`. The release will use the exact merged main CI package and will be downloaded and tested again. Personal v0.1.4 is preserved; company interop remains out of scope. New-head CI and code/security review are required before merge/publication.

### Fourth review — 2026-10-12 06:12 UTC

Head 6f4a270 passed Linux/Windows CI 38209480391; both exact-head reviews completed at 05:56 UTC and raised six code P2s plus one security P2. Eight new native cases failed before product changes (`review5-red.log`), and the packager version-mismatch case failed (`review5-package-red.log`). The owner/drive/path policies use isolated descriptors or enum/path inputs; no real second account or SMB share was created. The rollback case actually changed versions, canceled after Bridge startup, and reproduced the stale ownership marker blocking restoration.

Installation paths now require a local drive, trusted owner and ancestors without ordinary-account replacement permissions. The tests use a new private Documents subfolder because the Codex workspace has explicit shared sandbox write grants; no user/parent ACL was changed to make them pass. Initial long fixture paths exceeded .NET Framework's path limit and were shortened. AppContainer package/capability grants are evaluated separately from account grants because Windows intersects those principals' permissions ([Microsoft's documented dual-principal model](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)); ordinary account grants remain rejected. A read-only check of the actual default installation path failed before that refinement and passed afterward, without changing the operating installation.

Captured package bytes are verified against the manifest immediately before inclusion in a plan. WSL executable paths are validated before probes. Existing startup enabled/disabled state and its custom folder load into the GUI. A successful owned Bridge stop removes its unchanged marker, permitting version-update cancellation to restore and restart the old Bridge. The WSL packager rejects an extension version different from the release version.

Windows/WSL integration before the AppContainer-only refinement: 44 PASS (`review5-wsl-full.log`), including actual OpenCode 1.18.29 authentication with no model/page execution. Final native engine and real Form-control regressions after refinement: 40 PASS (`review5-final-native.log`, 31 review cases), with all prior cases retained. Standard-library packager regressions: 3 PASS. actionlint, Markdown links and diff checks pass. The latest GUI run before refinement passed through update; the driver then raced the deliberately exiting installed launcher. The verified hash-matching child GUI was closed normally, the driver's process-query race was fixed, and resume/update/self-uninstall passed (`gui-review5-resume.log`). This was a test-driver failure, not an application handoff failure.

Final candidate ZIP: 32 files, SHA256 `4f30b2dcec8d5bf32fda91fbcddb3293722c320b87681fd0c02317888db42d76`. Complete native-control GUI verification on this final candidate PASS (`gui-review5-final.log`): discovery, preview/cancel, startup failure/retry, WSL registration, stale validation, confirmed profile save, duplicate protection, pending-validation close, masked pairing, update, retained launcher handoff and self-uninstall. Physical mouse input remains unverified in this desktop session. Final production audit at 06:11 UTC confirms v0.1.4 PID 74680 and installation identity, pairing, profile definitions, data owner and global WSL settings unchanged. Latest-head CI and both reviews remain mandatory before publication; company interop is excluded.

### Owned process exit boundary — 2026-10-12 06:18 UTC

A final boundary of the same version-rollback fix was reproduced: when the owned Bridge had already exited before Stop, its otherwise verified marker was retained (`review5-exited-marker-red.log`). Stop now clears that unchanged verified marker for both already-exited and successfully-stopped processes. Foreign/reused PID or changed marker checks still fail without clearing their evidence. Native regression **41 PASS**, including all 32 review cases (`review5-exited-marker-green.log`). Candidate ZIP SHA256 `afcf74247718d86d4d4c72c16fabc070b49ed96adec263c688d11e86e9acc167`,32files. Latest candidate native-control GUI preview/cancel, startup failure/retry, WSL registration, update, installed-GUI handoff and self-uninstall all PASS (`gui-review6.log`). The preceding final candidate also passed the complete profile-dialog flow. No merge or release has occurred.


### Fifth review and security rerun — 2026-10-12 07:05 UTC

Remote head remains `09caec518be826c3995e0476fecf3e64e8539607`; its Linux/Windows CI 38211907836 passed. The 06:31 code review raised five P2s. The requested retry comment was posted successfully at https://github.com/jihoon22-lee/agent-browser/pull/5#issuecomment-6119150335 after a new explicit delegation requested the retry. Code review completed at 06:51 and raised five more P2s; security review completed at 07:01 and repeated the data-owner issue. The earlier 06:26 security `Failed` run exposed no explanation, so its cause is still unknown; it is not counted as a clean review.

Local fixes cover all ten distinct follow-up findings:

- Uninstall tracks missing registered settings in its preview snapshot, rejecting recreation before Apply.
- Empty managed-runtime maps no longer require launching a missing Bridge executable. Already-exited, owned PID records can be cleared without the deleted executable; live/unverified runtime records retain the installation.
- Remove ignores the disabled new-registration checkbox and selections.
- Native package verification and the shared PowerShell verifier used by the Windows builder reject extension/package version mismatch. Synthetic test package versions/hashes are internally consistent.
- Legacy PowerShell transactions record the bytes actually written, require the same hash during rollback, preserve concurrent changes, continue unrelated restorations and retain a recovery path/hash journal plus backups on conflict.
- Maintenance handoff uses `%LOCALAPPDATA%/AgentBrowser-Setup`, requiring the same trusted-owner/ancestor policy as installation roots before execution.
- The install and update guide restores ZIP SHA256 comparison against separately published SHA256SUMS or the official asset digest before extraction/execution.
- Automatic Windows executable discovery inspects components from the drive root and rejects reparse points before visiting descendants. This uses the [documented attribute behavior](https://devblogs.microsoft.com/oldnewthing/20100212-00/?p=14963): link attributes describe the link itself. No SMB server was contacted in tests.
- Private directory ACL preparation rejects foreign owners, including a pre-existing empty data child; it does not silently retain owner rights after changing the DACL.
- Windows executable and working-directory validation now precedes the version probe; relative, remote and reparse paths are rejected before execution.

The native uninstall/UI/package cases failed five times before fixes (`review6-red.log`), then all 47 native cases passed. Complete native/actual WSL integration passed 52 cases (`review6-wsl-final.log`), including real OpenCode 1.18.29 authentication with Bridge 0.1.5 and no model/page action. An earlier invocation failed only because the test driver received a relative JS path; it was rerun with an absolute path and a fresh fixture. The exact interrupted fixture was uninstalled through its verified install ID.

The four new owner/path cases each failed before fixes (`review7-red.log`); all 51 native cases then passed (`review7-green.log`). Owner checks use isolated security descriptors, the replaceable-ancestor test temporarily changes only its own fixture ACL and restores it, and discovery uses a local junction fixture. They are not a real second-user exploit or SMB authentication test. The relative Windows probe uses an isolated synthetic executable and also verifies that an explicitly selected valid absolute executable can be prepared.

GUI candidate 7 passed complete discovery, preview/Back/cancel, occupied-port rollback/retry, WSL registration, stale profile validation/save/duplicate/pending close, masked pairing, update and installed-GUI self-uninstall (`gui-review7.log`). Final candidate 8 also passed discovery, preview/cancel, failure/retry, update and self-uninstall through its exact-hash per-user maintenance cache (`gui-review8.log`). GUI tests use owned native HWND button/selection events plus UI Automation reads, not physical mouse input.

Legacy PowerShell 5.1 regressions were written for text/copy/delete rollback conflicts, continued unrelated recovery, version-mismatched packaging and actual WSL rollback. Local script execution was refused by host policy (`review6-wsl-rollback-red.log`); no policy bypass/change was used. The PowerShell 5.1 parser accepted the source, but this is syntax-only evidence. New PowerShell execution and latest-head CI remain pending. Standard-library package tests (3), CI helper tests (3), actionlint, Markdown links and diff checks passed. Rust/extension product source was not changed in these follow-ups; their prior remote-head CI pass is not presented as a latest-head CI run.

Final local candidate: 32 files, SHA256 `e19171e688ef714c4228574e72e6967c3cc8392191bf9b15487c03d5fb52b29a`; internal hashes, extension version, Windows x64 Bridge/GUI PE and absence of runtime/private artifacts passed. This is an unpublished local candidate, not a release asset.

Remote push of regression commit `c61094d` was rejected by automatic approval review because the original delegation withheld push approval and the later review request did not clearly authorize this exact repository/push. An exact repository/branch/PR/release approval question is pending; no workaround, push, merge, tag or release was performed after that rejection. The current remote findings therefore remain unresolved on GitHub until the local fixes can be pushed and reviewed. Personal operational v0.1.4 PID 74680, install identity, pairing, profiles, data owner and global WSL settings remain unchanged. The separate company WSL/active-tab/iframe work is excluded.

Final current-source Windows/WSL integration: **56 PASS** (14 existing + 42 review cases), `review7-wsl-final.log`. The valid absolute Windows profile probe also passed. Rebuilding the final candidate into a separate directory produced the identical SHA256 above. No local script-policy exception was used.

### Publication authorization restored — 2026-10-12 07:08 UTC

The parent supplied the later explicit user deployment approvals. The same previously rejected push was retried once and approved; `c61094d` and `8aa6677` are now on PR #5. The earlier blocker is resolved. Latest-head CI/code/security reviews remain required before merge and a new v0.1.5 prerelease; the operating v0.1.4 and separate WSL/iframe/active-tab work remain excluded.


### PowerShell CI execution follow-up — 2026-10-12 07:16 UTC

Current-head Linux CI passed. Windows CI 38216139555 passed the new concurrent text/copy/delete rollback regression plus normal install/update/removal and live-process checks, then exposed a real integration omission: direct COM Startup shortcut creation did not record its written hash, so occupied-port rollback retained that shortcut as a supposed concurrent edit. The existing occupied-port regression is the failing test. Setup now creates the link in its transaction stage and publishes it through Copy-TransactionFile. Owned process-marker writes also use the transaction when setup provides one, and snapshot-only calls suppress their internal journal objects from command output. GUI/native product code is unchanged; targeted PowerShell CI is the required revalidation, with no redundant manual review request.

Windows CI 38216816747 passed PowerShell install/update/rollback/uninstall, including the repaired occupied-port Startup cleanup. The next stage exposed a stale synthetic upgrade fixture: runtime-cleanup.tests.ps1 changed only the outer version to 0.2.0 while retaining extension 0.1.0. The fixture now updates the extension version/hash together. This follow-up changes tests only; it does not weaken the mixed-version rejection.

### GUI integration handoff; standalone release stopped — 2026-10-12 07:48 UTC

The user's latest instruction supersedes the earlier standalone v0.1.5 publication plan and exact-head review gates above: combine GUI, WSL, iframe, active-tab and board improvements into one release. PR #5 remains open and unmerged; no v0.1.5 tag or release was created. The integration owner is thread `01a12eae-b801-75cc-bd86-32fd1c55c031`. Do not publish this branch as a separate GUI release or restart repeated manual reviews.

CI 38217400340 at 61a116c passed both Linux and Windows, including the actual PowerShell install/update/rollback/remove and managed-runtime tests. The previous Startup rollback failure and synthetic package-version failure are resolved. Code and security reviews completed on that head; the last code review reported four P2s. Three concrete data/access issues received narrowly scoped fixes: deletion checks expected bytes while excluding Windows writers/replacers through the same handle; native rollback continues restoring independent files after a conflict and retains recovery evidence; package destination subdirectories must have trusted owners/private write permissions at preview and apply. The five new native cases all failed first (`boundary-red.log`) and then passed (`boundary-green.log`). WSL deletion uses the selected distribution/user and checks expected contents immediately before removal; it does not claim an atomic lock against arbitrary Unix writers.

The fourth finding asks to reject every local Windows path for WSL MCP registration. It is deferred for clearer path guidance: WSL can legitimately consume a Windows-mounted config via /mnt/c, so a blanket UNC-only restriction is not justified by the demonstrated evidence. This is not reported as fixed. No other feature/runtime scope was added.

The final source was compiled with the .NET Framework 4.8 C# compiler and validated with the existing native Windows/actual WSL suite. Initial WSL rerun stopped because the temporary fixture used invalid server.port=0; the fixture was corrected to a positive port and rerun in a fresh isolated directory. The published-v0.1.4 upgrade fixture prepared for the now-canceled standalone release and the interrupted WSL fixture were uninstalled through their verified identities. Operating v0.1.4 and global OpenCode settings remain untouched. Latest commit CI will run automatically after push; the integration owner should use its real result, not treat 61a116c's pass as a final-head pass. The pre-fix CI ZIP is not a final release artifact.
Final local result: **62 PASS** (15 existing/WSL cases + 47 review cases), `boundary-all-final.log`. Actual OpenCode 1.18.29 connected and an authenticated Bridge 0.1.5 reply was verified with delivered=false/executed=no; no model or page operation ran. At 07:47 UTC, the read-only production audit confirmed v0.1.4 PID 74680, identity, pairing, profiles, owner marker and global WSL configuration unchanged. No known failing installer test remains; final-head remote CI is pending handoff.
