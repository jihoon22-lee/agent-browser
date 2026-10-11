# 진행 상태

## 현재 단계

**M2–M4 구현·검증·Windows 설치 완료**(브랜치 `feat/m2-m4-usable-release`).
M0 환경 실측·OpenCode v1 명세 확보 완료. M1 Task 1–13 구현과 전체 브랜치 검토·수정 완료.
Task 14의 실제 Windows Chrome 회귀 26/26과 Task 15 네이티브 OpenCode API 검증은 통과했다.
**사용자 결정(2026-10-11)**: 실제 OpenCode 모델 테스트는 배포 후 사용자가 수행한다. 기존 HTTP 403·도구 0건 결과는 유지하며, 이 항목을 다음 단계 진행/배포의 차단 조건에서 제외한다. M2–M4 구현과 모델 호출 없는 검증을 완료했고 v0.1.0 설치 패키지를 생성했다.
현재 작업 원장은 [M2–M4 계획](./plans/2026-10-11-m2-m4-usable-release.md)이다. [m1-resume.md](./m1-resume.md)는 이전 단계의 역사 기록이다.

## 실측 환경 (2026-10-11)

| 항목 | 값 | 방법 |
|---|---|---|
| WSL | Ubuntu 26.04.1 LTS, kernel 6.18.33.2-microsoft-standard-WSL2, 배포판 이름 `Ubuntu` | `/etc/os-release`, `wsl.exe -l -v` |
| WSL 네트워킹 | NAT (`.wslconfig`에 networkingMode 없음) | `wslinfo --networking-mode` |
| WSL interop | 동작. 단, WSL PATH에 Windows 경로 없음 → `/mnt/c/...` 절대 경로 필요 | 직접 실행 |
| Windows | Windows 11, `10.0.26200.9457`, AMD64, 사용자 `USER`, PowerShell 5.1(pwsh 없음) | `cmd /c ver`, PowerShell |
| Chrome | 154.0.8037.99, `C:\Program Files\Google\Chrome\Application\chrome.exe` | 파일 버전 |
| OpenCode (WSL) | 1.18.29, `~/.opencode/bin/opencode` | `opencode --version` |
| OpenCode (Windows) | 공식 1.18.29 portable exe를 사용자 개발 영역 `AgentBrowser-dev/opencode/1.18.29`에 배치. PATH/전역 설정 변경 없음 | native Windows `--version`, `/global/health`, `/doc` |
| Windows 툴체인 | node 있음, git 있음, Rust 없음 | `Get-Command` |
| WSL 툴체인 | node 24.18.0, pnpm 9.15.9, bun 1.3.14, rustc 1.98.1/1.97.1, cargo-xwin, target `x86_64-pc-windows-msvc` | `--version` |
| Zen 무료 모델 | `opencode/big-pickle`, `ling-3.0-flash-fin-free`, `mimo-v2.5-free`, `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free` | `opencode models opencode` — 초기 목록. 실제 테스트는 현재 공식 가격·가용성·metadata를 재확인한 `big-pickle`; 공급자 403으로 도구 호출 미실시 |

## 실제 실행한 검증

| 날짜 | 검증 | 결과 |
|---|---|---|
| 2026-10-11 | `opencode serve --pure` 기동, `/global/health`, `/doc` 수집 | 통과 |
| 2026-10-11 | `OPENCODE_SERVER_PASSWORD` Basic 인증(401/200) | 통과 |
| 2026-10-11 | `chrome-extension://` Origin CORS preflight | Allow-Origin 없음(기록만) |
| 2026-10-11 | cargo-xwin으로 msvc exe 크로스 빌드 → `C:\...\ab 한글 probe\`(공백·한글 경로)에 복사 → WSL interop 실행 | 통과, `current_exe`가 Windows 경로로 출력 |
| 2026-10-11 | M1 Task 1: `cargo test -p agent-browser-bridge --test protocol_contract`(Linux), `vitest run test/protocol-contract.test.ts` | 4/4, 4/4 통과 |
| 2026-10-11 | M1 Task 2: `node --test tests/fixtures/server.test.mjs`(Linux) | 3/3 통과 |
| 2026-10-11 | M1 Task 3: `cargo test -p agent-browser-bridge --lib config`(Linux). `browser-bridge pair`를 한글·공백 경로의 `AGENT_BROWSER_HOME`으로 Linux에서 수동 실행 | 5/5 통과, 토큰 64자 출력. 보안 리뷰 지적 반영(config.json 0600, Unix) 후 6/6 — Windows ACL은 미검증 |
| 2026-10-11 | M1 Task 4: `cargo test -p agent-browser-bridge --test serve_auth`(Linux, 실제 WebSocket). `serve --port 0`을 SIGINT로 종료 | 13/13 통과(계획 9 + 추가 4), 종료 코드 0. Windows 포트 중복 bind는 Task 14에서 확인 예정 |
| 2026-10-11 | M1 Task 4 후속(보안 리뷰 반영): `--test serve_port_conflict`(Linux) | 2/2 통과 — 포트 점유 프로그램에 페어링 토큰을 보내지 않음. 확장·mcp가 토큰을 보내는 첫 `auth.hello`는 같은 위험이 남아 있음(포트 선점) |
| 2026-10-11 | M1 Task 5: `cargo test -p agent-browser-bridge`(Linux): 작업 게이트·레지스트리·타임라인 단위 테스트, 연결 루프 통합 테스트 | lib 19, protocol_contract 4, serve_auth 18, serve_port_conflict 2 모두 통과 |
| 2026-10-11 | M1 Task 6: `cargo test -p agent-browser-bridge`(Linux, 가짜 Extension을 실제 WebSocket으로 연결) | lib 21(도구 계약 fixture 2 포함), protocol_contract 4, serve_auth 18, serve_port_conflict 2, tool_router 11 통과. tool_router는 5회 반복 모두 통과. 실제 Extension·MCP 클라이언트와의 연동은 아직 미검증 |
| 2026-10-11 | M1 Task 7: `cargo test -p agent-browser-bridge --test mcp_stdio`(Linux, 실제 `browser-bridge mcp` 자식 프로세스에 원시 JSON-RPC) | 5/5 통과(initialize·tools/list·오류 매핑·serve 자동 시작과 생존·stdin 종료·serve 불가 시 BROWSER_DISCONNECTED). `cargo xwin build --release --target x86_64-pc-windows-msvc`로 `browser-bridge.exe` 생성만 확인 — **Windows 실행은 미검증**(Task 14) |
| 2026-10-11 | M1 Task 6 후속(보안 리뷰 반영, 입력 검증): `--test tool_router`(Linux) | 13/13 통과 — 스키마에 선언되지 않은 인수는 브라우저로 전달하지 않고, http(s) 이외 URL은 `UNSUPPORTED_PAGE`로 브리지에서 거부 |
| 2026-10-11 | M1 Task 8: `vitest run`(extension, jsdom, 가짜 WebSocket·타이머), `pnpm --filter agent-browser-extension build` | 단위 14/14 통과(protocol 4, bridge-connection 6, sender 4). 빌드 성공(`dist/`에 manifest·background·options·content 생성). **실제 Chrome에 로드한 검증은 미실시**(Task 14) |
| 2026-10-11 | M1 Task 9: `vitest run test/snapshot.test.ts`(jsdom) 및 extension 전체, build | snapshot 8/8, extension 전체 23/23 통과, 빌드 성공. jsdom에는 레이아웃이 없어 `checkLayout:true` 경로(실제 가시성)와 `innerText`는 **실제 Chrome에서 미검증**(Task 13·14) |
| 2026-10-11 | M1 Task 10: `vitest run`(jsdom) actions·extract 및 extension 전체, build | actions 11 + extract 4, extension 전체 39/39 통과, 빌드 성공. 클릭 가림 판정(`elementFromPoint`)·실제 스크롤·실제 키 이벤트는 jsdom에 레이아웃이 없어 **미검증**(Task 13·14) |
| 2026-10-11 | 재개 검토: `pnpm --filter agent-browser-extension exec vitest run test/actions.test.ts test/extract.test.ts test/bridge-connection.test.ts`, `pnpm --filter agent-browser-extension build` | 선별 3파일 22/22 통과, TypeScript 검사·Vite 빌드 성공. 전체 테스트 재실행 아님 |
| 2026-10-11 | 재개 검토: `cargo test --offline -p agent-browser-bridge --lib server::operation`, `cargo test --offline -p agent-browser-bridge --test tool_router` | Linux 5/5, 13/13 통과. tool_router는 최초 샌드박스 실행에서 localhost 소켓 생성이 `Operation not permitted`로 차단됨. 같은 명령을 제한 밖에서 재실행해 통과 |
| 2026-10-11 | 재개 검토: 기존 Rust 라이브러리·TS 소스를 호출하는 임시 재현 코드(Linux/Node/jsdom, 제품 코드 변경 없음) | 현재 탭 종료 후 switch/release 모두 `TAB_CLOSED`; `cancelUpTo` 후 이미 시작한 wait는 `CANCELLED` 대신 `TIMEOUT`; 연결 단절 후 `status.get` Promise 미종결 확인. 독립 ref 레지스트리의 동일 ID 충돌과 Bridge 재시작 시 generation 초기화도 확인. 실제 Chrome E2E 결과 아님. 이후 Task 11과 전체 브랜치 검토에서 수정(아래 행) |
| 2026-10-11 | M1 Task 11: SW 탭·문서 라우팅, 원자적 요청 중복 방지, 실행 중 취소, 캡처 보호, 탭 종료 복구, HMAC 상호 인증 | 실패 테스트 확인 후 구현. Extension 전체 15파일 111/111(동시 구현된 Task 12 테스트 포함), TypeScript/Vite 빌드 성공. Bridge 전체 Linux 78/78(lib 27, MCP 5, protocol 4, auth 23, port 2, router 17). Windows 검증 아님 |
| 2026-10-11 | M1 Task 12: 한국어 최소 패널(연결·작업 탭·최근 20개 기록·중단·브라우저 선택) | reducer 7 + React 통합 6 통과(Extension 111개 실행에 포함). 오류/재연결 복구, 오래된 초기 응답 경합, 다른 프로필 tabId 혼동 방지, React 텍스트 렌더링 검증. TypeScript/Vite 빌드 성공 |
| 2026-10-11 | M1 Task 13: `pnpm --filter agent-browser-e2e exec playwright test`, fixture 서버 테스트 | 실제 Linux Bridge + 확장 + Chromium 156.0.8078.4에서 20/20 통과, fixture 3/3 통과. S12 초기 관찰 방식 실패는 CDP stopped/timeOrigin 검증으로 수정. S13 제출 응답 보류→Bridge/SW 재시작→동일 ID replay에도 제출 1회. [테스트 문서](./testing.md) |
| 2026-10-11 | Task 11 이후 `cargo xwin build --offline --locked -p agent-browser-bridge --release --target x86_64-pc-windows-msvc` | HMAC 포함 Windows exe 빌드 성공. 이 행은 Windows 실행 증거가 아님 |
| 2026-10-11 | 전체 브랜치 독립 검토와 회귀 수정 | Critical 프로필 전송 경합, Important 9개(새 스냅샷·키·페이지 이동/출력 제한·표·radio·동시 초기화·재페어링) 수정. 준비된 명령의 검사/owner enqueue를 원자화. 실제 SW 쓰기 중 종료(R26) 추가. Extension 147/147, Rust 90/90(자식 실행용 helper 1개 기본 ignored), Node fixture/runner/runtime 20/20, Linux 실제 확장 E2E 26/26 통과. TypeScript·빌드 통과 |
| 2026-10-11 | Task 14 실제 Windows Chrome/MSVC exe: `bash scripts/test-windows.sh -- --grep 'S01 '`, 복사된 native Windows Node의 `windows-run.ts` 전체 실행 | Windows Node 24.18.1 + 실제 설치 Chrome 154.0.8037.99 + MSVC release exe, 별도 임시 프로필/headless 모드. 스모크 1/1 및 전체 26/26 통과(24.0초). Windows의 교차 출처 iframe·Shadow DOM·스크린샷·Bridge/SW 재시작·in-flight 쓰기 종료·중복 제출 거부 검증. 기존 사용자 Chrome 프로필/프로세스 수정·종료 없음 |
| 2026-10-11 | Task 14 Windows → WSL localhostForwarding | WSL fixture 127.0.0.1:37237에 Windows node.exe fetch: HTTP 200, 한글 검색 fixture 확인. 방화벽 변경/0.0.0.0 바인딩 없음 |
| 2026-10-11 | Task 14 Windows Chrome → WSL OpenCode v1 | 격리 WSL `opencode serve`의 `/global/health`를 Windows Node fetch 및 실제 Windows Chrome 새 탭/snapshot으로 확인: healthy=true, version=1.18.29. localhost forwarding 초기 재시도 필요. 작업 원래 탭 복귀/release, 임시 WSL 서버 종료 |
| 2026-10-11 | Task 14 WSL OpenCode + Zen 무료 모델 파일럿 | `opencode/big-pickle` 1회, MCP preflight 1/1. Zen HTTP 403 FreeTierError, 도구 0건, 작업 성공 0/1. 5회 시연 미실시 |
| 2026-10-11 | Task 15 실제 Windows OpenCode API: native Node `tests/agent/check-native.mjs` | 공식 portable 1.18.29, 격리 resolved config·health 통과. 저장된 WSL 명세와 경로 162/162, method+path 188/188 동일. non-/api 111개, /api 51개는 명세에만 존재하며 v2 호출 0회. 테스트 소유 서버 종료 확인 |
| 2026-10-11 | Task 15 Windows 네이티브 OpenCode + Zen 무료 모델 파일럿 | 같은 검증된 무료 모델 1회, MCP preflight 1/1. 같은 HTTP 403 FreeTierError, 도구 0건, 작업 성공 0/1. 추가 모델 호출 중단 |
| 2026-10-11 | 파일럿 실패 분류 회귀 | Zen FreeTierError·401/403·일반 API 실패 원인 보존. 실패 테스트 확인 후 수정, runner 단위/실제 합성 자식 프로세스 13/13 통과 |
| 2026-10-11 | Task 14 WSL→Windows MCP 자동 시작·수명 회귀 | 기존 exe는 native MCP 종료 후 WSL relay가 남아 EOF 테스트 실패. Windows `CreateProcessW`에서 handle 상속을 끄고 재검증: 일반/한글·공백 경로 2/2 통과. 실제 native MCP 종료와 WSL child.close(0), serve 생존·두 번째 serve 거부·11개 도구·순수 JSON-RPC stdout·토큰 미로그 확인. 모두 windows-breakaway 경로, fallback 경로는 미실행. root 독립 재실행도 2/2 통과, Linux MCP 5/5 통과. 수정된 exe로 Windows Chrome 전체 26/26 재검증(23.5초) |
| 2026-10-11 | interop 검증기 실패 정리 회귀 | 독립 검토에서 PID 파일 누락/손상·디렉터리 삭제 실패 시 정리/증거 보존 문제 확인 후 수정. 소유 PID 재검증은 유지. Node fixture/runner/runtime/interop 24/24 통과 |
| 2026-10-11 | Windows config ACL | 기본 home과 같은 `%LOCALAPPDATA%` 부모 아래 고유 테스트 home에서 config 상속 ACL 확인: 현재 사용자·SYSTEM·Administrators FullControl만 존재. `%TEMP%`의 별도 테스트 home은 환경의 추가 ACL을 상속했으며 기본 부모 ACL과 구분했다. ACL 변경 없음 |

## M2–M4 검증 기록 (모델 요청 0회)

| 검증 | 실제 결과 |
|---|---|
| 최종 Rust 전체(Linux) | **107/107** 통과, 자식 실행용 helper 1개 기본 ignored(부모 테스트가 실행). 테스트 fixture의 env→node 이미지 전환을 직접 node shebang으로 바로잡음. fork된 descriptor의 lock 보존 경합은 명시적 unlock guard/실패 회귀로 수정. 전체 재실행 통과 |
| 최종 Extension 전체 | **27파일 212/212** 통과, TypeScript/Vite 빌드 및 E2E TypeScript 검사 통과 |
| 최종 Node fixture/runner/interop | **25/25** 통과 |
| 최종 Windows release + 실제 Chrome E2E | **32/32** 통과(40.7초). Chrome 154.0.8037.99, Windows Node 24.18.1, 최종 exe SHA-256 `efcea098efc8d09030d24fe2f2de282ab1bc74939df32320485c109bcdbaddd4` |
| Linux 전체 실제 확장 E2E | **32/32** 통과(36.2초), 이전 테스트의 중복 password selector와 비동기 세션/첨부 준비 대기를 수정한 뒤 재실행 |
| OpenCode v1 제품 클라이언트·사용량 | 실패 테스트 후 구현. 인증·UTF-8·fetch receiver·SSE·재연결·세션 격리·토큰 중복·파일 목록 fallback 13개 통과 |
| 실제 Windows/WSL OpenCode 1.18.29 API | 두 환경 모두 성공. noReply 텍스트/PNG 첨부, 세션 CRUD/검색/분기/revert, 인증 SSE, 목록·파일 API. 합성 provider 요청 **0회** |
| 새 작업 UI Chrome E2E | Linux 실제 확장 + 합성 v1 HTTP/SSE의 W01–W06 **6/6** 통과. 질문/권한은 합성 pending이며 LLM 발생 요청이 아님 |
| Bridge 실제 Windows 런타임 | native exe / 한글·공백 cmd / WSL Ubuntu **3/3** 통과. 동시 ensure·Bridge 재시작 재사용·소유 프로세스 종료·설정 보존·인증 attach fixture·stop-all. 모델 0회 |
| Windows PowerShell 5.1 설치 | JSONC 병합/보존/충돌 통과, 설치 **12개**, 관리 런타임 정리 **3개**, 패키징 **2개** 통과. debug와 release exe 양쪽으로 확인. Startup 바로가기 생성/대상과 즉시 실행을 검사했으며 Windows 로그아웃·재로그인은 실행하지 않음 |
| Windows 관리 런타임 후속 | CLI 첫 start의 실제 서버는 ready이나 상속 pipe로 호출자가 EOF를 받지 못하는 문제 재현 → CreateProcessW의 핸들 상속을 끄고 native/cmd/WSL **3/3** 통과. 명시적 환경·한글/공백·인수 보존·사용자 포트·종료 확인. 독립 소스 검토와 quoting 회귀 통과 |
| 독립 전체 검토 | 중요 결함 5개 재현: 비동기 UI의 다른 환경 오염, 선택 세션 중단 누락, 서로 다른 프로필 자동 포트 충돌, 사용자 포트/오래된 overlay 불일치, 외부 URL prefix 검증 불일치. 각 항목 실패 회귀 후 수정 완료, 독립 재검토에서 원래 재현 해결 확인. UI 28개와 런타임 4개 독립 재실행 통과 |

구현: Windows/WSL 자동 실행 프로필, 인증된 v1 HTTP/SSE 작업 UI, 모델·에이전트·variant,
질문·권한·사용량·첨부·@/명령·diff/revert/내보내기, 사용자 영역 설치/Startup/업데이트/제거,
zip/SHA256/고정 의존성 고지. 상세 지원 경계는 [호환성 문서](./opencode-v1-compatibility.md)를 따른다.

## 무료 모델 실행 결과와 남은 검증

- 2026-10-11, OpenCode 1.18.29 + `opencode/big-pickle`: 기본 격리 runner의 WSL 파일럿 1회, Windows 네이티브 파일럿 1회.
  각 플랫폼의 MCP preflight는 1/1 성공. **실제 모델 도구 호출은 각각 0건**, 작업 성공은 각각 0/1이다.
  검색·새 탭 표 읽기·복귀·요약을 수행한 것으로 계산하지 않았다.
- 두 실행 모두 Zen이 HTTP 403 `FreeTierError`를 반환했다. 메시지는 “OpenCode's free tier can only be used from within OpenCode”.
  호출 전 공식 Zen 가격표의 Free 행, live model 목록, 설치본의 모든 cost tier 0과 toolcall=true를 확인했다.
  유료 fallback·헤더 위장·전역 설정 변경 없이 추가 반복을 중단했다.
- 별도 임시 runner에서 custom agent.prompt만 제거해 OpenCode 기본 시스템 프롬프트를 사용하는
  WSL 비교 파일럿도 1회 실행했다. 무료 가격·가용성을 다시 확인했고 도구·권한 제한은 유지했다.
  결과는 같은 HTTP 403, MCP preflight 1/1·도구 0건·작업 0/1이다. 프롬프트 제거만으로는 해결되지 않았다.
- 브라우저 전용 도구 구성과 무료 서비스의 요청 판별이 충돌했을 가능성은 있으나 정확한 서버 측 원인은 확정하지 않았다.
  [v1.18.29 요청 구성 소스](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/session/llm/request.ts)와
  같은 버전의 [read 비활성화 재현 보고](https://github.com/anomalyco/opencode/issues/51315)가 참고 근거다.
- 공급자 거부가 해소되면 같은 격리 구성에서 파일럿 → 5회 시연 → 모델 실행 중 패널 중단을 수행한다.
  결정적 Windows S11의 중단 통과를 실제 LLM 실행 중 중단 증거로 대체하지 않는다.
- 실제 사용자의 수동 확장 설치/페어링 UX, headed Chrome UI, 기업 관리 Chrome 정책,
  사내 Windows / 사내 WSL Ubuntu 24는 미검증이다. 이번 Chrome 검증은 별도 임시 headless 프로필이다.

## 인증 보강과 남은 검증

- 기존 **포트 선점 시 토큰 노출** 문제는 Task 11에서 HMAC-SHA256 상호 인증으로 보강했다.
  Extension과 MCP는 토큰을 전송하지 않고, 양쪽 nonce·역할·clientId·repair를 결합한 서버 증명을 검증한 후
  클라이언트 증명을 보낸다. 가짜 서버, 증명 반사/재생, 인증 전 명령 거부와 Rust/TS 공유 벡터를 테스트했다.
- 기존 저장 토큰은 유지된다. 구형 인증 클라이언트와는 호환되지 않으므로 Bridge와 Extension을 함께 갱신한다.
- `webNavigation` 권한을 추가해 프레임·documentId를 식별한다. 요소 ref는 다른 탭/문서에서 사용할 수 없다.
- 이 PC의 기본 부모 상속 ACL과 Windows 자동 시작·프로세스 수명은 위 실제 테스트로 확인했다.
  지정한 `AGENT_BROWSER_HOME`의 ACL은 부모에 따라 달라진다. 다른 PC의 ACL·breakaway 금지 시 fallback·기업 Chrome 정책은 미검증이다.

## 참고 사항

- 전역 `~/.cargo/config.toml`의 `build.target-dir`이 다른 프로젝트 캐시를 가리킨다. 이 저장소는 `.cargo/config.toml`로 `target/`을 쓴다.
- 전역 OpenCode 설정에는 기존 MCP(playwright 등)가 있다. 수정하지 않고 테스트는 별도 설정으로 격리한다.
- 검증용 Chrome/fixture/Bridge/OpenCode 프로세스는 종료했다. 아래 실제 사용자 설치의 Bridge는 사용을 위해 실행 상태로 유지한다. 전역 OpenCode 설정은 변경하지 않았다.

## v0.1.0 설치·배포물

- Windows x64 zip: `agent-browser-0.1.0-windows-x64.zip` (26개 파일, 제3자 패키지 162개 고지).
- zip SHA-256: `909021621dbf3c578496f760524c233f5a51556ec480adbfb1ccee16cd57ac0f`.
- 최종 exe로 런타임 제거 3/3·패키징 2/2 재검증, manifest 모든 파일 해시와 zip allowlist 독립 확인.
- 실제 사용자 영역 `%LOCALAPPDATA%\AgentBrowser`에 이 zip을 설치했다. Startup `AgentBrowser.lnk` 등록,
  Bridge PID 58304 / `127.0.0.1:4317` 실행 및 인증 진단 확인. 로그인 재실행 자체는 테스트하지 않았다.
- 실제 설치 프로필: `wsl-main` / Ubuntu / `/home/jihoon/.opencode/bin/opencode` 1.18.29 /
  작업 디렉터리 `/home/jihoon/projects/agent-browser`. 전역 모델·인증·MCP 설정 수정 없음.
- 다운로드 폴더에 zip, `AgentBrowser-0.1.0-SHA256SUMS`, 압축 해제 폴더 `AgentBrowser-0.1.0` 준비.
- 사용자 Chrome의 최초 수동 로드·페어링은 아직 하지 않았다. 진단은 Extension 미연결, OpenCode stopped,
  MCP/모델 미검증으로 정확히 표시한다. 페어링 후 패널에서 자동 ensure가 시작된다.

## 사용자에게 남은 최초 사용 절차

1. `chrome://extensions`에서 개발자 모드를 켜고 `%LOCALAPPDATA%\AgentBrowser\extension`을 압축해제 로드한다.
2. 설치 폴더 `show-pairing.ps1`로 로컬 토큰을 확인해 Options에 붙여넣고 연결한다.
3. 사이드 패널의 준비된 `WSL Ubuntu` 환경에서 세션을 만들고 사용할 모델을 선택한다.

실제 모델의 작업 수행과 사내 환경 검증은 사용자에게 이관했다. 기존 Zen 403 결과를 성공으로 변경하지 않는다.
사용 안내는 [README-install.md](../README-install.md), 구현/API 경계는 [호환성](./opencode-v1-compatibility.md)을 따른다.
