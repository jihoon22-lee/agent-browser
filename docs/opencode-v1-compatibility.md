# OpenCode v1 호환성

기준: WSL 설치본 **opencode 1.18.29**(`~/.opencode/bin/opencode`)를 `opencode serve --pure`로 띄워
`GET /doc`에서 받은 OpenAPI 3.1 명세([reference/opencode-1.18.29-openapi.json](./reference/opencode-1.18.29-openapi.json)),
2026-10-11 확인. 공개 최신 문서·v2 예제는 최종 계약이 아니다.

## 확인된 서버 특성

| 항목 | 확인 결과 | 방법 |
|---|---|---|
| 헬스 체크 | `GET /global/health` → `{"healthy":true,"version":"1.18.29"}` | 실제 호출 |
| 인증 | `OPENCODE_SERVER_PASSWORD` 설정 시 미인증 401, Basic `opencode:<password>` 200 | 실제 호출 |
| 명세의 securitySchemes | 비어 있음(인증은 명세에 표현되지 않음) | OpenAPI |
| CORS | `chrome-extension://` Origin preflight는 204지만 `Access-Control-Allow-Origin` 없음 | 실제 호출. 확장은 host permission 기반 요청 또는 `--cors <origin>` 필요 — M3 실제 확장 UI에서 합성 v1 서버와 직접 요청 확인 |
| 작업 디렉터리 | 대부분 경로가 `directory`, `workspace` query 파라미터를 받음 | OpenAPI |
| 경로 체계 | non-`/api` v1 경로와 `/api/*` v2 경로가 함께 존재 | OpenAPI. **v1만 사용** |
| 기본 바인딩 | `--hostname` 기본 `127.0.0.1`, `--port` 기본 0(임의) | `opencode serve --help` |
| 이벤트 | `GET /event`(인스턴스), `GET /global/event`(전역), `text/event-stream`, Event 변형 89종 | OpenAPI |

## 기능별 v1 경로

| 기능 | v1 경로 | 상태 |
|---|---|---|
| 상태 | `GET /global/health` | 확인됨 |
| 세션 목록·검색 | `GET /session?directory&search&limit&roots&start` | 실제 API 확인 |
| 세션 생성 | `POST /session` (`parentID,title,agent,model{id,providerID,variant},permission`) | 실제 API 확인 |
| 세션 조회·수정·삭제 | `GET/PATCH/DELETE /session/{id}` | 실제 API 확인 |
| 세션 상태 | `GET /session/status` → `idle` / `busy` / `retry` | 실제 API 확인 |
| 메시지 전송 | `POST /session/{id}/message`(동기), `POST /session/{id}/prompt_async` | noReply 실제 API 및 UI 합성 검증. body: `parts`, `model{providerID,modelID}`, `agent`, `variant`, `tools` |
| 메시지 조회 | `GET /session/{id}/message`, `GET /session/{id}/message/{mid}` | 실제 API 확인 |
| 중단 | `POST /session/{id}/abort` | 실제 API 확인 |
| 분기·압축 | `POST /session/{id}/fork`, `POST /session/{id}/summarize` | fork 실제 API, 압축 합성 UI·명세 검증 |
| revert·diff·todo | `/revert`, `/unrevert`, `GET /diff`, `GET /todo` | 실제 API 확인 |
| 커맨드 | `GET /command`, `POST /session/{id}/command` (`command`,`arguments`) | 목록 실제 API, 실행 합성 UI 검증 |
| 셸 | `POST /session/{id}/shell` | 명세·합성 UI 검증 |
| 에이전트 | `GET /agent` | 실제 API 확인 |
| 스킬 | `GET /skill` | 실제 API 확인 |
| 모델·provider | `GET /provider`, `GET /config/providers` | 실제 응답 확인. `/provider.connected`에 속한 provider의 모델을 표시 |
| MCP 상태 | `GET /mcp` | 실제 API 확인 |
| 질문 | `GET /question`, `POST /question/{rid}/reply` (`answers: string[][]`), `POST /question/{rid}/reject` | 목록·stale 404 실제 API, 대기 카드·응답 합성 UI 검증 |
| 권한 | `GET /permission`, `POST /permission/{rid}/reply` (`reply: once\|always\|reject`, `message?`) | 목록·stale 404 실제 API 확인, 응답 UI 합성 검증. 구 경로 `POST /session/{sid}/permissions/{pid}`도 존재 — 사용하지 않음 |
| 파일 참조 | `GET /find/file`, `GET /file`, `GET /file/content` | 실제 API 확인 |

## 사용하지 않는 경로

- `/api/*` (v2), `/tui/*`(TUI 제어), `/experimental/*`, `/sync/*`, `/session/{id}/share`(외부 공유는 범위 밖).

## SSE와 토큰 계약

- fetch 기반 Basic 인증 SSE를 사용한다. 재연결마다 세션·메시지·질문·권한을 다시 조회한다. 서버 replay/Last-Event-ID는 보장하지 않으며 의존하지 않는다.
- v1.18.29 `Session.getUsage`에서 input은 캐시를, output은 reasoning을 제외한다. 이 다섯 범주는 별도로 합산한다. `step-finish`가 있으면 단계 값을 사용하며 AssistantMessage의 마지막 단계 미러와 중복 합산하지 않는다.
- 최근 호출, 마지막 사용자 요청의 parentID별 합계, 세션 합계를 분리한다. 컨텍스트는 최신 일반 호출 토큰 합계의 **추정**이며 누적 사용량이 아니다. 압축 이후 새 일반 호출 전에는 정보 없음으로 표시한다. 모델 한도는 현재 선택 모델을 사용한다.

## 남은 외부 검증

- Windows/WSL 실제 Zen 모델 판단 흐름: 무료 모델 파일럿 모두 HTTP 403으로 도구 호출 전에 중단. API 명세 일치가 모델 실행 성공을 의미하지 않는다.

## Windows 네이티브 실측 (2026-10-11)

공식 GitHub v1.18.29의 `opencode-windows-x64.zip`을 사용자 개발 영역에 압축 해제했다.
ZIP SHA-256 `b32618aa3d1415f6e4f473aec248edef25759203fb707d7d968359d86d4a35ee`는 release asset digest와 일치했다.
실행 파일 SHA-256은 `88d2fa691b2d9e32fde6d1039382a850ddf96fe49cd41683c6375fe1dc8ec2a5`다.
PATH나 전역 설정을 변경하지 않았다.

Windows Node 24.18.1의 [검증 스크립트](../tests/agent/check-native.mjs)가 고유 임시 설정과
127.0.0.1의 임시 포트에서 실제 Windows 서버를 실행했다. `/global/health`는 healthy=true/version=1.18.29,
`/doc` 경로 162개와 HTTP 메서드·경로 조합 188개는 저장된 WSL 명세와 일치했다.
non-`/api/` 경로 111개, `/api/` 경로 51개이며 v2 API는 실행하지 않았다.
서버 프로세스 종료도 확인했다. 경로 집합 일치는 모든 경로의 동작 검증을 뜻하지 않는다.

Windows Chrome에서 WSL 서버의 `/global/health`도 읽을 수 있었다.
NAT localhostForwarding이 준비될 때까지 초기 연결 재시도가 필요했다.

## M3 실측과 UI 지원 (2026-10-11)

`tests/integration/opencode-v1-api.mjs`가 실제 Windows/WSL 1.18.29와 제품 클라이언트를 사용했다.
격리한 합성 provider의 요청 횟수는 두 환경 모두 **0회**다. 다음은 모델 호출 없는 실제 API 검증이다.

- Basic 401/200, health, provider/agent/command/skill, 빈 질문·권한 목록과 이미 처리된 ID의 404.
- 세션 생성·이름 변경·검색·삭제, 인증 SSE의 메시지 이벤트, noReply 동기·비동기 메시지 저장.
- UTF-8 텍스트·PNG를 data URL 파일 part로 전송하고 메시지 저장 확인. Windows 경로를 WSL에 전달하지 않는다.
- abort, fork, revert/unrevert, diff/todo/children, 서버 파일 검색·목록·본문.
- Windows `/find/file`은 존재하는 합성 파일에도 빈 결과를 반환했다. 제품은 `/file` 디렉터리 목록으로 보완한다.
- noReply 동기 `/message`는 명세의 AssistantMessage와 달리 UserMessage를 반환했다. 일반 UI 전송은 `/prompt_async`의 204 후 SSE/조회로 처리한다.
- fork는 선택한 메시지 **이전**까지 복사하며 새 root 세션을 만든다. 선택 메시지가 사용자 입력이면 분기한 작성창에 다시 채운다.

다음 UI 기능은 명세·동일 버전 소스와 합성 HTTP/SSE/Chrome 테스트로 검증했다.
실제 모델이 생성하는 질문·권한·커맨드·shell·압축 결과의 종합 시연은 사용자 테스트로 남긴다.

| 기능 | 구현과 경계 |
|---|---|
| 세션 | 검색·열기·생성·이름·삭제·분기·하위 세션·현재 디렉터리·상태 |
| 모델/에이전트 | `/provider.connected`에 속한 서버 모델만 노출, 검색·즐겨찾기·variant, 변경은 다음 요청부터 적용 |
| 메시지 | Markdown/코드/복사·도구 카드·오류·todo/diff·첨부 결과 열기/저장, HTML 실행 없음 |
| 질문/권한 | 다중 질문·복수/직접 답변·reject, once/always/reject, 처리 전 pending 재확인과 404 재동기화. always는 기존 OpenCode가 제시한 기억 범위이며 영구 전면 허용으로 표시하지 않음 |
| 참조/명령 | @파일/에이전트/현재탭/선택영역, /UI 명령과 서버 command 분리, command의 source로 skill/MCP prompt 구별, 서버 skill 본문은 문맥으로 첨부 |
| 작업 | 응답 중단·Bridge gate·실제 도구 결과에 근거한 operation/세션 연결, 압축·revert/unrevert·diff·shell |
| 내보내기 | 대화 JSON/Markdown, 표 CSV/Markdown, 로컬 파일·이미지는 typed data URL, server file 결과는 API로 읽기 |
| 환경 | Windows/WSL/외부 origin 프로필, 자동 ensure, 모델/API/MCP/Extension 진단, CLI attach 안내 |

TUI 전용 단축키, 대화형 터미널, 외부 편집기·OS 대화상자는 CLI로 넘긴다.
서버 플러그인의 도구·훅은 기존 서버가 실행하며 별도 플러그인/스킬 실행 엔진은 없다.
revert는 OpenCode 대화·파일 변경용이며 이미 제출한 웹사이트 작업을 되돌리지 않는다.
