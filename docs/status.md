# 상태

v0.2.0 이전의 작업·검증 기록은 Git 이력(`git log -p -- docs/status.md`)과 각 Release·PR 본문에 있다. 이 문서는 현재 배포, 최근 변경, 미해결 조사만 유지한다.

# 브라우저 품질 후속 — 2026-10-22, 드래그 개선·Linux 검증 완료

[PR #37](https://github.com/jihoon22-lee/agent-browser/pull/37)에 push했다. [첫 원격 CI 39776237431](https://github.com/jihoon22-lee/agent-browser/actions/runs/39776237431)은 양쪽 성공: Linux E2E **169 통과/3 제외**, 네이티브 Windows Chrome E2E **170 통과/2 제외**, 각각 5표본 품질 gate **13/13**. Windows는 Node 24.18.0·Chrome 155.0.8059.40·release exe이며 Rust·설치 수명주기·GUI 엔진·패키징 검사도 통과했다. 이 원격 실행은 로컬 WSL interop이나 설치 화면의 육안 검증을 대신하지 않는다. 리뷰 수정 후 최종 커밋의 CI·병합 상태는 PR checks와 병합 이력을 따른다.

제품 리뷰 수정 뒤 [CI 39779033152](https://github.com/jihoon22-lee/agent-browser/actions/runs/39779033152)도 양쪽 성공했다. 확장 **593 통과**, Linux E2E **171 통과/3 제외**, Windows E2E **172 통과/2 제외**, 품질 gate 양쪽 **13/13**이다. Linux 의존성 설치가 지연됐지만 실패·재실행 없이 끝났다.

추가 리뷰에서 fixture만 비교하던 해시를 전체 workload 지문으로 고쳤다. benchmark·설정·수집기·harness·runtime·MCP driver·테스트 의존성 명세·fixture 서버·사용 페이지를 해시하며, 옛 fixture-only 기록은 자동 비교를 거부한다. 실패 검사부터 수정 후 수집기 **6개**, 타입 검사, 5표본 smoke의 **13/13** 품질 검사가 통과했다. 과거 `54b04e7..e631b53` 측정 소스를 대조한 결과, 실제 호출·fixture·harness·설정·runtime은 같고 long-task 미측정값 처리만 달랐다. 아래 관측 수치는 보존하되 당시 해시가 전체 workload를 검증했다고 해석하지 않는다. 새 비교기로 기존 자료를 읽은 결과는 로컬 `comparison-pr37-legacy-guard/report.html`에 있다.

리뷰 지적 두 건도 실패 검사부터 고쳤다. 입력 후 검증은 같은 컨트롤의 연결·직접 부모·요소 식별·원래 레코드 키를 확인하되 일반 검증/가격 문구 변화는 허용한다. 입력 **전**의 전체 레코드 검사는 유지한다. iframe 입력이 최상위 문서를 교체하면 완료 조건은 도착한 frame 0에서 읽는다. iframe만 제거된 경우에는 top 문구로 성공을 대신하지 않는다. 수정 전 단위 실패 13개와 실제 브라우저 실패 2개를 확인했으며, 수정 후 전체 확장 **593개**, 관련 E2E **28개**가 통과했다.

리뷰 수정 `e631b53` 빌드를 같은 Linux 환경에서 다시 50회씩 측정했다(동시 로컬 시험 없음). 실제 상태 **13/13**, 오대상·잘못된 성공·중복 쓰기·중단 후 쓰기 모두 **0**. 5,000행 query p50/p95 **144.2/181.6ms**, snapshot **119.0/151.9ms**로 초기 기준선 대비 p50은 각각 **90.7%·47.2% 감소**했다. fill **62.0/64.4ms**, 무변화 클릭 **1,631.7/1,635.6ms**다. 아래 표는 앞선 측정 이력이고, 최신 결과는 후속 JSON의 `postReviewMetrics` 및 로컬 `comparison-pr37-final/report.html`이다.

리뷰 회귀 중 게시판을 포함한 별도 실행은 **36 통과/1 실패/1 제외**였다. 기존 B10이 `first-frame-visible`에서 90초 timeout으로 다시 재현됐다. 당시 새 탭 snapshot에는 자식 frame 두 개의 요소가 있었고, relay 완료는 3.6~54.3ms, heartbeat는 0.48~0.62ms, 연결 끊김은 0이었다. 따라서 이 실행의 멈춤 위치는 Playwright의 첫 iframe 표시 확인까지 좁혔지만 최초 원인은 아직 미확인이다. 아래 50회 무재현 실험과 구분해 보존한다.

명시 `waitFor` 조건이 있는 드래그에도 남아 있던 고정 500ms 관찰을 제거했다. 드래그 입력은 한 번만 보내고 지정 조건을 확인한다. 명시 조건 없는 일반 클릭의 기존 지연 이동 관찰은 유지한다. [후속 수치·환경·반복 기록](./reference/browser-quality-followup-2026-10-22.json), [미해결 조사 계획](./plans/browser-quality-followup.md).

| DOM 드래그 + 완료 조건 | 수정 전 p50 / p95 | 수정 후 p50 / p95 |
|---|---:|---:|
| 포인터 정렬 | 699.8 / 745.8ms | **207.1 / 248.3ms** |
| HTML5 drop | 697.1 / 739.7ms | **210.2 / 245.6ms** |

Linux Chromium 156.0.8078.4 headless·Node 24.18.0·debug Bridge에서 각 1회 예열+50회 측정했다. 매번 실제 정렬/drop 결과와 이벤트 1회 실행을 확인했다. p50은 각각 70.4%·69.8% 감소했다. 호스트 부하는 완전히 통제하지 않았고, 수정 전 측정 일부는 단위 검사와 겹쳤다. 신뢰 입력은 기능 E2E로 확인했으며 이 반복 성능 수치에 합치지 않았다.

- **검증:** 먼저 실패한 드래그 대기 회귀 검사 수정 후 확장 **54파일/575개 통과**, 집중 E2E **16개 통과**, 최종 전체 Linux E2E **169개 통과/선택 실행 3개 제외**(4.7분). 확장 빌드와 E2E 타입 검사 통과. 이번 후속에서 Rust 제품 코드는 바뀌지 않았다.
- **B10 미해결:** 기본 6회, 2 CPU 제한 12회, 25ms heartbeat·Bridge 재시작 6회, 새 탭 결과 진단 20회, Chrome 프로토콜 메타데이터 수집 6회의 완료된 게시판 반복은 **450개 통과/50개 제외**였지만 기존 멈춤을 재현하지 못했다. 초기 수집기 오류로 중단한 반복은 이 합계에서 제외했다. 실패 시 시험 단계·새 탭 snapshot 오류·frame 상태·relay 왕복을 남기도록 보강했다. timeout·재시도로 실패를 숨기지 않았다.
- **관찰 경계:** 설치본 Playwright 1.64의 첫 `expect` 조회에는 `nullProgress` 경로가 있다([상류 이슈](https://github.com/microsoft/playwright/issues/42880)). assertion의 10초 설정을 넘어 시험 90초까지 멈춘 현상을 설명할 수 있지만, 최초 renderer/관찰 정지 원인은 아직 확인하지 못했다. 의존성은 바꾸지 않았다.
- **결과:** ignored `tests/agent/results/browser-metrics/drag-{before-linux,after-linux,comparison-linux}/`에 원시 수치와 비교 HTML을 보존했다. 로컬 Windows·모델 호출은 추가 실행하지 않았다. 사용자 요청에 따라 이 변경과 앞선 품질 개선을 함께 push·PR·원격 CI·merge로 마무리한다. 원격 검증 결과는 해당 PR에도 기록한다.

---

# 브라우저 품질 측정·개선 — 2026-10-22, Linux 검증 완료

`feat/m1-browser-quality`에서 [초기 검토](./review-browser-performance-2026-10-22.md)의 결함을 실패 테스트부터 수정하고, 전후 benchmark와 실제 모델용 수집기를 구성했다. [실행·보고서 사용법](./browser-quality-metrics.md), [환경·전체 수치·검증 기록 JSON](./reference/browser-quality-2026-10-22.json).

- **정확도:** 행의 정적 텍스트·ID·링크가 바뀐 재사용 ref 거부, 접근 이름 우선순위와 ShadowRoot 레이블, aria-disabled/inert, query 뒤 행 문맥, 입력 이벤트 뒤 값/대상 재확인을 보강했다. 제거된 링크의 URL host를 ShadowRoot host로 오인한 회귀도 단위 실패 테스트와 실제 B02 재현 뒤 고쳤다.
- **완료·움직임:** click/press의 `waitFor`에 text/textGone/urlIncludes를 지정하면 조건을 관찰하고 도착 snapshot을 반환한다. default all·5초이며 최대 30초다. 입력 후 timeout/취소가 재입력으로 이어지지 않는다. `browser_wait`도 match:all을 지원한다(refGone 조합 제외). 스크롤은 smooth CSS에 영향받지 않는 즉시 이동 후 위치·경계를 반환한다. 클릭은 이미 도달 가능한 대상을 불필요하게 스크롤하지 않는다.
- **비용:** query에 맞지 않는 행을 먼저 걸러 읽고, mutation 때 추가 subtree만 스캔한다. 한 snapshot 안에서 native labels 연관을 한 번 구성해 수천 버튼의 반복 조회 비용을 줄였다. snapshot 사이의 장기 캐시나 TCP 설정 변경은 넣지 않았다.
- **수집:** 합성 benchmark는 숫자 JSON·HTML·Markdown, 실제 상태 정답·오대상·잘못된 성공·중복/중단 후 쓰기·왕복/heartbeat/복구·반환량을 기록한다. 모델 runner는 목표만 주는 평가와 호출/step/토큰/시간을 추가했다. 누락은 미측정으로 보존한다. CI에 Linux/Windows 5표본 정확도 gate와 artifact 업로드를 구성했으나 원격 CI는 실행하지 않았다.

최종 Linux: Node 24.18.0, Chromium **156.0.8078.4 headless**, DOM 입력, debug Bridge. 같은 fixture/workload, 각 1회 예열 + **50회**. 중간에 WSL 재시작이 있었고 호스트 부하는 통제하지 않았으므로 이 합성 workload의 관측 결과이며 Windows/일반 사이트 SLA가 아니다.

| 지표 | 수정 전 | 수정 후 |
|---|---:|---:|
| 5,000행 일치 없는 query p50 / p95 | 1,555.3 / 3,694.1ms | **121.3 / 150.4ms** |
| 5,000행 snapshot p50 / p95 | 225.4 / 293.7ms | **110.8 / 155.7ms** |
| 1,000행 query p50 / p95 | 188.7 / 225.7ms | 68.6 / 90.9ms |
| fill p50 / p95 | 53.0 / 67.6ms | 62.7 / 64.0ms |
| 변화 없는 click p50 / p95 | 1,642.4 / 1,663.4ms | 1,632.5 / 1,638.3ms |
| DOM 변경 click p50 / p95 | 724.1 / 768.3ms | 702.7 / 728.6ms |
| 실제 상태 검사(각 1회, 총 13개) | 5/13 | **13/13** |
| 오대상 / 잘못된 성공 | 2 / 5 | **0 / 0** |
| 중복 쓰기 / 중단 후 쓰기 | 0 / 0 | **0 / 0** |

5,000행 query p50은 92.2%, snapshot은 50.8% 감소했다. fill은 실제 값 재확인 비용이 더해져 중앙값이 9.7ms 늘었다. 명시 조건 없는 무변화 클릭의 기존 관찰 대기 약 1.6초는 개선되지 않았다. 13개 정답은 결함 회귀 검사 수이며 모델 성공률 표본은 아니다. 최종 510개 측정 호출 동안 의도적 worker 종료 전 연결 끊김은 0, heartbeat p50/p95 0.5/0.6ms(8회), 강제 worker 종료 후 복구는 257.9ms(1회)였다.

- **검증:** 확장 **54파일/574개**, Rust **225개 통과 + Windows 실행용 helper 1개 ignored**, 합성 Node **36개**, 최종 기본 Linux E2E **167개 통과/3개 선택 실행 제외**. 새 품질·게시판 집중 E2E **14개 통과/1개 제외**. 확장·Linux Bridge 빌드, MSVC release cross-build, E2E 타입, actionlint·shell 구문 통과. clippy 종료 0(기존 경고 줄 23개). 측정·모델 수집기 통계/누락/격리/대체 경로 회귀도 통과했다.
- **실패 이력:** 첫 전체 E2E는 B02만 실패(166 통과/3 제외)했고 위 detached link 수정 뒤 전체 통과했다. 별도 게시판 3회 반복 도중에는 B02 재현 2회와 기존 B10 90초 timeout 1회가 나왔다. B02 원인 확인 후 반복을 중단했으며 중단된 B06과 미실행 13개를 통과로 세지 않았다. B10은 최종 전체 실행에서는 통과했지만 아래 미해결 항목을 유지한다.
- **Windows:** 수정 전 기준선만 실제 Windows Node 24.18.1 + Chrome **155.0.8059.85** + release exe로 50표본 수집했다(동일 결함 5/13, query 5,000행 p50/p95 1,109.7/1,327.1ms). 수정 후에는 WSL interop `accept4 failed 110`/Windows 프로세스 무응답이 재발했다. 사용자가 **이번에는 Linux 결과까지**로 범위를 정했으므로 수정 후 Windows 실행·GUI 검증은 하지 않았다. cross-build 성공을 실제 Windows 통과로 취급하지 않는다.
- **실제 모델:** OpenCode **1.19.3**, 공식 무료 가격·가용성·격리 preflight 확인 후 `opencode/big-pickle` 목표 평가를 1회 시도했다. Zen **HTTP 403 FreeTierError**로 도구 호출 전에 중단됐다(CLI 4,720.8ms, 도구 0, step/usage 미측정). 모델 성공률·토큰 절감은 측정하지 못했다. 유료 fallback·전역 설정 변경 없음.
- **로컬 결과:** ignored `tests/agent/results/browser-metrics/{before-linux,before-windows,after-linux-verified,comparison-linux-verified}/`, 모델 `tests/agent/results/2026-10-22T10-52-59-479Z-305025/`. 원시 수치와 HTML은 로컬에 보존하고 위 JSON에는 합성 수치만 커밋한다. 기존 사용자 설치·Chrome 프로필은 건드리지 않았다. 로컬 과제별 커밋만 만들었으며 push/PR/Release는 하지 않았다.

---

# v0.2.1 Windows preview — 게시 완료 (2026-10-22)

[v0.2.1](https://github.com/jihoon22-lee/agent-browser/releases/tag/v0.2.1)(prerelease)을 **2026-10-22 00:13:00 UTC / 09:13:00 KST**에 게시했다. 주석 태그 `v0.2.1` → main `786fee5316464569d10c5b4cc5b571231cb70873`([PR #35](https://github.com/jihoon22-lee/agent-browser/pull/35) 병합 커밋). v0.2.0 뒤의 변경은 serve.pid 시작 경합 수정 하나다.

- **배포 ZIP:** 3,846,920 bytes / 37 files, SHA256 **`aaab927825e3cc98d347e41ff4d4f21a98ad5e6b71b97da76205425b467cb3c5`**(GitHub asset digest 일치), `SHA256SUMS` 별도 자산.
- **빌드 경로(이번만 다름):** WSL interop이 `UtilAcceptVsock accept4 failed 110`으로 2시간 넘게 멈춰 `build-release-wsl.sh`(Windows에서 `--version` 확인 필요)를 실행하지 못했다. WSL 재시작은 할 수 없었다. 대신 태그 커밋의 [main CI 39693158602](https://github.com/jihoon22-lee/agent-browser/actions/runs/39693158602) Windows 작업이 `build-release.ps1`로 만든 artifact `windows-x64-package-786fee5…`를 게시했다. 그 작업이 Windows에서 `--version`을 확인했다. 받은 ZIP의 package-manifest 해시 36개가 모두 일치했고, 스크립트·문서 15개는 `786fee5`와 바이트 단위로 같았다.
- **CI(같은 Windows 작업, 이 exe·ZIP):** PowerShell 5.1 설치 수명주기 14개 + 프로세스 검사, 런타임 정리 4개, 패키징·보안·진단·JSONC, GUI 엔진 설치·업데이트·롤백·제거와 설치 마법사 회귀, Windows Chrome E2E 163개 통과. Linux 작업도 성공.
- **게시본 재다운로드:** `sha256sum -c` 통과, CI artifact와 ZIP·SHA256SUMS 바이트 일치.
- **실행하지 않음:** 로컬 실제 Windows 검사(설치 테스트, 게시된 v0.2.0 → 0.2.1 격리 업데이트). interop 장애 때문이다.
- **정리:** 완료된 계획 문서(`docs/plans/`)를 지우고 이 문서를 현재 상태만 남기도록 줄였다(PR #35).

---

# serve.pid 시작 경합 수정 — 2026-10-22 KST

PR #30 리뷰 지적([discussion](https://github.com/jihoon22-lee/agent-browser/pull/30#discussion_r4306856384))을 [PR #34](https://github.com/jihoon22-lee/agent-browser/pull/34)로 고쳐 main에 병합했다(`599a9f8`).

- **결함:** Bridge가 꺼진 상태에서 같은 home·포트로 `start`·`mcp`가 겹치면, 두 serve가 모두 bind 전에 `serve.pid`를 쓰고 진 쪽이 `AlreadyRunning` 뒤 파일을 무조건 지웠다. `start`가 `pid: null`이나 곧 종료될 PID를 보고해 `Start-OwnedBridge`(`scripts/installer-common.ps1:526-531`)가 실패했고, 마커가 남지 않아 Bridge를 직접 끌 때까지 같은 실패가 반복됐다.
- **수정:** 포트를 bind한 serve만, accept 전에 PID를 쓴다(`server::start_publishing_pid`). 인증을 마친 클라이언트는 항상 승자의 PID를 읽으므로 v0.2.0에서 고친 "pid 파일 없음" 경합도 다시 생기지 않는다. 정상 종료 때는 포트를 놓기 전에, 자기 PID일 때만 지운다. 리뷰가 제안한 "자기 PID일 때만 삭제"만으로는 진 쪽이 나중에 덮어쓴 경우를 막지 못한다. 쓰는 프로세스가 하나뿐이고 읽는 쪽은 기록 뒤에야 인증되므로 임시 파일+rename은 넣지 않았다.
- **Linux:** 실패 테스트 2개(`losing_serve_keeps_the_running_servers_pid_file`, `graceful_exit_removes_only_its_own_pid_file`)가 수정 전 실패·수정 후 통과. 회귀 방지 `serve_publishes_its_pid_before_answering_clients` 추가. `serve_port_conflict` 5회 반복 통과, Bridge Rust 전체 **223 통과**, clippy 경고 수 main과 동일(23).
- **Windows:** 로컬 WSL interop이 `UtilAcceptVsock accept4 failed 110`으로 멈춰 로컬 실제 Windows 실행은 하지 못했다. [PR #34 CI](https://github.com/jihoon22-lee/agent-browser/actions/runs/39687166655) Windows 작업에서 `serve_port_conflict` **4개 통과**(graceful exit 테스트는 Unix 전용). 같은 작업에서 이 exe로 PowerShell 설치 수명주기·런타임 정리·패키징·GUI 엔진 회귀와 Windows Chrome E2E도 통과했다.

---

# B10 간헐 시간 초과 조사 — 2026-10-18 KST, 미해결

`board-navigation.spec.ts:160` B10(앞서 검사한 iframe이 나중 close 검사 중 수정됨)이 Linux E2E에서 90초 시간 초과로 멈추는 간헐 실패를 조사했다. 원인은 확정하지 못했고 코드는 바꾸지 않았다.

- **발생 기록:** 계획 4 검증(2026-10-17) 때 1회, v0.2.0 태그 대상 [main CI 39124432525](https://github.com/jihoon22-lee/agent-browser/actions/runs/39124432525) 1차 시도에서 1회. 계획 4 이전에는 기록이 없다.
- **재현:** `taskset -c 0,1 pnpm --filter agent-browser-e2e exec playwright test board-navigation.spec.ts --repeat-each N --workers 1`로 spec 전체를 반복하면 재현된다. 계측 없음 1/8, 단계 로그만 넣었을 때 1/10(B10 기준). B10 단독 실행에서는 재현하지 못했다.
- **멈춘 위치:** 단계 로그상 `browser_tabs new`는 정상 반환했고, 이어지는 iframe 입력칸 `toBeVisible()` 두 줄에서 멈췄다. expect 제한은 10초인데 테스트는 90초 동안 멈췄다. 이 모순은 풀지 못했다. 테스트 코드보다 아래 단계(브라우저·CDP)에서 걸렸을 가능성이 있다.
- **실패 화면:** CI artifact의 확장 설정 화면이 "Bridge 연결을 다시 시도하는 중…"이었다. 실패 순간 확장과 Bridge 연결이 끊겨 있었던 것으로 보인다. 정상 실행 때의 같은 화면과는 비교하지 못했다.
- **가설(미확인):** spec의 `beforeAll`이 반복마다 새 world를 띄우므로 B10은 항상 그 world의 마지막 테스트다. 시작 시점이 연결 약 15~20초 뒤라서, 확장의 첫 heartbeat(연결 20초 뒤 전송, 응답 10초 제한, 없으면 소켓 종료 — `extension/src/background/bridge-connection.ts`)와 겹친다. Bridge `serve_extension`(`bridge/src/server/conn.rs`)은 확장의 일반 요청을 수신 루프 안에서 직접 기다리므로, 그동안 heartbeat 응답이 늦어질 수 있는 구조다.
- **배제:** 신뢰 입력 debugger는 이 spec에서 꺼져 있어 탭에 붙지 않는다.
- **중단 이유:** 30·60초 상태 덤프(페이지·frame, 서비스 워커 evaluate, 연결 상태, `status.get`, Bridge 출력)와 trace 보존을 넣은 뒤로는 B10이 80회 연속 통과했다. 계측이 타이밍을 바꿔 경합을 숨기는 것으로 보인다.
- **다음에 할 일:** heartbeat 간격을 테스트에서 조정해 B10과 일부러 겹치게 만들고 멈춤이 재현되는지 확인한다. 재현되면 그 테스트를 실패 테스트로 삼아 고친다. 원인 확인 전에 B10에 시간 제한·재시도를 넣지 않는다.

---

# v0.2.0 Windows preview — 게시 완료 (2026-10-18)

[v0.2.0](https://github.com/jihoon22-lee/agent-browser/releases/tag/v0.2.0)(prerelease)을 **2026-10-18 12:03:06 UTC / 21:03:06 KST**에 게시했다. 주석 태그 `v0.2.0` → main `1b1dc7b23f2b83c5b4807b0eaa3e17df41f0fe6e`(PR #30 병합 커밋).

- **배포 ZIP:** 3,795,462 bytes / 37 files, SHA256 **`b297dd328a775ad082674b3e60221f1947926ffafe28f211dd5f4154fab4aa5d`**(GitHub asset digest 일치), `SHA256SUMS` 별도 자산. 정확히 태그 커밋의 main에서 `build-release-wsl.sh`로 만들었다. Linux `package_release_test.py` 통과.
- **최종 ZIP 실제 Windows:** `--version` = `browser-bridge 0.2.0`. `install.tests.ps1` **14/14 + 프로세스 검사**, `runtime-cleanup.tests.ps1` **4 PASS**, 게시된 v0.1.11 → 0.2.0 격리 업데이트·제거 **3 PASS**(아래 후보 검사와 같은 드라이버). 패키징·보안·진단·JSONC 검사는 후보 ZIP 결과이며, 최종 ZIP과 스크립트·문서는 같고 Bridge exe만 pid 수정으로 다르다.
- **CI:** [PR #30 CI 39123610916](https://github.com/jihoon22-lee/agent-browser/actions/runs/39123610916) Linux·Windows 성공. [태그 대상 main CI 39124432525](https://github.com/jihoon22-lee/agent-browser/actions/runs/39124432525)는 1차에서 Linux E2E B10(`board-navigation.spec.ts:160`)이 90초 시간 초과로 실패했다. 이 테스트는 이전에도 같은 방식으로 한 번 실패했다. 로그에 close 결과 줄이 없어, 자체 시간 제한이 없는 대기(서비스 워커 evaluate·MCP 호출·스냅샷) 중 하나에서 멈춘 것으로 보인다. 로컬 3회 반복은 모두 0.6초 안에 통과했다. 실패 작업 재실행(2차)에서 Linux·Windows 모두 성공했다. 원인은 조사하지 않은 채 남아 있다.
- **게시본 재다운로드:** `sha256sum -c` 통과, 검증본(`release/v0.2.0-main`)과 ZIP·SHA256SUMS 바이트 일치. 다운로드본으로 설치를 다시 실행하지는 않았다.
- **미검증:** 설치 GUI 화면·배율 육안 확인, 실제 Chrome에서 0.2.0 확장 로드 후 사용자 흐름, 실제 모델 수행 품질. 운영 설치·사용자 Chrome 프로필·전역 OpenCode 설정은 건드리지 않았다.

---

## 실측 환경 (2026-10-11 기준, 이후 WSL OpenCode 1.19.3도 확인)

| 항목 | 값 |
|---|---|
| WSL | Ubuntu 26.04.1 LTS, kernel 6.18.33.2-microsoft-standard-WSL2, NAT 네트워킹. WSL PATH에 Windows 경로 없음 → `/mnt/c/...` 절대 경로 |
| Windows | Windows 11 `10.0.26200.9457` AMD64, PowerShell 5.1(pwsh 없음), node·git 있음, Rust 없음 |
| Chrome | 154.0.8037.99 |
| OpenCode | WSL `~/.opencode/bin/opencode` 1.18.29. Windows 검증용 portable 1.18.29는 `AgentBrowser-dev/opencode/1.18.29` |
| WSL 툴체인 | node 24.18.0, pnpm 9.15.9, rustc 1.98.1/1.97.1, cargo-xwin, target `x86_64-pc-windows-msvc` |

## 알려진 제한

- 인증: Extension·MCP는 토큰을 전송하지 않는 HMAC-SHA256 상호 인증을 쓴다. 구형 인증 클라이언트와 호환되지 않으므로 Bridge와 Extension을 함께 갱신한다.
- 지원하지 않는 대상: Chrome 내부 페이지, OS 대화상자, 닫힌 Shadow DOM, canvas 내부, 백그라운드 전체 페이지 캡처.
- 고치지 않고 남긴 작은 결함(계획 6 판단): 늦은 이동 감시 중 Bridge 연결이 끊긴 클릭의 결과 재조회, 신뢰 클릭 좌표의 왕복 뒤 재확인, 긴 같은 이름 첨부의 지시문 표시, 탐색 재표시의 드문 경합.
- Clippy의 기존 스타일/복잡도 경고가 남아 있다(23개).

## 참고 사항

- 전역 `~/.cargo/config.toml`의 `build.target-dir`이 다른 프로젝트 캐시를 가리킨다. 이 저장소는 `.cargo/config.toml`로 `target/`을 쓴다.
- 전역 OpenCode 설정에는 기존 MCP(playwright 등)가 있다. 수정하지 않고 테스트는 별도 설정으로 격리한다.
- 실제 사용자 설치의 Bridge는 사용을 위해 실행 상태로 유지한다. 검증용 프로세스는 테스트가 끝나면 종료한다.
