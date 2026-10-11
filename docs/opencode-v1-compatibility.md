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
| CORS | `chrome-extension://` Origin preflight는 204지만 `Access-Control-Allow-Origin` 없음 | 실제 호출. 확장은 host permission 기반 요청 또는 `--cors <origin>` 필요 — M3에서 검증 |
| 작업 디렉터리 | 대부분 경로가 `directory`, `workspace` query 파라미터를 받음 | OpenAPI |
| 경로 체계 | non-`/api` v1 경로와 `/api/*` v2 경로가 함께 존재 | OpenAPI. **v1만 사용** |
| 기본 바인딩 | `--hostname` 기본 `127.0.0.1`, `--port` 기본 0(임의) | `opencode serve --help` |
| 이벤트 | `GET /event`(인스턴스), `GET /global/event`(전역), `text/event-stream`, Event 변형 89종 | OpenAPI |

## 기능별 v1 경로 (후보 → 확정은 해당 마일스톤에서 실제 호출로)

| 기능 | v1 경로 | 상태 |
|---|---|---|
| 상태 | `GET /global/health` | 확인됨 |
| 세션 목록·검색 | `GET /session?directory&search&limit&roots&start` | 명세 확인 |
| 세션 생성 | `POST /session` (`parentID,title,agent,model{id,providerID,variant},permission`) | 명세 확인 |
| 세션 조회·수정·삭제 | `GET/PATCH/DELETE /session/{id}` | 명세 확인 |
| 세션 상태 | `GET /session/status` → `idle` / `busy` / `retry` | 명세 확인 |
| 메시지 전송 | `POST /session/{id}/message`(동기), `POST /session/{id}/prompt_async` | 명세 확인. body: `parts`, `model{providerID,modelID}`, `agent`, `variant`, `tools` |
| 메시지 조회 | `GET /session/{id}/message`, `GET /session/{id}/message/{mid}` | 명세 확인 |
| 중단 | `POST /session/{id}/abort` | 명세 확인 |
| 분기·압축 | `POST /session/{id}/fork`, `POST /session/{id}/summarize` | 명세 확인 |
| revert·diff·todo | `/revert`, `/unrevert`, `GET /diff`, `GET /todo` | 명세 확인 |
| 커맨드 | `GET /command`, `POST /session/{id}/command` (`command`,`arguments`) | 명세 확인 |
| 셸 | `POST /session/{id}/shell` | 명세 확인 |
| 에이전트 | `GET /agent` | 명세 확인 |
| 스킬 | `GET /skill` | 명세 확인 |
| 모델·provider | `GET /provider`, `GET /config/providers` | 명세 확인. 어느 쪽이 '설정·사용 가능' 기준인지 M3에서 실제 응답으로 결정 |
| MCP 상태 | `GET /mcp` | 명세 확인 |
| 질문 | `GET /question`, `POST /question/{rid}/reply` (`answers: string[][]`), `POST /question/{rid}/reject` | 명세 확인 |
| 권한 | `GET /permission`, `POST /permission/{rid}/reply` (`reply: once\|always\|reject`, `message?`) | 명세 확인. 구 경로 `POST /session/{sid}/permissions/{pid}`도 존재 — 사용하지 않음 |
| 파일 참조 | `GET /find/file`, `GET /file`, `GET /file/content` | 명세 확인 |

## 사용하지 않는 경로

- `/api/*` (v2), `/tui/*`(TUI 제어), `/experimental/*`, `/sync/*`, `/session/{id}/share`(외부 공유는 범위 밖).

## 미확인

- SSE의 Last-Event-ID·replay 지원 여부.
- 토큰 필드(`AssistantMessage.tokens`)의 캐시·추론 포함 관계와 단계별 집계 중복.
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
