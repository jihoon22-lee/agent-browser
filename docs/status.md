# 진행 상태

## 현재 단계

**M1 브라우저 제어 구현 — 진행 중**(브랜치 `feat/m1-browser-control`).
M0 환경 실측·OpenCode v1 명세 확보 완료. M1 계획의 Task 1부터 순서대로 구현하며, 아래 검증 표에 과제별 실행 결과를 남긴다.

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

## 미검증

- Windows Chrome → WSL `opencode serve`의 localhost 접속(NAT localhostForwarding).
- Windows 네이티브 OpenCode 경로 전체.
- Zen 무료 모델의 도구 호출 능력.
- Chrome 정책에 의한 압축해제 확장 로드 제한 여부(개발용 프로필에서 확인 예정).
- 사내 Windows / 사내 WSL Ubuntu 24 전체.

## 알려진 위험 (결정 필요)

- **포트 선점 시 토큰 노출**: `auth.hello`는 페어링 토큰을 그대로 보낸다. 같은 PC의 다른 사용자(또는 프로그램)가 serve보다 먼저
  `127.0.0.1:4317`을 점유하면 Extension·mcp가 그 프로그램에 토큰을 보내게 된다. 시작 시 포트 점검(probe)은 토큰을 보내지 않도록 고쳤다.
  완전한 해결은 토큰을 보내지 않는 챌린지-응답(HMAC) 핸드셰이크로 `auth.hello` 계약을 바꾸는 것이며, 계획의 인증 규약이 달라지므로
  임의로 바꾸지 않았다. 개인 PC 단일 사용자 전제라면 현재 수준으로 두고, 다중 사용자 환경이면 M1 마무리 전에 바꾼다.

## 참고 사항

- 전역 `~/.cargo/config.toml`의 `build.target-dir`이 다른 프로젝트 캐시를 가리킨다. 이 저장소는 `.cargo/config.toml`로 `target/`을 쓴다.
- 전역 OpenCode 설정에는 기존 MCP(playwright 등)가 있다. 수정하지 않고 테스트는 별도 설정으로 격리한다.

## 다음 작업

1. [M1 계획](./plans/2026-10-11-m1-browser-control.md) Task 8(Extension 골격)부터 순서대로 구현.
