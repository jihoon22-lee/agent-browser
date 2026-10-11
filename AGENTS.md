# AGENTS.md

AgentBrowser(가칭)는 기존 OpenCode v1의 에이전트로 사용자의 Windows Chrome을 읽고 조작하고,
그 작업을 Chrome 안에서 지시·확인·관리하는 도구다. 산출물은 Chrome Extension과
Windows용 Browser Bridge(`browser-bridge.exe`) 두 가지다.
원격은 `https://github.com/jihoon22-lee/agent-browser`(private)다.

## 먼저 읽을 문서

- 요구사항 원장: [docs/handoff.md](./docs/handoff.md). 이미 정한 내용을 다시 일반론으로 되돌리거나 사용자에게 재질문하지 않는다.
- 현재 상태·검증 기록: [docs/status.md](./docs/status.md). 실제 실행한 것과 미검증을 구분해 갱신한다.
- 실행 계획: `docs/plans/`의 미완료 계획. 완료된 계획을 새 작업의 원장으로 쓰지 않는다.
- OpenCode API 근거: [docs/opencode-v1-compatibility.md](./docs/opencode-v1-compatibility.md)와
  설치본에서 받은 [OpenAPI 명세](./docs/reference/opencode-1.18.29-openapi.json). 공개 최신 문서·v2 예제보다 이것이 우선이다.

## 범위 규칙

- 최우선은 실제 브라우저 제어(M1)다. 채팅 UI로 이를 대체하거나 미루지 않는다.
- 제외 범위(handoff §2): 자체 에이전트 하네스, ACP/Native Messaging/Windows 서비스/Named Pipe,
  Linux·macOS Bridge, 다중 하네스 어댑터, SSO·RBAC·DLP, 자동 업데이트, 원격 telemetry.
- OpenCode는 v1 경로만 쓴다. 설치된 1.18.29 서버는 `/api/*` v2 경로도 함께 노출하지만 사용하지 않는다.
- 사용자의 전역 OpenCode 설정(`~/.config/opencode/opencode.json`)을 개발·테스트 때문에 수정하지 않는다.
  테스트는 프로젝트 단위 설정 또는 `OPENCODE_CONFIG`로 격리한다.
- 테스트 LLM은 OpenCode Zen 무료 모델만 쓴다. 모델 ID를 제품 코드에 하드코딩하지 않는다.

## 구현과 검증

- Extension: Manifest V3 + TypeScript + React + Vite, 패키지 매니저 pnpm 9.
- Bridge: Rust(`rust-toolchain.toml` 고정). Windows exe는 WSL에서
  `cargo xwin build --target x86_64-pc-windows-msvc`로 만들고, `/mnt/c/...`에 복사해 interop으로
  실제 Windows 프로세스로 실행해 검증한다. Linux 바이너리 테스트를 Windows 검증으로 보고하지 않는다.
- WSL의 PATH에는 Windows 경로가 없다. `wsl.exe`·`powershell.exe` 등은 `/mnt/c/Windows/System32/...` 절대 경로로 호출한다.
- cargo 빌드 산출물은 저장소의 `target/`에 둔다(`.cargo/config.toml`). 전역 target-dir을 쓰지 않는다.
- 의존성은 검증한 정확한 버전으로 고정하고 lockfile을 커밋한다. 실행 시 패키지를 내려받는 구성을 만들지 않는다.
- 과제 단위로 실패하는 테스트를 먼저 쓰고, 그 테스트와 직접 영향받는 테스트만 실행한다. 전체 검증은 마일스톤 끝에 모은다.
- 실행하지 않은 테스트·Windows 검증을 통과로 보고하지 않는다. 결과는 docs/status.md에 기록한다.
- 사용자 데이터·실제 대화·웹페이지 원문·비밀정보를 fixture나 Release에 넣지 않는다.

## Git

- 커밋은 영어 Conventional Commits, 과제 단위. 작성자 이메일은 저장소 로컬 설정의 GitHub noreply 주소를 쓴다.
- 기본 브랜치는 `main`. 마일스톤 작업은 `feat/<milestone>-<topic>` 브랜치에서 진행한다.
- push·PR·Release·저장소 설정 변경은 사용자 요청이 있을 때만 한다.
