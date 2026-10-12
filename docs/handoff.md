# 개발 작업 지시서: Windows/WSL용 Chrome 브라우저 에이전트

## 0. 이 작업의 목적과 진행 방식

이 문서는 앞선 논의에서 합의한 개발 요구사항이다. 다시 원론적인 기술 비교나 방향 제안부터 시작하지 말고, 현재 저장소와 실행 환경을 확인한 뒤 단계적으로 실제 구현·테스트를 진행한다.

목표는 단순한 AI 채팅 확장프로그램이 아니다.

> 기존 OpenCode의 에이전트 기능을 이용해 사용자가 이미 쓰고 있는 Windows Chrome을 읽고 조작하고, 그 작업을 Chrome 안에서 지시·확인·관리하는 도구를 만든다.

가칭은 AgentBrowser다. 프로젝트명은 아직 확정되지 않았으므로 기존 저장소명이 있으면 그것을 우선하고, 이름 결정 때문에 개발을 중단하지 않는다.

최우선 목표는 채팅 UI가 아니라 실제 브라우저 제어의 완성이다. 첫 단계에서 채팅 화면만 만든 뒤 브라우저 조작을 나중으로 미루지 않는다.

작업 원칙:
- 현재 저장소의 AGENTS.md, README, 기존 코드, git 상태부터 확인한다.
- 기존 변경사항과 OpenCode 설정을 보존한다. 관련 없는 프로젝트는 수정하지 않는다.
- 이 문서에서 이미 정한 내용을 사용자에게 다시 질문하지 않는다.
- 확인할 수 있는 환경·버전·경로는 직접 확인한다. 접근할 수 없는 환경은 미검증으로 기록한다.
- 문서와 목업만 작성하고 끝내지 말고, 실행되는 최소 구현과 테스트까지 진행한다.
- 외부 공개, 저장소 생성·삭제, push, Release 게시 등은 별도 요청 없이 수행하지 않는다.
- 구현·테스트 결과와 미완료 사항을 구분하고, 실행하지 않은 테스트를 통과했다고 보고하지 않는다.

## 1. 확정된 사용자 환경

| 항목 | 내용 |
|---|---|
| 개인 개발·검증 PC | main, Windows 11 + WSL2 Ubuntu 26 |
| 개인 OpenCode | WSL 설치, 사용자 확인 버전 v1.18.29 |
| 개인 테스트 LLM | OpenCode Zen으로 제공되는 무료 모델 |
| 사내 PC | Windows 11, Windows 네이티브 또는 WSL2 Ubuntu 24 |
| 사내 사용 비율 | Windows 네이티브 약 80%, WSL 약 20% |
| 사내 OpenCode | v1, 정확한 패치 버전은 추후 확인 |
| 사내 LLM | 기존 OpenCode에 구성된 사내 모델만 사용·노출 |
| 대상 브라우저 | Windows의 기존 Google Chrome |
| 배포 | 사내 GitHub Releases에 설치·실행 산출물 배포 |
| 제외 환경 | 폐쇄망 RHEL 개발 머신 |

Windows 사용자에게 WSL 설치를 요구하지 않는다. WSL 사용자에게 Windows 네이티브 OpenCode로 갈아타도록 요구하지도 않는다.

개인 PC에서 개발하고 동일한 Windows Bridge 실행 파일과 Extension 빌드를 사내로 옮기는 것을 목표로 한다. Ubuntu 버전이 다르다는 이유만으로 별도 제품을 만들지 않되, 실제 사내 호환성은 별도로 검증한다.

개인 PC에 Windows 네이티브 OpenCode가 없다면 이 경로는 아직 검증되지 않은 것이다. WSL 테스트만으로 Windows 지원을 완료 처리하지 않는다.

## 2. 범위와 과도한 범용화 방지

개발·배포할 프로그램은 두 가지다.

1. Chrome Extension: 브라우저 제어, 사이드 패널, OpenCode 작업 UI.
2. Browser Bridge: MCP 중계, Chrome 연결, OpenCode 실행 관리.

설치·해제·진단·패키징 스크립트와 테스트 코드는 보조 산출물이며 별도 상주 제품이 아니다.

현재 구현하지 않을 것:
- 별도 AI 추론 엔진 또는 자체 에이전트 하네스.
- ACP Gateway, Native Messaging Host, Windows 서비스, Named Pipe 계층.
- 별도 Linux Bridge, macOS 지원, RHEL 연결.
- 여러 하네스에 대한 선제적인 어댑터 구현.
- SSO, 조직·사용자 RBAC, 데이터 분류·DLP, 사이트별 업무 접근통제 시스템.
- 플러그인 마켓, 외부 클라우드 백엔드, 자체 자동 업데이트 플랫폼.
- 전체 터미널 에뮬레이터와 TUI 화면의 완전 복제.

하네스 교체 가능성은 두 가지로만 대비한다.
- 브라우저 도구는 표준 MCP로 노출한다.
- 채팅 API와 실행 명령의 OpenCode 의존 코드는 작은 v1 어댑터·실행 모듈로 분리한다.

MCP가 표준인 것이지, 우리가 만드는 browser_* 도구 이름이나 내부 WebSocket RPC까지 업계 표준이라는 뜻은 아니다.

## 3. 전체 아키텍처

```text
Windows Chrome
  └─ 자체 Chrome Extension
       ├─ Side Panel / Options
       │    └─ HTTP + SSE ──────────────> OpenCode v1 serve
       ├─ Service Worker                         Windows 또는 WSL
       │    ↕ Local WebSocket                         │
       │    Browser Bridge serve                      └─ 기존 LLM 설정
       │      Windows 상주 프로세스                     개인: Zen 무료
       │          ↕ 내부 Local RPC                     사내: 사내 모델
       │    Browser Bridge mcp
       │      Windows 프로세스, 같은 exe의 다른 모드
       │          ↕ MCP stdio
       │    OpenCode CLI 또는 OpenCode serve
       └─ Content Scripts
            └─ 기존 Chrome 탭의 DOM 읽기·조작
```

통신 목적을 구분한다.
- 채팅: Extension → OpenCode HTTP API → LLM.
- 브라우저 도구: OpenCode → MCP stdio → Bridge mcp → Bridge serve → Extension → 탭.
- 자동 실행: Extension → Bridge 제어 요청 → OpenCode 프로세스 시작·상태 확인.

브라우저 도구 결과는 역순으로 OpenCode에 돌아간다. Bridge가 직접 LLM을 호출하지 않는다.

Chrome은 MCP 서버를 자동 검색하지 않는다. 설치 때 정해진 Windows localhost 주소로 Bridge에 연결한다. OpenCode는 MCP 설정에 등록된 Bridge 명령을 실행한다.

## 4. 기술 스택과 저장소

기본 스택:
- Extension: Manifest V3 + TypeScript + React + Vite.
- Bridge: Rust, Windows 실행 파일.
- MCP: stdio transport, 검증된 SDK 사용을 우선한다.
- Bridge ↔ Extension: localhost WebSocket, 버전이 있는 JSON RPC.
- Extension ↔ OpenCode: HTTP API + SSE, OpenCode v1 전용 어댑터.

의존성은 검증한 버전으로 고정하고 lockfile을 커밋한다. 실행 시 npm/Cargo에서 패키지를 내려받는 구성을 만들지 않는다.

권장 저장소 구조:

```text
<repository>/
  extension/
    src/
      background/
      content/
      sidepanel/
      options/
      agents/opencode-v1/
      browser/
  bridge/
    src/
      server/
      mcp/
      rpc/
      runtime/opencode_v1/
      config/
      diagnostics/
  protocol/
    schema/
    fixtures/
  tests/
    fixtures/site/
    integration/
    e2e/
  scripts/
    setup.ps1
    uninstall.ps1
    build-release.ps1
  docs/
    architecture.md
    protocol.md
    opencode-v1-compatibility.md
    testing.md
    installation.md
    status.md
  .github/workflows/
```

기존 구조가 있다면 무리하게 교체하지 않고, 위 책임 분리를 기존 구조에 적용한다.

## 5. Bridge 실행 모드와 연결 발견

같은 browser-bridge.exe에 다음 모드를 구현한다. 명령명과 포트는 이 프로젝트의 설계값이다.

```text
browser-bridge.exe serve
browser-bridge.exe mcp
browser-bridge.exe doctor
```

- serve: Windows localhost에서 Extension과 MCP proxy 연결을 받는다. OpenCode 실행 관리도 이 프로세스 안에 둔다.
- mcp: OpenCode가 실행하는 MCP stdio 서버다. 브라우저 요청을 serve에 전달한다.
- doctor: 설정·버전·연결·실행 경로를 진단한다. 기계 판독 가능한 출력도 제공한다.

기본 Bridge 주소는 ws://127.0.0.1:4317로 시작하고 설정에서 변경할 수 있게 한다.

Extension용 /extension, MCP proxy용 /mcp-proxy처럼 연결 역할을 구분하되, 별도의 서버나 포트를 불필요하게 늘리지 않는다. 이 경로는 내부 프로토콜이며 HTTP MCP endpoint가 아니다.

중요한 실행 규칙:
- serve는 사용자당 하나만 실행되도록 한다.
- mcp는 OpenCode 연결별로 여러 개 실행될 수 있다.
- MCP 프로세스 하나가 대화 세션 하나라는 가정을 하지 않는다.
- mcp 실행 시 serve가 없으면 동일 exe의 serve 모드를 안전하게 시작할 수 있게 한다.
- mcp가 serve를 시작하더라도 OpenCode를 다시 시작하지 않는다. 순환 실행을 방지한다.
- mcp의 stdout에는 MCP 메시지만 출력한다. 로그·배너·진단문은 stderr 또는 별도 파일로 보낸다. [R17]
- 한글·공백 경로, UTF-8, stdio 종료, 프로세스 재시작을 테스트한다.

## 6. Windows와 WSL의 MCP 연결

Bridge serve는 항상 Windows에서 실행한다.

Windows OpenCode는 Windows 경로로 Bridge를 실행하고, WSL OpenCode는 WSL interop으로 같은 Windows exe를 실행한다. 따라서 MCP proxy가 접속하는 localhost는 Windows localhost다. Linux에서 Windows 서버에 직접 연결하는 것과 혼동하지 않는다. [R4]

설정 예시이며, 설치 스크립트가 실제 경로로 생성해야 한다.

Windows OpenCode v1:

```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["C:\\Tools\\AgentBrowser\\browser-bridge.exe", "mcp"],
      "enabled": true
    }
  }
}
```

WSL OpenCode v1:

```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["/mnt/c/Tools/AgentBrowser/browser-bridge.exe", "mcp"],
      "enabled": true
    }
  }
}
```

OpenCode v1의 실제 설정 스키마와 설치된 버전으로 검증한다. v2 설정 형식을 적용하지 않는다. [R2]

WSL에서 실행된 Windows exe도 같은 Windows 사용자 설정을 읽도록 한다. 설정 위치를 현재 작업 디렉터리나 Linux HOME에 의존시키지 않는다.

WSL interop이 차단된 환경은 명확하게 진단한다. 이 경우를 위해 처음부터 Linux proxy와 터널 시스템까지 만들지는 않는다.

## 7. OpenCode 자동 실행과 수명 관리

사용자가 평소에 opencode serve를 직접 실행해야 하는 제품으로 만들지 않는다.

정상적인 사용자 흐름:
1. 최초 설치 시 Windows 또는 WSL 실행 프로필을 설정한다.
2. Windows 로그인 시 Bridge가 사용자 계정으로 시작된다.
3. Chrome Extension이 Bridge에 연결한다.
4. 사용자가 채팅 패널을 열면 Extension이 Bridge에 runtime.ensure 요청을 보낸다.
5. Bridge는 기존 서버를 확인하거나 OpenCode serve를 시작한다.
6. 서버 준비 확인 후 Extension이 HTTP/SSE로 연결한다.

설치·연결 안내는 필요하지만, 매번 터미널에 명령을 입력하게 하지 않는다.

프로필 설정:
- 프로필 ID·이름.
- Windows / WSL 구분.
- OpenCode 실행 파일 또는 설치 형태에 맞는 launcher.
- WSL일 경우 배포판 이름, 필요한 경우 Linux 사용자.
- 작업 디렉터리.
- 필요한 환경변수 또는 사용자가 지정한 실행 래퍼.
- 서버 포트·인증 설정.
- 직접 관리할 서버인지, 기존 서버 URL에 접속할 것인지.

기본 포트는 4096으로 시작하되, Windows/WSL 프로필 동시 실행과 포트 충돌을 처리한다. 자동 선택한 주소는 Extension에 반환하고 저장한다.

실행 구현 주의:
- Windows는 실제 설치 경로와 .exe/.cmd 등 설치 형태를 확인한다.
- WSL은 Windows Bridge에서 wsl.exe로 지정 배포판의 OpenCode를 실행한다.
- 로그인 시 PATH가 터미널의 PATH와 같다고 가정하지 않는다.
- bash -lc 한 줄로 모든 사용자의 nvm·bun·프록시·인증 환경이 준비된다고 가정하지 않는다.
- 가능하면 확인된 실행 경로와 구조화된 인수 배열을 사용한다.
- 사용자 입력을 shell 문자열로 무분별하게 이어 붙이지 않는다.
- 기존 사내 인증서·프록시 설정을 이용하고 TLS 검증을 끄지 않는다.

서버 관리:
- 중복 runtime.ensure 요청에는 서버 하나만 시작한다.
- 단순히 포트가 열렸다는 이유로 OpenCode라고 판단하지 않는다.
- 서버 상태·버전·인증을 확인한다. 시작 제한시간과 실패 이유를 제공한다.
- 직접 시작한 프로세스와 사용자가 원래 실행한 프로세스를 구분한다.
- 기존 사용자 프로세스를 임의 종료·재시작하지 않는다.
- Bridge 재시작 시 이미 관리하던 서버를 확인하고 중복 실행하지 않는다.
- 패널을 닫았다는 이유로 실행 중인 작업이나 서버를 종료하지 않는다.
- 제품이 소유한 Windows/WSL 자식 프로세스의 종료·고아 프로세스 처리도 테스트한다.

Windows → WSL의 localhost 연결은 별도 검증 항목이다. 실패하면 원인을 진단하고, 자동으로 0.0.0.0 바인딩이나 방화벽 해제를 하지 않는다. [R5]

기존 CLI에서 MCP로 브라우저만 조작할 때는 별도의 serve 시작을 요구하지 않는다. 같은 백엔드의 작업을 CLI에서도 보려면 opencode attach 경로를 제공한다. 독립 실행 중인 모든 CLI 작업에 새 serve가 자동 연결된다고 표시하지 않는다. [R1, R3]

## 8. 내부 RPC와 오류 처리

protocol/에 요청·응답 스키마와 예제 fixture를 둔다. Rust와 TypeScript 구현이 일치하는지 계약 테스트한다.

최소 필드:
- protocolVersion.
- requestId.
- 연결 역할, connectionId 또는 clientId.
- method, params.
- 브라우저 작업의 contextId / operationId.
- 실행 결과 또는 구조화된 오류.

브라우저 요청에는 필요한 경우 tabId, frameId, documentId, snapshotId, elementRef를 포함한다.

도구 결과에는 다음을 구분한다.
- 명령 전달 여부.
- 실제 조작 실행 여부.
- 조작 후 검증 결과.
- 실행 여부가 불명확한 상태.

예시 오류:
BROWSER_DISCONNECTED, TAB_NOT_FOUND, TAB_CLOSED,
UNSUPPORTED_PAGE, FRAME_UNAVAILABLE, STALE_ELEMENT,
ELEMENT_NOT_INTERACTABLE, TIMEOUT, CANCELLED,
BROWSER_BUSY, EXECUTION_UNKNOWN, NEEDS_TAB_ACTIVATION.

일시적 연결 실패, 프레임 접근 실패, 요소 없음 등 서로 다른 문제를 하나의 '실패' 문자열로 뭉개지 않는다.

중복·재연결 규칙:
- 요청 ID로 진행 중 요청과 결과를 매칭한다.
- 살아 있는 실행 구간 안에서 동일 ID의 중복 실행을 방지한다.
- 읽기 재시도와 쓰기·제출 재시도를 구분한다.
- 응답이 없었다는 이유만으로 클릭·전송·삭제를 자동 재실행하지 않는다.
- 재시작으로 실행 여부를 잃었다면 EXECUTION_UNKNOWN으로 처리하고 상태부터 확인한다.
- 프로세스 재시작을 가로지르는 '정확히 한 번 실행'을 보장한다고 주장하지 않는다.
- 타임아웃·취소된 요청이 나중에 살아나 동작하지 않도록 실행 세대를 무효화한다.

## 9. Chrome Extension 실행 구조

- Service Worker: Bridge 연결, 브라우저 명령 라우팅, 연결 상태.
- Content Scripts: 페이지 읽기, 요소 참조, DOM 조작.
- Side Panel: 초기에 상태·작업 탭·중단만 제공하고, 이후 전체 작업 UI를 추가.
- Options: 연결·실행 프로필·진단·초기 설정.

브라우저 제어는 패널이 닫혀 있어도 동작해야 한다.

WebSocket 연결은 Service Worker에 두되 종료·재시작을 전제로 설계한다. 연결 중 heartbeat, 끊김 후 제한된 재시도, startup·extension 이벤트·필요 시 alarms를 통한 재연결을 구현한다. 메모리 전역 변수만으로 작업 상태가 영구 유지된다고 가정하지 않는다. 사용한 API에 맞춰 최소 Chrome 버전을 명시한다. [R6]

페이지 코드에서 OpenCode API를 호출하지 않는다. API 인증정보는 Extension의 신뢰 영역에만 두고 content script로 전달하지 않는다. [R7]

권한 방향:
- sidePanel, scripting, tabs, storage 등 실제 기능에 필요한 권한을 사용한다.
- 다중 사이트 이동과 캡처가 필요하므로 activeTab만으로 전체 기능이 된다고 가정하지 않는다.
- 초기 제품은 <all_urls> host permission을 사용하는 단순한 방식으로 시작하고 설치 권한을 문서화한다.
- 제품의 일반 조작 대상은 HTTP/HTTPS 페이지다. chrome://, Chrome Web Store 등 제한 페이지는 지원 불가를 반환한다.
- 별도의 사이트별 업무 승인·화이트리스트 시스템은 만들지 않는다.
- debugger는 초기 필수 권한으로 두지 않는다.
- downloads·contextMenus·alarms 등은 해당 기능을 실제 구현할 때 추가한다.

Chrome 정책이 로컬 확장 로딩이나 필요한 권한을 막으면 이를 제한사항으로 보고한다. 정책 우회 기능은 만들지 않는다. [R8, R9]

## 10. 첫 목표: 실제 브라우저 제어

완료 기준은 'click 호출 성공'이 아니라 다음 전체 흐름이다.

> 페이지 상태 읽기 → 대상 식별 → 조작 → 상태 변화 대기 → 결과 확인 → 실패 시 원인 반환.

초기 도구 계약:

| 도구 예시 | 기능 |
|---|---|
| browser_tabs | 탭 목록, 작업 탭 연결·해제, 새 탭 생성·선택 |
| browser_snapshot | 페이지·요소·본문의 구조화된 읽기 |
| browser_navigate | URL 이동, 뒤로·앞으로, 새로고침 |
| browser_click | 요소 참조 기반 클릭 |
| browser_fill | 입력 요소 값 설정·교체 |
| browser_select | 선택 항목·체크박스 변경 |
| browser_press | Enter, Tab 등 기본 키 동작 |
| browser_scroll | 문서 또는 지정 컨테이너 스크롤 |
| browser_wait | 요소·텍스트·URL·상태 변화 대기 |
| browser_extract | 선택 영역·본문·표 추출 |
| browser_screenshot | 현재 작업 탭 화면 캡처 |

도구 이름은 예시지만, 위 기능은 구현 범위다. 무료 모델이 이해할 수 있도록 스키마와 설명을 작고 명확하게 유지한다.

스냅샷·요소 참조:
- URL, 제목, 탭·프레임·문서 식별자, snapshotId를 반환한다.
- 버튼·링크·입력·선택 요소의 종류, 레이블, 상태와 elementRef를 제공한다.
- 모델이 CSS selector를 매번 추측하는 방식보다 스냅샷의 참조를 재사용하도록 한다.
- 문서 이동이나 DOM 교체로 참조가 오래되면 다시 읽도록 한다. 비슷한 요소를 임의 클릭하지 않는다.
- 원본 HTML 전체 대신 관련 영역·텍스트·요소를 제한해서 반환한다.
- 잘림 여부와 추가 읽기 방법을 명시하고, 정확한 토큰 수를 계산하지 않았다면 문자 수 제한을 토큰 수라고 부르지 않는다.
- DOM 기반 표현을 실제 브라우저 Accessibility Tree와 동일하다고 표시하지 않는다.

페이지 지원:
- 일반 HTML, React류의 제어 입력, SPA 이동·재렌더링, 지연 로딩을 테스트한다.
- iframe은 프레임별로 읽고 결과를 합친다. 교차 출처·sandbox 제약은 개별 오류로 표시한다.
- open Shadow DOM은 지원 방향에 포함하고, closed Shadow DOM·canvas UI 등 제한은 명시한다.
- 고정 sleep만 사용하지 않고 관찰 가능한 상태와 타임아웃으로 대기한다.
- 파일 선택창, 인증서·OS 대화상자, 브라우저 자체 UI까지 지원한다고 주장하지 않는다.

DOM click·dispatchEvent가 실제 사용자 입력과 항상 같지는 않다. 우선 이 방식으로 구현하고, 실제 대상 페이지에서 막히는 사례가 확인되면 Extension 내부의 선택적 chrome.debugger/CDP 제어를 검토한다. 처음부터 별도 Playwright MCP 확장에 의존하지 않는다. [R10]

스크린샷:
- DOM 텍스트 중심으로 먼저 동작시키고, 이미지 입력 모델을 필수로 요구하지 않는다.
- captureVisibleTab은 지정 창의 활성 탭을 캡처한다. 작업 탭과 다른 탭을 캡처해 결과로 보내지 않는다.
- 초기에는 작업 탭이 활성 상태일 때만 캡처하고, 아니라면 NEEDS_TAB_ACTIVATION을 반환한다.
- 캡처 전후 탭 상태와 권한을 확인한다. 지원하지 않는 백그라운드·전체 페이지 캡처를 지원한다고 표시하지 않는다. [R9]

## 11. 작업 탭 고정, 동시 실행, 중단

'현재 탭'은 작업 시작 시 선택한 탭이다. 매 명령마다 사용자가 보고 있는 활성 탭으로 바뀌면 안 된다.

초기 동시 실행 정책:
- 채팅 세션은 여러 개를 지원한다.
- 브라우저 제어 작업은 한 번에 하나의 operation만 허용한다.
- 작업이 여러 탭을 사용하면 연결된 탭 집합을 명시적으로 관리한다.
- 충돌하는 작업은 BROWSER_BUSY로 반환하거나 사용자에게 제어권 전환을 요청한다.
- 병렬 브라우저 작업 스케줄러를 처음부터 개발하지 않는다.

특히 MCP에는 OpenCode의 대화 sessionId가 자동 전달된다고 가정하면 안 된다. MCP 연결과 OpenCode 세션은 다를 수 있다.

Bridge가 발급하는 contextId/operationId를 명시적인 도구 인수 또는 바인딩 절차로 전달한다. browser_tabs의 작업 시작·해제 같은 경로로 operation을 발급·종료하고, 변경 도구에는 유효한 operationId를 요구한다. 패널에서 시작한 세션과의 매핑은 어댑터에서 관리하되, 실제 식별이 불가능한 외부 CLI 작업에는 세션 연결을 추측해서 표시하지 않는다.

초기에는 하나의 Chrome 프로필을 대상으로 한다. 여러 Extension 연결이 발견되면 사용할 연결을 명시적으로 선택하고, 마지막에 접속한 브라우저로 작업 대상이 몰래 바뀌지 않게 한다.

중단 버튼:
- Bridge의 작업 게이트를 먼저 닫고 대기·후속 브라우저 명령을 막는다.
- 연결된 OpenCode 세션을 알고 있으면 해당 세션도 abort한다.
- 외부 CLI 세션을 식별할 수 없어도 브라우저 동작은 확실히 중단한다.
- 재개는 새 작업 허가와 최신 페이지 스냅샷으로 시작한다.
- 이미 제출한 웹사이트 요청을 취소·롤백했다고 표시하지 않는다.
- 전체 opencode 프로세스를 일괄 종료하는 식으로 구현하지 않는다.

## 12. 완성판의 필수 작업 UI

첫 목표 뒤에 구현하되, 아래 기능을 선택 기능으로 낮추거나 누락하지 않는다.

### 세션·실행 환경
- 세션 목록, 검색, 프로젝트·실행 환경 구분, 최근 세션.
- 기존 세션 연결 및 대화 이어가기.
- 새 세션 생성과 작업 디렉터리 선택.
- 이름 변경, 삭제, 분기, 이전 메시지부터 이어가기.
- 현재 세션, 작업 상태, 연결된 작업 탭 표시.
- 저장된 대화 열기와 다른 프로세스의 실행 중 작업 연결을 구분한다.

### 에이전트·모델
- 기본·사용자 정의 에이전트 선택.
- 사용 가능한 모델 목록, 검색, 즐겨찾기, 세션 중 변경.
- 지원되는 모델 variant·추론 옵션.
- 모델·에이전트 변경의 실제 적용 시점을 명확히 표시한다.
- 별도 외부 모델 카탈로그를 추가하지 않는다.
- 서버의 전체 provider 카탈로그를 그대로 노출하지 말고, 해당 환경의 사용 가능·설정된 모델을 기준으로 표시한다.

### 메시지·작업 현황
- 스트리밍 응답, Markdown·코드블록, 도구 실행 카드.
- 작업 목록, 하위 작업, 오류, 변경 diff 등 서버가 제공하는 상태.
- 파일·이미지 첨부와 결과물 열기·복사·내보내기.
- Windows에서 선택한 파일 경로를 WSL 서버가 그대로 읽을 수 있다고 가정하지 않는다. 실제 API가 지원하는 첨부 전송 또는 실행 환경에 맞는 임시 저장 경로를 사용한다.
- 긴 입력, 키보드 탐색, 한글 IME 조합 중 Enter 오전송 방지.
- 기본 한국어 UI, 라이트·다크 또는 시스템 테마.

### 질문 카드
- 선택지, 복수 선택, 여러 질문, 직접 답변.
- 답변 제출·취소, 대기·완료 상태.
- 패널을 닫거나 재연결해도 미응답 요청 복원.
- 이미 다른 클라이언트에서 처리한 요청을 중복 제출하지 않음.

### 권한 카드
- 실제 요청한 도구·명령·대상·범위를 표시.
- 해당 v1의 허용·거부·기억 범위 의미를 정확히 반영.
- 기존 OpenCode 권한 정책을 이용하고 별도 승인 시스템을 중복 개발하지 않음.
- always와 같은 응답을 영구적인 전면 허용으로 임의 해석하지 않음.

### 사용량·컨텍스트
- 최근 호출 입력·출력 토큰.
- 한 사용자 요청에 대한 전체 호출 합계.
- 세션 누적 사용량.
- 서버가 제공하는 캐시·추론 토큰 상세.
- 현재 컨텍스트 크기와 모델 한도, 압축 상태.
- 알 수 없는 값은 정보 없음, 추정한 값은 추정으로 표시.

세션 누적 토큰을 컨텍스트 점유량으로 표시하지 않는다. 메시지·단계별 집계 중복, 캐시 및 추론 토큰의 포함 관계를 실제 v1 타입과 맞춰 검증한다. 모델 변경 후에는 해당 모델의 한도를 사용한다.

### @ 및 / 기능
- 파일·에이전트 참조 자동완성.
- 사용자 커맨드, 이용 가능한 스킬·MCP 프롬프트의 검색·사용.
- /new, /sessions, /models 같은 UI 명령은 패널 동작으로 대응.
- 사용자 작업 커맨드는 OpenCode의 해당 실행 경로로 전달.
- @현재탭, @선택영역 등은 제품에서 추가하는 브라우저 참조로 구분.
- 파일·이미지 참조를 문자열만 붙여 넣는 것으로 대체하지 않는다.

플러그인은 모두 @이름으로 직접 호출되는 대상이라고 가정하지 않는다. 기존 서버 측 플러그인의 도구·훅·기능은 활용하고, TUI 전용 화면·단축키는 별도 대응 또는 제한으로 명시한다. 스킬 실행 엔진도 새로 만들지 않는다. [R11, R12]

### 그 밖의 CLI 대응
- 중단, 컨텍스트 압축, 메시지 복사, 로컬 내보내기.
- 서버가 지원하는 revert/unrevert, diff, shell 실행 결과 표시.
- 대화·파일 변경 되돌리기와 웹사이트에서 이미 완료된 작업의 되돌리기는 구분.
- 대화형 터미널, 외부 편집기·OS 대화상자는 기존 CLI로 넘길 수 있음.
- 외부 공개 공유 기능은 초기 범위에서 제외.

기능별 지원 상태를 docs/opencode-v1-compatibility.md에 기록한다. 핵심 API가 없다고 기능을 조용히 제거하지 말고, 동일 버전 구현을 확인해 대체 경로·제약을 기록한다.

## 13. OpenCode v1 API 검증·연동 원칙

기준은 사용자의 v1.18.29이며, 공개 최신 문서나 v2 예제가 최종 계약이 아니다.

첫 작업에서:
- 실제 opencode --version과 실행 파일 위치 확인.
- 설치된 서버의 /doc 또는 실제 제공되는 OpenAPI 명세 확인.
- 동일 태그의 SDK·소스가 필요하면 버전을 맞춰 확인.
- 상태·세션·메시지·이벤트·모델·에이전트·커맨드·질문·권한 기능을 표로 기록.

검증 후보에는 /global/health, /session, 메시지 전송·조회,
/event, /agent, /provider, /command, /mcp 및 질문·권한 응답 경로가 있다.
정확한 경로·파라미터·이벤트명·작업 디렉터리 전달 방식은 설치된 버전으로 확정한다. [R1, R13]

특히 과거 예제의 권한 응답 endpoint를 그대로 복사하거나 질문 API를 추측해서 만들지 않는다.

SSE 처리:
- 인증 가능한 fetch 기반 스트리밍 또는 검증된 SDK를 사용한다.
- EventSource에 임의 Authorization 헤더를 바로 설정할 수 있다고 가정하지 않는다.
- 재연결 시 세션·메시지·미응답 카드 상태를 재조회한다.
- 이벤트 replay나 Last-Event-ID 지원은 확인 후 사용한다.
- 같은 message/part/request를 중복 렌더링·집계하지 않는다.
- 패널이 닫히면 UI 스트림은 정리하되 서버 작업과 브라우저 제어는 유지한다.

연동 코드는 얇은 AgentClient 인터페이스 뒤에 둔다. 구현체는 우선 OpenCodeV1Client 하나만 만든다. 추상 인터페이스 설계 자체가 개발의 주 작업이 되어서는 안 된다.

## 14. 개인 무료 모델과 사내 모델

개인 검증:
- 실제 이용 가능한 Zen 무료 모델 중 도구 호출이 가능한 모델을 선택한다.
- 특정 무료 모델명을 제품 코드에 하드코딩하지 않는다.
- 테스트 결과에는 model ID, OpenCode 버전, 검증 시점을 기록한다.
- 주 모델뿐 아니라 제목 생성 등 보조 작업의 small_model·에이전트별 모델 override도 확인한다.
- 테스트 전용 설정으로 무료 모델만 쓰도록 하고 유료 fallback을 만들지 않는다.
- 무료 여부를 확인할 수 없거나 한도에 막히면 오류를 보여주고 멈춘다.
- 개인 테스트에는 직접 만든 fixture와 공개·비민감 데이터를 사용한다. [R14, R15]

사내 사용:
- 기존 OpenCode의 사내 provider·모델·인증 설정을 그대로 이용한다.
- Extension이나 Bridge가 외부 LLM에 직접 연결하지 않는다.
- Zen 설정이나 개인 API 키를 사내 배포물에 포함하지 않는다.
- 사내에 없는 외부 모델을 UI에서 별도로 생성·노출하지 않는다.

모델 성능과 제품 정확성을 분리한다. 도구 자체 테스트가 통과했더라도 모델의 다단계 작업이 실패할 수 있으며, 그 반대도 구분해 기록한다.

## 15. 최소한의 로컬 통신 안전장치

별도 데이터 접근통제 제품을 만드는 것은 범위 밖이다. 다만 로컬 브라우저 제어 포트를 아무 웹페이지나 호출할 수 있게 만들지는 않는다.

최소 구현:
- Bridge는 127.0.0.1에만 바인딩.
- 설치별 임의 토큰과 최초 1회 Extension 페어링.
- Extension 연결의 Origin·역할 검증, 인증 이전에는 제어 요청 실행 금지.
- MCP proxy처럼 Origin이 없는 클라이언트도 역할별 인증 필요.
- 브라우저 WebSocket은 임의 인증 헤더 대신 최초 인증 메시지 등 실제 지원되는 방법 사용.
- 토큰은 URL query·로그·content script에 넣지 않음.
- OpenCode 서버는 해당 v1이 지원하는 인증을 사용하고, 필요한 경우 실제 Extension Origin만 CORS에 추가.
- 원격 CDN·analytics·telemetry SDK·원격 JS 실행 없음.
- Extension이 렌더링하는 페이지 텍스트·Markdown은 실행되지 않게 처리.
- 임의 JavaScript eval 도구를 초기 도구에 포함하지 않음.
- 페이지에서 읽은 지시문은 관찰 데이터이며 사용자 명령으로 취급하지 않음.

OpenCode 자체와 설치된 플러그인의 네트워크 동작까지 검증 없이 '외부 통신이 전혀 없다'고 단정하지 않는다. 제품 자체의 통신과 기존 하네스의 통신을 구분해 진단한다.

## 16. 추가 기능 우선순위

초기 필수:
- 작업 탭 고정.
- 전체 중단과 수동 인계.
- 브라우저 작업 타임라인.
- Extension / Bridge / MCP / OpenCode / 모델별 연결 진단.

전체 작업 UI 이후 우선 제공:
- 선택 영역·화면 요소를 대화에 첨부.
- 추출한 표·결과를 CSV 또는 Markdown으로 내보내기.
- 여러 탭을 하나의 작업에 연결.
- 자주 쓰는 작업을 기존 OpenCode 커맨드·스킬로 재사용.

초기 제외:
- 여러 에이전트의 브라우저 동시 조작 최적화.
- 복잡한 매크로 녹화·편집기.
- 완전한 페이지 비디오 녹화.
- 스크린샷 모델 전용 제어 또는 모든 웹앱 자동화 보장.

## 17. 테스트 전략과 완료 조건

### A. LLM 없는 결정적 테스트

직접 만든 테스트 사이트에서 MCP 또는 내부 RPC를 호출한다.

필수 시나리오:
1. 탭 조회와 지정 탭 연결.
2. 검색창 입력 → Enter/버튼 → 결과 확인.
3. select·checkbox·텍스트 필드 조작과 값 검증.
4. 새 탭 생성·전환·원래 탭 복귀.
5. SPA 이동·재렌더링 뒤 stale element 처리.
6. 비동기 요소 출현 대기와 타임아웃.
7. iframe·open Shadow DOM 지원 범위 확인.
8. 표 추출의 실제 행·열·문자열 확인.
9. 사용자가 다른 탭으로 이동해도 작업 대상 유지.
10. 다른 활성 탭의 스크린샷을 잘못 반환하지 않음.
11. 중단 이후 대기 중 명령이 실행되지 않음.
12. Extension/Bridge 재시작·WebSocket 단절 후 복구.
13. 제출 직후 연결 단절 시 중복 제출 방지.
14. 두 클라이언트의 브라우저 작업 충돌 처리.
15. 패널이 닫힌 상태에서도 CLI의 브라우저 조작 가능.

fixture 서버에 제출 횟수·요청 ID·폼 값을 기록해 눈으로만 판단하지 않고 assertion으로 검증한다.

### B. 실제 에이전트 테스트

OpenCode Zen 무료 모델에 다음과 같은 목표를 전달한다.

> 테스트 페이지에서 검색 조건을 입력하고 결과를 연 뒤,
> 새 탭의 표를 읽고 원래 탭으로 돌아와 결과를 요약해줘.

통신 성공, 도구 실행 성공, 모델 판단 성공을 별도로 기록한다. 가능하면 같은 시나리오를 여러 차례 실행해 성공/전체 횟수를 보고한다. 외부 유료 모델을 몰래 사용하지 않는다.

### C. 환경 매트릭스

| 환경 | 검증 내용 |
|---|---|
| main WSL2 Ubuntu 26 | MCP stdio 왕복, 실제 Chrome 제어, serve 자동 실행 |
| main Windows 네이티브 | 동일 도구·동일 UI·자동 실행 |
| 사내 Windows 네이티브 | 설치·정책·사내 모델·실제 업무 페이지 |
| 사내 WSL2 Ubuntu 24 | interop·localhost·환경변수·사내 모델 |

사내 접근이 없으면 사내 항목은 미검증으로 남긴다. 빌드가 성공한 것과 실제 Windows 프로세스·Chrome 테스트가 성공한 것을 구분한다.

### D. UI·프로토콜 테스트

- Rust/TypeScript 스키마 호환 및 알 수 없는 버전 처리.
- MCP initialize, tools/list, tools/call, 오류·취소·종료 처리.
- 인증 실패, 포트 충돌, 중복 시작, 존재하지 않는 실행 파일.
- MCP 브라우저 도구에서 런타임 실행·설정 변경 같은 관리 API를 호출할 수 없음.
- 질문·권한 대기 요청 복원과 중복 응답 방지.
- 세션 전환 중 이벤트가 다른 세션에 섞이지 않음.
- 누적 토큰·최근 호출·컨텍스트 수치의 계산 fixture.
- 한글 경로·공백 경로·IME 입력.
- 업그레이드와 uninstall이 기존 OpenCode 설정·세션을 손상하지 않음.

자동화 도구를 테스트 의존성으로 사용하는 것은 괜찮지만, 실제 사용자의 브라우저 제어가 제3자 자동화 확장이나 별도 테스트 브라우저에 의존하면 안 된다.

## 18. 개발 단계와 게이트

### M0. 환경·계약 확인
- 저장소·OpenCode 버전·설치 경로·WSL 배포판·Chrome 버전 확인.
- 접근 가능한 Windows 실행 환경 확인.
- v1 API·MCP 계약과 무료 모델 확인.
- 최소 구조, protocol fixture, 테스트 사이트 생성.

완료: 실제 확인값과 미확인값이 문서에 구분되어 있고 브라우저 왕복 구현을 시작할 수 있다.

### M1. 브라우저 제어 수직 구현 — 최우선
- Extension ↔ Bridge WebSocket 연결.
- Bridge의 MCP stdio 모드.
- snapshot → fill → click → wait → extract의 전체 왕복.
- 작업 탭 고정, 최소 중단, 기본 오류 처리.
- main WSL OpenCode에서 실제 Chrome 제어.
- Windows 네이티브 경로 검증.

완료: 채팅 UI 없이 기존 OpenCode CLI에서 실제 다단계 브라우저 작업을 수행하고 결과를 검증한다. Windows 네이티브 미검증은 명시적으로 남긴다.

### M2. 실사용 안정화·자동 실행
- 로그인 시 Bridge 시작, CLI에서 필요 시 Bridge 시작.
- OpenCode Windows/WSL 실행 프로필과 runtime.ensure.
- 재연결, 중복 실행 방지, 작업 중단, 타임라인, doctor.
- 최소 패널로 자동 실행과 작업 상태 확인.

완료: 최초 설정 뒤 매번 Bridge나 opencode serve를 수동 실행하지 않고 사용할 수 있다.

### M3. CLI 수준의 작업 UI
- 12절의 필수 세션·모델·에이전트·질문·권한·토큰·@·/ 기능.
- 인증 SSE와 상태 재동기화.
- 첨부·압축·diff·작업 결과 등 브라우저에서 가능한 CLI 대응.

완료: 브라우저 작업 중 일반적인 지시·질문 응답·권한 승인·세션 관리를 위해 CLI로 돌아갈 필요가 없다. 제외 기능은 문서화한다.

### M4. 배포·사용성 마무리
- 설치·설정·업데이트·제거 검증.
- 결과 내보내기·요소 첨부 등 우선 편의 기능.
- 사내 반입용 Release 산출물과 사용 설명서.

완료: 개발 툴체인 없는 Windows 사용자에게 배포할 수 있는 패키지가 있다. 사내 실제 테스트 여부는 별도 기록한다.

## 19. GitHub Releases 배포

권장 산출물:

```text
agent-browser-<version>-windows-x64.zip
  browser-bridge.exe
  extension/
  setup.ps1
  uninstall.ps1
  start-bridge.cmd
  examples/
  README-install.md
  THIRD_PARTY_NOTICES

SHA256SUMS
```

기본은 Windows x64로 시작하되 실제 대상 아키텍처를 확인한다. WSL 사용자도 같은 Bridge exe를 사용한다.

설치 스크립트:
- 사용자 영역에 설치하고 관리자 권한·Windows 서비스를 기본 요구하지 않는다.
- Windows 로그인 시 자동 시작을 등록하고 즉시 Bridge를 실행한다.
- 최초 페어링과 Windows/WSL 프로필 설정을 안내한다.
- 실제 경로의 MCP 설정 조각을 생성한다.
- 기존 JSON/JSONC를 백업하고 필요한 항목만 병합한다. 모델·인증·다른 MCP 설정을 덮어쓰지 않는다.
- 사용자의 전체 설정을 제품 예제로 복사하지 않는다.
- 반복 실행·업데이트·제거가 안전해야 한다.
- Bridge 자동 시작 실패 시 사용할 시작 바로가기를 제공한다.

Extension은 압축을 푼 고정 경로에서 Chrome의 '압축해제된 확장 프로그램 로드'로 설치하는 방식으로 시작한다. 설치 스크립트만으로 Chrome 정책과 로컬 로딩 절차가 자동 해결된다고 가정하지 않는다. 경로 변경·확장 ID 변경에 따른 재페어링을 처리한다. [R16]

실행 시 Node.js·Rust·Python 설치를 요구하지 않는다. OpenCode 자체는 기존 설치를 사용하는 별도 전제다. 불필요하게 재설치하거나 v2로 업그레이드하지 않는다.

Windows 실행 파일은 실제 Windows 빌드·실행으로 검증한다. WSL에서 Linux 바이너리만 만든 뒤 Windows 배포물이라고 표시하지 않는다.

CI는 사내 runner와 미러 접근을 고려한다. GitHub Actions가 없어도 실행 가능한 패키징 스크립트를 제공한다. 개인 환경의 비밀정보·로그·실제 대화·웹페이지 원문은 Release에서 제외한다.

## 20. 진행 기록과 보고 형식

docs/status.md에 다음을 유지한다.
- 현재 단계와 구현한 기능.
- 실제 실행한 테스트, 환경·버전·모델.
- 실패 원인과 재현 방법.
- 미검증 환경과 아직 없는 기능.
- 다음에 진행할 구체적인 작업.

각 작업 결과 보고에는 다음을 포함한다.
1. 변경 내용과 주요 파일.
2. 실제 실행한 빌드·테스트 명령과 결과.
3. 사용자 PC에서 바로 재현하는 최소 절차.
4. 제약·미완료·다음 작업.

큰 범위 변경이 필요할 때만 이유와 대안을 설명한다. 기존 합의를 다시 일반론으로 되돌리지 않는다.

## 21. 에이전트의 첫 실행 지시

이제 현재 작업 환경과 저장소를 확인하고 M0부터 수행한다. 이어서 가능한 범위에서 M1의 실제 구현과 테스트를 진행한다.

첫 사용자 시연 목표는 다음이다.

> 개인 PC main의 WSL OpenCode v1.18.29에서 Zen 무료 모델을 사용해,
> 현재 Windows Chrome의 테스트 페이지를 읽고 검색·입력·이동·표 추출을 수행한다.
> 사용자가 다른 탭을 보더라도 작업 탭은 유지되고,
> 중단을 누르면 후속 브라우저 조작이 멈추며,
> 결과와 실패 원인이 OpenCode 및 최소 상태 UI에 표시된다.

그다음 동일 시나리오를 Windows 네이티브 OpenCode로 검증한다.

채팅 UI만 완성하는 것으로 이 목표를 대체하지 않는다. 접근 가능한 환경에서 실제 실행 증거를 남기고, 접근할 수 없는 Windows/사내 테스트는 정확히 미검증으로 보고한다.

## 22. 기술 확인용 공식 자료

아래는 구현 근거를 확인하는 참고 문서다. 설치된 v1.18.29의 실제 동작·명세가 우선이며, 공개 문서의 최신 변경을 무조건 적용하지 않는다.

[R1] OpenCode Server: https://opencode.ai/docs/server/
[R2] OpenCode MCP: https://opencode.ai/docs/mcp-servers/
[R3] OpenCode CLI: https://opencode.ai/docs/cli/
[R4] WSL interop: https://learn.microsoft.com/en-us/windows/wsl/filesystems
[R5] WSL networking: https://learn.microsoft.com/en-us/windows/wsl/networking
[R6] Chrome WebSocket/Service Worker: https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets
[R7] Chrome network requests: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
[R8] Chrome activeTab: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
[R9] Chrome tabs/capture: https://developer.chrome.com/docs/extensions/reference/api/tabs
[R10] Chrome debugger: https://developer.chrome.com/docs/extensions/reference/api/debugger
[R11] OpenCode skills/commands: https://opencode.ai/docs/skills/ ; https://opencode.ai/docs/commands/
[R12] OpenCode plugins/TUI: https://opencode.ai/docs/plugins/ ; https://opencode.ai/docs/tui/
[R13] OpenCode SDK/tools/permissions: https://opencode.ai/docs/sdk/ ; https://opencode.ai/docs/tools/ ; https://opencode.ai/docs/permissions/
[R14] OpenCode Zen: https://opencode.ai/docs/zen/
[R15] OpenCode config/models: https://opencode.ai/docs/config/ ; https://opencode.ai/docs/models/
[R16] Chrome extension loading: https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world
[R17] MCP stdio: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports


### Fifth review and security rerun — 2026-10-12 07:05 UTC

Remote head remains `09caec518be826c3995e0476fecf3e64e8539607`; its Linux/Windows CI 38211907836 passed. The 06:31 code review raised five P2s. The requested retry comment was posted successfully at https://github.com/jihoon22-lee/agent-browser/pull/5#issuecomment-6119150335 after a new explicit delegation requested the retry. Code review completed at 06:51 and raised five more P2s; security review completed at 07:01 and repeated the data-owner issue. The earlier 06:26 security `Failed` run exposed no explanation, so its cause is still unknown; it is not counted as a clean review.

Local fixes cover all ten distinct follow-up findings:

- Uninstall tracks missing registered settings in its preview snapshot, rejecting recreation before Apply.
- Empty managed-runtime maps no longer require launching a missing Bridge executable. Already-exited, owned PID records can be cleared without the deleted executable; live/unverified runtime records retain the installation.
- Remove ignores the disabled new-registration checkbox and selections.
- Native package verification and the shared PowerShell verifier used by the Windows builder reject extension/package version mismatch. Synthetic test package versions/hashes are internally consistent.
- Legacy PowerShell transactions record the bytes actually written, require the same hash during rollback, preserve concurrent changes, continue unrelated restorations and retain a recovery path/hash journal plus backups on conflict.
- Maintenance handoff uses `%LOCALAPPDATA%/AgentBrowser-Setup`, requiring the same trusted-owner/ancestor policy as installation roots before execution.
- The install and update guide restores ZIP SHA256 comparison against separately published SHA256SUMS or the official asset digest before extraction/execution.
- Automatic Windows executable discovery inspects components from the drive root and rejects reparse points before visiting descendants. This uses the [documented attribute behavior](https://devblogs.microsoft.com/oldnewthing/20100212-00/?p=14963): link attributes describe the link itself. No SMB server was contacted in tests.
- Private directory ACL preparation rejects foreign owners, including a pre-existing empty data child; it does not silently retain owner rights after changing the DACL.
- Windows executable and working-directory validation now precedes the version probe; relative, remote and reparse paths are rejected before execution.

The native uninstall/UI/package cases failed five times before fixes (`review6-red.log`), then all 47 native cases passed. Complete native/actual WSL integration passed 52 cases (`review6-wsl-final.log`), including real OpenCode 1.18.29 authentication with Bridge 0.1.5 and no model/page action. An earlier invocation failed only because the test driver received a relative JS path; it was rerun with an absolute path and a fresh fixture. The exact interrupted fixture was uninstalled through its verified install ID.

The four new owner/path cases each failed before fixes (`review7-red.log`); all 51 native cases then passed (`review7-green.log`). Owner checks use isolated security descriptors, the replaceable-ancestor test temporarily changes only its own fixture ACL and restores it, and discovery uses a local junction fixture. They are not a real second-user exploit or SMB authentication test. The relative Windows probe uses an isolated synthetic executable and also verifies that an explicitly selected valid absolute executable can be prepared.

GUI candidate 7 passed complete discovery, preview/Back/cancel, occupied-port rollback/retry, WSL registration, stale profile validation/save/duplicate/pending close, masked pairing, update and installed-GUI self-uninstall (`gui-review7.log`). Final candidate 8 also passed discovery, preview/cancel, failure/retry, update and self-uninstall through its exact-hash per-user maintenance cache (`gui-review8.log`). GUI tests use owned native HWND button/selection events plus UI Automation reads, not physical mouse input.

Legacy PowerShell 5.1 regressions were written for text/copy/delete rollback conflicts, continued unrelated recovery, version-mismatched packaging and actual WSL rollback. Local script execution was refused by host policy (`review6-wsl-rollback-red.log`); no policy bypass/change was used. The PowerShell 5.1 parser accepted the source, but this is syntax-only evidence. New PowerShell execution and latest-head CI remain pending. Standard-library package tests (3), CI helper tests (3), actionlint, Markdown links and diff checks passed. Rust/extension product source was not changed in these follow-ups; their prior remote-head CI pass is not presented as a latest-head CI run.

Final local candidate: 32 files, SHA256 `e19171e688ef714c4228574e72e6967c3cc8392191bf9b15487c03d5fb52b29a`; internal hashes, extension version, Windows x64 Bridge/GUI PE and absence of runtime/private artifacts passed. This is an unpublished local candidate, not a release asset.

Remote push of regression commit `c61094d` was rejected by automatic approval review because the original delegation withheld push approval and the later review request did not clearly authorize this exact repository/push. An exact repository/branch/PR/release approval question is pending; no workaround, push, merge, tag or release was performed after that rejection. The current remote findings therefore remain unresolved on GitHub until the local fixes can be pushed and reviewed. Personal operational v0.1.4 PID 74680, install identity, pairing, profiles, data owner and global WSL settings remain unchanged. The separate company WSL/active-tab/iframe work is excluded.

Final current-source Windows/WSL integration: **56 PASS** (14 existing + 42 review cases), `review7-wsl-final.log`. The valid absolute Windows profile probe also passed. Rebuilding the final candidate into a separate directory produced the identical SHA256 above. No local script-policy exception was used.

### Publication authorization restored — 2026-10-12 07:08 UTC

The parent supplied the later explicit user deployment approvals. The same previously rejected push was retried once and approved; `c61094d` and `8aa6677` are now on PR #5. The earlier blocker is resolved. Latest-head CI/code/security reviews remain required before merge and a new v0.1.5 prerelease; the operating v0.1.4 and separate WSL/iframe/active-tab work remain excluded.


### PowerShell CI execution follow-up — 2026-10-12 07:16 UTC

Current-head Linux CI passed. Windows CI 38216139555 passed the new concurrent text/copy/delete rollback regression plus normal install/update/removal and live-process checks, then exposed a real integration omission: direct COM Startup shortcut creation did not record its written hash, so occupied-port rollback retained that shortcut as a supposed concurrent edit. The existing occupied-port regression is the failing test. Setup now creates the link in its transaction stage and publishes it through Copy-TransactionFile. Owned process-marker writes also use the transaction when setup provides one, and snapshot-only calls suppress their internal journal objects from command output. GUI/native product code is unchanged; targeted PowerShell CI is the required revalidation, with no redundant manual review request.

Windows CI 38216816747 passed PowerShell install/update/rollback/uninstall, including the repaired occupied-port Startup cleanup. The next stage exposed a stale synthetic upgrade fixture: runtime-cleanup.tests.ps1 changed only the outer version to 0.2.0 while retaining extension 0.1.0. The fixture now updates the extension version/hash together. This follow-up changes tests only; it does not weaken the mixed-version rejection.

### GUI integration handoff; standalone release stopped — 2026-10-12 07:48 UTC

The user's latest instruction supersedes the earlier standalone v0.1.5 publication plan and exact-head review gates above: combine GUI, WSL, iframe, active-tab and board improvements into one release. PR #5 remains open and unmerged; no v0.1.5 tag or release was created. The integration owner is thread `01a12eae-b801-75cc-bd86-32fd1c55c031`. Do not publish this branch as a separate GUI release or restart repeated manual reviews.

CI 38217400340 at 61a116c passed both Linux and Windows, including the actual PowerShell install/update/rollback/remove and managed-runtime tests. The previous Startup rollback failure and synthetic package-version failure are resolved. Code and security reviews completed on that head; the last code review reported four P2s. Three concrete data/access issues received narrowly scoped fixes: deletion checks expected bytes while excluding Windows writers/replacers through the same handle; native rollback continues restoring independent files after a conflict and retains recovery evidence; package destination subdirectories must have trusted owners/private write permissions at preview and apply. The five new native cases all failed first (`boundary-red.log`) and then passed (`boundary-green.log`). WSL deletion uses the selected distribution/user and checks expected contents immediately before removal; it does not claim an atomic lock against arbitrary Unix writers.

The fourth finding asks to reject every local Windows path for WSL MCP registration. It is deferred for clearer path guidance: WSL can legitimately consume a Windows-mounted config via /mnt/c, so a blanket UNC-only restriction is not justified by the demonstrated evidence. This is not reported as fixed. No other feature/runtime scope was added.

The final source was compiled with the .NET Framework 4.8 C# compiler and validated with the existing native Windows/actual WSL suite. Initial WSL rerun stopped because the temporary fixture used invalid server.port=0; the fixture was corrected to a positive port and rerun in a fresh isolated directory. The published-v0.1.4 upgrade fixture prepared for the now-canceled standalone release and the interrupted WSL fixture were uninstalled through their verified identities. Operating v0.1.4 and global OpenCode settings remain untouched. Latest commit CI will run automatically after push; the integration owner should use its real result, not treat 61a116c's pass as a final-head pass. The pre-fix CI ZIP is not a final release artifact.
Final local result: **62 PASS** (15 existing/WSL cases + 47 review cases), `boundary-all-final.log`. Actual OpenCode 1.18.29 connected and an authenticated Bridge 0.1.5 reply was verified with delivered=false/executed=no; no model or page operation ran. At 07:47 UTC, the read-only production audit confirmed v0.1.4 PID 74680, identity, pairing, profiles, owner marker and global WSL configuration unchanged. No known failing installer test remains; final-head remote CI is pending handoff.
