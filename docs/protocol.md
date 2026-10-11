# 내부 RPC 프로토콜 (v1)

Bridge(`browser-bridge`), Chrome Extension, MCP 프록시가 WebSocket(`ws://127.0.0.1:4317`)으로 주고받는
JSON 메시지 규약이다. 계약의 원장은 `protocol/` 디렉터리이며 Rust와 TypeScript 양쪽이 같은 fixture로 테스트한다.

| 파일 | 내용 |
|---|---|
| `protocol/schema/envelope.schema.json` | 봉투 JSON Schema |
| `protocol/schema/error-codes.json` | 오류 코드 목록(양쪽 구현의 순서까지 같아야 함) |
| `protocol/fixtures/*.json` | 요청·응답·이벤트 예제. `res-unknown-version.json`은 거부되어야 하는 입력 |

## 봉투

버전은 정수 `v: 1`. 알 수 없는 버전은 `PROTOCOL_VERSION_UNSUPPORTED` 응답 후 연결을 닫는다.

```json
{"v":1,"type":"req","id":"req-…","method":"browser.click","params":{}}
{"v":1,"type":"res","id":"req-…","ok":true,"result":{}}
{"v":1,"type":"res","id":"req-…","ok":false,"error":{"code":"STALE_ELEMENT","message":"…","retry":"never","details":{}}}
{"v":1,"type":"evt","event":"status.changed","data":{}}
```

## 연결과 역할

| 경로 | 역할 | Origin | 첫 메시지 |
|---|---|---|---|
| `/extension` | Extension | `chrome-extension://<id>` 필수 | `auth.hello` |
| `/mcp-proxy` | Mcp | 헤더가 있으면 거부 | `auth.hello` |

토큰은 URL query에 넣지 않고 `auth.hello`의 `params.token`으로만 보낸다. 인증 전 요청은 `AUTH_REQUIRED`.

## 역할별 허용 메서드

| 방향 | 메서드 |
|---|---|
| Extension → serve | `heartbeat`, `status.get`, `operation.abort`, `browser.use` |
| Mcp → serve | `tool.call` |
| serve → Extension | `browser.*` 명령(`browser.click` 등) |
| 그 밖 | `FORBIDDEN_METHOD` |

## 오류

`error.retry`의 의미:

| 값 | 의미 |
|---|---|
| `safe` | 같은 요청을 다시 보내도 된다 |
| `unsafe` | 실행 여부를 알 수 없다. 페이지 상태를 먼저 확인한다 |
| `never` | 입력이나 상태를 바꾸지 않으면 같은 결과다 |

오류 코드 전체 목록은 `protocol/schema/error-codes.json`을 따른다. 응답 없음·연결 끊김·타임아웃 뒤의
쓰기 명령(click/fill/select/press/navigate/scroll/tabs new)은 자동 재실행하지 않고 `EXECUTION_UNKNOWN`으로 끝낸다.
