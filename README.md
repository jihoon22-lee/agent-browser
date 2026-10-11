# AgentBrowser (가칭)

기존 OpenCode v1 에이전트가 사용자의 Windows Chrome을 읽고 조작하고, 그 작업을 Chrome 사이드 패널에서 지시·확인·관리하는 도구다.

- 브라우저 탭·페이지 읽기와 조작, 작업 중단, Chrome 프로필 선택
- Windows·WSL의 기존 OpenCode 자동 실행·재사용, 외부 서버 연결과 진단
- 모델·agent 선택, 세션과 파일 입력, 질문·권한 응답, 도구 결과·사용량·압축 표시
- 관리자 권한 없는 사용자 설치, 로그인 자동 시작, 업데이트·제거

배포 zip을 압축 해제한 뒤 Windows PowerShell에서 `powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1`을 실행한다. 기본 설치 위치는 `%LOCALAPPDATA%\AgentBrowser`이며 Chrome에는 그 아래 `extension` 폴더를 로드한다. 기존 OpenCode는 별도로 준비해야 한다. 페어링과 실행 프로필 설정까지 [설치 안내](README-install.md)를 따른다.

현재 구현·검증·남은 사용자 확인은 [상태 문서](docs/status.md)에 기록한다. 실제 모델 작업 검증은 배포 후 사용자가 수행한다.

| 디렉터리 | 역할 |
|---|---|
| `extension/` | MV3 Extension, 브라우저 제어, OpenCode v1 작업 UI |
| `bridge/` | Windows Bridge, MCP stdio 프록시, 실행 프로필·런타임 관리 |
| `protocol/` | 내부 RPC 스키마와 합성 fixture |
| `scripts/` | 빌드·패키징·설치·제거·검증 도구 |
| `docs/` | [요구사항](docs/handoff.md), [아키텍처](docs/architecture.md), [프로토콜](docs/protocol.md), [패키징](docs/installation.md) |
