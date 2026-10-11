# 개발·변경 안내

먼저 [AGENTS.md](AGENTS.md), 요구사항 원장 [handoff](docs/handoff.md),
현재 [상태](docs/status.md)를 읽습니다. OpenCode 계약은 저장된 1.18.29 명세가 우선이며 v2 API를 사용하지 않습니다.

## 준비와 검증

Node 24, pnpm 9.15.9와 `rust-toolchain.toml`에 고정한 Rust를 준비합니다.
의존성은 `pnpm install --frozen-lockfile`, `cargo fetch --locked`로 설치합니다.
Linux E2E 개발 환경은 `pnpm --filter agent-browser-e2e exec playwright install --with-deps chromium`으로 테스트 브라우저를 준비합니다.
제품 실행 사용자는 이 개발 도구를 설치할 필요가 없습니다.

과제마다 실패하는 테스트를 먼저 만들고 관련 검증을 실행합니다. 전체 검증과 Windows 실행 절차는
[테스트 문서](docs/testing.md)를 따릅니다. Linux Bridge는 테스트용이며 Windows 지원의 증거가 아닙니다.
Windows exe는 실제 Windows 프로세스와 Chrome에서 검사합니다.

사용자의 전역 OpenCode 설정을 바꾸지 않습니다. 실제 모델 검증이 별도로 요청되지 않았다면
결정적 fixture만 사용합니다. 모델 테스트를 수행할 때도 검증된 Zen 무료 모델만 사용하고 유료 fallback을 두지 않습니다.
토큰·실제 대화·업무 페이지·개인 설정을 테스트나 산출물에 포함하지 않습니다.

## 변경·PR·머지

- 기능 브랜치에서 과제 단위 영어 Conventional Commits를 작성합니다. 의존성 버전과 lockfile을 함께 유지합니다.
- 사용자 동작이 달라지면 `CHANGELOG.md`, 사용/설치/문제 해결 안내와 지원 범위를 갱신합니다.
- PR은 문제와 변경 후 동작, 실제 실행한 검사, 남은 한계를 설명합니다. 미실행을 통과로 표시하지 않습니다.
- CI와 검토 결과를 확인하고 결함을 수정한 뒤 main에 머지합니다. 로컬 Windows 증거와 GitHub Windows runner 증거를 구분합니다.
- push·PR·머지·Release 등 원격 작업은 해당 작업에서 사용자가 허용한 범위 안에서 수행합니다.

CI의 Linux·Windows 작업은 모델을 호출하지 않습니다. 사내 정책, 사용자 OpenCode 설정과 실제 모델 판단은
CI가 검증한 것으로 해석하지 않습니다. 현재 코드의 기존 clippy 경고는 별도 기록하며 경고가 없다고 보고하지 않습니다.

## 배포

버전 동기화, 문서 포함 zip, 체크섬, PR·CI·main·태그의 순서는
[설치·패키징 문서](docs/installation.md)를 따릅니다. 이미 배포한 zip이나 태그를 수정하지 않고 새 패치 버전을 만듭니다.
MIT 라이선스와 제3자 고지를 유지합니다.
