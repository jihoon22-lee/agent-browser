# AgentBrowser 설치와 첫 연결

Windows Chrome 안에서 기존 OpenCode v1으로 작업하는 도구입니다. Windows x64용이며 설치에 관리자 권한이나 Node.js·Rust·Python이 필요하지 않습니다. OpenCode는 별도로 설치되어 있어야 합니다. 기존 OpenCode를 다시 설치하거나 v2로 변경하지 않습니다.

이미 설치된 PC에서는 1절을 건너뛰고 2절부터 진행합니다. 연결 후 실제 작업은 [사용 안내](docs/user-guide.md), 오류는 [문제 해결](docs/troubleshooting.md), 버전 변경은 [CHANGELOG](CHANGELOG.md)를 확인하세요.

## 1. 설치와 로그인 자동 시작

배포 zip을 다운로드 폴더 등 임시 위치에 모두 압축 해제합니다. `SHA256SUMS`가 함께 제공되면 `Get-FileHash <zip 경로> -Algorithm SHA256`으로 확인합니다. 해당 폴더에서 Windows PowerShell을 열고 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

압축 해제 위치와 설치 위치는 다릅니다. 사용자가 설치 경로에 직접 압축을 풀 필요가 없습니다. 기본 설치 위치는 `%LOCALAPPDATA%\AgentBrowser`입니다. 현재 사용자 Startup 폴더에 시작 바로가기를 등록하고 Bridge를 즉시 시작합니다. 이 명령의 실행 정책만 지정하며 PC의 전역 실행 정책을 바꾸지 않습니다.

설치 위치를 바꾸려면 위 명령 뒤에 `-InstallDir "D:\Apps\AgentBrowser"`를 추가합니다. 이후 안내의 설치 경로도 그 위치로 바꿉니다.

로그인 자동 시작이 실패하면 설치 폴더의 `start-bridge.cmd`를 실행합니다. 설치·업데이트 전에 진행 중인 브라우저 작업을 중단합니다.

## 2. Chrome 확장 로드와 페어링

1. 사용할 Windows Chrome 프로필에서 `chrome://extensions`를 엽니다.
2. 개발자 모드를 켜고 **압축해제된 확장 프로그램 로드**를 선택합니다.
3. 폴더 선택 창에서 **Alt+D**를 누르고 `%LOCALAPPDATA%\AgentBrowser\extension`을 입력한 뒤 Enter → **폴더 선택**을 누릅니다. 설치 위치를 바꿨다면 그 폴더 아래 `extension`을 선택합니다. 다운로드한 임시 압축 해제 폴더가 아닙니다.
4. Windows 시작 메뉴에서 **PowerShell**을 열고 다음 명령으로 페어링 토큰을 표시합니다. 설치 위치를 바꿨다면 명령의 스크립트 경로도 바꿉니다.

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AgentBrowser\show-pairing.ps1"
   ```

5. `chrome://extensions`의 **AgentBrowser → 세부정보 → 확장 프로그램 옵션**을 엽니다. **Bridge 주소**에 `ws://127.0.0.1:4317/extension`, **페어링 토큰**에 출력된 64자리 토큰만 넣고 **저장 후 연결**을 누릅니다. 설치 시 포트를 바꿨다면 설치 결과에 나온 주소를 사용합니다. **Bridge에 연결되었습니다.**를 확인합니다. 토큰은 공유하지 않습니다.
6. Chrome 오른쪽 위 퍼즐 아이콘에서 **AgentBrowser**를 고정하고 아이콘을 눌러 사이드 패널을 엽니다. **대화 → 실행 설정**에서 실행 환경을 선택해 **OpenCode … 연결됨**을 확인합니다. 같은 화면에서 **모델·에이전트**를 고르고 **대화로 돌아가기 → 새 대화 시작** 후 메시지를 보냅니다. **세션 → 새 세션**으로도 대화를 만들 수 있습니다. 실행 환경이 없으면 아래 3절을 진행합니다.

페어링은 최초 1회 절차입니다. 정상 연결 후에는 서버를 매번 직접 실행하지 않습니다. 확장 경로나 Chrome 프로필을 바꿔 페어링이 필요해지면 같은 절차로 다시 연결합니다.

Chrome 조직 정책이 로컬 확장 설치를 막으면 이 설치 방식은 사용할 수 없습니다. 정책을 변경하거나 우회하지 않으며 담당 관리자에게 승인된 설치 방법을 확인해야 합니다.

## 3. 기존 OpenCode 연결

Options에서 실행 환경을 추가합니다.

- **Windows**: 기존 OpenCode 실행 파일과 Windows 작업 디렉터리를 지정합니다.
- **WSL**: 배포판 이름과 그 배포판 안의 OpenCode 실행 파일·작업 디렉터리를 지정합니다.
- **외부 서버**: 이미 실행 중인 OpenCode v1 서버의 주소와 필요한 인증정보를 지정합니다.

프로필을 저장하고 패널의 **대화 → 실행 설정**에서 선택합니다. Bridge가 관리하는 서버에는 브라우저 MCP 설정을 별도 overlay로 제공하며 기존 모델·provider·인증·다른 MCP 설정을 덮어쓰지 않습니다. 외부 서버는 해당 서버의 설정에서 브라우저 MCP를 별도로 등록해야 합니다. API 연결이 실패하면 Options의 진단 결과와 `%LOCALAPPDATA%\AgentBrowser\data\logs`를 확인합니다.

CLI에서도 브라우저 도구를 쓰려면 설치된 `examples\mcp-windows.json`의 실제 경로 설정을 사용합니다. 직접 병합하려면 파일을 먼저 백업합니다. 설치 스크립트가 지정한 파일의 `mcp.browser`만 병합하도록 할 수도 있습니다.

```powershell
.\setup.ps1 -OpenCodeConfig "$env:USERPROFILE\.config\opencode\opencode.jsonc"
```

WSL용 실제 경로 조각은 배포판을 명시하여 생성합니다. WSL 설정 파일도 명시했을 때에만 수정합니다.

```powershell
.\setup.ps1 -OpenCodeKind wsl -Distribution Ubuntu
# 필요할 때만 명시적으로 설정 파일까지 지정:
.\setup.ps1 -OpenCodeKind wsl -Distribution Ubuntu -OpenCodeConfig '\\wsl.localhost\Ubuntu\home\사용자\.config\opencode\opencode.jsonc'
```

이 명령들은 압축 해제한 배포 폴더에서 실행합니다. 이미 다른 프로그램이 `mcp.browser`를 사용하거나 해당 항목을 사용자가 수정했다면 덮어쓰지 않고 중단합니다. 원본 설정의 백업은 원본 파일 옆에 남깁니다. 사용자 전체 설정을 배포 파일이나 예제로 복사하지 않습니다.

## 4. 업데이트와 제거

새 zip을 별도 폴더에 압축 해제하고 새 `setup.ps1`을 실행합니다. 설치 경로를 변경했다면 이전과 같은 `-InstallDir`을 지정합니다. 페어링·프로필 데이터는 유지됩니다. 업데이트 후 `chrome://extensions`에서 AgentBrowser를 새로고침합니다.

제거 전에 패널에서 진행 중인 작업을 멈춥니다. 제거 스크립트는 소유권이 확인된 Bridge 관리 OpenCode 서버를 중지한 뒤 Bridge와 설치 파일을 제거합니다. 다른 프로그램이 시작한 외부 OpenCode 서버는 종료하지 않고 기존 세션 데이터도 유지합니다. 업데이트는 관리 OpenCode 서버를 유지하며 새 Bridge가 다시 연결합니다.

```powershell
# 설치 폴더에서 실행. 페어링·프로필 데이터는 기본 보존합니다.
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
# 페어링·프로필 데이터까지 지우려는 경우에만 사용합니다.
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveData
```

Chrome 확장은 `chrome://extensions`에서 별도로 제거합니다. 제거 스크립트는 이 설치가 소유한 관리 OpenCode 서버·Bridge 프로세스·바로가기·파일·MCP 항목만 대상으로 합니다. 다른 MCP·모델·인증·OpenCode 세션은 유지됩니다. 설치 파일이나 소유한 MCP 항목이 수정되었으면 충돌을 보고하고 원래 상태를 보존합니다. 수정한 파일을 별도로 보관한 후 충돌을 해소하고 다시 실행할 수 있습니다.

## 검증 범위

실제 모델의 작업 수행은 사용자가 배포 후 검증합니다. 무료 모델 목록과 실제 요청 허용 여부는 다를 수 있습니다. Zen의 `FreeTierError`·한도 오류가 나면 제한을 우회하거나 유료 모델로 자동 전환하지 않습니다. 사내 OpenCode 버전·브라우저 정책·사내 모델은 해당 환경에서 확인해야 합니다.

Bridge 포트를 변경했거나 관리 서버가 사용하던 Bridge exe를 별도로 삭제한 경우,
기존 OpenCode의 MCP 설정과 현재 Bridge가 맞지 않을 수 있습니다. 이때 준비 완료로 표시하지 않고
오류를 표시합니다. Options에서 해당 프로필의 **서버 중지** 후 다시 시작하면 새 MCP 설정이 적용됩니다.
일반 업데이트는 이전 exe 경로를 보존하므로 실행 중 관리 서버를 유지할 수 있습니다.

제품 라이선스는 [MIT](LICENSE)이며 제3자 고지는 같은 폴더의 `THIRD_PARTY_NOTICES`에 있습니다. 데이터 처리와 신고 범위는 [보안 안내](SECURITY.md)를 확인하세요.
