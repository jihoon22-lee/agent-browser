# 브라우저 작업 지원 범위와 권한

## 이번 후속 보완의 원인

이전 new 도구는 operationId와 일반 웹페이지의 snapshot을 모두 요구하고 HTTP(S) URL만 받았다. Chrome 새 탭 화면에서는 attach도 거부되어 시작 경로가 막혔다. 실제 MCP→Windows Bridge→확장→Chrome에서 작업 없는 new는 OPERATION_REQUIRED, attach 직후 new는 STALE_ELEMENT로 실패함을 확인했다.

이제 `browser_tabs {action:"new",url:"https://…"}`로 기존 페이지를 읽지 않고 작업을 시작할 수 있다. operationId를 주면 해당 작업에 추가하며, URL을 생략하면 about:blank다. 빈 탭에서는 `browser_navigate {operationId,url:"https://…"}`로 이동한 다음 snapshot한다. 동시 standalone new는 BROWSER_BUSY로 차단한다. 새 작업 예약은 실패/취소 시 해제하고, 응답을 잃은 생성은 자동 재실행하지 않는다.

## 기능별 점검

| 표준 작업 | 현재 지원과 사용법 | 남은 제약/권한 |
|---|---|---|
| 새 탭 생성 | new 단독으로 작업 시작, 또는 operationId로 추가. snapshot 불필요. URL 생략은 빈 탭 | HTTP(S)/about:blank만 허용. 자동 재시도 없음 |
| 탭 목록 | list, windowId 필터. tabId/windowId/index/openerTabId/status/pinned/active 메타데이터 | 선택된 연결 Chrome 프로필 범위 |
| 창별 대상 선택 | windows로 일반 창 ID·focused·state 확인, list/new에 windowId 지정 | 창 생성·닫기·크기 변경 도구는 이번 범위 밖. 새 권한 없음 |
| 기존 탭 연결 | attach에 tabId 지정. 제한 페이지도 메타데이터 연결 후 일반 URL로 이동 가능 | chrome:// 등의 DOM/스크린샷 접근은 허용하지 않음 |
| 작업 탭 전환 | 같은 Chrome에서 조회·검증한 HTTP(S) tabId로 명시 switch | 기존 탭과 새 탭을 오가며 사용자 전경 포커스는 바꾸지 않음 |
| 탭 닫기 | close로 현재 명시 선택한 웹 탭. 기존 탭도 선택 후 닫기 가능 | snapshot·폼 확인, beforeunload 유지. about:blank는 Chrome의 DOM 접근 거부로 검사할 수 없어 안전한 close 대상에서 제외한다. 전용 오류가 웹 페이지로 이동 후 검사하거나 그대로 열어 두도록 안내. 강제 닫기 없음 |
| 링크를 새 탭으로 | browser_click의 newTab=true + 최신 ref. 출발 페이지의 click handler를 실행하지 않고 href를 새 탭으로 엶 | 일반 HTTP(S) anchor만. download 속성, JavaScript 버튼·링크를 추측하지 않음 |
| back/forward/reload/goto | browser_navigate. history는 정확히 한 항목 이동, 완료 관찰. 결과에 도착 페이지 snapshot 포함 | 이동 전 snapshot 불필요. 링크 클릭으로 인한 이동은 navigated:true로 성공 보고 |
| snapshot/read/extract | DOM 텍스트·요소·표, 문자/요소/frame cursor. iframe과 open Shadow DOM. 포인터 커서 영역(clickable), 상태(state), 반복 버튼의 행 맥락(context), 아이콘 이름. 페이지를 바꾼 동작의 결과에 자동 포함 | UTF-8 바이트 예산 안에서 잘리며 cursor로 이어 읽음. 접근 불가 frame은 부분 오류. closed Shadow DOM/canvas/브라우저 내부 UI 불가 |
| scroll | 문서 또는 ref 컨테이너의 up/down/top/bottom | 수직 기준. 좌표·수평·드래그는 미지원 |
| wait | 텍스트 나타남/사라짐, refGone, URL 부분문자열과 timeout | 범용 network-idle/사이트 readiness 판정 없음. 조건을 단계별로 확인 |
| input | text 계열 input/textarea 값 교체, contenteditable은 insertText(실패 시 내용 교체)와 input/change 이벤트 | 버튼·체크박스 등 텍스트가 아닌 input과 파일 입력은 거부. 모든 프레임워크/IME를 보장하지 않음 |
| select | option value/label, checkbox/radio 원하는 상태 | 다중 선택 배열 API는 없음. disabled option과 불가능한 radio 해제는 거부 |
| keyboard | Enter/Tab/Escape/Space/Backspace/ArrowUp/ArrowDown의 DOM 이벤트 및 구현된 기본 동작 | trusted OS 입력·Ctrl/L·브라우저 단축키·키 조합·IME 미지원 |
| screenshot | 작업 탭이 활성일 때 visible PNG | 필요하면 사용자가 작업 탭을 활성화. 전체 페이지/백그라운드 캡처와 OS UI 미지원 |
| 즐겨찾기 | browser_bookmarks list, folderId로 폴더 진입, search query, offset/limit | 아래 선택 bookmarks 권한. 읽기만 제공. URL은 조회만 하고 방문하지 않음 |
| 다운로드 | 일반 링크 클릭으로 Chrome 자체 다운로드가 발생할 수 있음 | 시작/목록/진행/완료/경로/파일 읽기 도구 없음. downloads 권한 추가하지 않음 |
| 업로드 | 미지원임을 명시적으로 반환 | OS 파일 선택창·로컬 경로·파일 내용 읽기를 우회하지 않음. 별도 승인된 파일 선택 설계 필요 |

새 탭은 background 생성이 기본이며 작업의 currentTab이 새 탭으로 바뀐다. 사용자 전경 탭을 임의로 바꾸지 않는다. 패널 요청 중 단독 new는 현재 requestId를 요구한다. 안전한 기본 탭이 없어도 명시적인 새 탭 생성은 가능하고, 새 operation은 해당 요청에 속한다.

명시적 새 탭 열기는 생성 직후 작업에 포함한다. 페이지의 하위 리소스가 계속 로딩돼도 읽을 수 있는 DOM은 snapshot으로 반환하지만, 새 문서로 이동 중이면 이전 DOM을 반환하지 않는다. wait의 URL 조건은 최상위 탭 주소이며 요소 조건과 함께 지정하면 어느 하나가 충족될 때 끝난다. iframe 내부 주소를 최상위 탭 주소로 취급하지 않는다.

뒤로·앞으로 이동은 같은 URL의 방문 기록도 구분한다. 기록의 끝에서 이동이 관찰되지 않으면 약 1.5초 뒤 미실행 오류를 반환한다. 실제 이동이 시작됐지만 끝나지 않은 경우는 별도의 로딩 제한시간을 따른다. 문서 교체로 사전 확인이 실패하면 새 snapshot을 읽고 다시 판단한다.

## 즐겨찾기 선택 권한의 정확한 영향

기존 필수 permissions/host_permissions를 늘리지 않고 `optional_permissions:["bookmarks"]`만 추가했다. Chrome은 즐겨찾기에 읽기 전용 권한을 제공하지 않으므로 읽기에도 읽기·변경을 포함하는 bookmarks 권한이 필요하다. 실제 제품 MCP/API 구현은 getChildren/search만 사용하며 생성·수정·이동·삭제 도구는 없다.

기본 상태는 미허용이다. 사용자가 확장 설정의 **즐겨찾기 접근 허용**을 직접 누르면 같은 클릭 처리 안에서 Chrome permissions.request를 호출한다. Chrome 동의 창은 사용자에게 맡긴다. 에이전트 도구·페이지 content script·Bridge는 권한을 요청하거나 승인할 수 없다. 설정의 **접근 해제**로 선택 권한을 철회할 수 있다. 권한 거부/철회는 FORBIDDEN_METHOD와 permission=bookmarks 안내를 반환한다.

허용하면 연결된 Chrome 프로필의 즐겨찾기 제목/URL을 에이전트가 요청한 범위에서 읽을 수 있고, 반환 정보는 연결된 모델로 전달될 수 있다. 결과는 기본 25개/최대 50개 및 약 28,000자 레코드 예산으로 제한한다. 긴 URL은 일부를 실제 URL로 오인하지 않도록 생략하고 urlOmitted를 표시한다. bookmarklet 등의 URL은 데이터로만 반환하고 openable=false다. 검색/결과를 별도 로컬 캐시에 저장하지 않는다. 조회 사이 사용자 편집이 있으면 offset 페이지가 변할 수 있다.

시험은 생산 manifest의 기본 권한 거부를 실제 Chrome에서 별도로 확인한다. 허용 상태의 API 시험은 `AB_TEST_BOOKMARKS=1`일 때 하네스가 **자체 임시 디렉터리에 확장을 복사하고 시험 manifest에서만 bookmarks를 필수 권한으로 선언**하여 빈 임시 프로필에 로드한다. 자체 생성한 합성 즐겨찾기만 사용한다. 이는 사용자의 선택 권한 동의 UI 승인을 검증했다는 뜻이 아니다. 동의/거부/해제 UI 흐름은 mock API 단위 테스트로 검증하며 실제 사용자 프롬프트를 자동 승인하지 않는다.

공식 근거: [Chrome bookmarks API](https://developer.chrome.com/docs/extensions/reference/api/bookmarks), [optional permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions).

## 요청과 브라우저 선택

패널의 기존 페이지 작업은 요청 전송 시 캡처한 기본 탭을 사용하며, 명시한 탭이 우선한다. 독립 새 탭 생성은 해당 requestId로 새 operation을 시작한다. 실패·취소 시 새 operation 예약을 정리하며 이전 요청의 ID는 거부한다. 즐겨찾기와 창/탭 목록 조회는 operation 없이 선택된 연결 브라우저를 읽는다. 일반 웹페이지 클릭·입력에는 최신 snapshot 안전 장치를 유지한다.
