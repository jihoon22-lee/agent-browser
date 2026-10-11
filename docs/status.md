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
| 2026-10-11 | M1 Task 3: `cargo test -p agent-browser-bridge --lib config`(Linux). `browser-bridge pair`를 한글·공백 경로의 `AGENT_BROWSER_HOME`으로 Linux에서 수동 실행 | 5/5 통과, 토큰 64자 출력 |

## 미검증

- Windows Chrome → WSL `opencode serve`의 localhost 접속(NAT localhostForwarding).
- Windows 네이티브 OpenCode 경로 전체.
- Zen 무료 모델의 도구 호출 능력.
- Chrome 정책에 의한 압축해제 확장 로드 제한 여부(개발용 프로필에서 확인 예정).
- 사내 Windows / 사내 WSL Ubuntu 24 전체.

## 참고 사항

- 전역 `~/.cargo/config.toml`의 `build.target-dir`이 다른 프로젝트 캐시를 가리킨다. 이 저장소는 `.cargo/config.toml`로 `target/`을 쓴다.
- 전역 OpenCode 설정에는 기존 MCP(playwright 등)가 있다. 수정하지 않고 테스트는 별도 설정으로 격리한다.

## 다음 작업

1. [M1 계획](./plans/2026-10-11-m1-browser-control.md) Task 4(serve 리스너·인증)부터 순서대로 구현.
