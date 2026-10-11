# 아키텍처

요구사항 원장은 [handoff.md](./handoff.md)이고, API 계약은 저장소의 [OpenCode v1 호환성 문서](./opencode-v1-compatibility.md)와 [1.18.29 OpenAPI 명세](./reference/opencode-1.18.29-openapi.json)를 따른다. 구현과 검증 결과는 [status.md](./status.md)에서 구분한다.

```text
Windows Chrome
  └─ Chrome Extension (MV3)
       ├─ Side Panel ── HTTP + SSE ──> OpenCode serve (v1, Basic 인증)
       │                               Windows / WSL / 기존 외부 서버
       ├─ Options / Service Worker
       │    ↕ ws://127.0.0.1:4317/extension
       │  browser-bridge.exe serve   (해당 사용자·설정·포트의 상주 프로세스)
       │    ├─ 프로필 저장, 관리 OpenCode 시작·재사용·종료·진단
       │    ↕ ws://127.0.0.1:4317/mcp-proxy
       │  browser-bridge.exe mcp     (OpenCode 연결마다 실행, stdout은 MCP 전용)
       │    ↕ MCP stdio
       │  OpenCode (WSL에서도 interop으로 같은 Windows exe 실행)
       └─ Content Scripts ── 선택한 작업 탭의 DOM 읽기·조작
```

## 책임과 통신 경로

| 목적 | 경로와 책임 |
|---|---|
| 대화·모델·세션·질문·권한 | Side Panel → OpenCode HTTP API/SSE. OpenCode가 에이전트 실행과 모델 호출을 담당 |
| 브라우저 도구 | OpenCode → MCP stdio → Bridge mcp → Bridge serve → Extension SW → content script |
| 실행 환경 | Options/Side Panel → SW → 인증된 Bridge RPC → 저장된 프로필에 따라 OpenCode 관리 |
| CLI와 패널 병행 | Bridge `attach --profile` → 같은 관리 OpenCode 서버에 기존 CLI 연결 |
| 설치·로그인 시작 | PowerShell 설치 스크립트 → 사용자 Startup 바로가기 → Bridge `start` |

Bridge는 LLM을 직접 호출하거나 별도 에이전트 하네스를 구현하지 않는다. Extension은 설정된 loopback Bridge에 접속하며 MCP 서버를 자동 검색하지 않는다. HTTP/SSE 어댑터는 non-`/api` v1 경로만 사용하고 `/api/*`, `/tui/*`, 공유 API를 거부한다.

## 실행 프로필과 프로세스 수명

`bridge/src/runtime/`이 Windows, WSL, 외부 서버 프로필을 관리한다. `runtime.json`에는 프로필·기본 프로필 ID·관리 런타임 소유권을 저장한다. 프로필 작업 잠금과 설정 쓰기 잠금은 별도 CLI 프로세스에서도 적용된다. 관리 런타임 기록이 있는 프로필은 먼저 중지한 뒤 수정한다.

| 프로필 | 실행과 소유권 |
|---|---|
| Windows | 지정된 기존 OpenCode exe 또는 `.cmd` 런처를 절대 작업 경로에서 실행. PID·생성 시각·실행 경로와 listener의 소유 관계 확인 |
| WSL | 명시한 배포판·선택적 사용자·Linux 절대 경로로 실행. 별도 프로세스 그룹, PID·시작 tick·instance 표식, Linux listener 및 Windows WSL 전달 프로세스 확인 |
| 외부 서버 | 사용자가 실행한 서버의 v1 API와 인증 확인. Bridge가 시작·종료하지 않음. 원격은 HTTPS, loopback은 HTTP도 허용 |

`runtime.ensure`는 소유권과 인증된 v1 health/API 명세를 확인한 서버를 재사용한다. 관리 서버가 없으면 `127.0.0.1`에 시작하며 기본 4096 포트가 사용 중이면 빈 포트를 선택한다. 사용자가 지정한 포트의 충돌은 오류다. 요청한 서버가 60초 내 검증되지 않으면 관리 프로세스 정리를 시도하고 원인을 보고한다. 이름만 같거나 포트만 열린 다른 프로세스를 관리 서버로 간주하지 않는다.

관리 서버에는 임의의 Basic 인증 비밀번호와 페어링된 확장 Origin의 CORS 설정을 전달한다. `--pure`는 설치된 OpenCode 1.18.29의 순수 v1 서버 경로를 사용하기 위한 옵션이다. `OPENCODE_CONFIG_CONTENT` overlay는 기존 모델·provider·인증·다른 MCP 설정을 유지하면서 해당 관리 프로세스의 `mcp.browser`를 구성한다. 전역 OpenCode 설정 파일을 쓰지 않는다. WSL에서도 MCP는 설치된 Windows Bridge exe를 호출한다.

Bridge가 종료되어도 관리 OpenCode는 유지되므로 Bridge 재시작·업데이트 뒤 같은 서버를 재사용할 수 있다. 명시적 중지·프로필 삭제·제품 제거는 소유권이 확인된 관리 프로세스만 종료한다. 종료를 확인할 수 없으면 소유권 기록을 남겨 후속 진단·재시도를 가능하게 한다. 외부 서버의 MCP 등록은 그 서버의 설정에서 별도로 수행한다.

## 작업 UI와 재연결

`extension/src/agents/opencode-v1/`은 저장된 명세의 타입, HTTP/SSE 클라이언트, 사용량 계산을 담당한다. Side Panel은 서버가 반환한 연결된 provider의 모델, agent, command, skill 목록을 사용한다. 모델 ID나 외부 모델 카탈로그를 제품에 고정하지 않는다.

패널은 세션 생성·검색·이름 변경·삭제·분기·revert, 텍스트와 파일 입력, 도구 결과·todo·diff·자식 세션, 질문·권한 응답, 수동 압축 및 JSON/Markdown 내보내기를 제공한다. 대화와 실행 상태의 원본은 OpenCode다. 대화 삭제·revert는 이미 완료된 웹사이트 작업을 되돌리지 않는다.

각 연결은 프로필과 `directory`를 고정하고 SSE를 구독한다. 연결 복구 시 메시지·세션 상태·미응답 질문과 권한을 다시 읽는다. 서버 이벤트 replay를 가정하지 않으며, snapshot과 겹친 텍스트 delta는 재조회하여 중복 반영을 피한다. 프로필·세션 전환 전의 비동기 응답은 새 화면 상태에 반영하지 않는다. 변경 HTTP 요청은 자동 재전송하지 않는다.

사용량은 로드된 해당 세션의 OpenCode 메시지/step 데이터에서 계산한다. 최근 호출·현재 사용자 요청·세션 누적을 구분하고, step와 메시지의 중복을 제외한다. 컨텍스트는 최근 호출 기반 추정이며 모델 한도·압축 상태·모델 변경 여부를 함께 표시한다. 값이 없으면 0으로 꾸미지 않는다.

## 브라우저 작업과 인증 경계

- Extension은 `webNavigation`의 프레임/documentId를 확인하고 해당 문서에만 content 명령을 보낸다. snapshot 번호는 Extension 세션 전체에서 증가하며 탭·프레임·문서 소유 정보를 저장한다.
- 취소는 operationId/requestId 범위다. 선택한 브라우저가 바뀌어도 취소는 작업의 원래 소유자에게 전달된다. 패널은 확인된 operation과 OpenCode 세션의 연결을 이용해 서버 응답도 중단한다.
- 실행 중 쓰기 기록은 SW 재시작 뒤에도 재실행하지 않는다. 완료 결과는 10분/최근 200개 캐시이고, 중단된 in-flight 표시는 브라우저 세션 동안 유지한다. 프로세스를 가로지르는 exactly-once 보장은 아니다.
- 로컬 WebSocket은 HMAC-SHA256 challenge-response로 양방향 인증하며 역할별 메서드를 제한한다. MCP 연결에는 프로필 관리·런타임 시작 권한이 없다. 자세한 봉투와 관리 메서드는 [protocol.md](./protocol.md)를 따른다.
- 프로필 목록·진단·CLI 출력에는 저장된 비밀번호와 환경변수 값을 넣지 않는다. `runtime.ensure`는 인증된 Extension에 HTTP 연결용 자격 증명을 전달하고, 패널의 API 클라이언트가 메모리에서 사용한다. 토큰과 런타임 자격 증명은 사용자별 설치 데이터 디렉터리의 ACL로 보호한다.

## 설치 구조

산출물은 Chrome Extension과 Windows x64 `browser-bridge.exe`다. PowerShell 5.1 설치 스크립트는 관리자 권한 없이 `%LOCALAPPDATA%\AgentBrowser`에 설치하고 현재 사용자 Startup 바로가기와 즉시 시작을 제공한다. 확장은 고정된 `extension` 경로에, exe는 버전과 해시가 포함된 `app` 경로에 둔다. 기존 관리 서버의 MCP 경로가 계속 유효하도록 이전 exe도 소유 파일로 유지한다.

설치 manifest와 파일 해시로 소유 파일을 추적하고, 선택적으로 사용자가 지정한 JSON/JSONC의 `mcp.browser`만 백업 후 병합한다. 제거는 관리 OpenCode·Bridge를 정리한 뒤 소유 파일과 설정 항목을 제거하고, 페어링·프로필 데이터는 기본 보존한다. 경로와 파일 충돌 및 rollback, zip 생성 절차는 [installation.md](./installation.md), 사용자 절차는 [README-install.md](../README-install.md)에 있다.

## 유지하는 결정

| 결정 | 근거 |
|---|---|
| OpenCode non-`/api` v1 경로만 사용 | 설치된 1.18.29 명세 및 handoff 요구사항 |
| Windows exe를 WSL에서 cargo-xwin(msvc)으로 빌드 | Windows용 단일 Bridge 산출물. 실제 Windows 검증은 별도 기록 |
| 고정 확장 ID `icgmjjcpnaenpfjfoggnaodeaidbnihl` | manifest의 공개 `key`로 압축해제 로드의 Origin 유지. 개인키는 저장하지 않음 |
| 기존 OpenCode와 설정 사용 | 제품이 OpenCode를 재설치·업그레이드하거나 런타임 의존성을 다운로드하지 않음 |
