# 테스트와 실행 증거

요구사항 원장은 [handoff.md](./handoff.md) §17, 최신 실행 결과는 [status.md](./status.md)다.
Linux 테스트 통과, Windows용 빌드 성공, 실제 Windows 프로세스 실행, 실제 에이전트 판단 성공은 서로 다른 검증이다.

## 계층과 실행

```bash
cargo test --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-extension test
node --test tests/fixtures/*.test.mjs tests/agent/*.test.mjs tests/e2e/runtime.test.ts tests/e2e/interop-check.test.mjs
pnpm --filter agent-browser-extension build
cargo build --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-e2e exec playwright test
```

최초 개발 환경에서만 고정된 테스트 의존성의 Chromium을 설치한다:

```bash
pnpm install --frozen-lockfile
pnpm --filter agent-browser-e2e exec playwright install chromium
```

- Rust: RPC 계약, 설정, 인증, 작업 게이트, 실제 localhost WebSocket, 실제 MCP stdio 자식 프로세스.
- Extension/Vitest: DOM·제어 입력·참조·취소·Shadow DOM, 가짜 Chrome API 경계의 SW 라우팅,
  session 저장소 중복 방지, 연결 수명, HMAC 공유 벡터, 패널 reducer/React 통합.
- E2E: 실제 Linux Bridge + 실제 확장 + Playwright Chromium + 직접 작성한 fixture 사이트.
  Linux Bridge와 Playwright는 **테스트 의존성**이며 Windows 제품 배포물이나 사용자의 브라우저 제어 하네스가 아니다.
- Windows/에이전트: 실제 Windows exe·Chrome·WSL interop·OpenCode Zen 검증은 별도 결과로 기록한다.

## Windows PowerShell 5.1 배포 진입점 회귀

`tests/install/package.tests.ps1`은 실제 `build-release.ps1` ZIP을 만들고 한글·공백 경로에 추출한다. Windows 시스템의 `WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -File`을 자식 프로세스로 실행해 `PackageDir` 생략/명시 모두 검사한다. 별도 InstallDir·StartupDir·빈 포트를 사용하며 인증된 Bridge health, 재설치 InstallId/PID 유지, 설치된 `uninstall.ps1`의 InstallDir 생략/명시와 소유 프로세스·데이터·Startup 제거를 확인한다.

직접 `& setup.ps1` 호출만으로 이 회귀를 대체하지 않는다. PowerShell 5.1의 advanced-script 매개변수 기본값은 `-File`에서 `$PSScriptRoot`가 비는 경우가 있으므로 기본 경로 초기화는 본문에서 수행한다. 실행 정책 옵션은 테스트 자식 프로세스에만 적용하며 전역 정책은 변경하지 않는다. Windows CI의 기존 package 단계에서도 이 검사가 실행된다.

## 결정적 시나리오 대응

| E2E | handoff §17-A | 검증 |
|---|---|---|
| S01 | 1 | 목록, 지정 탭 attach |
| S02 | 2 | fill/Enter 검색, fixture 검색 body |
| S03 | 3 | 입력·select·checkbox, 앱 상태와 추출 결과 |
| S04 | 4 | 새 탭, 작업 탭 전환, 원래 탭 복귀 |
| S05 | 5 | SPA 교체 후 옛 ref가 STALE_ELEMENT |
| S06 | 6 | 비동기 출현과 TIMEOUT |
| S07 | 7 | 동일/교차 출처/sandbox 프레임, open/closed Shadow DOM |
| S08 | 8 | 표의 정확한 행·열·문자열 |
| S09 | 9 | 사용자가 활성 탭을 바꿔도 작업 대상 고정 |
| S10 | 10 | 다른 탭 스크린샷 거부, 활성 작업 탭 PNG |
| S11 | 11 | 대기 중 중단, 이후 명령 차단 |
| S12 | 12 | Bridge 재시작, 실제 SW 종료/재시작과 복구 |
| S13 | 13 | 제출 응답 유실, SW 재시작, 동일 ID 재전송에도 제출 1회 |
| S14 | 14 | 두 MCP 클라이언트의 BROWSER_BUSY |
| S15 | 15 | 패널을 열었다 닫아도 조작 유지 |
| S16 | 추가 | MCP stdout은 JSON-RPC만 |
| S17 | 추가 | 제한 페이지 거부 |
| R18 | 추가 회귀 | 취소 → Bridge 재시작 → 새 작업 허용 |
| R19 | 추가 회귀 | 다른 탭/이동한 문서에서 옛 ref 거부 |
| R20 | 추가 회귀 | 현재 탭 종료 후 다른 탭으로 전환/작업 해제 |
| R21 | 검토 회귀 | 새 작업의 snapshot 이전 쓰기와 옛 작업 ref 거부 |
| R22 | 검토 회귀 | Enter/Backspace/Space의 실제 상태 변화, radio 해제 거부 |
| R23 | 검토 회귀 | 150개 이후 요소 cursor, 두 번째 일반 표, rowspan 열 정렬 |
| R24 | 검토 회귀 | 큰 값·표 응답 제한과 다음 행 읽기 |
| R25 | 검토 회귀 | 동일 토큰으로 재페어링 |
| R26 | 검토 회귀 | 실제 SW를 쓰기 진행 중 종료, in-flight 표식으로 중복 실행 거부 |

## 브라우저에서 확인한 사항

- Linux: Playwright `1.64.0`, Chromium `156.0.8078.4` (revision 1248).
- S07: 이번 Chromium에서는 `sandbox=""` srcdoc 프레임에도 확장 주입이 가능했다.
  이를 `injected`로 고정해 검사한다. 다른 버전/정책에서의 동일 동작을 주장하지 않는다.
- SW 종료는 CDP `ServiceWorker.stopAllWorkers`의 `runningStatus: stopped`와 새
  `performance.timeOrigin`, 재인증/실제 snapshot 왕복으로 확인한다. Playwright의 worker.close만으로
  판단하지 않는다(이번 Chromium은 같은 target ID를 재사용했다).
- S13은 테스트 전용 WebSocket relay로 **브라우저 명령 응답**을 보류하고 fixture에 제출이 기록된 후
  Bridge 연결을 끊는다. 사이트 HTTP 응답의 2초 지연과 Bridge 응답 시점을 혼동하지 않는다.
- 모든 fixture/profile/config는 테스트가 만든 임시 위치를 사용한다. 종료 시 테스트가 소유한
  자식 프로세스만 정리하며 사용자의 브라우저나 OpenCode 설정을 건드리지 않는다.
- HTML fixture·인증 벡터는 합성 데이터다. 실행 토큰·사용자 페이지·실제 대화는 저장소에 추가하지 않는다.

## 현재 구현의 한계

DOM 이벤트는 trusted 사용자 입력과 동일하지 않다. OS 대화상자, 닫힌 Shadow DOM, canvas 내부 조작,
전체 페이지·백그라운드 캡처는 지원을 주장하지 않는다. snapshot 본문은 문자 수 제한이며 토큰 수가 아니다.
완료 요청 캐시는 10분/최근 200개이며 in-flight tombstone은 브라우저 세션 동안 보존한다.
프로세스 재시작을 가로지르는 무제한 exactly-once 보장은 아니다.

## 검토 후 읽기/조작 계약

- 새 operation의 쓰기는 그 operation으로 현재 문서의 snapshot을 먼저 읽어야 한다.
- snapshot의 `offset`은 본문 문자, `elementOffset`은 요소, `frameOffset`은 프레임 cursor다.
  각 frame의 `elementsNextOffset`과 최상위 `framesNextOffset`으로 남은 부분을 읽는다.
- 단일 frame JSON은 32768자, 여러 frame 합계는 약 60000자 예산으로 제한한다. 긴 필드 잘림은 limits에 표시한다.
- `extract(kind=table)`의 `offset`은 header를 제외한 데이터 행 번호다. `nextOffset`, `truncated`, limits를 확인한다.
  너무 큰 단일 셀/열은 명시적으로 잘리고, 과도한 확장 grid는 구조화된 오류로 거부한다.
- press는 synthetic 키이며 native 기본 동작을 구현한 경우 `defaultApplied`로 알린다.
  지원하지 않는 기본 동작은 event-only 표시 또는 명시적 오류다. 체크된 radio의 false 설정은 실행 전 거부한다.

## Windows 검증 실행

```bash
bash scripts/test-windows.sh -- --grep 'S01 '
bash scripts/test-windows.sh
```

스크립트는 이미 설치된 고정 테스트 패키지를 Windows 사용자 영역의 AgentBrowser-dev/testing에 복사한다.
Windows Node가 실제 설치된 Google Chrome과 MSVC exe를 실행하며, Linux 프로세스를 Windows 증거로 기록하지 않는다.
테스트용 확장 로드는 Chrome의 [공식 Extensions.loadUnpacked](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/)를 사용한다.
개발용 debugging pipe/확장 디버깅 플래그는 테스트 프로필에만 적용되며 제품 권한/통신 구조에 추가되지 않는다.
정책이 거부하면 실패로 기록하며 정책을 변경하지 않는다. 사용자 기존 Chrome 프로필/프로세스를 종료하지 않는다.
2026-10-11 Windows Node 24.18.1 + 설치된 Chrome 154.0.8037.99 + 최종 MSVC release로 32/32 통과했다.
시험별 최신 실행 결과는 status.md에 기록한다.

## 실제 OpenCode 검증

[run-agent.mjs](../tests/agent/run-agent.mjs)는 실행마다 설정·HOME 대체 경로·XDG 디렉터리를 격리하고,
Zen의 명시적 무료 가격·현재 가용성·설치본 cost/toolcall metadata를 확인한 뒤 호출한다.
모델 ID는 실행 인자로만 받는다. 소스 코드에 테스트 모델을 고정하지 않는다.

```bash
bash tests/agent/run-agent.sh opencode/<verified-free-model> 5 \
  --exe /mnt/c/<dev-directory>/browser-bridge.exe \
  --bridge-home 'C:\<isolated-demo-home>' --bridge-port <demo-port> \
  --fixture-url http://127.0.0.1:<fixture-port> --tab-id <fixture-tab-id>
```

실제 연결된 격리 demo가 먼저 필요하다. `windows-run.ts --demo`는 `AB_DEMO_INFO`에
`bridgeHome`, `bridgePort`, `fixtureBase`, `tabId`, `stopFile`을 저장한다(토큰 제외).
`stopFile`을 생성하면 해당 demo가 만든 Chrome·Bridge·MCP만 정리한다.
Windows 네이티브 실행은 같은 runner를 **Windows node.exe**로 실행하고 `--opencode`, `--exe`,
`--bridge-home`을 모두 Windows 경로로 전달한다. WSL Node에서 opencode.exe만 바꿔 실행한 결과로 대체하지 않는다.

원시 합성 실행 기록은 ignored `tests/agent/results/`에만 저장한다.
MCP preflight, 실제 도구 결과, fixture 검색 body·표·복귀·요약을 각각 채점한다.
공급자 오류·비무료 비용·확인할 수 없는 가격에서 반복 실행을 중단하고 유료 fallback을 하지 않는다.
2026-10-11의 WSL/Windows 파일럿은 Zen HTTP 403으로 실제 도구 호출 전에 종료됐다(통과로 기록하지 않는다).
이후 사용자가 개인 PC의 WSL OpenCode로 실제 동작을 확인했으며, 실제 모델 반복 시연은 남은 검증 항목으로 두지 않는다.

네이티브 API만 검증할 때는 LLM 없이 다음 스크립트를 Windows Node로 실행한다:

```text
node tests/agent/check-native.mjs --exe C:\<dev-directory>\opencode.exe
```

고유 임시 설정·포트를 사용해 버전, `/global/health`, `/doc`의 경로와 HTTP 메서드 집합을 비교하고
시작한 서버를 종료한다. `/api/*`는 명세에서 비교만 하며 호출하지 않는다.

## WSL interop와 Windows 프로세스 수명

```bash
node tests/e2e/interop-check.mjs --exe /mnt/c/<dev-directory>/browser-bridge.exe
```

WSL에서 일반 경로와 공백·한글 경로의 Windows exe 사본을 실행한다. 각 사본은
`%LOCALAPPDATA%` 아래 고유 home/포트를 사용한다. MCP 초기화·11개 도구·JSON-RPC stdout,
자동 serve 시작, MCP stdin 종료 후 **native PID 소멸과 WSL relay 종료**, serve 생존,
중복 serve 거부와 config 상속 ACL을 확인한다. 소유한 경로·PID 생성 시각·역할/포트를 검증한 뒤에만 정리한다.

Windows detached 시작은 `CreateProcessW(bInheritHandles=FALSE)`로 WSL 채널 상속을 막는다.
이 PC에서는 `windows-breakaway`로 성공했다. breakaway가 거부될 때의 fallback은 아직 실측하지 않았다.


## M2–M4 추가 검증

`workbench.spec.ts` W01–W06은 모델을 부르지 않는 합성 v1 HTTP/SSE 서버와 실제 확장을 연결한다.
프로필·세션·스트리밍·서버 모델 필터, typed 첨부/IME, 질문·권한 복원, SSE 재연결/세션 격리,
현재 탭 관찰·커맨드 경로, 내보내기·분기·revert를 검사한다. 실제 설치된 OpenCode 계약은 별도 검사한다.

```bash
node --experimental-transform-types tests/integration/opencode-v1-api.mjs
'/mnt/c/Program Files/nodejs/node.exe' --experimental-transform-types \
  '\\wsl.localhost\Ubuntu\home\jihoon\projects\agent-browser\tests\integration\opencode-v1-api.mjs' \
  --opencode 'C:\Users\USER\AppData\Local\AgentBrowser-dev\opencode\1.18.29\opencode.exe'
```

Bridge 런타임은 `bridge/tests/windows-runtime.mjs`를 **Windows Node**로 실행한다.
파일 상단에 명시된 exe/WSL 경로 환경변수와 RUNTIME_KIND(native/cmd/wsl)를 사용한다.
서버와 설정을 격리하고 ensure 동시성·Bridge 재시작 복구·인증·overlay 보존·소유 프로세스 종료를 검사한다.
attach는 fixture wrapper의 argv/env 및 실제 backend 인증까지 검사하며 대화형 TUI/모델 실행은 하지 않는다.

설치 검증은 Windows PowerShell 5.1에서 수행한다. 각 테스트는 고유 임시 설치/Startup/설정 위치를 사용한다.

```powershell
.\tests\install\jsonc.tests.ps1
.\tests\install\install.tests.ps1 -BridgeExe <built-windows-exe> -WslDistribution Ubuntu
.\tests\install\runtime-cleanup.tests.ps1 -BridgeExe <built-windows-exe>
.\tests\install\package.tests.ps1 -BridgeExe <built-windows-exe>
```

패키징은 `bash scripts/build-release-wsl.sh` 또는 Windows의 `scripts/build-release.ps1`로 수행한다.
출력은 ignored `release/`에 있고 배포 zip/manifest/SHA256/제3자 고지를 검사한다.
실행 시 개발 도구·패키지 다운로드를 요구하지 않는다. 수동 Chrome 확장 로딩은 사용자 최초 1회 절차다.


## 실제 OpenCode 생성 → SSE → 제품 상태 검증

`tests/integration/opencode-v1-stream.mjs`는 설치된 **OpenCode 1.18.29**를 고유 임시 설정·작업 디렉터리·포트로 실행한다. 로컬 OpenAI 호환 provider fixture가 300ms 간격의 텍스트 chunk 3개, finish와 `[DONE]`을 반환한다. 외부 모델과 인증정보를 쓰지 않으며 설정상 허용 provider·모델은 fixture 하나다. 원래 사용자 서버·세션·전역 설정은 읽거나 수정하지 않는다.

```bash
node --experimental-transform-types tests/integration/opencode-v1-stream.mjs \
  --opencode /home/<user>/.opencode/bin/opencode
```

Windows에서는 Windows Node로 같은 파일을 실행한다.

```powershell
node --experimental-transform-types .\tests\integration\opencode-v1-stream.mjs `
  --opencode 'C:\<existing-opencode>\opencode.exe'
```

실제 서버의 SSE 원문에서 이벤트 **메타데이터**를 별도로 기록하고, 같은 스트림을 제품 `OpenCodeV1Client`와 `workbenchReducer`에 전달한다. 다음을 assert한다.

- 합성 provider 요청 정확히 **1회**, 실제 LLM 호출 **0회**.
- Stop·abort 요청과 수동 상태 재조회 없이 SSE만으로 완전한 assistant 텍스트와 완료 상태가 구성됨.
- 첫 텍스트가 provider의 최종 응답 종료 전에 보임.
- 서버에 저장된 assistant 수와 reducer의 assistant 수가 같음. 검증용 마지막 GET은 reducer에 넣지 않음.

2026-10-11 수정 후 검증은 WSL/Linux(Node 24.18.0)와 실제 Windows(Node 24.18.1) 모두 통과했다. 최종 측정에서 요청 이후 첫 텍스트/완료는 Linux **1246/2144ms**, Windows **1525/2749ms**였으며, 두 환경 모두 assistant **1개**로 서버와 일치했다. 최초 진단은 `session.updated`를 잘못 message로 해석해 빈 assistant가 추가되는 결함을 드러냈고, 허용된 message 이벤트만 처리하는 회귀 검사로 보강했다.

출력 `tests/agent/results/stream-*/summary.json`은 플랫폼·이벤트 유형/ID·길이·개수·HTTP 상태와 시각만 담는다. 비밀번호·환경변수·대화 본문·provider 요청 본문·서버 stderr 원문은 쓰지 않는다. 초기 준비, HTTP 응답, SSE 표시 시각을 분리한다. Linux 측정의 약 62초 초기 health 대기는 프롬프트 이전이므로 응답 렌더링 지연과 합산하지 않는다.

이 검사는 실제 설치된 서버의 생성/SSE 계약을 검증하지만 Chrome DOM이나 React hook 전체를 실행하지 않는다. 사용자가 보고한 “Stop을 눌러야 응답이 보임” 현상의 원인을 확정하거나 해당 사용자 환경이 수정되었음을 증명하지 않는다. 실제 모델의 판단·도구 사용·속도 검증도 아니다. CI는 이 실제 OpenCode 실행을 자동 호출하지 않는다.

## GitHub Actions CI

[CI workflow](../.github/workflows/ci.yml)는 main 대상 PR과 main push에서 Linux/Windows를 따로 실행한다.
Linux는 전체 Rust·Extension·합성 Node·Chromium E2E, 문서 링크와 workflow 구문을 검사한다.
Windows는 네이티브 MSVC 빌드·실행, 설치된 Chrome의 합성 E2E, PowerShell 5.1 설치·정리·패키징을 검사한다.
호스팅 runner에 WSL이나 실제 OpenCode를 설치해 모델을 호출하지 않는다. 그 항목은 앞의 별도 실제 환경 검증과 구분한다.

Actions는 커밋 SHA, 도구는 명시한 버전, 의존성은 lockfile로 고정한다. Chrome 버전은 runner 제공값을 매 실행 기록한다.
clippy의 기존 스타일/복잡도 경고는 숨기지 않으며 현재 CI는 경고를 오류로 바꾸지 않는다.
문서 링크 검사는 로컬 파일 존재를 검사하며 원격 URL 응답과 heading anchor까지 검증한 것으로 주장하지 않는다.

CI 패키지 artifact는 설치할 수 있는 검토 산출물이지만 Release 게시가 아니다. artifact에는 zip/체크섬만,
실패 증거에는 합성 E2E 자료만 올린다. 모델 실행 원시 기록, 설치 데이터, 토큰, 실제 페이지는 업로드하지 않는다.


## 0.1.1 새 탭·패널 회귀

`tests/e2e/new-tabs.spec.ts`는 실제 Extension·Bridge·Chrome으로 클릭/Enter에서 열린 탭의 작업 연결을 검사한다.
`target=_blank`/noopener, `window.open`, about:blank 이후 지연 이동, 자식 탭의 새 스냅샷과 원래 탭 복귀,
다른 opener, 같은 프레임에서 동시에 발생한 사용자 입력, 닫힌 탭과 중단 후 늦은 응답을 포함한다.
동일 프레임의 사용자 입력 회귀는 수정 전 무관한 탭이 편입되는 실패를 확인했다.
입력 epoch 또는 소스 문서 확인이 불가능하면 자동 편입하지 않고 경고를 반환한다.

`workbench.spec.ts`는 대화/세션/브라우저 전환, 고정 입력창, 중단 버튼, 키보드 포커스,
Catppuccin 4개 테마 × 320/400/600px, 시스템 테마와 Options 동기화를 실제 렌더링으로 검사한다.
본문·보조 문구·버튼·코드·오류·placeholder/hover 조합은 4.5:1, 컨트롤/포커스는 3:1 이상을 검사한다.
부모/하위 세션·페이지당 루트 세션 수, 이벤트 연결은 살아 있으나 완료 이벤트가 누락된 경우,
전송 직후 이벤트가 전혀 없는 경우에도 상태와 최종 텍스트가 복구되는지 합성 서버로 확인한다.
이는 실제 LLM 작업이나 전체 WCAG 준수 검증을 뜻하지 않는다. 최종 플랫폼별 결과는 [상태](./status.md)에 기록한다.


## R01–R11/D01 리뷰 회귀

새 테스트는 기존 Rust/Vitest/Windows runtime harness에 추가했다. 전체 결과와 실제 실패 이력은 [상태](./status.md)의 리뷰 후속 수정에 기록한다.

```bash
cargo test --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-extension test
cargo xwin test --offline --locked --target x86_64-pc-windows-msvc --no-run --lib --test mcp_stdio --test tool_router
```

교차 빌드한 lib/mcp_stdio/tool_router 테스트 exe를 Windows의 별도 작업 폴더에 복사한다.
`AGENT_BROWSER_TEST_EXE`는 같은 최종 코드의 로컬 Windows `browser-bridge.exe`로 지정한다.
lib와 tool_router는 전체 실행, mcp_stdio는 `--skip starts_serve_when_missing_and_serve_outlives_mcp`로 실행한다.
그 기존 테스트는 Unix `kill` 및 `unix-process-group` 진단을 요구하므로 WSL 전체 실행으로 검증한다.

아래 Windows 합성 런타임 모드는 실제 OpenCode나 모델을 실행하지 않는다. Node/WSL Node/Bridge 경로는 검증된 로컬 파일을 지정한다.

```powershell
$env:AGENT_BROWSER_TEST_EXE = '<final-windows-bridge.exe>'
$env:AGENT_BROWSER_TEST_OPENCODE_EXE = 'C:\Program Files\nodejs\node.exe'
$env:AGENT_BROWSER_TEST_MODULE_ROOT = '<isolated-windows-verification>\package.json'
$env:AGENT_BROWSER_TEST_WSL_EXE = '/bin/true'
$env:AGENT_BROWSER_TEST_WSL_NODE = '<existing-wsl-node>'
$env:RUNTIME_KIND = 'cmd'
$env:RUNTIME_SCENARIO = 'health-failure'
node .\bridge\tests\windows-runtime.mjs
```

7가지 조합을 각각 실행한다. `cmd/health-failure`, `wsl/wsl-start-failure`, `wsl/wsl-unknown-marker`, `cmd/doctor-env`, `wsl/doctor-env`, `cmd/healthy-fixture`, `wsl/healthy-fixture`.
WSL 배포 이름은 기본 Ubuntu이며 다른 이름은 `AGENT_BROWSER_TEST_WSL_DISTRO`로 지정한다.
각 실행은 고유 임시 home, 포트, 자식 서버만 사용한다. health-failure는 제품의 60초 health timeout을 실제로 기다린다.
`healthy-fixture`는 ready·status·Bridge 재시작 재사용·Stop·프로필 삭제를 검사한다.
`RUNTIME_SCENARIO`를 생략한 기존 모드는 실제 OpenCode를 사용하므로 위 합성 검증과 구분한다.


### PR #3의 pending WSL 저장 실패 회귀

`runtime::wsl_persist_failure_tests::review_pending_wsl_owner_is_cleaned_after_initial_persist_failure`는 Windows lib 테스트 exe에서 실행한다.
기존 Ubuntu WSL 배포를 사용하며 고유 임시 home의 synthetic shell/sleep 프로세스만 시작·정리한다. 실제 OpenCode나 모델은 실행하지 않는다.
WSL이 없는 hosted Windows runner에서 잘못 실패하지 않도록 기본 ignored이며, WSL 검증 PC에서는 반드시 명시적으로 실행한다.

```powershell
$testExe = '<copied Windows lib test exe>'
& $testExe --ignored --exact runtime::wsl_persist_failure_tests::review_pending_wsl_owner_is_cleaned_after_initial_persist_failure
```

소유자 신원 게시를 늦추고 초기 runtime.json 저장을 실패시켜, cleanup 이후 서버 역할의 명령이 뒤늦게 실행되지 않는지 검사한다.
Unix lib의 `review_wsl_launch_requires_matching_persisted_start_permit`는 같은 launch shell이 permit 없음/다른 nonce에서는 exec하지 않고 일치하는 저장 허가 뒤에만 실행하는지 검사한다.
UI 후속 회귀는 기존 `workbench.test.ts`의 `review ` 테스트 7개로 초기·검색·추가 목록, 연결 중 선택/삭제, 반복 재연결/프로필 전환의 요청 상한을 검증한다.


## 요청별 활성 탭 회귀

새 동작은 패널에서 생성한 requestId를 `browser_tabs action=attach`에 전달한다. 명시적인 tabId가 없으면 전송 당시 캡처한 기본 탭을 사용하며, 이후 사용자 탭 전환을 따라가지 않는다. Chrome 확장 권한은 추가하지 않는다.

```powershell
# 고정 pnpm 의존성 및 extension/dist, Windows Bridge 빌드가 준비된 독립 복제본
node tests/e2e/request-target.windows.mjs
```

기본 exe는 `target/x86_64-pc-windows-msvc/debug/browser-bridge.exe`이며 `AB_BRIDGE_EXE`로 변경할 수 있다. Chrome은 설치된 Windows Chrome을 사용한다. 테스트는 자체 포트·임시 HOME/profile·합성 HTTP/SSE만 사용하고 생성한 프로세스를 정리한다. `Extensions.loadUnpacked`는 공식 CDP API로 호출하며 새 확장 권한/정책 설정을 추가하지 않는다. 현재 PC에서 플래그를 수동 추가하지 않고 로드에 성공했다. 다른 환경에서 실패하면 오류를 그대로 보고한다.

추가 단위 회귀: `extension/test/request-target.test.ts`, `extension/test/panel-requests.test.ts`, `workbench.test.ts`의 요청 캡처/전송 취소; Rust `server::operation`과 `mcp::tools`. 실제 모델이 요청 문맥을 따르는지는 이 결정적 테스트의 검증 범위가 아니다. 요청 ID를 누락하거나 종료된 operation을 재사용하면 조작 전에 거부한다.


## iframe 전체 경로 회귀

`node tests/e2e/iframe.windows.mjs`는 실제 Windows Chrome + MSVC Bridge + 빌드 확장으로 MCP → background → 격리 content 경로를 검사한다. `tests/fixtures/iframe.mjs`의 합성 같은 출처·다른 출처·중첩 iframe만 이용하며 새 임시 프로필·HOME·포트를 사용한다. `AB_BRIDGE_EXE`와 `AB_EXTENSION_DIR`로 격리 패키지를 지정할 수 있고 활성 탭 스크립트도 같은 변수를 지원한다. 운영 설치·Chrome 프로필은 읽거나 변경하지 않는다.

검사 항목: inline/키보드 후보, 좌표 조건과 스크롤, isTrusted 거절 유지, 체크박스 기본 활성화, 새 탭 편입, frameRef의 텍스트·URL 범위, 본문 교체 후 대기, 오래된 요소 및 문서 이동 후 프레임 참조 거부. 결과 JSON은 ignored `tests/agent/results/iframe.json`에 기록한다. 실제 모델 호출과 사내 서비스 접속은 포함하지 않는다.

실제 패널 경계 추가 검증: Stop 후 늦은 attach 거부, 비동기 활성 탭 캡처 중 취소 뒤 미전송, HTTP 400 admission 거절 뒤 정확한 예약 해제를 포함해 요청 단위 전체 경로 12개를 검사한다. OpenCode fixture는 정상 응답 종료의 finish=stop을 실제 v1 필드로 제공한다.
## WSL interop 회귀

배경과 완료된 실행 기록은 [WSL interop 검증](./wsl-interop-validation.md)을 따른다.
Linux에서 `cargo test --locked --offline --lib runtime::` 및 `--test runtime_management`를 실행한다.
Windows 산출물은 별도 worktree의 `target/`에서 만든 뒤 작업 전용 Windows 경로로 복사한다.

```bash
cargo xwin build --locked --offline --target x86_64-pc-windows-msvc -p agent-browser-bridge
cargo xwin test --locked --offline --target x86_64-pc-windows-msvc --lib --no-run
```

실제 Windows에서 생성된 unit test exe의 다음 필터를 각각 `--ignored --nocapture`로 실행한다.
이는 자체 임시 HOME와 nonce를 쓰며 `/bin/sleep` 또는 시작 허가를 기다리는 shell만 만든다.

- `keeper_initial_persist_failure_cleans_the_unpermitted_group`
- `review_pending_wsl_owner_is_cleaned_after_initial_persist_failure`
- `stop_revokes_permission_before_a_delayed_wsl_launch_can_exec`

`bridge/tests/windows-runtime.mjs`는 native Windows Node와 기존 `ws` 의존성을 사용한다.
`AGENT_BROWSER_TEST_EXE`, `AGENT_BROWSER_TEST_OPENCODE_EXE`, 필요하면
`AGENT_BROWSER_TEST_MODULE_ROOT`를 지정한다. WSL에는 `AGENT_BROWSER_TEST_WSL_EXE`,
`AGENT_BROWSER_TEST_WSL_NODE`, 선택적으로 `AGENT_BROWSER_TEST_WSL_DISTRO`를 지정한다.
fixture를 Windows 드라이브에 복사하거나 해당 배포판의 WSL UNC 경로에서 실행할 수 있다.

- `RUNTIME_KIND=wsl`, `RUNTIME_SCENARIO=interop-keeper`: 실제 OpenCode 연결, 같은 keeper 소켓의
  Windows canary, 실제 MCP initialize와 합성 도구 응답, 자체 소켓 정지/부재, keeper 종료,
  Bridge 재시작과 이전 기록의 보수적 처리 및 정리를 확인한다. `/usr/bin/python3`가 필요하다.
- `RUNTIME_SCENARIO=probe-count`: 동일 합성 서버에서 시작과 status 5회의 제어 호출을 센다.
  기준 바이너리에도 `wsl_control_status`의 같은 debug 로그를 넣는다. 로그 관측으로 WSL 호출을 추가하지 않는다.
- `RUNTIME_KIND=cmd`, `RUNTIME_SCENARIO=mcp-delay` / `mcp-failure`: HTTP 성공만으로 ready를
  반환하지 않는지, MCP 지연을 기다리는지, 실패 기한 뒤 자체 서버를 정리하는지 확인한다.
- `wsl-start-failure`, `wsl-unknown-marker`, `healthy-fixture` 및 scenario 없는 실제 CLI 경로도 유지한다.

`result.json`은 자격정보나 사용자 대화를 포함하지 않는 단계별 결과만 보관한다.
기존 runtime.json, 로그, 사용자 Chrome 페이지를 fixture로 가져오지 않는다.
커널 결함을 주장하려면 별도 근거가 필요하며, 자체 AF_UNIX handshake 정지를 그 재현으로 보고하지 않는다.

## WSL interop follow-up review scenarios

Use the same native Windows runner environment described above. The review
fixtures additionally support these `RUNTIME_KIND=wsl` scenarios:

- `previous-boot`: isolated previous-boot owner/keeper markers and absent process
  identities; stopped then fresh start. Does not shut down the host WSL instance.
- `orphan-leader`: kill only the nonce/start-tick-verified fixture server leader,
  leave its synthetic HTTP child alive, then verify owned Stop closes the child.
  The fixture has source-removal and 90-second self-termination safeguards.
- `startup-crash`: delay only the fixture server launch, kill its own resident
  Bridge after durable ownership, restart, verify retained instance, Stop, start.
- `concurrent-callers`: run two separate native CLI starts against one isolated
  home/profile; require one owned record and either shared readiness or an explicit
  profile-lock rejection, then reuse after callers exit and cleanly stop.
- `interop-review`: real OpenCode 1.18.29 with isolated HOME/XDG/project/config;
  verify settings and environment preservation, inject a nonresponsive browser
  MCP command through v1 POST /mcp, require HTTP-healthy/MCP-failed error state
  and retained ownership, restore the command, initialize and run a synthetic tool.

Review-only Linux regressions reside in `bridge/src/runtime/interop_tests.rs`:
previous boot with absent keeper, exited leader with owned surviving child, and
foreign-nonce orphan group refusal. Full suite command:
`cargo test --locked --offline -p agent-browser-bridge`.
Results and distinctions from real Chrome/model/kernel reproduction are recorded
in [wsl-interop-review.md](./wsl-interop-review.md).


실제 WSL→Chrome 통합은 `AB_WSL_OPENCODE`에 WSL OpenCode 실행 파일 경로를 설정하고 `node tests/e2e/iframe.windows.mjs`로 실행한다. 필요하면 `AB_WSL_DISTRO`를 지정한다. 자체 HOME/XDG의 관리형 OpenCode HTTP health와 MCP 연결을 확인한 후, 그 서버가 반환한 MCP 명령을 별도 시험 클라이언트로 실행해 실제 Windows 확장의 iframe 클릭·본문 대기를 수행한다. 실제 Chrome E2E이며 모델 호출은 0회다. 종료 시 runtime.stop 후 runtime.status=stopped를 확인한다.
## 게시판 탐색 회귀 (독립 worktree)

`tests/e2e/board-navigation.spec.ts`는 기존 World 하네스의 자체 포트·AGENT_BROWSER_HOME·임시 Chrome 프로필을 사용한다. 실제 사용자 탭은 대상에 포함되지 않는다. B01은 네 번의 hard 목록/본문/back 왕복 및 forward/reload, B02는 SPA back 후 900ms 지연 목록·같은 DOM 노드 정렬·pagination, B03은 iframe 교체, B04는 새 탭 본문/닫기/명시적 원래 탭 복귀, B05는 편집된 폼의 닫기 거부, B06은 실제 beforeunload 창 dismiss, B07은 실제 BFCache 복원을 검사한다. B08은 mousedown에서 링크가 재지정돼도 실제 click 직전 STALE_ELEMENT로 차단되는지 검사한다.

Windows 준비: 별도 `AGENT_BROWSER_WINDOWS_TEST_DIR`를 설정한 뒤 `bash scripts/test-windows.sh --prepare-only`. Windows PowerShell에서 아래 명령을 실행한다(경로는 해당 별도 시험 디렉터리):

```powershell
$env:AB_TEST_BFCACHE='1'
node <isolated-test-directory>/tests/e2e/windows-run.ts -- board-navigation.spec.ts
```

AB_TEST_BFCACHE는 Playwright의 기본 `--disable-back-forward-cache` 인수를 제외한다. 일반 테스트 실행에서 B07은 명시적으로 skip되며 BFCache 검증으로 집계하지 않는다. opt-in 실행은 `pageshow.persisted === true`를 반드시 assert하고 notRestoredReasons를 기록한다. 설정은 시험 자식 프로필에만 적용하며 OS/운영 브라우저 정책 및 manifest 권한은 변경하지 않는다. B06의 신뢰된 클릭도 합성 시험 페이지에만 수행한다.

회귀 단위 검사는 snapshot 문서 교체 중 재읽기/상한, 연결 노드 identity 변경, pagehide registry 만료, 오래된 complete 경합, close의 operation 경계·request dedupe·편집된 iframe/Shadow DOM 보호를 검사한다. 실행 결과는 status.md의 게시판 절에 기록한다.


## 새 탭·창·즐겨찾기 기능 검사

`browser-capabilities.spec.ts` C01–C07은 실제 MCP 호출로 standalone new, snapshot 없는 new, blank→HTTP goto, windows/windowId, anchor newTab, 생산 optional permission 기본 거부, about:blank 보안 경계를 검사한다. `bookmarks.spec.ts` F01–F02는 별도 `AB_TEST_BOOKMARKS=1` 시험 확장 복사본과 빈 프로필에서 만든 합성 즐겨찾기로 폴더/검색/페이지/비방문/변경 도구 거부를 검사한다. 일반 실행에서는 F01–F02를 skip하고 허용 상태 검증으로 집계하지 않는다. 시험 manifest 차이와 실제 사용자 동의 UI의 검증 한계는 [지원표](./browser-capabilities.md)에 기록한다.

## 관리 런타임 업데이트 회귀

기존 NativeEngineTests가 idle/busy/retry/잘못된 상태 응답, 취소 복구, Start=false, 변경 없는 재적용을 검사한다. 외부 프로필의 URL은 시험에서 도달 불가능한 값이며 호출하지 않아야 한다.

`tests/install/ManagedRuntimeUpgradeTests.cs`를 installer C# 소스와 함께 별도 Main으로 컴파일하면 실제 Windows/WSL 업데이트를 시험할 수 있다. 인수는 기존 0.1.5 패키지, 후보 0.1.6 패키지, **새 개인 Windows fixture 폴더**, 미리 생성한 격리 Linux 작업 폴더다. Linux 폴더에는 빈 `opencode.json`을 두며 XDG config/data/state/cache는 그 아래로 격리한다. 현재 시험 대상은 Ubuntu의 `/home/jihoon/.opencode/bin/opencode` 1.18.29다. 테스트는 합성 페어링을 자신의 데이터에만 기록하고 빈 세션만 생성하며 모델 요청/사용자 Chrome 접근을 하지 않는다. 완료 또는 실패 시 자신의 설치를 uninstall한다. 사용자 운영 폴더에 실행하지 않는다.


### 실제 OpenCode와 headed Windows 사이드 패널

`tests/e2e/opencode-panel.windows.mjs`는 Windows Node에서 실행한다. `scripts/test-windows.sh --prepare-only`로 Windows 개발 폴더에 최신 exe·Extension·고정 Playwright 의존성을 준비한 후 그 폴더에서 실행한다.

```powershell
node tests/e2e/opencode-panel.windows.mjs
node tests/e2e/opencode-panel.windows.mjs --wsl
```

설치된 Windows OpenCode 1.18.29의 기본 검증 경로는 `%LOCALAPPDATA%/AgentBrowser-dev/opencode/1.18.29/opencode.exe`이며 `AB_OPENCODE_EXE`로 바꿀 수 있다. WSL 검사는 Ubuntu의 `/home/jihoon/.opencode/bin/opencode`를 사용하고 `AB_WSL_OPENCODE`로 변경할 수 있다. `AB_BRIDGE_EXE`·`AB_EXTENSION_DIR`로 최종 패키지를 지정할 수 있다. 실제 `sidePanel.open`과 CDP/DOM 입력을 사용하며 물리 마우스 입력은 아니다.

각 실행은 격리된 설정·프로필·포트·합성 페이지와 localhost provider를 사용한다. WSL provider는 WSL loopback에서 실행한다. 두 탭의 새 요청, ID 누락 오류 뒤 교정, attach/snapshot, 정상·오류 응답 뒤 lease/중단 버튼 정리를 확인하고 관리 runtime을 중지한다. 결과 JSON·패널 PNG는 개발 `tests/agent/results`에만 저장한다. Zen 검사는 `--model opencode/<무료 모델 ID>`를 별도로 지정한다. 카탈로그 갱신과 모든 비용 0·공식 live 목록 가용성 확인을 통과해야 실행하며, 외부 모델 성공 여부는 합성 검사와 별도로 보고한다.
