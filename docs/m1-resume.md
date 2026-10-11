# M1 재개 안내 (2026-10-11)

현재 원장은 [status.md](./status.md), 요구사항은 [handoff.md](./handoff.md), 미완료 계획은
[2026-10-11-m1-browser-control.md](./plans/2026-10-11-m1-browser-control.md)다.

## 현재 위치

- 브랜치: `feat/m1-browser-control`, main 기준 `f156c33`.
- Task 1–13 구현·Linux 검증 완료. 전체 브랜치 독립 검토의 Critical/Important 항목도 회귀 테스트로 수정했다.
- Task 14: 실제 Windows Chrome/WSL OpenCode 검증을 진행할 차례. 테스트 스크립트/고정 패키지/Windows exe 준비됨.
- Task 15: WSL 시연 후 Windows 네이티브 OpenCode 1.18.29 검증.
- 사용자는 이번 세션에서 서브에이전트 사용과 필수 개입 이외의 자율 진행을 명시적으로 허용했다.
- push/PR/Release는 요청되지 않았고 수행하지 않았다. 전역 OpenCode 설정은 수정하지 않는다.

## 실제 확인한 최신 기준선

| 범위 | 결과 |
|---|---|
| Rust Linux `cargo test --offline --locked -p agent-browser-bridge` | 90개 통과. 자식 프로세스 테스트용 helper 1개는 기본 ignored이며 부모 테스트가 실제 실행 |
| Extension Vitest | 19파일 147개 통과 |
| Extension TypeScript/Vite | 성공 |
| Node fixture/agent-runner/runtime | 20개 통과 |
| 실제 Linux Bridge + 확장 + Chromium 156.0.8078.4 | 26개 E2E 통과 |
| Windows MSVC release | 빌드 성공 기록 있음. 최근 수정 이후 재빌드·실행 필요 |

Windows 실검증과 LLM 결과는 status.md의 이후 행을 확인한다. Linux Chromium을 Windows Chrome이라고 보고하지 않는다.

## 구현에서 계획과 달라진 핵심 사항

- WebSocket은 `auth.hello` challenge → 서버 HMAC 검증 → `auth.prove` → 승인 순서다.
  토큰을 전송하지 않으며 구형 클라이언트와는 호환되지 않는다. 상세는 [protocol.md](./protocol.md).
- 취소는 operationId/requestId 범위다. Bridge generation이 재시작해도 과거 취소가 새 작업을 막지 않는다.
- ref는 전역 snapshot 번호와 탭/프레임/documentId/operationId 소유 정보에 묶인다.
  새 operation의 쓰기에는 새 snapshot이 필요하다. 다른 탭·문서·작업의 ref는 STALE_ELEMENT다.
- snapshot은 문자/요소/프레임 cursor와 크기 제한을 제공한다. plain table도 ref를 갖는다.
  표 offset은 데이터 행 인덱스이며 rowspan/colspan을 논리 grid로 펼친다.
- `webNavigation` 권한은 정확한 프레임/documentId 식별에 사용한다. debugger 권한은 없다.
- Gate 검사와 owner 연결 enqueue는 동기적으로 하나의 경계 안에서 처리하며 응답 대기는 lock 밖이다.
  abort 취소도 전역 선택값 대신 작업 소유 프로필로 보낸다.
- 같은 요청의 동시 수신은 한 번만 실행한다. 완료 결과는 10분/200개 캐시,
  불명확한 in-flight 표식은 브라우저 세션 동안 유지한다. 무제한 exactly-once 보장은 아니다.
- 동시 최초 config 초기화는 프로세스 간 lock과 원자적 publish로 단일 토큰을 보장한다.
  방치된 lock은 제한시간 뒤 진단 오류를 내고 임의로 제거하지 않는다.
- Windows 설치 준비 스크립트는 고유한 builds 디렉터리로 복사한다. 실행 중인 사용자 프로세스를 강제 종료하지 않는다.
- Windows 테스트는 native Node + 설치된 Chrome + MSVC exe다. CDP 확장 로드는 테스트 전용이며 제품 하네스가 아니다.

## 검토와 검증에서 중요한 점

- 버튼 Enter, 입력 Backspace/Space, select 방향키 등은 실제 기본 동작을 검증한다.
  DOM synthetic 이벤트와 trusted 입력을 동일하다고 주장하지 않는다.
- R26은 테스트에서 SW의 Chrome API 응답을 보류하고 실제 worker를 종료한다.
  제출 한 번, EXECUTION_UNKNOWN, in-flight 기록 유지와 재실행 거부를 확인했다.
- R25는 동일 토큰·주소로 재페어링한다. Options의 명시적 reconnect 요청으로 halted 연결도 복구한다.
- Chromium sandbox srcdoc 프레임은 이번 버전에서 주입 가능했다. 다른 정책/버전은 따로 검증한다.
- 전체 브랜치 검토에서 보수적인 링크 이동 결과 EXECUTION_UNKNOWN은 유지했다.
  모델이 페이지를 다시 읽어 판단하도록 한다. MCP 부분 전송 재시도는 검토에서 중복 실행 결함으로 확정되지 않았다.
- M2 자동 실행/doctor, M3 전체 작업 UI, M4 배포 패키지는 아직 구현 범위 밖이다.

## 이어서 실행

1. `git status`, `git log`와 status.md의 최신 행을 확인한다. 기존 변경사항을 보존한다.
2. Windows 스모크: `bash scripts/test-windows.sh -- --grep 'S01 '`, 이후 전체 Windows 시나리오.
3. WSL fixture의 Windows localhost 접근 확인. 실패하면 별도 Windows fixture를 사용하고 차이를 기록한다.
4. demo 모드로 Windows 테스트 세계를 유지하고 `tests/agent/run-agent.sh`로 실제 WSL OpenCode를 호출한다.
   무료 검증·격리 설정·원시 결과는 `tests/agent/results/`에만 저장하며 git에 추가하지 않는다.
   공식 현재 가격/모델 목록과 설치본 metadata로 무료·toolcall을 확인한다. 유료 fallback은 없다.
5. 실제 Windows exe의 공백/한글 경로·MCP stdout·자동 시작·MCP 종료 후 serve 생존·중복 serve를 확인한다.
   어떤 detached 시작 경로가 사용됐는지는 MCP stderr의 `serve_spawn` 진단으로 확인한다.
6. Task 15 Windows 네이티브 OpenCode 1.18.29를 사용자 검증 영역에 두고 같은 시나리오/API 명세를 확인한다.
7. 과제별 실제 결과와 미검증을 status.md에 기록하고 Conventional Commit으로 남긴다.

실행 계획 보조 기록은 `.superpowers/sdd/2026-10-11-m1-browser-control/`에 있다.
계획서의 과거 미체크박스보다 상태 문서·검증 출력·커밋을 우선한다.
