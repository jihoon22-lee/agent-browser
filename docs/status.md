# 진행 상태

## 현재 단계

**v0.1.2 배포 완료(main `1b8f0123cf65556a7a386f01a9a5e33731041fd0`), 이 PC 설치 업데이트 완료.**
다음 개선 후보(검토 backlog): [M5 계획](./plans/2026-10-11-m5-usability-polish.md)의 "다음 개선 후보".

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
