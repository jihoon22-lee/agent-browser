# 진행 상태

## 현재 단계

**v0.1.2 배포 완료(main `1b8f0123cf65556a7a386f01a9a5e33731041fd0`), 이 PC 설치 업데이트 완료.**
다음 개선 후보(검토 backlog): [M5 계획](./plans/2026-10-11-m5-usability-polish.md)의 "다음 개선 후보".

**사용자 확인(2026-10-11)**: 사용자가 개인 PC의 WSL OpenCode로 실제 대화와 브라우저 제어가 동작함을 확인했다.
이후 실제 사용 검증(실제 모델 반복 시연, 사내·다른 PC 환경, 로그인 후 자동 실행 등)은 별도의 남은 항목으로 두지 않는다.
실제 사용 중 발견한 문제는 이슈로 받아 처리한다. 이 결정은 이전 Zen 무료 모델 파일럿(HTTP 403, 도구 0건)을 통과로 바꾸지 않는다.

이전 단계의 계획·재개 기록은 git 이력에 있다(M1 계획, M2–M4 계획, 배포 준비 계획, `m1-resume.md`).

## 리뷰 후속 수정 — 로컬 완료 (2026-10-11)

- 기준: 로컬·원격 main `c3243f8419d54e87c073082f9fb6d4fbee150f49`. 시작 시 원격 main과 같았으며 기존 v0.1.2 Stop 수정도 확인했다.
- 격리 worktree의 검토 브랜치: `feat/review-regressions`.
- R01–R11 및 D01 모두 수정·회귀 검증 완료. 원본 main 체크아웃은 변경하지 않았다. 사용자가 승인한 24개 파일을 커밋·푸시하고 main 대상 draft PR로 제출한다. 병합·release·운영 설치 업데이트는 승인 범위에 없다.
- 최종 Windows release exe SHA-256: `212e2f92f70530f3ad0afbfb3469a49df41a16dc187931fb7b0ecdd4fa074d06`.
- 최종 코드·테스트 diff SHA-256: `4f26d4137d173be624d10c8fb0da41d2e3d280c39e62c05d1a2a1dcd6d704de2` (`git diff --binary c3243f8 HEAD -- bridge/src bridge/tests extension/src extension/test | sha256sum`). 이후 수정은 문서뿐이다.
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
