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

1. 클라이언트 → `auth.hello`: `{authVersion:1, role, clientId, clientNonce, clientVersion, repair:false}`. 관리 런타임이 띄운 MCP 프록시는 선택 필드 `runtimeId`(기동마다 새로 만드는 `AGENT_BROWSER_RUNTIME_ID`, 64자 이하 영숫자·하이픈)와 `cwd`(프록시의 현재 폴더)를 함께 보낸다. 인증 transcript에는 포함하지 않으며 아래 "패널 요청 자동 결합"에만 쓴다.
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
| Extension → serve | `heartbeat`, `status.get`, `request.begin`, `request.end`, `operation.abort`, `operation.pause`, `operation.resume`, `browser.use`, `profile.list`, `profile.save`, `profile.delete`, `runtime.ensure`, `runtime.status`, `runtime.stop`, `doctor.run` |
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
| `runtime.status` | `{profileId:string, includeConnection?:boolean}` | 서버를 시작하지 않고 현재 상태 확인. 인증된 Extension이 includeConnection을 요청한 ready 응답만 HTTP 인증정보 포함 |
| `runtime.stop` | `{profileId:string}` | 소유권이 확인된 관리 서버만 종료. `{stopped:boolean}` 반환 |
| `doctor.run` | `{profileId?:string}` | 지정 프로필 또는 모든 프로필의 실행 파일·연결·MCP·모델 메타데이터 진단 |

런타임 결과의 공통 필드는 `profileId`, `directory`, `state`, `owned`다. `state`는 `ready`, `stopped`, `starting`, `error`이고 연결 가능하면 `baseUrl`, `version`, `attachCommand`가 추가된다. 관리 서버 실패에는 `error` 설명이 추가된다. `runtime.ensure`는 정상 RPC 응답(`ok:true`) 안에 `state:"error"`를 반환할 수 있으므로 호출자는 두 상태를 구분해야 한다.

`runtime.ensure`의 `ready` 결과에는 HTTP 클라이언트가 사용할 `username`, `password`가 포함될 수 있다. 이는 인증된 Extension에만 전달하며 URL·화면·로그·클립보드·브라우저 영구 저장에 넣지 않는다. `runtime.status` 기본 응답, 프로필 요약, 진단에는 비밀번호를 넣지 않는다. managed 서버의 HTTP health는 통과했으나 MCP가 실패하면 state:error/httpReady:true로 구분하고 doctor는 MCP 세부 진단을 계속한다. background 완료 확인은 `runtime.status {includeConnection:true}`로 실행 중 연결만 조회하며 인증정보는 메모리에서만 사용한다. `attachCommand`는 비밀번호 대신 Bridge의 `--home ... attach --profile ...` 호출을 표시한다. CLI는 저장된 인증정보를 자식 OpenCode의 환경변수로 전달한다.

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
쓰기 명령(click/fill/select/press/navigate/scroll/tabs new/close)은 자동 재실행하지 않고 `EXECUTION_UNKNOWN`으로 끝낸다.


### 패널 요청의 탭 예약

Extension 관리 RPC `request.begin {requestId, clientId, tabId?, profileId?, sessionId?, directory?}`는 선택된 브라우저의 새 사용자 요청을 예약한다. 하나의 요청만 예약할 수 있다. tabId 누락은 안전한 기본 대상이 없음을 뜻하며 attach 시 현재 탭으로 대체하지 않는다. `browser_tabs action=attach`의 선택적 requestId가 예약과 일치해야 한다. 명시적 tabId는 캡처된 기본값보다 우선한다. 기존 CLI는 예약이 없을 때 requestId 없이 attach할 수 있다.

`profileId`·`sessionId`·`directory`는 이 요청을 처리하는 실행 환경·OpenCode 세션·작업 폴더다. 셋이 모두 있을 때만 요청 범위로 기록하고, 없으면 기존처럼 범위 없는 요청이다.

**패널 요청 자동 결합.** 관리 런타임의 MCP 프록시가 보낸 도구 호출이 아래 조건을 모두 만족하면 Bridge가 생략된 ID를 현재 패널 요청으로 채운다. 조건은 호출마다 다시 확인한다.
- 프록시의 `runtimeId`가 현재 런타임 기록의 실행 ID와 같다(이전 기동의 프록시는 결합하지 않는다).
- 그 런타임의 프로필이 요청의 `profileId`와 같고, 프록시 `cwd`가 요청 `directory`와 같다. OpenCode가 디렉터리 문자열로 인스턴스를 나누므로 드라이브 문자 대소문자와 구분자·끝 구분자만 무시하고 나머지는 그대로 비교한다. WSL은 `\\wsl.localhost\<배포판>\…`·`\\wsl$\…`를 Linux 경로로, `/mnt/<드라이브>/…` 폴더의 드라이브 경로(`C:\…`)를 `/mnt/c/…`로 바꿔 비교한다.
- Bridge가 그 런타임의 `GET /session/status?directory=<directory>`를 직접 조회했을 때 busy·retry 세션이 요청 세션뿐이다. 같은 서버에 붙은 CLI 세션이나 다른 패널 세션이 작업 중이면 결합하지 않는다.

결합되면 `browser_tabs` attach/new의 `requestId`, switch/close/release와 페이지 도구의 `operationId`를 채운다. 페이지 도구인데 요청에 작업이 아직 없으면 캡처된 탭에 attach한 뒤 실행한다. 이 암묵 attach는 일반 attach와 같은 snapshot·쓰기 안전 규칙을 따르고, 호출이 취소되면 새 작업을 해제한다. 암묵 attach가 필요했던 호출이 쓰기 도구(navigate·click·fill·select·press·scroll)이면 실행하지 않고 attach 결과(snapshot·openTabs)를 `STALE_ELEMENT`(retry safe, executed no)로 돌려준다. 모델이 보지 않은 페이지에 쓰지 않기 위해서다. 요청에 작업이 이미 있으면 ID 없는 `new`는 그 작업에 탭을 추가한다. 조건이 하나라도 어긋나면 인수를 바꾸지 않으므로 기존 오류(`OPERATION_REQUIRED`, "Missing requestId…", 끝난 요청, 정지 후 30초 차단)가 그대로 난다. 외부 서버 프로필과 사용자가 직접 등록한 CLI MCP는 `runtimeId`가 없어 항상 명시 ID를 쓴다.

`request.end {requestId, clientId, abort?:boolean}`는 정확히 일치하는 예약을 끝내고 content 명령을 취소한다. 정상 완료는 Released, 사용자 Stop(`abort:true`)은 Aborted로 남겨 이전 operation 호출에 CANCELLED를 반환한다. Stop 후 같은 client의 requestId 없는 attach/new는 30초 동안 CANCELLED이며, 명시적인 새 사용자 requestId는 즉시 사용할 수 있다. 이 유한한 중단 표시가 Bridge 재시작이나 30초 이후까지 모든 늦은 호출을 막는다고 보장하지 않는다. MCP tool.cancel/응답 전송 실패의 operation abort는 예약과 캡처한 기본 탭을 유지한다. Extension의 operation.abort는 사용자 중단으로 예약도 끝낸다.

background는 활성 worker에서 15초 주기, suspended worker에서는 1분 alarm으로 예약을 확인한다(Chrome 스케줄링에 따른 지연 가능). 패널이 닫혀도 같은 session/message의 완료 응답과 busy/retry가 아닌 상태를 확인하면 정상 해제한다. stopped/error 응답 또는 명확한 프로필 삭제 오류를 확인한 경우에만 runtime을 시작하지 않고 Bridge gate를 닫아 lease를 정리한다. 시작 중 상태, 연결 단절, timeout, 기타 조회 실패는 완료 증거가 아니므로 lease를 보존한다. runtime.status는 managed MCP 준비 확인을 위해 60초 응답 제한을 사용한다. 열린 패널은 storage 변경을 구독해 background 해제를 즉시 반영한다. Stop은 gate가 닫히면 런타임 발견/abort 실패와 무관하게 lease를 정리하고, background 취소는 handled/abortSent를 반환한다. 성공적으로 전송한 /abort는 패널에서 반복하지 않으며, Bridge 실패 또는 abortSent:false일 때는 패널이 선택된 OpenCode 세션의 /abort를 직접 시도한다.


### 프레임 대기

`browser_snapshot`의 각 프레임은 `frameRef`(예: `s4h2kxf7`, 스냅샷 ID는 36진수)를 반환한다. `browser_wait {operationId, frameRef, text}`는 그 snapshot에 결합된 tab/operation/document에서 조건을 검사한다. DOM 본문만 교체되면 유지되지만 프레임 제거·문서 이동·다른 작업/탭의 참조는 `STALE_ELEMENT`다. `refGone`과 함께 지정하면 같은 snapshot 프레임이어야 한다.

조건은 OR이며 URL 조건은 frameRef/refGone 유무와 관계없이 탭의 최상위 URL을 관찰한다. 텍스트·refGone은 명시적 frameRef, 없으면 refGone의 프레임, 둘 다 없으면 최상위 문서를 사용한다. content 문서가 사라져도 URL 관찰은 timeout까지 유지한다. iframe의 문서 간 이동 후에는 새 snapshot을 요청한다. 다른 프레임의 같은 텍스트로 성공을 대신하지 않는다.


## 게시판 탐색과 탭 닫기

- back/forward는 현재 top document를 고정한 isolated-world `history.back/forward`를 사용한다. Chrome의 `tabs.goBack/goForward`는 신뢰된 사용자 활성화가 없는 기록을 건너뛸 수 있어 합성 클릭 뒤 목록 복귀에 사용하지 않는다.
- 탐색은 문서 ID/URL 또는 loading/complete 이벤트로 실제 전환을 관찰한다. API 승인 직후 이전 complete 상태만으로 성공하지 않는다. 30초 내 전환을 관찰하지 못하면 실행 여부가 명확한 timeout 또는 EXECUTION_UNKNOWN을 반환하며 자동 재실행하지 않는다. back/forward는 Navigation API currentEntry.key도 비교해 URL이 같은 SPA 기록 이동을 식별한다. dispatch 뒤 1.5초 동안 기록 항목·탐색 시작·탭 loading·URL·문서 변화가 모두 없으면 ELEMENT_NOT_INTERACTABLE(executed:false)로 반환한다. 탐색이 시작된 경우에는 기존 30초 완료 대기를 유지한다.
- snapshot은 읽은 frame document ID와 반환 시점의 live 문서를 비교한다. top 문서 읽기 실패나 문서/URL 변경은 총 3번까지 읽기만 반복한다. 3번 모두 실패하면 safe FRAME_UNAVAILABLE이다. 부분 iframe 실패는 frameErrors로 유지한다. loading 중에도 읽을 수 있는 DOM은 loading:true와 함께 반환한다. 새 탭의 첫 문서가 아직 준비되지 않았으면 최대 2초 범위에서 읽기만 재시도하며, 전체 load 완료를 기다리지 않는다. 현재 URL이 HTTP(S)여도 pendingUrl이 있으면 이전 문서를 읽거나 ref를 게시하지 않으며, 제한시간 내 목적지가 commit되지 않으면 safe FRAME_UNAVAILABLE을 반환한다.
- refs는 실제 DOM 노드와 snapshot/frame/document/operation 경계에 묶인다. 노드가 연결돼 있어도 접근 가능한 이름·role·href·target·type·formaction이 바뀌면 STALE_ELEMENT다. pagehide에서 registry를 지워 BFCache 복원 후 옛 refs의 부활을 막는다. 값 입력 자체는 참조를 무효화하지 않는다. textarea의 live value와 달리 authored defaultValue 변경은 노드 재활용 신호로 유지한다.
- SPA 렌더 완료나 지연 목록 준비는 load와 다르다. `browser_wait(text=예상 목록 텍스트)` → `browser_snapshot` → 이름/href로 재선택한다. 이전 index로 자동 클릭하거나 STALE을 무시하지 않는다.
- `browser_tabs(action=close,operationId)`는 현재 operation의 **현재 선택된 탭**을 닫는다. 최초 attach 또는 기존 HTTP(S) 탭도 명시적으로 선택하면 대상이 된다. close에 임의 tabId를 지정하면 거부한다. 닫기 전 현재 문서 snapshot을 요구하며 모든 접근 가능한 frame의 편집된 폼을 검사한다. 검사 불가 frame은 닫지 않는다.
- 닫기는 `chrome.tabs.remove`를 한 번 요청한다. 기존 탭과 빈 탭에서 이동한 탭도 닫을 수 있으며 Chrome의 beforeunload 경고는 유지한다. 경고 취소 시 API Promise가 미완료로 남을 수 있으므로 이를 기다리지 않는다. `tabs.onRemoved`만 성공 근거로 사용하며 3초 안에 확인되지 않으면 unsafe EXECUTION_UNKNOWN이다. 경고 창을 자동 승인하지 않는다.
- 현재 탭의 close/수동 닫기 이벤트는 해당 Chrome 소유 작업의 최근 명시 방문 순서로 살아 있는 대상을 복원한다. 방문하지 않은 백그라운드 탭이나 다른 브라우저의 탭은 고르지 않는다. 복귀 시 needsObservation을 설정하고 새 snapshot 전에는 쓰기·닫기를 거부한다. target epoch를 비교하므로 팝업 전의 늦은 snapshot 응답이 이 제한을 해제하지 못한다. 대상이 없으면 기존 operationId로 new 또는 명시 switch를 할 수 있다. switch는 기존과 같이 작업 대상 전환이며 브라우저의 전경 활성화 기능과 다르다.
- close는 mutation dedupe를 적용한다. 동일 requestId 재전송은 저장된 결과를 돌려주고 실제 닫기를 반복하지 않는다. 취소/연결 단절 후 불명확한 결과는 탭 목록과 페이지 상태부터 확인한다.

한계: 임의 사이트의 JS closure만 바뀌고 DOM의 의미 정보가 같은 경우를 완전히 검출할 수 없다. 폼 검사는 일반 input/textarea/select 및 open Shadow DOM, editable 영역을 대상으로 하며 저장 완료를 판정하지 않는다. 사이트 자체 JS 상태, 닫힌 Shadow DOM/canvas 편집기, 브라우저가 경고를 제공하지 않는 비표준 편집 데이터의 저장 여부는 보장하지 않는다. beforeunload 창을 취소하거나 닫힘을 확인하지 못하면 탭을 보존하고 사용자 판단을 요구한다.


독립 검토 보완: top document가 열거되지 않으면 history 이동은 dispatch 전에 거부하며 새 문서로 fallback하지 않는다. 닫기 사전 검사 후 frame/document 집합을 다시 확인하여 교체·추가·제거된 iframe이 있으면 닫지 않는다. 첫 사전 검사 뒤 모든 frame의 폼을 병렬로 한 번 재검사하고 문서 집합도 재확인한다. 앞서 검사한 frame이 뒤 frame의 검사 중 편집되면 닫기를 보내지 않는다. 재검사는 한 번으로 제한하며 dirty/검사 불가/문서 변경은 안전하게 중단한다. 여러 frame의 검사는 원자적 트랜잭션이 아니므로 각 frame의 최종 응답 이후에 발생한 편집까지 저장 여부를 보장하지 않는다. 포인터 이벤트 처리 중 href/DOM identity가 바뀌면 실제 click 직전에 다시 검사하여 STALE_ELEMENT로 중단한다.


## 새 탭 시작·즐겨찾기 읽기 후속 계약

`browser_tabs new`는 operationId를 생략하면 선택된 Chrome에 새 작업을 예약한 뒤 탭을 생성한다. 기존 operationId가 있으면 그 작업에 추가하며 페이지 snapshot은 요구하지 않는다. URL 생략은 about:blank, 선택 windowId는 new/list에 사용한다. 예약은 drop/실패/취소 시 해당 ID만 해제하며 다른 활성 작업이 있으면 생성 전에 BROWSER_BUSY다. 늦은 새 작업 응답 취소도 기존 attach와 같은 연결별 정리 경로를 사용한다.

제한 페이지 attach는 메타데이터 대상 선정만 허용한다. attachable=false는 DOM 접근 불가 의미로 유지하고 snapshot/read는 계속 UNSUPPORTED_PAGE다. 명시적 HTTP(S) goto만 DOM snapshot 없이 허용한다. `browser_click newTab=true`는 ref의 일반 HTTP(S) anchor href를 읽어 새 탭을 생성하고 기존 작업에 채택한다. source click handler는 실행하지 않는다. JavaScript 버튼·download 링크는 거부한다.

`browser_bookmarks`는 operationId 없이 선택된 연결 Chrome에서 list/search를 수행하는 읽기 도구다. 별도 변경/권한 요청 도구는 없다. 선택 bookmarks 권한이 없거나 읽기 중 철회되면 FORBIDDEN_METHOD다. 폴더 탐색은 list+folderId, 검색은 search+query, 페이지는 offset/limit를 사용한다. 결과·권한·제약은 [지원표](./browser-capabilities.md)에 명시한다.

명시적 `browser_click(newTab:true)`은 Chrome이 탭 ID를 반환하면 즉시 openedTabs로 등록한다. 아직 URL이 비어 있거나 about:blank이면 검증된 HTTP(S) pendingUrl을 함께 전달하며, Bridge는 그 목적지와 원본 tab/frame을 확인해 operation에 편입한다. 후속 snapshot/wait로 문서 준비를 확인한다.


## 요청 ID와 기존 탭 선택 (v0.1.9)

패널 요청의 requestId는 메시지 전송 전에 생성되어 OpenCode system 문맥에 전달된다. 첫 attach/new는 그 ID로 예약을 확인하며 탭마다 새 ID를 만들지 않는다. 동일 요청에 활성 operation이 있으면 중복 bootstrap은 BROWSER_BUSY와 기존 operationId를 반환한다. 이후 도구는 operationId로 계속한다. 누락·불일치 ID를 임의 보정하거나 다른 요청의 예약을 가져오지 않는다.

switch는 operation 소유 Chrome 연결에 정확한 tabId를 조회한 뒤 HTTP(S) 대상임을 확인하고 방문 목록에 추가한다. 같은 작업이 이미 생성·채택한 준비 중 빈 탭은 재선택할 수 있다. 외부 빈 탭이나 Chrome 내부 페이지를 일반 쓰기 대상으로 편입하지 않는다. switch는 DOM 관찰을 대신하지 않으며 요소 참조는 대상 문서·operation·snapshot 경계를 그대로 유지한다.

## 결과에 붙는 스냅샷·탭 목록과 출력 예산 (2026-10-15)

- **ref 형식:** `s<36진 snapshotId>f<frameId>e<index>`, frameRef는 `s<36진>f<frameId>`다. snapshotId는 2026-01-01 이후 0.1초 단위로 단조 증가한다. 이전 10진 ref는 바인딩이 없으므로 STALE_ELEMENT로 거부된다.
- **결과에 붙는 스냅샷(`data.snapshot`):** 다음 경우 Bridge가 같은 operation으로 `browser.snapshot`(`maxChars:1500`, `settleMs:6000`, `maxElements:40`)을 추가로 실행해 결과에 붙인다. 요소가 더 있으면 `elementsNextOffset`으로 이어 읽는다. 실패하면 `data.snapshotError{code,message}`가 붙는다.
  - `browser_click`이 성공하고 `verified.urlChanged`·`verified.domChanged` 중 하나가 true이거나 작업 탭이 새 탭으로 옮겨 갔을 때
  - `browser_press`·`browser_navigate` 성공, `browser_tabs` attach·switch 성공, URL을 준 new 성공
  - 미실행(`executed:"no"`)인 쓰기 도구의 `STALE_ELEMENT` 실패. 복귀한 탭의 관찰 요구(needsObservation)도 이 스냅샷으로 해소된다.
  - fill·select·scroll과 변화 없는 click에는 붙이지 않는다. 직전 ref가 그대로 유효하다.
- **`settleMs`(내부 매개변수):** 확장은 snapshot 전에 탭이 `status:'complete'`이고 `pendingUrl`이 없을 때까지 최대 6초 기다린다. 링크 클릭 결과가 이전 문서가 아니라 도착한 문서를 읽게 한다. 도구 스키마에는 노출하지 않는다.
- **열린 탭 목록(`data.openTabs`):** attach·new 성공 시 작업 탭 창의 탭, switch가 TAB_NOT_FOUND·UNSUPPORTED_PAGE로 실패하면 모든 창의 탭을 최대 20개(`tabId, active, attachable, title≤60자, url≤100자`) 붙인다.
- **이동:** goto·back·forward·reload는 snapshot 없이 실행한다. 복귀 탭의 needsObservation 제한은 Bridge가 계속 적용한다.
- **이동을 일으킨 클릭:** click·press의 content 응답이 끊긴 뒤 1초 안에 그 frame의 문서가 바뀌었거나 탭에 pendingUrl이 있으면 `{executed:true, verified:{navigated:true, urlChanged:true}}`로 보고한다. 문서가 그대로면 기존처럼 unsafe EXECUTION_UNKNOWN이다.
- **생성 직후 취소:** attach·standalone new가 operation을 만든 뒤 결과의 후속 읽기 중 취소되면 Bridge가 그 operation을 CANCELLED로 정리하고 확장에 browser.cancel을 보낸다.
- **스냅샷 검색(`query`, 80자 이하):** 대소문자·공백 차이를 무시하고, 그 말이 들어간 본문 줄(긴 줄은 일치 위치를 중심으로 300자)과 요소만 돌려준다. 요소는 이름·값·href 또는 같은 행(`tr`·`li`·`[role=row]`·`[role=listitem]`·`article`, 없으면 부모. 페이지 전체는 행으로 보지 않음)의 글자가 일치하면 고른다. 비밀번호 칸의 값은 검색 대상이 아니다. 각 frame에 정규화한 `query`를 되돌려 주고, 일치가 없으면 `limits`에 `query-no-match`가 붙는다. 커서(`offset`/`elementOffset`/`frameOffset`)는 걸러낸 결과 안에서 움직이며, ref는 일반 snapshot과 같이 바인딩된다.
- **늦은 스크립트 이동:** click 결과가 `urlChanged:false, domChanged:false`이거나 press 결과가 폼 제출(`submitted:true`)이면 background가 탭의 `pendingUrl`·URL 변화를 최대 1초 지켜본다. 바뀌면 `verified`에 `urlChanged:true, navigated:true, lateNavigation:true`를 넣고, 위 규칙대로 도착 페이지 스냅샷이 붙는다.
- **잠시 넘겨받기:** Extension RPC `operation.pause {operationId, clientId}`/`operation.resume {operationId, clientId}`는 작업을 실행 중인 브라우저만 쓸 수 있다. 상태의 `operation.paused`가 바뀌어 `status.changed`로 알린다. 멈춘 동안 페이지 도구와 `browser_tabs` new·switch·close는 재개까지 최대 45초 기다린다. 시간이 넘으면 `BROWSER_BUSY`(retry safe, `details.handoff:true`)다. release와 중단은 기다리지 않는다. 재개하면 사용자가 페이지를 바꿨을 수 있으므로 첫 쓰기 전에 새 스냅샷을 요구한다(`STALE_ELEMENT`).
- **출력 예산(UTF-8 바이트):** content frame당 24,000B, background snapshot frame 묶음 28,000B, extract 28,000B, MCP 최종 텍스트 40,000B. OpenCode는 한 줄 도구 결과가 한도(관찰상 약 50KB)를 넘으면 통째로 파일로 돌리므로, 최종 텍스트가 40,000B를 넘으면 먼저 `data.snapshot`만 빼고 `snapshotError.tooLarge`를 붙인다. 그래도 넘으면 읽기는 `ok:false`·`details.tooLarge`로 더 작은 `maxChars`를 안내하고, 실행된 동작은 `ok`·`executed`를 유지한 채 "반복하지 말고 다시 읽으라"는 `data.note`로 바꾼다.
- **스냅샷 요소:** `role:"clickable"`은 의미 있는 태그·역할 없이 포인터 커서만 있는 최외곽 영역이다. `state`에는 expanded/collapsed/selected/pressed/mixed/current/required/readonly/invalid/focused가 들어간다. ARIA checkbox·switch는 `checked`, 범위 위젯은 `value`다. 같은 role·name이 여러 개면 같은 이름의 다른 요소를 포함하지 않는 가장 큰 조상의 텍스트를 `context`(≤80자)로 붙인다. 이름은 자식 `img alt`·SVG `title`·자식 `aria-label`도 쓴다. DOM 기반이며 Accessibility Tree와 같지 않다.
- **끝난 requestId:** 진행 중인 패널 요청이 없는데 requestId를 주면 "이미 끝난 요청"이라는 OPERATION_INVALID다(대기 안내가 아니다).
