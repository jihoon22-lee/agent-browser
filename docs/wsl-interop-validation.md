# WSL interop 방어 구현과 검증 (2026-10-12)

작업 기준은 `v0.1.4` (`fb2bcdbb4672a09395c7d7cc2ee75e6796e897c1`), 브랜치는
`fix/wsl-interop-compat`이다. GUI 설치 작업과 분리한 worktree에서 구현했다.
운영 설치를 교체하거나 WSL을 재시작·다운그레이드하지 않았다.

## 변경

- WSL 프로필마다 자체 `wsl.exe` 세션의 keeper를 유지한다. keeper와 서버 각각의
  Windows PID·생성 시각·이미지, Linux PID·시작 tick·프로세스 그룹·boot ID·nonce를
  소유 기록으로 확인한다. 다른 터미널의 소켓이나 init의 `1_interop`/`2_interop`을 선택하지 않는다.
- keeper는 자기 조상 프로세스의 interop 소켓을 선택하고 실제 Windows Bridge의
  `--version`을 실행한 뒤 readiness를 게시한다. 소켓 파일 존재만으로 준비 완료로 보지 않는다.
  canary는 회당 5초, 강제 종료 유예 1초, 최대 2회이며 keeper 준비 대기는 20초다.
- keeper와 OpenCode 시작 허가는 소유 기록 저장 뒤에만 발행한다. Stop은 해당 인스턴스의
  허가 파일을 먼저 취소하고, 매번 새로 확인한 소유 프로세스 그룹만 종료한다.
  저장 실패·늦은 WSL 실행·Bridge 종료 후 재사용을 고려한다.
- OpenCode와 browser MCP는 canary가 검증한 동일 소켓을 사용한다. MCP 실행 직전에도
  keeper의 nonce·boot ID·PID·시작 tick·프로세스 그룹·소켓을 다시 확인한다.
- WSL 상태, 소유권, Linux 리스너 검사를 한 번의 제어 호출로 합쳤다. 정상 상태 조회는
  제어 호출 1회이며 시작 재검사는 직렬로 1.5초 간격을 둔다. Windows 리스너의 WSL 프로세스
  출처 확인도 유지한다. 프로필별 잠금은 중복 시작과 상태 검사 경합을 막는다.
- 관리 서버의 `ready`는 인증된 v1 HTTP 검사와 `/mcp?directory=…`의 browser 연결을
  모두 요구한다. HTTP 성공과 MCP 실패를 구분한다. 기존 WSL 기록에 keeper가 없으면
  서버를 그대로 보존하고 명시적인 Stop/재시작으로 구성을 갱신하도록 안내한다.
- keeper가 죽거나 소유권을 확인할 수 없으면 자동으로 다른 keeper나 서버를 만들지 않는다.
  소유 기록을 보존하며, 서버 종료를 확인한 다음 keeper를 정리한다.

## 실행한 검증

Windows `10.0.26200.9457`, WSL `2.7.12.0`, Ubuntu, OpenCode `1.18.29`에서 실행했다.
테스트마다 별도 HOME/XDG 경로와 포트를 사용했다. Rust 의존성은 `--locked --offline`,
Windows 빌드는 `cargo xwin`의 `x86_64-pc-windows-msvc` 대상으로 만들었다.

| 검사 | 결과 |
|---|---|
| 기존 구현에서 두 회귀 재현 | HTTP 정상/MCP 실패를 ready로 표시, 통합 검사 부재: 모두 실패 확인 후 수정 |
| Linux Bridge 전체 회귀 | 135개 통과. 후속 변경의 runtime 단위 25개 및 runtime management 10개도 통과 |
| 실제 Windows 합성 WSL 서버 | 시작, Bridge 재시작, 같은 서버 재사용, Stop/Delete 통과 |
| 실제 OpenCode 동시 ensure | 같은 runtime 재사용, HTTP와 MCP 연결 확인 |
| 같은 keeper 소켓의 Windows canary | 실제 Windows Bridge `--version` 성공 |
| native MCP 프로세스 | 동일 시험 실행 파일의 Windows resident Bridge와 MCP proxy 2개 확인 |
| MCP 프로토콜 | OpenCode에 등록한 실제 명령을 별도 stdio 클라이언트로 실행하여 `initialize` 응답 확인 |
| 첫 MCP 도구 | 같은 명령의 `browser_tabs` 요청에 합성 확장이 성공 응답. 실제 Chrome 페이지나 모델 호출 없음 |
| 소켓 고장 주입 | 없는 소켓은 native 실행 전 거부. 자체 AF_UNIX 소켓의 handshake 정지는 11.23초에 canary 실패 |
| keeper 종료 | 오류 상태, 소유 기록 유지, 자동 대체 없음, 이어서 서버·keeper 정리 통과 |
| Bridge 재시작 | 같은 keeper PID와 서버 재사용 통과 |
| 기존 keeper 없는 기록 | 기존 서버 보존, 구성 갱신 요구 통과 |
| 시작 오류·소유권 불명 | 잘못된 작업 디렉터리 정리, 없는 소유 마커의 기록 보존 통과 |
| 실제 Windows `.cmd` fixture | 정상 수명 주기, 3초 MCP 준비 지연 대기, HTTP 성공/MCP 실패의 시작 기한·정리 통과 |
| 실제 Windows 저장 실패 | keeper 초기 저장 실패, 기존 pending owner 저장 실패의 정리 통과 |
| Stop과 지연 실행 경합 | 수정 전 실패 재현. 시작 허가를 먼저 취소한 뒤에는 늦은 명령의 미실행과 그룹 종료 통과 |
| 실제 OpenCode CLI 경로 | CLI 시작 호출자 종료 후 재사용, doctor, attach, 자격정보 출력 제거, stop-all 통과 |

MCP 프로토콜/첫 도구 검사는 OpenCode의 설정된 명령을 직접 실행한 별도 MCP 클라이언트다.
OpenCode 자체의 MCP 연결 상태와 별도로 검증했으며, 모델을 거치는 에이전트 요청으로 표현하지 않는다.

## 제어 프로브 비교

동일한 Windows/WSL 합성 HTTP fixture에서 기준 버전과 수정 버전을 순서대로 실행했다.
기준 빌드에는 `v0.1.4` 소스에 제어 함수의 debug 로그 한 줄만 추가했다.
관측은 자체 Bridge 로그로 수행하여 관측용 `wsl.exe` 실행을 추가하지 않았다.

| 조건 | v0.1.4 기준 | 수정 버전 |
|---|---:|---:|
| 시작 중 WSL 제어 호출 (이번 실행) | 6 | 2 |
| 정상 status 5회 중 WSL 제어 호출 | 15 | 5 |
| status 5회 경과 시간 (참고, 단일 측정) | 2,452ms | 1,060ms |

위 수치는 **제어 프로브** 수다. 수정 버전은 별도의 장기 실행 keeper 세션 1개를 추가한다.
시작 호출 수와 시간은 환경에 따라 달라질 수 있다. 최초 계측에서 로그 환경 변수 이름이
잘못되어 0으로 기록된 실행은 비교에서 제외하고, 저장소의 `AGENT_BROWSER_LOG`로 다시 측정했다.

## WSL 결함 근거와 검증 한계

공식 [WSL 2.7.12 init.cpp](https://github.com/microsoft/WSL/blob/2.7.12/src/linux/init/init.cpp)의
`CreateProcessUtilityVm`은 `UtilAcceptVsock(ListenSocket, SocketAddress)`에 timeout을 넘기지 않는다.
[수정 #41252](https://github.com/microsoft/WSL/pull/41252)는 이 accept 대기에 timeout을 추가하며,
[2.9.8 사전 릴리스](https://github.com/microsoft/WSL/releases/tag/2.9.8)에 포함되어 있다.
따라서 현재 PC의 정상 시험 성공이 이 런타임 결함의 부재나 수정 포함을 의미하지 않는다.

[Issue #41242](https://github.com/microsoft/WSL/issues/41242)의 relay/accept 누적 문제와
[Issue #41283](https://github.com/microsoft/WSL/issues/41283)의 살아 있는 소켓 경로/죽은 init interop 문제는
관측과 원인이 같다고 단정하지 않았다. 자체 AF_UNIX handshake 정지는 응용 계층의 제한 시간과
오류 처리를 검증하는 fault injection이며, 커널의 원래 vsock accept 결함을 재현했다고 보고하지 않는다.

기존 격리 Windows VM은 접근 권한 범위에서 확인하지 못했다. 별도 구형 WSL 패키지의 시험은
실행하지 않았다. 같은 호스트의 두 번째 Ubuntu 배포판은 동일 WSL 런타임을 공유하므로 대체하지 못한다.
호스트 자원 고갈 스트레스, WSL shutdown/업데이트, 가상화·보안 설정 변경은 수행하지 않았다.
응용 수정은 소유 세션을 유지하고 호출을 줄여 실패를 제한하며, 이미 발생한 WSL 커널 자원 누수를
복구하거나 모든 런타임 결함을 제거하는 패치는 아니다.
