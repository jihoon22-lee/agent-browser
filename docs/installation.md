# 설치·업데이트·패키징

Windows 기존 설정 파일은 해시 검사부터 교체까지 쓰기·이름 변경을 막는 핸들로 보호한다. 검증한 원본을 같은 폴더의 `.agent-browser-recovery-<id>` 이름으로 옮긴 뒤 새 파일을 덮어쓰기 없이 게시한다. 이 사이 경로가 잠깐 비어 있을 수 있다. 다른 프로그램이 파일을 만들면 그 파일을 보존하고 중단한다. 프로세스가 이 구간에서 중단되면 원본 recovery 파일과 설치 transaction 백업을 확인한다. 정상 완료 시 recovery 파일은 정리된다. WSL 파일은 해당 Linux 파일시스템의 해시 검사·rename 경로를 사용하며 Windows 핸들 잠금 보장의 대상이 아니다.

사용자 설치 절차는 배포에 포함되는 [README-install.md](../README-install.md)를 따른다. 설치 기본값은 현재 사용자 `%LOCALAPPDATA%\AgentBrowser`, 확장 고정 경로는 그 아래 `extension`이다.

## 설치 파일과 소유권

- `app/<version>-<exe sha256 앞 12자>/browser-bridge.exe`: 업데이트 시 실행 중인 이전 exe를 덮어쓰지 않는다. 기존 관리 OpenCode의 MCP 경로를 유지하도록 이전 버전도 소유 파일로 남긴다.
- `data/config.json`, `data/runtime.json`: 페어링과 실행 프로필. 기본 제거에서는 보존한다.
- `.agent-browser-install.json`: 설치 ID, 소유 파일 해시, Startup 및 선택적 MCP 등록 정보. 다른 위치의 설치에 재사용하지 않는다.
- `data/.installer-bridge-process.json`: 직접 시작한 Bridge의 PID, 실행 경로, 생성 시각, 포트. 종료 직전 다시 검증한다.
- `data/runtime/`: 프로필 작업 잠금과 WSL 관리 프로세스 소유권 표식. `runtime.json`의 PID·생성 시각·실행 경로 등과 함께 종료·재사용을 검증한다.
- `data/logs/serve.log`: 상주 Bridge 진단 로그. 사용자 데이터 디렉터리는 ACL 상속을 끊고 현재 사용자·SYSTEM·Administrators 접근으로 제한한다.
- `examples/mcp-windows.json`: 설치된 실제 실행 경로로 만든 MCP 조각. WSL을 명시하면 `mcp-wsl.json`도 생성한다.

기본 설치는 OpenCode 전역 설정을 수정하지 않는다. `-OpenCodeConfig`로 지정한 JSON/JSONC 파일만 `mcp.browser`를 병합한다. 주석과 다른 설정을 원문 그대로 유지하고, 수정 전 전체 원본을 같은 디렉터리에 백업한다. 기존 browser 항목이나 사용자가 수정한 소유 항목은 거부한다. 제거도 소유 항목만 지우며 백업은 남긴다.

설치 루트와 파일 경로의 reparse point 및 경로 이탈을 거부한다. 중간 실패 시 제품 파일·Startup·MCP 변경을 rollback하고, 중지했던 소유 Bridge를 복구한다. 제거에서는 관리 OpenCode 프로세스의 소유권을 Bridge CLI로 검증해 종료하고, 외부 서버는 건드리지 않는다. 일부 종료 또는 이후 파일 작업이 실패하면 제거를 중단하고 실제 종료한 프로필만 다시 시작한다. GUI 업데이트에서 실행 파일 경로나 포트가 바뀌면 관리 OpenCode의 유휴 상태를 확인한 뒤 중지하고, 파일 적용 후 새 MCP 경로로 다시 시작한다. 시작 옵션을 끄면 다음 명시적 시작까지 중지 상태로 둔다. busy/retry·상태 확인 실패는 변경 전에 거부한다. 외부 서버는 유지한다. 호환 PowerShell 업데이트는 관리 서버를 유지하므로 새 MCP 경로가 필요하면 Options에서 서버 중지 후 다시 시작한다. rollback 실패 시 경고를 보고하고 transaction 백업을 남기며 임의로 다른 프로세스를 종료하지 않는다. 설치 폴더에 사용자가 추가한 파일은 삭제하지 않는다.

## 실행 환경과 진단

Options에서 기존 Windows OpenCode의 절대 실행 경로와 작업 디렉터리, 또는 WSL 배포판·Linux 절대 경로를 저장한다. Windows `.cmd` 런처도 지원한다. 외부 서버 주소는 path가 없는 origin으로 지정하고, 원격 서버에는 HTTPS를 사용한다. 관리 서버에는 프로세스별 인증과 브라우저 MCP overlay를 제공하며, 외부 서버는 기존 인증·MCP 등록을 사용한다.

패널에서 프로필을 선택하면 Bridge가 서버를 시작하거나 검증된 기존 서버를 재사용한다. 표시된 CLI 연결 명령은 동일한 서버에 attach하며 비밀번호를 명령 문자열에 넣지 않는다. 관리 프로필 수정 전에는 Options에서 해당 런타임을 중지한다. 사용 중인 OpenCode를 강제로 재설치하거나 다른 버전으로 전환하지 않는다.

`doctor --json`과 Options 진단은 서버를 새로 시작하거나 모델 추론을 수행하지 않는다. 실행 파일·v1 API·MCP·모델 메타데이터 결과를 구분하며, 실제 추론 성공 여부는 배포 후 사용자 확인 대상으로 남긴다. CLI에서 설치 데이터를 명시할 때에는 `browser-bridge.exe --home <설치 경로>\data doctor --json`을 사용한다. 설치 경로에 공백이 있으면 인수를 따옴표로 감싼다.

## 패키지 생성

런타임에는 개발 도구가 필요하지 않다. 패키지를 만드는 개발 환경에는 저장소에 고정한 Rust·pnpm 9·Node가 필요하다.

```bash
# WSL 개발 환경: Windows x64 크로스 빌드, 확장 빌드, 고지 생성, Windows zip 생성
bash scripts/build-release-wsl.sh
```

Windows 개발 환경에서는 다음을 실행할 수 있다.

```powershell
.\scripts\build-release.ps1
# 이미 빌드와 제3자 고지를 생성한 경우
.\scripts\build-release.ps1 -SkipBuild
```

GitHub Actions 없이 실행 가능하다. `release/agent-browser-<version>-windows-x64.zip`, `release/SHA256SUMS`를 생성하며 publish는 하지 않는다. 0.1.1부터 zip에는 Windows exe, 확장 빌드, 설치·제거·시작 스크립트, 설치 안내·사용법·문제 해결·CHANGELOG·LICENSE·보안 안내, 공개 예제, 제3자 고지와 해시 manifest를 포함한다. 모델 테스트 결과·실제 대화·로그·전역 설정·환경변수·node_modules는 포함하지 않는다.

패키징은 exe의 버전, lockfile과 제3자 inventory의 해시, 확장 산출물 경로를 확인한다. manifest에는 포함 파일별 SHA-256을 기록하고, zip 엔트리 순서와 시각을 고정해 같은 입력에서 동일한 zip을 만든다. 설치도 manifest 해시를 검증한 뒤 파일을 변경한다.

`generate-third-party-notices.mjs`는 잠긴 Cargo 메타데이터에서 Windows normal/build 의존성과 실제 설치된 Extension production 의존성을 수집한다. 각 패키지의 라이선스 파일을 읽어 `THIRD_PARTY_NOTICES`와 inventory를 만들고, 필요한 라이선스가 없으면 생성을 중단한다. 패키징은 source tree 전체를 복사하지 않는다.

## 검증 명령

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\install\jsonc.tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\install\install.tests.ps1 -BridgeExe <Windows x64 exe> -WslDistribution Ubuntu
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\install\runtime-cleanup.tests.ps1 -BridgeExe <Windows x64 exe>
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\install\package.tests.ps1 -BridgeExe <Windows x64 exe>
```

테스트는 고유한 임시 설치 위치·임시 Startup 디렉터리·합성 OpenCode 설정을 사용한다. 실제 사용자 Startup 및 전역 OpenCode 설정은 테스트 대상이 아니다. 설치·중복 실행·업데이트·제거·주석과 Unicode 경로·충돌·누락 파일·실패 rollback을 검증한다. 실행 결과는 상태 문서에서 별도로 기록한다.

Bridge 포트를 변경했거나 관리 서버가 사용하던 Bridge exe를 별도로 삭제한 경우,
기존 OpenCode의 MCP 설정과 현재 Bridge가 맞지 않을 수 있습니다. 이때 준비 완료로 표시하지 않고
오류를 표시합니다. Options에서 해당 프로필의 **서버 중지** 후 다시 시작하면 새 MCP 설정이 적용됩니다.
GUI 업데이트로 Bridge 실행 경로나 포트가 바뀌면 유휴 상태의 관리 서버를 중지하고 새 MCP 경로로 다시 시작합니다. 실행 중인 작업이 있거나 상태를 확인하지 못하면 파일을 바꾸기 전에 업데이트를 보류합니다. **설치 후 시작**을 끄면 관리 서버도 중지된 상태로 남으며 다음 명시적 시작에서 새 MCP를 사용합니다. 외부 서버와 경로·포트가 같은 재적용은 유지합니다.


## PR·CI·Release 순서

1. 기능 브랜치에서 요구사항과 테스트를 마무리하고 PR을 생성한다. 실제 동작을 바꾼 경우 관련 테스트부터 실행한다.
2. 버전을 `Cargo.toml` workspace, `Cargo.lock`의 `agent-browser-bridge`, `extension/public/manifest.json`에 동일하게 반영한다.
   제품 라이선스는 루트 `LICENSE`와 Cargo package의 workspace 상속을 유지한다.
3. `CHANGELOG.md`에 사용자 변경·호환성을 적고 설치·사용·문제 해결 문서를 실제 UI와 대조한다.
4. PR의 `Linux checks`와 `Windows checks` 결과를 확인한다. 실패를 숨기거나 실행하지 않은 검사를 통과로 표시하지 않는다.
   CI가 만든 Windows zip은 검토용 artifact이며 자동으로 GitHub Release를 게시하지 않는다.
5. 독립 검토의 중요한 결함을 수정하고 최종 PR 커밋의 CI가 성공한 뒤 main에 머지한다.
6. main의 정확한 커밋을 체크아웃한 상태에서 패키징하고, 그 커밋에 `v<version>` 태그를 만든다.
   CI의 main 실행도 확인한다. 이미 게시한 태그/동일 이름 zip을 강제로 바꾸지 않는다.
7. `package.tests.ps1`로 필수 문서·zip 내부 링크·allowlist·manifest·체크섬·재현성을 검사한다.
   `SHA256SUMS`와 zip을 같은 Release에 게시하고 GitHub asset digest와 로컬 해시가 같은지 확인한다.
8. Release 안내에는 설치 시작점, CHANGELOG, 검증 환경을 적는다.
   `docs/status.md`에 실제 명령·결과·태그/PR/CI 링크를 기록한다. 실행 로그나 사용자 데이터는 게시하지 않는다.

`README-install.md`, `CHANGELOG.md`, `LICENSE`, `SECURITY.md`, `docs/user-guide.md`,
`docs/troubleshooting.md`는 배포 필수 문서다. zip 안의 상대 링크는 함께 포함된 파일만 가리킨다.
`README.md`, `CONTRIBUTING.md`, 개발 계획·상태·테스트 문서는 저장소에서 제공한다.

Windows 사용자에게 업데이트 설치를 실행하면 사용 중인 Bridge가 교체될 수 있다.
배포 문서를 보완했다는 이유만으로 사용자 설치를 자동으로 재시작하지 않는다. 사용자는 작업을 마친 뒤 업데이트하며,
최초 Chrome 로드·페어링 절차는 [사용 안내](user-guide.md)에 있다.
