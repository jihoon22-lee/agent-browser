# 테스트와 실행 증거

요구사항 원장은 [handoff.md](./handoff.md) §17, 최신 실행 결과는 [status.md](./status.md)다.
Linux 테스트 통과, Windows용 빌드 성공, 실제 Windows 프로세스 실행, 실제 에이전트 판단 성공은 서로 다른 검증이다.

## 계층과 실행

```bash
cargo test --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-extension test
node --test tests/fixtures/server.test.mjs
pnpm --filter agent-browser-extension build
cargo build --offline --locked -p agent-browser-bridge
pnpm --filter agent-browser-e2e exec playwright test
```

최초 개발 환경에서만 고정된 테스트 의존성의 Chromium을 설치한다:

```bash
pnpm install --frozen-lockfile
pnpm --filter agent-browser-e2e exec playwright install chromium
```

- Rust: RPC 계약, 설정, 인증, 작업 게이트, 실제 localhost WebSocket, 실제 MCP stdio 자식 프로세스.
- Extension/Vitest: DOM·제어 입력·참조·취소·Shadow DOM, 가짜 Chrome API 경계의 SW 라우팅,
  session 저장소 중복 방지, 연결 수명, HMAC 공유 벡터, 패널 reducer/React 통합.
- E2E: 실제 Linux Bridge + 실제 확장 + Playwright Chromium + 직접 작성한 fixture 사이트.
  Linux Bridge와 Playwright는 **테스트 의존성**이며 Windows 제품 배포물이나 사용자의 브라우저 제어 하네스가 아니다.
- Windows/에이전트: 실제 Windows exe·Chrome·WSL interop·OpenCode Zen 검증은 별도 결과로 기록한다.

## 결정적 시나리오 대응

| E2E | handoff §17-A | 검증 |
|---|---|---|
| S01 | 1 | 목록, 지정 탭 attach |
| S02 | 2 | fill/Enter 검색, fixture 검색 body |
| S03 | 3 | 입력·select·checkbox, 앱 상태와 추출 결과 |
| S04 | 4 | 새 탭, 작업 탭 전환, 원래 탭 복귀 |
| S05 | 5 | SPA 교체 후 옛 ref가 STALE_ELEMENT |
| S06 | 6 | 비동기 출현과 TIMEOUT |
| S07 | 7 | 동일/교차 출처/sandbox 프레임, open/closed Shadow DOM |
| S08 | 8 | 표의 정확한 행·열·문자열 |
| S09 | 9 | 사용자가 활성 탭을 바꿔도 작업 대상 고정 |
| S10 | 10 | 다른 탭 스크린샷 거부, 활성 작업 탭 PNG |
| S11 | 11 | 대기 중 중단, 이후 명령 차단 |
| S12 | 12 | Bridge 재시작, 실제 SW 종료/재시작과 복구 |
| S13 | 13 | 제출 응답 유실, SW 재시작, 동일 ID 재전송에도 제출 1회 |
| S14 | 14 | 두 MCP 클라이언트의 BROWSER_BUSY |
| S15 | 15 | 패널을 열었다 닫아도 조작 유지 |
| S16 | 추가 | MCP stdout은 JSON-RPC만 |
| S17 | 추가 | 제한 페이지 거부 |
| R18 | 추가 회귀 | 취소 → Bridge 재시작 → 새 작업 허용 |
| R19 | 추가 회귀 | 다른 탭/이동한 문서에서 옛 ref 거부 |
| R20 | 추가 회귀 | 현재 탭 종료 후 다른 탭으로 전환/작업 해제 |

## 브라우저에서 확인한 사항

- Linux: Playwright `1.64.0`, Chromium `156.0.8078.4` (revision 1248).
- S07: 이번 Chromium에서는 `sandbox=""` srcdoc 프레임에도 확장 주입이 가능했다.
  이를 `injected`로 고정해 검사한다. 다른 버전/정책에서의 동일 동작을 주장하지 않는다.
- SW 종료는 CDP `ServiceWorker.stopAllWorkers`의 `runningStatus: stopped`와 새
  `performance.timeOrigin`, 재인증/실제 snapshot 왕복으로 확인한다. Playwright의 worker.close만으로
  판단하지 않는다(이번 Chromium은 같은 target ID를 재사용했다).
- S13은 테스트 전용 WebSocket relay로 **브라우저 명령 응답**을 보류하고 fixture에 제출이 기록된 후
  Bridge 연결을 끊는다. 사이트 HTTP 응답의 2초 지연과 Bridge 응답 시점을 혼동하지 않는다.
- 모든 fixture/profile/config는 테스트가 만든 임시 위치를 사용한다. 종료 시 테스트가 소유한
  자식 프로세스만 정리하며 사용자의 브라우저나 OpenCode 설정을 건드리지 않는다.
- HTML fixture·인증 벡터는 합성 데이터다. 실행 토큰·사용자 페이지·실제 대화는 저장소에 추가하지 않는다.

## 현재 구현의 한계

DOM 이벤트는 trusted 사용자 입력과 동일하지 않다. OS 대화상자, 닫힌 Shadow DOM, canvas 내부 조작,
전체 페이지·백그라운드 캡처는 지원을 주장하지 않는다. snapshot 본문은 문자 수 제한이며 토큰 수가 아니다.
완료 요청 캐시는 10분/최근 200개이며 in-flight tombstone은 브라우저 세션 동안 보존한다.
프로세스 재시작을 가로지르는 무제한 exactly-once 보장은 아니다.
