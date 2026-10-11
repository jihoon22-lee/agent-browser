# 아키텍처

요구사항 원장은 [handoff.md](./handoff.md) §3–§11이다. 이 문서는 구현이 진행되며 실제 구조로 갱신한다.

```text
Windows Chrome (개발: 별도 'AgentBrowser-dev' 프로필)
  └─ Chrome Extension (MV3)
       ├─ Side Panel / Options ── HTTP + SSE ──> opencode serve (v1 경로, Basic 인증)
       ├─ Service Worker                          Windows 또는 WSL
       │    ↕ ws://127.0.0.1:4317/extension
       │  browser-bridge.exe serve   (Windows 사용자당 1개)
       │    ↕ ws://127.0.0.1:4317/mcp-proxy
       │  browser-bridge.exe mcp     (OpenCode 연결마다 1개, stdout은 MCP 전용)
       │    ↕ MCP stdio
       │  opencode (CLI 또는 serve; WSL은 interop으로 같은 exe 실행)
       └─ Content Scripts ── 작업 탭의 DOM 읽기·조작
```

## 통신 경로

| 목적 | 경로 |
|---|---|
| 채팅 | Extension → OpenCode HTTP API/SSE → LLM |
| 브라우저 도구 | OpenCode → MCP stdio → Bridge mcp → Bridge serve → Extension SW → content script |
| 자동 실행 | Extension → Bridge `runtime.ensure` → OpenCode serve 시작·확인 |

Bridge는 LLM을 직접 호출하지 않는다. Chrome은 MCP 서버를 자동 검색하지 않고 설정된 localhost 주소로 Bridge에 접속한다.

## 결정 기록

| 날짜 | 결정 | 근거 |
|---|---|---|
| 2026-10-11 | OpenCode는 non-`/api` v1 경로만 사용 | 1.18.29 서버가 v1·v2 경로를 함께 노출, handoff §6·§13은 v1 기준 |
| 2026-10-11 | Windows exe는 WSL에서 cargo-xwin(msvc)으로 크로스 빌드 | main Windows에 Rust 없음, interop 실행 검증 완료(status.md) |
| 2026-10-11 | 개발 중 확장은 Windows Chrome의 별도 개발용 프로필에 로드 | 사용자 결정 |
| 2026-10-11 | main의 Windows 네이티브 OpenCode는 M1 WSL 시연 후 v1.18.29로 설치 | 사용자 결정, 그 전까지 Windows 경로는 미검증 |
| 2026-10-11 | 개발용 고정 확장 ID `icgmjjcpnaenpfjfoggnaodeaidbnihl` (manifest `key`, 개인키는 보관하지 않음) | Bridge가 `chrome-extension://<id>` Origin을 페어링 대상으로 고정하려면 압축해제 로드에서도 ID가 안정적이어야 함 |

## M1 구현 보강 (2026-10-11)

- Extension은 `webNavigation`으로 프레임/documentId를 확인하고 그 문서에만 content 명령을 보낸다.
- snapshot 번호는 Extension 세션 전체에서 증가하며 탭·프레임·문서 소유 정보를 저장한다.
- 취소는 operationId/requestId 범위다. Bridge 재시작으로 generation이 초기화되어도 새 작업을 막지 않는다.
- 실행 중 쓰기 기록은 SW 재시작 뒤에도 재실행하지 않는다. 완료 결과는 10분/최근 200개 캐시이며
  중단된 in-flight 표시는 브라우저 세션 동안 유지한다. 프로세스를 가로지르는 exactly-once 보장은 아니다.
- 로컬 WebSocket은 HMAC-SHA256 challenge-response로 양방향 인증한다. 상세는 protocol.md.
