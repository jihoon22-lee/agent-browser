# M2–M4 실사용·배포 완료 계획

기준: docs/handoff.md §7, §12–19. 시작 커밋 6a9106d.
사용자 최신 지시: 실제 OpenCode 모델 테스트는 배포 후 사용자가 수행한다. 이 항목을 개발/배포 게이트에서 제외하고 나머지 구현·검증·사용 가능한 배포물까지 진행한다. 기존 403 결과를 성공으로 변경하지 않는다.

## 계약과 작업 분담

- Bridge 런타임 설정은 기존 페어링 config.json과 분리한 runtime.json에 저장한다. 모델/provider/인증 전역 OpenCode 설정을 수정하지 않는다.
- 인증된 Extension만 profile.list/profile.save/profile.delete, runtime.ensure/runtime.status/runtime.stop, doctor.run 관리 RPC를 호출할 수 있다. MCP에는 관리 API를 노출하지 않는다.
- Profile: {id,name,kind:"windows"|"wsl"|"external",executable?,distribution?,user?,directory,env?:Record<string,string>,port?:number,baseUrl?,username?,password?}. ID는 제한된 문자열. 목록에는 password 및 env 값 비공개, 설정 변경 시 생략된 기존 비밀값 유지.
- profile.list -> {profiles: ProfileSummary[], defaultProfileId?:string}; profile.save {profile,makeDefault?} -> {profile:ProfileSummary}; profile.delete {profileId} -> {deleted:true}.
- runtime.ensure/status {profileId} -> RuntimeInfo {profileId,state:"ready"|"stopped"|"error"|"starting",baseUrl?,directory,username?,password?,version?,owned,attachCommand?,error?}. 자격정보는 ensure의 인증된 Extension 응답에만 포함; status/doctor/log에는 제외.
- runtime.stop {profileId} -> {stopped:boolean}; 직접 시작한 프로세스만 대상으로 한다. 기존 서버를 종료하지 않는다. ensure 동시 요청은 중복 시작하지 않는다. 재시작 후 인증·버전·소유 상태를 재확인한다.
- 실행은 고정 실행 파일과 구조화된 인수, 필요한 경우 고정 wrapper 스크립트의 positional args. Windows/WSL 포트 충돌·인증·시작 타임아웃·한글 공백 경로를 다룬다. TLS 검증을 끄지 않는다.
- 제품 OpenCode serve에 browser MCP를 overlay로 등록하고 기존 모델/플러그인/provider 설정을 보존한다. WSL MCP는 Windows exe + Windows home/port 전달을 유지한다.
- Extension의 OpenCodeV1Client는 runtime.ensure의 접속정보로 HTTP/SSE를 직접 호출한다. content script는 API 자격정보를 받지 않는다. v1 명세만 사용하며 fetch SSE 재연결 시 상태를 다시 조회한다.
- 패널의 operation↔session 매핑은 실제 해당 세션 도구 결과의 operationId로만 한다. 중단은 Bridge gate를 먼저 닫고 알려진 세션만 abort한다. CLI 세션을 추정하지 않는다.

## 실행 과제

- [x] 1. M1 모델 검증의 사용자 이관과 새 완료 기준 문서화, runtime/API 인터페이스 고정.
- [x] 2. Bridge 프로필 저장·runtime.ensure/status/stop·Windows/WSL 실행 관리·doctor와 역할 제한. 실패 테스트 → 구현 → 대상 테스트 → 실제 Windows 검증.
- [x] 3. OpenCode v1 클라이언트·타입·SSE·사용량/중복 처리·실제 API 계약 검증. 모델 호출 없이 세션/모델/에이전트/명령/스킬/질문/권한/첨부 계약을 확인.
- [x] 4. 한국어 작업 UI: 세션/환경, 모델·에이전트·variant, 대화/도구/Markdown, 질문/권한, 사용량/컨텍스트, 파일·이미지 첨부, @ 및 /, 압축/revert/diff/내보내기. Options 프로필·진단·페어링. IME·이벤트 경합·재연결 회귀.
- [x] 5. 사용자 영역 설치·로그인 시작·업데이트·제거·MCP 조각/설정 안전 병합, 개발 툴 없는 zip·SHA256·제3자 고지·문서. 합성 사용자 설정으로 실제 PowerShell 검증.
- [x] 6. 전체 검증: Linux 계약/단위/E2E와 실제 Windows Chrome/자동 실행/네이티브·WSL OpenCode API/설치 업그레이드 제거. 실제 LLM은 호출하지 않는다.
- [x] 7. 독립 전체 검토와 중요 결함 수정, 재현 검증, 배포 산출물 생성·사용 위치/절차 확정. 사용자 실제 사용 가능한 설치 상태까지 준비.

## 검토 초점

프로필 비밀정보 노출, 임의 포트의 인증정보 수신, 재시작 후 외부 프로세스 오인 종료, WSL 고아 프로세스, 동시 ensure, MCP 관리 API 차단, 다른 세션 SSE 혼입, 질문/권한 중복 응답, 첨부의 실행 환경 독립성, 토큰 집계 중복/컨텍스트 혼동, Markdown 실행, 설치/업데이트/제거의 기존 설정 보존과 symlink/경로 경계, 배포물 비밀정보 제외.

실제 LLM 판단·사용자 기업 환경·기업 Chrome 정책은 사용자 검증으로 구분한다. 기능 누락을 이 문장으로 대체하지 않는다.


## 완료 기록

2026-10-11: 제품 구현, 독립 검토와 중요 결함 회귀, Rust107/Extension212/Node25,
Linux32/실제 Windows Chrome32, 실제 Windows/WSL API(LLM0), Windows 설치12/정리3/패키징2 통과.
Windows 핸들 상속·사용자 포트·다른 프로필 동시 시작·UI 비동기 환경 경합을 수정했다.
v0.1.0 zip/SHA256/제3자 고지를 생성하고 실제 Windows 사용자 영역에 설치했다.
사용자 Chrome의 수동 확장 로드/페어링과 실제 모델 사용은 사용자 절차로 남긴다.
최종 증거와 설치 위치는 docs/status.md를 따른다. 이 완료 계획을 다음 작업의 미완료 원장으로 쓰지 않는다.
