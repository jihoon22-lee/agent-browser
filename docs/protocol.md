# 내부 RPC 프로토콜 (v1)

Bridge(`browser-bridge`), Chrome Extension, MCP 프록시가 WebSocket(`ws://127.0.0.1:4317`)으로 주고받는
JSON 메시지 규약이다. 계약의 원장은 `protocol/` 디렉터리이며 Rust와 TypeScript 양쪽이 같은 fixture로 테스트한다.

| 파일 | 내용 |
|---|---|
| `protocol/schema/envelope.schema.json` | 봉투 JSON Schema |
| `protocol/schema/error-codes.json` | 오류 코드 목록(양쪽 구현의 순서까지 같아야 함) |
| `protocol/fixtures/*.json` | 요청·응답·이벤트 예제. `res-unknown-version.json`은 거부되어야 하는 입력 |
| `protocol/auth-vectors.json` | 합성 토큰으로 독립 계산한 HMAC 벡터. Rust와 WebCrypto에서 같은 결과를 검증 |

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

페어링 토큰은 URL이나 WebSocket 메시지에 보내지 않는다. 봉투 `v: 1` 안에서 별도
`authVersion: 1`인 HMAC-SHA256 상호 인증을 사용한다. 인증 전에 일반 메서드를 보내면
`AUTH_REQUIRED`로 응답하고 연결을 닫는다.

1. 클라이언트 → `auth.hello`: `{authVersion:1, role, clientId, clientNonce, clientVersion, repair:false}`.
   `clientNonce`는 새 연결마다 만드는 64자리 소문자 hex이고, `clientId`는 비어 있지 않은 256바이트 이하 문자열이다.
2. 서버 → hello 성공 응답: `{authVersion:1, serverName:"agent-browser", serverNonce, serverProof}`.
   `serverNonce`도 연결마다 새로 만드는 64자리 소문자 hex다. 이 응답만으로 연결을 인증하거나
   Extension ID를 페어링하지 않는다.
3. 클라이언트는 토큰으로 `serverProof`를 검증한 뒤에만 `auth.prove`를 보낸다:
   `{authVersion:1, proof:clientProof}`. 증명이 틀리면 `AUTH_FAILED`로 닫으며 토큰이나 클라이언트 증명을 보내지 않는다.
4. 서버는 클라이언트 증명을 검증한 뒤 페어링·등록을 수행하고, prove 성공 응답에
   `{authVersion:1, serverName, serverVersion, protocolVersion, connectionId, selected, clientId}`를 보낸다.
   Extension은 이 응답 뒤부터 브라우저 명령을 처리한다.

증명은 토큰 문자열의 **UTF-8 바이트를 키**로 사용하는 HMAC-SHA256의 64자리 소문자 hex다.
토큰이 hex처럼 보여도 디코딩하지 않는다. 입력은 아래 배열을 공백 없는 JSON으로 직렬화한 UTF-8 바이트다.
Rust `serde_json`과 JavaScript `JSON.stringify`가 같은 값을 생성한다. `repair`는 boolean이다.

```text
["agent-browser-auth-v1", side, role, clientId, clientNonce, serverNonce, repair]
```

`side`는 서버 증명에 `"server"`, 클라이언트 증명에 `"client"`를 사용한다. 두 방향의 증명을
분리하고 역할·클라이언트 ID·두 nonce·재페어링 의도를 묶어 반사 공격과 다른 연결의 증명 재사용을 거부한다.
Rust는 HMAC 라이브러리의 상수 시간 검증을, Extension은 WebCrypto의 `verify`를 사용한다.
서버는 hello와 prove를 각각 5초 이내에 받아야 하고, Extension은 소켓 연결부터 prove 승인까지 총 10초를 제한한다.

이전 `params.token` 방식이나 지원하지 않는 `authVersion`은 `AUTH_FAILED`로 거부한다.
Bridge와 Extension을 함께 업데이트해야 하며 기존 페어링 토큰 자체는 계속 사용할 수 있다.
포트 진단 probe는 토큰 없는 hello 응답의 `serverName`만 읽는다. 이 문자열은 진단용 식별 정보이며
서버 인증의 근거가 아니다. 실제 MCP와 Extension 연결은 항상 양방향 증명을 완료해야 한다.
이 규약은 로컬 연결의 상대방 인증이며 메시지 암호화 기능은 제공하지 않는다.

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
