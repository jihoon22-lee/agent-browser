# AgentBrowser

기존 OpenCode v1 에이전트로 Windows Chrome을 읽고 조작하고, Chrome 사이드 패널에서 작업을 지시·확인·중단하는 도구입니다.
Windows 네이티브와 WSL OpenCode 모두 같은 Windows Bridge를 사용합니다.

## 처음 사용하기

[GitHub Releases](https://github.com/jihoon22-lee/agent-browser/releases)에서 Windows x64 zip을 받습니다.
zip은 다운로드 폴더 등 **아무 임시 폴더에 압축 해제**하고 `setup.ps1`을 실행합니다.
설치 프로그램이 고정 설치 경로에 파일을 복사합니다. 그 경로에 직접 압축을 풀 필요는 없습니다.
기본 설치 위치는 `%LOCALAPPDATA%\AgentBrowser`이며, `D:\Multimedia\AgentBrowser` 같은 별도 위치는 `-InstallDir`로 지정합니다. Chrome에는 실제 설치 폴더 아래 `extension`을 로드합니다.

설치만 마쳤다면 **Chrome 확장 로드 → 토큰 페어링 → 패널의 실행 환경 선택 → 새 세션** 순서로 진행합니다.
실행할 버튼과 명령은 [설치·첫 연결 안내](README-install.md)와 [사용 안내](docs/user-guide.md)에 있습니다.
기존 OpenCode v1 설치는 필요하지만 Node.js·Rust·Python은 제품 실행에 필요하지 않습니다.

| 필요한 정보 | 문서 |
|---|---|
| 설치 위치, Chrome 연결, 업데이트·제거 | [설치 안내](README-install.md) |
| 첫 작업, 세션·모델, 첨부·질문·권한·중단·내보내기 | [사용 안내](docs/user-guide.md) |
| 연결/실행/모델 오류와 진단 | [문제 해결](docs/troubleshooting.md) |
| 버전별 변경과 제한 | [CHANGELOG](CHANGELOG.md) |
| 저장·전송되는 데이터와 보안 신고 | [보안 안내](SECURITY.md) |
| 제품 라이선스 | [MIT LICENSE](LICENSE) |

## 지원 범위

- Windows x64 Bridge, Chrome MV3 확장, 기존 OpenCode v1. 실제 계약 기준은 **1.18.29**입니다.
- 탭·페이지 읽기/조작, 작업 탭 고정, 중단과 타임라인, Windows/WSL 자동 실행.
- 세션·모델·에이전트·스트리밍, 질문·권한, 파일/브라우저 참조, 사용량·압축·diff·내보내기.
- 사용자 영역 설치, Startup 등록, 수동 업데이트와 소유 파일·프로세스만 제거.

현재는 시험 배포입니다. 결정적 브라우저·API·설치 검증과 실제 모델 판단은 구분합니다.
실제 모델 작업 수행과 사내 환경은 사용자 검증 대상으로 남아 있습니다. 닫힌 Shadow DOM·canvas 내부·OS 대화상자·대화형 터미널은 지원하지 않습니다.
세부 호환성은 [OpenCode v1 지원표](docs/opencode-v1-compatibility.md), 실행 증거는 [상태](docs/status.md)를 확인하세요.

## 개발·검증·배포

[개발 안내](CONTRIBUTING.md)에서 시작하세요. 요구사항은 [handoff](docs/handoff.md), 작업 규칙은 [AGENTS.md](AGENTS.md)입니다.
[아키텍처](docs/architecture.md), [프로토콜](docs/protocol.md), [화면·테마 설계](docs/ui-design.md), [테스트](docs/testing.md),
[패키징·PR·CI·Release 절차](docs/installation.md)를 따릅니다.

`extension/`은 Chrome 확장, `bridge/`는 Windows exe, `protocol/`은 내부 계약,
`scripts/`와 `tests/`는 빌드·설치·검증 도구입니다. CI는 모델을 호출하지 않습니다.
