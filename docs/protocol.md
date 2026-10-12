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
| Extension → serve | `heartbeat`, `status.get`, `operation.abort`, `browser.use`, `profile.list`, `profile.save`, `profile.delete`, `runtime.ensure`, `runtime.status`, `runtime.stop`, `doctor.run` |
| Mcp → serve | `tool.call`, `tool.cancel` |
| serve → Extension | `browser.*` 명령(`browser.click` 등) |
| 그 밖 | `FORBIDDEN_METHOD` |

MCP 연결은 동일한 토큰으로 인증했더라도 프로필과 런타임 관리 메서드를 호출할 수 없다. Extension SW는 확장 내부 페이지에서 온 관리 요청만 전달한다. 관리 작업은 연결의 브라우저 응답 처리를 막지 않도록 비동기로 실행된다.

## MCP 요청 취소

MCP `notifications/cancelled`의 요청별 토큰은 mutex 대기·연결·전송·응답 대기를 중단한다.
전송 후에는 `tool.cancel`의 `{requestId: 원래 tool.call의 RPC ID}`를 같은 인증 연결로 보낸다.
serve는 해당 연결의 요청 future만 정리하며, registry는 그 요청의 `browser.cancel`을 원래 Extension으로 보낸다.
연결과 다른 요청, 기존 operation은 유지된다. 이미 전달된 쓰기는 실행 여부가 불명확할 수 있으므로 자동 재실행하지 않는다.
취소와 성공 응답이 교차한 attach만 그 요청이 새로 만든 operation을 닫는다. 교체된 operation은 닫지 않는다.

## 프로필 관리

아래는 일반 `req` 봉투의 `method`와 `params`다. 성공 결과는 `res.result`에 담긴다. 프로필과 실행 상태의 파일 형식은 Bridge 내부 저장 형식이며 RPC 봉투 버전과 별도로 관리한다.

| 메서드 | params | 성공 result |
|---|---|---|
| `profile.list` | `{}` | `{profiles:[프로필 요약...], defaultProfileId}` |
| `profile.save` | `{profile:프로필, makeDefault?:boolean}` | `{profile:프로필 요약}` |
| `profile.delete` | `{profileId:string}` | `{deleted:true}` |

프로필은 `id`, `name`, `kind`, `directory`가 필수다. `id`는 영문·숫자·`_`·`-`로 된 1–64자이며 `kind`는 `windows`, `wsl`, `external` 중 하나다.

| 필드 | 의미 |
|---|---|
| `executable` | 관리 Windows/WSL OpenCode의 절대 경로. Windows는 `.cmd` 런처도 지원 |
| `distribution`, `user` | WSL 배포판과 선택적 사용자. WSL은 배포판을 명시 |
| `directory` | 서버에 전달할 작업 경로. 관리 프로필은 해당 OS의 절대 경로 |
| `env` | 관리 프로세스에 전달할 환경변수 객체. 소유권·서버 인증·WSLENV 예약 키는 거부 |
| `port` | 관리 OpenCode 포트 1–65535. 생략하면 자동 선택 |
| `baseUrl` | 외부 OpenCode의 HTTP(S) origin. 원격 HTTP와 URL 내 인증정보는 거부 |
| `username`, `password` | 외부 서버의 선택적 Basic 인증정보 |

목록과 저장 응답은 `password`, `env` 값을 제외하고 `hasPassword`, `envKeys`로 저장 여부를 나타낸다. 기존 프로필 저장 시 `password` 또는 `env`를 생략하면 해당 저장값을 유지한다. 관리 런타임 기록이 있으면 먼저 `runtime.stop`을 수행해야 프로필을 수정할 수 있다. 프로필 삭제는 관리 런타임 종료에 성공한 뒤 저장된 프로필을 지우며 외부 서버를 종료하지 않는다.

## 런타임과 진단

| 메서드 | params | 동작 |
|---|---|---|
| `runtime.ensure` | `{profileId:string}` | 소유권·인증·v1 API를 확인해 재사용하거나 관리 서버 시작. 외부 서버는 연결만 확인 |
| `runtime.status` | `{profileId:string}` | 서버를 시작하지 않고 현재 상태 확인 |
| `runtime.stop` | `{profileId:string}` | 소유권이 확인된 관리 서버만 종료. `{stopped:boolean}` 반환 |
| `doctor.run` | `{profileId?:string}` | 지정 프로필 또는 모든 프로필의 실행 파일·연결·MCP·모델 메타데이터 진단 |

런타임 결과의 공통 필드는 `profileId`, `directory`, `state`, `owned`다. `state`는 `ready`, `stopped`, `starting`, `error`이고 연결 가능하면 `baseUrl`, `version`, `attachCommand`가 추가된다. 관리 서버 실패에는 `error` 설명이 추가된다. `runtime.ensure`는 정상 RPC 응답(`ok:true`) 안에 `state:"error"`를 반환할 수 있으므로 호출자는 두 상태를 구분해야 한다.

`runtime.ensure`의 `ready` 결과에는 HTTP 클라이언트가 사용할 `username`, `password`가 포함될 수 있다. 이는 인증된 Extension에만 전달하며 URL·화면·로그·클립보드·브라우저 영구 저장에 넣지 않는다. `runtime.status`, 프로필 요약, 진단에는 비밀번호를 넣지 않는다. `attachCommand`는 비밀번호 대신 Bridge의 `--home ... attach --profile ...` 호출을 표시한다. CLI는 저장된 인증정보를 자식 OpenCode의 환경변수로 전달한다.

관리 서버는 인증 없는 health 요청이 401이고 인증된 `/global/health`가 v1 정상 상태이며 `/doc`에 필요한 v1 경로가 있을 때 사용한다. 프로세스가 남아 있지만 listener 소유권을 검증할 수 없으면 중복 서버를 시작하지 않고 오류를 반환한다. 관리 작업은 프로필별 프로세스 잠금으로 중복 실행을 막는다. 종료 확인 실패 시 소유권 기록을 유지한다.

`doctor.run` 결과는 `{ok:boolean, checks:[...]}`다. 각 check는 `id`, `status`(`ok`/`warning`/`error`), `message`와 필요하면 `profileId`를 가진다. `ok`는 오류가 없다는 뜻이며 경고까지 모두 해소되었다는 뜻은 아니다. 진단은 OpenCode 서버를 새로 시작하거나 모델 요청을 보내지 않는다. 모델 목록 조회와 추론 성공을 구분하며 `inferenceTested:false`를 표시한다.

제품 제거용 `runtime stop-all --json`과 복구용 `runtime start --profile`은 로컬 CLI 명령이며 WebSocket 메서드가 아니다. 전자는 `stoppedProfiles`, `skippedExternal`, `errors`를 출력하고 실패 항목이 있으면 비정상 종료한다. 설치 스크립트는 실제 중지된 프로필만 rollback 대상으로 사용한다.

## OpenCode HTTP/SSE와의 구분

대화 API는 이 WebSocket 봉투에 싣지 않는다. Side Panel이 선택한 OpenCode v1 origin에 직접 HTTP/SSE로 연결하고 `directory` query와 필요한 Basic 인증을 전달한다. 권한·질문 응답, 세션·메시지·모델 데이터의 계약은 [저장된 OpenAPI 명세](./reference/opencode-1.18.29-openapi.json)를 따른다.

SSE가 끊기면 재연결 후 메시지·세션 상태·미응답 질문과 권한을 다시 조회한다. 이벤트 replay는 가정하지 않고, 제공된 이벤트 ID는 제한된 캐시로 중복을 제거한다. 변경 HTTP 요청은 자동 재전송하지 않는다. 프로필·세션 전환은 기존 스트림을 중단하고 이전 연결의 늦은 결과가 새 상태를 덮어쓰지 않도록 분리한다.

## 오류

`error.retry`의 의미:

| 값 | 의미 |
|---|---|
| `safe` | 같은 요청을 다시 보내도 된다 |
| `unsafe` | 실행 여부를 알 수 없다. 페이지 상태를 먼저 확인한다 |
| `never` | 입력이나 상태를 바꾸지 않으면 같은 결과다 |

오류 코드 전체 목록은 `protocol/schema/error-codes.json`을 따른다. 응답 없음·연결 끊김·타임아웃 뒤의
쓰기 명령(click/fill/select/press/navigate/scroll/tabs new)은 자동 재실행하지 않고 `EXECUTION_UNKNOWN`으로 끝낸다.


### 패널 요청의 탭 예약

Extension 관리 RPC `request.begin {requestId, clientId, tabId?}`는 선택된 브라우저의 새 사용자 요청을 예약한다. 하나의 요청만 예약할 수 있다. tabId 누락은 안전한 기본 대상이 없음을 뜻하며 attach 시 현재 탭으로 대체하지 않는다. `browser_tabs action=attach`의 선택적 requestId가 예약과 일치해야 한다. 명시적 tabId는 캡처된 기본값보다 우선한다. 기존 CLI는 예약이 없을 때 requestId 없이 attach할 수 있다.

`request.end {requestId, clientId}`는 정확히 일치하는 예약과 그 operation을 해제하고 content 명령을 취소한다. 이전 operation으로 뒤늦게 들어온 도구 호출은 거부한다. Stop은 operation과 연결된 예약도 무효화한다. 완료 판단은 동일 OpenCode session/message 응답과 authoritative idle 상태로 확인하며, API 응답이 불명확하면 session storage의 예약 식별자를 보존한다.


### 프레임 대기

`browser_snapshot`의 각 프레임은 `frameRef`(예: `s12f7`)를 반환한다. `browser_wait {operationId, frameRef, text}`는 그 snapshot에 결합된 tab/operation/document에서 조건을 검사한다. DOM 본문만 교체되면 유지되지만 프레임 제거·문서 이동·다른 작업/탭의 참조는 `STALE_ELEMENT`다. `refGone`과 함께 지정하면 같은 snapshot 프레임이어야 한다.

조건은 OR이며, 명시적 frameRef의 URL 조건도 해당 문서에만 적용한다. frameRef를 생략하면 refGone의 프레임, 둘 다 없으면 최상위 문서를 사용한다. 최상위 URL 대기는 기존의 탭 이동 관찰을 유지한다. iframe의 문서 간 이동 후에는 새 snapshot을 요청한다. 다른 프레임의 같은 텍스트나 URL로 성공을 대신하지 않는다.
