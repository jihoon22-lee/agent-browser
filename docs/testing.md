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
시험별 최신 실행 결과와 미검증 범위는 status.md에 기록한다.

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
2026-10-11의 WSL/Windows 파일럿은 Zen HTTP 403으로 실제 도구 호출 전에 종료됐다.
따라서 5회 시연·실제 모델 실행 중 중단은 아직 검증되지 않았다.

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
