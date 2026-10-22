# 상태

v0.2.0 이전의 작업·검증 기록은 Git 이력(`git log -p -- docs/status.md`)과 각 Release·PR 본문에 있다. 이 문서는 현재 배포, 최근 변경, 미해결 조사만 유지한다.

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
