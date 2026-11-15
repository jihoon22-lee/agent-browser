# Bridge 런타임 수명: 실패 원인 보존, 제한 시간, 막힌 기록 복구 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCode 시작 실패의 원인이 사용자에게 전달되게 하고, 호출자의 제한 시간과 잠금 대기가 Bridge의 실제 동작 시간과 맞지 않아 생기는 거짓 실패를 없애며, 사라진 WSL 배포판 때문에 중지·삭제·업데이트가 막히는 기록을 풀 수 있게 한다.

**Architecture:** 내부 RPC와 MCP 계약은 그대로 두고 `bridge/src/runtime/`의 오류 문구·분류와 호출자(설치 관리자, 스크립트)의 제한 시간만 고친다. Bridge 자체의 종료 방식(중지 요청, 자가 종료)은 계약·동작 결정이 필요해 이 계획에 넣지 않고 아래 표에 남긴다.

**Tech Stack:** Rust(`rust-toolchain.toml` 고정, tokio), C# 5 설치 관리자, Windows PowerShell 5.1, Windows Node 시나리오(`bridge/tests/windows-runtime.mjs`).

**Spec:** 이 문서의 "근거" 절과 `docs/status.md`의 "Bridge 런타임 실제 Windows·WSL 실행과 관찰 (2026-11-15)".

## Global Constraints

- 내부 RPC 메서드·필드와 MCP 도구 계약을 바꾸지 않는다. 오류의 `code`는 그대로 두고 `message`만 구체화한다.
- 관리 OpenCode는 Bridge가 끝나도 남겨 재사용한다(`docs/architecture.md`의 결정). 이 동작을 바꾸지 않는다.
- 하위 프로세스의 원문 출력을 RPC 오류에 싣지 않는다(`bridge/src/runtime/diagnostics.rs:40-41`의 기존 원칙). 원인은 고정 문구로 전달한다.
- `wsl --shutdown`을 쓰거나 안내하지 않는다. 다른 WSL 작업을 멈추지 않는다.
- Windows 서비스, Named Pipe, Native Messaging을 도입하지 않는다.
- Windows exe는 `cargo xwin build --target x86_64-pc-windows-msvc`로 만들고 `/mnt/c/...`에 복사해 실제 Windows 프로세스로 검증한다. Linux 테스트 결과를 Windows 검증으로 보고하지 않는다.
- 테스트는 합성 fixture만 쓴다. 실제 모델 호출 없음. 전역 OpenCode 설정을 건드리지 않는다.

## 결정이 필요한 것 (이 계획에 넣지 않았다)

| 항목 | 내용 | 기본안 |
|---|---|---|
| Bridge 중지 요청 | Windows에서 Bridge를 끄는 길은 프로세스 kill뿐이다. 종료 계기는 Ctrl+C 하나인데(`bridge/src/lib.rs:65`), 분리된 프로세스 그룹으로 뜬 serve에는 도달하지 않는다(플랫폼 지식, 미추적). kill은 `serve.pid`와 임시 파일을 남긴다 | 인증된 내부 RPC `bridge.stop`(설치 관리자 CLI 전용)을 추가하고 설치 관리자·스크립트가 kill 전에 먼저 호출. 프로토콜 변경이다 |
| 상태 응답에 프로세스 정보 | `status.get`이 serve의 PID·시작 시각·실행 파일을 돌려주면 설치 관리자의 인수 판단이 단순해진다 | 설치 관리자 계획(`installer-overlap-and-bridge-adoption.md`)은 이것 없이 `serve.pid`와 WMI로 처리한다. 추가는 선택 |
| 자가 종료 | 데이터 폴더가 지워져도 serve가 포트를 잡고 있다가 폴더를 다시 만든다(`bridge/src/runtime/storage.rs:41`, `bridge/src/server/conn.rs:113`). 같은 위치 재설치가 "소유 표식 없는 데이터"로 막힌다 | 60초마다 `config.json`을 확인해 없거나 토큰이 메모리와 다르면 종료하고, serve가 데이터 폴더를 새로 만들지 않는다. 동작 변경이다 |
| WSL 그룹 밖 자손 | 중지는 서버의 프로세스 그룹에만 신호를 보낸다(`bridge/src/runtime/mod.rs:764`). 세션을 떠난 자손은 남는다 | OpenCode 1.18.29·1.19.x가 실제로 그런 자식을 만드는지 먼저 확인한다. 만든다면 `AGENT_BROWSER_RUNTIME_ID` 표식으로 `/proc/*/environ`을 훑어 정리 |
| 확정 실패의 조기 종료 | v1이 아닌 서버나 인증 거부처럼 기다려도 바뀌지 않을 실패도 60초를 다 기다린다 | 같은 확정 사유가 연속 5회면 대기를 끝낸다. 패널을 열 때마다 타는 경로의 동작 변경이라, "처음 몇 초는 401, 그 뒤 정상" fixture와 실제 OpenCode 시작 확인이 함께 필요하다 |
| kill 직전 재확인 | 설치 관리자는 WMI로 확인한 뒤 PID로 kill한다(`installer/InstallerEngine.cs:447`, `scripts/installer-common.ps1:456`). 그 사이 PID가 재사용될 수 있는 창은 밀리초다 | 프로세스 핸들을 먼저 열고 그 핸들의 시작 시각을 비교한 뒤 같은 핸들로 종료. 낮은 우선순위 |

## 근거

**실제로 실행한 것 (2026-11-15, 실제 Windows·WSL, 합성 fixture)**
- `windows-runtime.mjs`의 `cmd/cmd-tree-stop`, `cmd/healthy-fixture`와 `wsl/healthy-fixture`, `concurrent-callers`, `previous-boot`, `startup-crash`, `orphan-leader`, `wsl-start-failure`, `wsl-unknown-marker`가 통과했다. 이 계획의 수정은 이 시나리오들을 깨뜨리면 안 된다.
- 없는 배포판 이름으로 `wsl.exe -d <이름> --exec /bin/true`를 실행하면 종료 코드 255, `WSL_E_DISTRO_NOT_FOUND`다.

**코드로 확인한 것**
1. **시작 실패 원인 유실.** 준비 대기 루프가 `health(...)`의 오류를 매번 버린다(`bridge/src/runtime/mod.rs:193`의 `let Ok(version) = health(…)`). 60초 뒤 `OpenCode HTTP and browser MCP did not become ready within 60 seconds. Check the executable/version, port, WSL localhost forwarding, directory, and environment.`만 돌려준다(`:210`). v1이 아닌 서버, 인증 거부, 브라우저 MCP 실패가 모두 같은 문구다. `docs/architecture.md`는 "원인을 보고한다"고 적고 있다.
2. **알 수 없는 WSL 상태.** 프로브의 예상 밖 종료 코드는 전부 `WslState::Unknown`이 된다(`mod.rs:645-652`). 255(배포판 없음)도 여기에 든다.

**검토 에이전트가 추적한 것 (직접 재확인하지 않음 — 각 과제의 첫 단계가 실패 테스트로 확인한다)**
3. `Unknown` 상태에서는 중지가 오류를 내고 기록을 남기며(`mod.rs:299`, `:323-324`), 삭제·저장이 그 오류로 막히고(`:123`, `:96-97`, `:544`), 설치 관리자의 업데이트·제거가 중단된다(`installer/InstallerEngine.cs:517`, `scripts/uninstall.ps1:66-67`).
4. 설치 관리자는 `runtime start`를 60초 제한으로 부른다(`installer/InstallerEngine.cs:349`, `scripts/uninstall.ps1:93`). Bridge의 60초 준비 대기는 실행 이후부터 세고, WSL은 그 전에 20초 사전 점검 두 번과 20초 keeper 대기가 있을 수 있다(`bridge/src/runtime/interop.rs:27`, `:118`). 마법사는 이미 90초를 쓴다(`installer/ProfileForm.cs:65`).
5. serve가 프로필 잠금 파일을 쥐고 있는 동안(상태 점검, 최대 60초의 ensure) 다른 프로세스의 `runtime stop-all`은 기다리지 않고 바로 실패한다(`mod.rs:106`). 업데이트·제거가 "A managed runtime could not be stopped"로 중단된다.
6. `serve.log`는 시작할 때만 크기를 확인해 자른다(`bridge/src/lib.rs:36`). 오래 켜 둔 serve에서는 계속 커진다.

## Review Focus

- 원인 문구를 붙인 뒤에도 패널의 한국어 오류 안내가 그대로 나와야 한다. 확장은 Bridge의 영문 문장으로 안내를 고른다(Task 1의 확장 테스트).
- 배포판이 "없음"과 "꺼져 있음"은 다르다. 꺼진 배포판의 기록을 지우면 안 된다(Task 2의 음성 테스트).
- `wsl.exe` 자체가 없거나 WSL이 설치되지 않은 PC에서 WSL 프로필 기록을 지울 수 있어야 하는지(Task 2: 목록 조회 실패 시 지금처럼 보존).
- 잠금 대기를 넣은 뒤 두 CLI가 서로를 기다리며 멈추면 안 된다(Task 3: 대기 상한과 한쪽만 대기).
- 로그 크기 제한이 쓰기 도중 줄 중간을 잘라 진단에 쓸 수 없는 파일을 만들면 안 된다(Task 4).

---

### Task 1: 시작 실패의 마지막 원인을 오류에 싣는다

**Files:**
- Modify: `bridge/src/runtime/mod.rs:184-211`(준비 대기 루프)
- Test: `bridge/tests/runtime_management.rs`(fixture: `bridge/tests/fixtures/opencode-server.cjs`, `bridge/tests/common/runtime_fixture.rs`)

**Interfaces:**
- Produces: 기존 두 실패 문장은 **한 글자도 바꾸지 않고** 그 뒤에 ` Last check: <사유>.`를 붙인다. 확장이 이 문장에 묶여 있다: `extension/src/sidepanel/error-text.ts:18`이 `did not become ready within 60 seconds`로 한국어 안내를 고르고, `extension/test/error-text.test.ts`는 Rust 소스에 샘플 문장이 그대로 있는지 검사한다(`doctor-checks.test.ts`, `workbench.test.ts`도 같은 문장을 쓴다). 문장 리터럴은 소스에 연속된 문자열로 남겨 둔다. `<사유>`는 `health`·`browser_mcp`가 이미 만드는 고정 문구다. 60초 대기는 그대로다.

- [ ] **Step 1: 실패하는 테스트** — fixture 서버가 (a) v1이 아닌 문서를 돌려줄 때, (b) Basic 인증을 거부할 때, (c) 브라우저 MCP 상태를 `failed`로 돌려줄 때(`AGENT_BROWSER_FIXTURE_MCP_STATUS=failed`, 기존 `mcp-failure` 시나리오와 같은 조건) `runtime.ensure`의 오류 메시지가 기존 문장으로 시작하고 뒤에 각 사유 문구가 붙어 있음을 단언한다. 음성: 준비에 시간이 걸리다 성공하는 fixture(`AGENT_BROWSER_FIXTURE_MCP_DELAY_MS=3000`)는 지금처럼 `ready`. 확장 쪽: `extension/test/error-text.test.ts`에 사유가 붙은 메시지도 같은 한국어 안내로 분류되고 사유가 접힌 원문에 남는 케이스를 추가한다.
- [ ] **Step 2: 실패 확인** — Run: `cargo test -p agent-browser-bridge --test runtime_management`.
- [ ] **Step 3: 구현** — 루프에서 `health`와 `browser_mcp`의 `Err`를 `last_reason`에 보관하고 마지막 오류에 붙인다. 대기 시간과 종료 조건은 바꾸지 않는다. 메시지에 하위 프로세스 출력이나 URL·비밀번호를 넣지 않는다.
- [ ] **Step 4: 통과 확인** — 같은 명령, `cargo test -p agent-browser-bridge --lib runtime`, 그리고 `cd extension && pnpm exec vitest run test/error-text.test.ts test/doctor-checks.test.ts test/workbench.test.ts`.
- [ ] **Step 5: Windows 확인** — MSVC exe로 `RUNTIME_KIND=cmd`의 `health-failure`와 `mcp-failure`, `healthy-fixture`를 실행한다(`docs/testing.md`의 `windows-runtime.mjs` 절차). `health-failure`의 기대 메시지 단언을 새 형식에 맞춘다.
- [ ] **Step 6: Commit** — `fix(runtime): report why a managed OpenCode start failed`

### Task 2: 사라진 WSL 배포판의 기록을 정리할 수 있게 한다

**Files:**
- Modify: `bridge/src/runtime/mod.rs`(`wsl_state_code` 645행 부근, `stop_inner`), 필요하면 `bridge/src/runtime/interop.rs`
- Test: `bridge/src/runtime/interop_tests.rs` 또는 `bridge/tests/runtime_management.rs`, `bridge/tests/windows-runtime.mjs`(새 시나리오 `wsl-unregistered`)

**Interfaces:**
- Produces: `WslState::Unregistered` — 프로브가 실패했고 `wsl.exe --list --quiet`의 목록에 그 배포판 이름이 없을 때만. 이 상태에서 stop·delete는 기록을 지우고 성공한다(그 배포판 안에는 프로세스가 있을 수 없다). 목록 조회가 실패하거나 이름이 있으면 지금처럼 `Unknown`으로 보존한다.

- [ ] **Step 1: 추적 내용을 실패 테스트로 확인** — `windows-runtime.mjs`에 `wsl-unregistered`: 프로필의 배포판을 존재하지 않는 이름(`AbNoSuchDistro-<난수>`)으로 두고 `runtime.json`에 이전 실행의 기록을 심는다(기존 `previous-boot` 시나리오가 기록을 심는 방식). 단언: `runtime.stop`이 성공하고 기록이 사라진다, `profile.delete`가 성공한다. 음성: 기존 `wsl-unknown-marker`(배포판은 있고 표식만 없음)는 그대로 기록을 보존한다.
- [ ] **Step 2: 실패 확인** — Run: 실제 Windows에서 `RUNTIME_KIND=wsl RUNTIME_SCENARIO=wsl-unregistered`. Expected: stop이 오류를 내고 기록이 남는다(근거 3). 통과한다면 추적이 틀린 것이므로 이 과제는 시나리오만 남기고 끝낸다.
- [ ] **Step 3: 구현** — 목록 출력은 UTF-16LE다. 이름 비교는 대소문자를 무시한다. 판정 함수는 순수 함수(`fn unregistered(listing: &str, name: &str) -> bool`)로 떼어 단위 테스트한다(빈 목록, 다른 이름만 있음, 같은 이름이 대소문자만 다름).
- [ ] **Step 4: 통과 확인** — 단위 테스트, 그리고 Windows에서 `wsl-unregistered`, `wsl-unknown-marker`, `previous-boot`, `healthy-fixture`.
- [ ] **Step 5: Commit** — `fix(runtime): clear the record of a WSL distribution that no longer exists`

### Task 3: 호출자의 제한 시간과 잠금 대기를 Bridge의 실제 시간에 맞춘다

**Files:**
- Modify: `installer/InstallerEngine.cs:349`, `scripts/uninstall.ps1:93`
- Modify: `bridge/src/runtime/mod.rs:106` 부근(프로필 파일 잠금 획득)
- Test: `bridge/tests/runtime_management.rs`, `tests/install/InstallerReviewTests.cs`

**Interfaces:**
- Produces: CLI의 변경 명령(`runtime stop`, `stop-all`, `profile delete`)은 프로필 파일 잠금을 최대 10초 기다린다. serve 안의 요청은 지금처럼 기다리지 않는다(상호 대기 방지). 설치 관리자·스크립트의 `runtime start` 제한은 150,000ms(준비 60초 + WSL 사전 점검 최대 60초 + 여유).

- [ ] **Step 1: 실패하는 테스트** — (a) 한 프로세스가 프로필 잠금을 3초 쥐고 있는 동안 CLI `runtime stop-all`을 실행하면 잠금이 풀린 뒤 성공한다. 잠금이 12초 유지되면 기존 문구(`Another operation is already managing this profile…`)로 실패한다. (b) `InstallerReviewTests`의 합성 Bridge(`SyntheticBridge`)가 `runtime start`에 70초 걸리게 한 업데이트가 성공한다.
- [ ] **Step 2: 실패 확인** — Run: `cargo test -p agent-browser-bridge --test runtime_management`, 그리고 `NativeEngineTests`.
- [ ] **Step 3: 구현** — 잠금 대기는 CLI 진입점에서만 켠다(대기 여부를 인자로 받는다). 제한 시간 상수 두 곳을 바꾼다.
- [ ] **Step 4: 통과 확인 후 Commit** — `fix(runtime): wait briefly for a busy profile and give starts enough time`

### Task 4: serve 로그를 쓰는 동안에도 제한한다

**Files:**
- Modify: `bridge/src/lib.rs:30-45`(`init_logging`)
- Test: `bridge/src/lib.rs`의 단위 테스트

**Interfaces:**
- Produces: 로그 파일이 `MAX_LOG_BYTES`를 넘으면 다음 줄을 쓰기 전에 파일을 비우고 `log truncated`를 첫 줄로 쓴다. 줄 중간에서 자르지 않는다.

- [ ] **Step 1: 실패하는 테스트** — 작은 한도(1,024바이트)로 만든 로그 쓰기 객체에 200바이트 줄을 20번 쓴 뒤 파일 크기가 한도 + 한 줄 이하이고, 파일의 첫 줄이 `log truncated`이며 모든 줄이 온전함을 단언.
- [ ] **Step 2: 실패 확인** — Run: `cargo test -p agent-browser-bridge --lib log`.
- [ ] **Step 3: 구현** — 한도를 인자로 받는 줄 단위 쓰기 객체를 만들어 `init_logging`이 쓴다.
- [ ] **Step 4: 통과 확인 후 Commit** — `fix(bridge): keep serve.log bounded while the Bridge runs`

### Task 5: 전체 검증과 기록

- [ ] **Step 1** — `cargo test -p agent-browser-bridge`, `cargo clippy -p agent-browser-bridge --all-targets`(기존 스타일 경고 17건 외 새 경고 없음).
- [ ] **Step 2** — MSVC exe로 `windows-runtime.mjs`의 근거 절 시나리오 9개와 새 `wsl-unregistered`, 그리고 `health-failure`·`mcp-failure`를 실행한다. 실행 뒤 Windows·WSL에 남은 프로세스와 `%TEMP%\ab-runtime-*` 폴더가 없는지 확인한다.
- [ ] **Step 3** — `docs/architecture.md`의 "실행 프로필과 프로세스 수명", `docs/troubleshooting.md`의 런타임 오류 문구, `docs/protocol.md`("런타임과 진단"의 오류 메시지 예), `CHANGELOG.md`, `docs/status.md`를 갱신한다. 2026-11-11의 보류 항목 "등록 해제된 WSL 배포판의 복구 경로"를 해결로 옮긴다.
- [ ] **Step 4** — push → PR → CI → 병합·출시는 `AGENTS.md`의 Git 절. 이 계획 파일은 완료 후 삭제한다.
