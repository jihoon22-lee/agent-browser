# 진행 상태

## 현재 단계

**v0.1.1 배포 완료(main `4cfae595230db2f359973ef5c2f98c07c550be00`). M5 사용성·성능 개선 1차 구현·검증 완료(미병합, 미배포).**
진행 중 계획: [M5 사용성·성능 개선](./plans/2026-10-11-m5-usability-polish.md).

**사용자 확인(2026-10-11)**: 사용자가 개인 PC의 WSL OpenCode로 실제 대화와 브라우저 제어가 동작함을 확인했다.
이후 실제 사용 검증(실제 모델 반복 시연, 사내·다른 PC 환경, 로그인 후 자동 실행 등)은 별도의 남은 항목으로 두지 않는다.
실제 사용 중 발견한 문제는 이슈로 받아 처리한다. 이 결정은 이전 Zen 무료 모델 파일럿(HTTP 403, 도구 0건)을 통과로 바꾸지 않는다.

이전 단계의 계획·재개 기록은 git 이력에 있다(M1 계획, M2–M4 계획, 배포 준비 계획, `m1-resume.md`).

## 실측 환경 (2026-10-11)

| 항목 | 값 |
|---|---|
| WSL | Ubuntu 26.04.1 LTS, kernel 6.18.33.2-microsoft-standard-WSL2, NAT 네트워킹. WSL PATH에 Windows 경로 없음 → `/mnt/c/...` 절대 경로 |
| Windows | Windows 11 `10.0.26200.9457` AMD64, PowerShell 5.1(pwsh 없음), node·git 있음, Rust 없음 |
| Chrome | 154.0.8037.99 |
| OpenCode | WSL `~/.opencode/bin/opencode` 1.18.29. Windows 검증용 portable 1.18.29는 `AgentBrowser-dev/opencode/1.18.29` |
| WSL 툴체인 | node 24.18.0, pnpm 9.15.9, rustc 1.98.1/1.97.1, cargo-xwin, target `x86_64-pc-windows-msvc` |

## 최신 검증 기준선 (v0.1.1, main `4cfae59`)

| 범위 | 결과 |
|---|---|
| Rust 전체(Linux) | 117/117 통과(부모 테스트가 실행하는 helper 1개 기본 ignored) |
| Extension Vitest | 30파일 242/242 통과, TypeScript/Vite 빌드 통과 |
| Node fixture/runner/interop/문서 helper | 28/28 통과 |
| Linux Chromium 실제 확장 E2E | 47/47 통과(새 탭 9 + 브라우저 26 + 작업 UI 12) |
| 실제 Windows Chrome E2E | 47/47 통과. Windows Node 24.18.1, Chrome 154.0.8037.99, MSVC release exe, 격리 headless 프로필 |
| Windows 설치·런타임 정리·패키징 | 설치 13, 런타임 정리 3, 패키징 3 통과 |
| OpenCode v1 API | 실제 Windows/WSL 1.18.29에서 모델 호출 없이 세션·첨부·SSE·분기·revert 계약 확인 |
| 원격 CI | [PR CI](https://github.com/jihoon22-lee/agent-browser/actions/runs/38126797768), [main CI](https://github.com/jihoon22-lee/agent-browser/actions/runs/38127471889) Linux·Windows 성공 |

## M5 사용성·성능 개선 검증 (2026-10-11, 브랜치 `feat/m5-usability-polish`)

| 범위 | 결과 |
|---|---|
| Extension Vitest | 30파일 249/249 통과(신규·변경: 하위 세션 화살표, 제자리 삭제, 인라인 이름 변경, 이벤트 반영, 메시지 정리, `--bubble` 대비). TypeScript/Vite 빌드 통과 |
| Linux Chromium 실제 확장 E2E | 전체 48/48 통과(W13 세션 삭제 신규, W06·W11 갱신). 이후 이름 변경 상태 초기화 수정 뒤 작업 UI 13/13 재실행 통과 |
| 실제 Windows Chrome E2E | `scripts/test-windows.sh` 전체 48/48 통과(1.0분). Windows Node 24.18.1, Chrome 154.0.8037.99, MSVC release exe, 격리 headless 프로필. 커밋 `fbee2cf` 기준이며 이후의 한 줄 수정(세션 전환 시 이름 변경 상태 초기화)은 Linux에서만 재실행 |
| Node fixture/runner/interop/문서 helper | 28/28 통과. 문서 링크 검사 통과 |
| Rust | 변경 없음, 재실행하지 않음 |

실제 모델 호출은 하지 않았다. 합성 HTTP/SSE fixture만 사용했다.

## 배포

- [v0.1.1 Release](https://github.com/jihoon22-lee/agent-browser/releases/tag/v0.1.1)(비공개 저장소 prerelease). 태그는 main 병합 커밋.
  ZIP `agent-browser-0.1.1-windows-x64.zip` 3,410,517 bytes, 파일 31개, 제3자 고지 163개,
  SHA-256 `11eb24028a265fa24d0a76d60bc725f32c195e20100d3e4c7ff0127da7304efd`. exe SHA-256 `055f81a58681f6418a9ae3bfa3262fd316d9270face30c71d81712654dbf3d8a`.
- [v0.1.0 Release](https://github.com/jihoon22-lee/agent-browser/releases/tag/v0.1.0)는 변경하지 않았다. ZIP SHA-256 `909021621dbf3c578496f760524c233f5a51556ec480adbfb1ccee16cd57ac0f`.
- 이 PC 설치: `%LOCALAPPDATA%\AgentBrowser`를 0.1.1로 업데이트. 프로필 `wsl-main` / Ubuntu / `/home/jihoon/.opencode/bin/opencode` 1.18.29 /
  작업 디렉터리 `/home/jihoon/projects/agent-browser`. Bridge 포트 4317. 페어링 토큰·프로필·전역 OpenCode 설정 보존.

## 알려진 제한

- 인증: Extension·MCP는 토큰을 전송하지 않는 HMAC-SHA256 상호 인증을 쓴다. 구형 인증 클라이언트와 호환되지 않으므로 Bridge와 Extension을 함께 갱신한다.
- 지원하지 않는 대상: Chrome 내부 페이지, OS 대화상자, 닫힌 Shadow DOM, canvas 내부, 백그라운드 전체 페이지 캡처.
- Clippy의 기존 스타일/복잡도 경고가 남아 있다.

## 참고 사항

- 전역 `~/.cargo/config.toml`의 `build.target-dir`이 다른 프로젝트 캐시를 가리킨다. 이 저장소는 `.cargo/config.toml`로 `target/`을 쓴다.
- 전역 OpenCode 설정에는 기존 MCP(playwright 등)가 있다. 수정하지 않고 테스트는 별도 설정으로 격리한다.
- 실제 사용자 설치의 Bridge는 사용을 위해 실행 상태로 유지한다. 검증용 프로세스는 테스트가 끝나면 종료한다.
