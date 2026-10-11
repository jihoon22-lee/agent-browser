# 진행 상태

## 현재 단계

**M1 브라우저 제어 구현 — 진행 중**(브랜치 `feat/m1-browser-control`).
M0 환경 실측·OpenCode v1 명세 확보 완료. M1 계획 Task 1–13 구현·Linux 검증 완료, 전체 브랜치 검토 및 Task 14–15 Windows 검증 남음.
**이어서 작업하려면 [m1-resume.md](./m1-resume.md)를 먼저 읽는다.**

## 실측 환경 (2026-10-11, main)

| 항목 | 값 | 방법 |
|---|---|---|
| WSL | Ubuntu 26.04.1 LTS, kernel 6.18.33.2-microsoft-standard-WSL2, 배포판 이름 `Ubuntu` | `/etc/os-release`, `wsl.exe -l -v` |
| WSL 네트워킹 | NAT (`.wslconfig`에 networkingMode 없음) | `wslinfo --networking-mode` |
| WSL interop | 동작. 단, WSL PATH에 Windows 경로 없음 → `/mnt/c/...` 절대 경로 필요 | 직접 실행 |
| Windows | Windows 11, `10.0.26200.9457`, AMD64, 사용자 `USER`, PowerShell 5.1(pwsh 없음) | `cmd /c ver`, PowerShell |
| Chrome | 154.0.8037.99, `C:\Program Files\Google\Chrome\Application\chrome.exe` | 파일 버전 |
| OpenCode (WSL) | 1.18.29, `~/.opencode/bin/opencode` | `opencode --version` |
| OpenCode (Windows) | **없음** — M1 WSL 시연 후 1.18.29 설치 예정 | `Get-Command` |
| Windows 툴체인 | node 있음, git 있음, Rust 없음 | `Get-Command` |
| WSL 툴체인 | node 24.18.0, pnpm 9.15.9, bun 1.3.14, rustc 1.98.1/1.97.1, cargo-xwin, target `x86_64-pc-windows-msvc` | `--version` |
| Zen 무료 모델 | `opencode/big-pickle`, `ling-3.0-flash-fin-free`, `mimo-v2.5-free`, `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free` | `opencode models opencode` — 도구 호출 가능 여부는 미확인 |

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
| 2026-10-11 | 재개 검토: 기존 Rust 라이브러리·TS 소스를 호출하는 임시 재현 코드(Linux/Node/jsdom, 제품 코드 변경 없음) | 현재 탭 종료 후 switch/release 모두 `TAB_CLOSED`; `cancelUpTo` 후 이미 시작한 wait는 `CANCELLED` 대신 `TIMEOUT`; 연결 단절 후 `status.get` Promise 미종결 확인. 독립 ref 레지스트리의 동일 ID 충돌과 Bridge 재시작 시 generation 초기화도 확인. 실제 Chrome E2E 결과 아님. 상세는 [재개 검토](./m1-resume.md#재개-검토-2026-10-11) |

| 2026-10-11 | M1 Task 11: SW 탭·문서 라우팅, 원자적 요청 중복 방지, 실행 중 취소, 캡처 보호, 탭 종료 복구, HMAC 상호 인증 | 실패 테스트 확인 후 구현. Extension 전체 15파일 111/111(동시 구현된 Task 12 테스트 포함), TypeScript/Vite 빌드 성공. Bridge 전체 Linux 78/78(lib 27, MCP 5, protocol 4, auth 23, port 2, router 17). Windows 검증 아님 |
| 2026-10-11 | M1 Task 12: 한국어 최소 패널(연결·작업 탭·최근 20개 기록·중단·브라우저 선택) | reducer 7 + React 통합 6 통과(Extension 111개 실행에 포함). 오류/재연결 복구, 오래된 초기 응답 경합, 다른 프로필 tabId 혼동 방지, React 텍스트 렌더링 검증. TypeScript/Vite 빌드 성공 |
| 2026-10-11 | M1 Task 13: `pnpm --filter agent-browser-e2e exec playwright test`, fixture 서버 테스트 | 실제 Linux Bridge + 확장 + Chromium 156.0.8078.4에서 20/20 통과, fixture 3/3 통과. S12 초기 관찰 방식 실패는 CDP stopped/timeOrigin 검증으로 수정. S13 제출 응답 보류→Bridge/SW 재시작→동일 ID replay에도 제출 1회. [테스트 문서](./testing.md) |
| 2026-10-11 | Task 11 이후 `cargo xwin build --offline --locked -p agent-browser-bridge --release --target x86_64-pc-windows-msvc` | HMAC 포함 Windows exe 빌드 성공. 이 행은 Windows 실행 증거가 아님 |

## 미검증

- Windows Chrome → WSL `opencode serve`의 localhost 접속(NAT localhostForwarding).
- Windows 네이티브 OpenCode 경로 전체.
- Zen 무료 모델의 도구 호출 능력.
- Chrome 정책에 의한 압축해제 확장 로드 제한 여부(개발용 프로필에서 확인 예정).
- 사내 Windows / 사내 WSL Ubuntu 24 전체.

## 인증 보강과 남은 검증

- 기존 **포트 선점 시 토큰 노출** 문제는 Task 11에서 HMAC-SHA256 상호 인증으로 보강했다.
  Extension과 MCP는 토큰을 전송하지 않고, 양쪽 nonce·역할·clientId·repair를 결합한 서버 증명을 검증한 후
  클라이언트 증명을 보낸다. 가짜 서버, 증명 반사/재생, 인증 전 명령 거부와 Rust/TS 공유 벡터를 테스트했다.
- 기존 저장 토큰은 유지된다. 구형 인증 클라이언트와는 호환되지 않으므로 Bridge와 Extension을 함께 갱신한다.
- `webNavigation` 권한을 추가해 프레임·documentId를 식별한다. 요소 ref는 다른 탭/문서에서 사용할 수 없다.
- Windows ACL·실제 Windows exe 프로세스 수명·Chrome 정책·사내 환경은 계속 미검증이다.

## 참고 사항

- 전역 `~/.cargo/config.toml`의 `build.target-dir`이 다른 프로젝트 캐시를 가리킨다. 이 저장소는 `.cargo/config.toml`로 `target/`을 쓴다.
- 전역 OpenCode 설정에는 기존 MCP(playwright 등)가 있다. 수정하지 않고 테스트는 별도 설정으로 격리한다.

## 다음 작업

1. [재개 검토](./m1-resume.md#재개-검토-2026-10-11)의 회귀 항목을 반영해 [M1 계획](./plans/2026-10-11-m1-browser-control.md) 남은 과제를 순서대로 구현.
2. Task 12 최소 패널 → Task 13 결정적 E2E → 전체 브랜치 검토 → Task 14 Windows Chrome/WSL OpenCode → Task 15 Windows 네이티브 OpenCode 검증.
3. 이번 재개 검토는 구현 착수 전 준비다. Task 11–15 완료 상태는 바뀌지 않았으며 Windows 실행·Chrome·LLM 검증을 추가로 수행하지 않았다.
