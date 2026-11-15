# 설치 관리자 0.4.3: 글자 가림, 표식 없는 Bridge 인수, 테스트 의존성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설치 마법사에서 입력란 왼쪽이 가려지는 문제와, 설치 관리자가 직접 시작하지 않은 Bridge 때문에 업데이트·제거·연결 설정이 막히는 문제를 고치고, 테스트 도구의 취약점 알림 10건을 해소해 0.4.3으로 낸다.

**Architecture:** 겹침은 "보이는 형제 컨트롤의 영역이 겹치지 않는다"는 기하 검사로 먼저 실패시키고 그 검사가 내놓는 전부를 고친다. Bridge 인수는 프로토콜을 건드리지 않고, C#이 `serve.pid`의 프로세스를 실행 파일·명령줄·포트·인증된 상태 조회로 확인해 자기 것으로 표식한다(PowerShell `Start-OwnedBridge`가 이미 쓰는 규칙과 같다). 의존성은 lockfile의 정확한 버전만 올린다.

**Tech Stack:** C# 5 / .NET Framework 4 WinForms(`csc` v4.0.30319), Windows PowerShell 5.1, pnpm 9, vitest.

**Spec:** 이 문서의 "근거" 절과 `docs/status.md`의 2026-11-15 두 절("v0.4.2 Windows preview", "Bridge 런타임 실제 Windows·WSL 실행과 관찰").

## Global Constraints

- C# 5 문법만 쓴다. `?.`, `$""`, `nameof`, `out var`, 식 본문 멤버는 컴파일되지 않는다.
- 설치 테스트는 실제 Windows에서 `AB_PACKAGE_ZIP=<zip> bash scripts/test-installer-windows.sh <클래스>`로 실행한다. Linux 결과를 Windows 검증으로 보고하지 않는다.
- 과제마다 실패하는 테스트를 먼저 쓰고 실패를 확인한 뒤 고친다. 커밋은 영어 Conventional Commits, 과제 단위.
- 페어링 인증, 소유 파일 해시 검증, 사용자 수정 파일 보존은 그대로 둔다. 소유자 SID·ACL 검사를 추가하지 않는다.
- 내부 RPC·MCP 도구 계약을 바꾸지 않는다(Bridge의 중지 요청 추가는 `docs/plans/bridge-runtime-lifecycle.md`의 결정 사항이다).
- 사용자에게 보이는 문구는 한국어, 다음 행동을 포함한다.
- 테스트는 `%LOCALAPPDATA%\AgentBrowser-dev` 아래 격리 폴더와 빈 포트만 쓴다. 사용 중인 실제 설치와 4317 포트의 Bridge를 건드리지 않는다.

## 근거

**글자 가림 (실제 v0.4.2 exe를 96 DPI 화면에서 창 캡처로 확인, 2026-11-15)**
- `수행할 작업`의 `설치`가 `치`로, `업데이트`가 `데이트`로 보인다. OpenCode 단계에서는 `Windows`가 `ndows`, `/home/jihoon/.opencode/bin/opencode`가 `ome/jihoon/…`, `/tmp/…`이 `mp/…`로 보인다.
- 원인: `LabelAt`의 기본 폭이 170인데(`installer/SetupForm.cs:54`) 같은 줄의 입력란이 x=154(시작 화면)와 x=150(OpenCode 단계)에서 시작한다. 라벨이 먼저 추가되어 z-order가 위라서 입력란의 왼쪽 16px·20px을 덮는다. 해당 쌍은 여섯 개다(시작 화면 2, OpenCode 단계 4). 고급 설정은 입력란이 x=180이라 겹치지 않는다.
- 2026-10-13(시작 화면), 2026-10-16(OpenCode 단계)부터 있었고 v0.2.2~v0.4.2에 모두 들어 있다.
- `SetupDisplayTests`의 `DrawToBitmap` PNG는 자식 컨트롤을 실제 z-order와 다르게 그려서 이 문제가 보이지 않는다. 0.4.2 기록의 "겹침 없음" 확인은 이 PNG에 근거한 것이라 틀렸다.

**표식 없는 Bridge (격리 설치에서 재현, 2026-11-15)**
- 설치(Start=true) → 표식 있는 serve 종료 → `browser-bridge.exe start --port P`(MCP 프록시가 Bridge를 다시 띄울 때와 같은 경로) 뒤의 결과:
  - `BridgeControl.Stop`은 false를 돌려주고 serve를 그대로 둔다(`installer/InstallerEngine.cs:446`).
  - `BridgeControl.Start`는 `Bridge PID does not belong to this startup.`으로 실패한다(`installer/NativeIO.cs:64`).
  - 같은 패키지 업데이트(Start=true)는 같은 오류로 실패한다.
  - 제거는 `액세스가 거부되었습니다`로 실패하고 설치 기록이 남는다.
- 마법사는 확장 추가 화면에서 `BridgeControl.Start`를 1.5초마다 다시 시도하고 예외를 버린다(`installer/SetupForm.cs:248`, `:254`). 다음 단계에서 위 영문 오류가 `Friendly` 변환 없이 나온다.
- PowerShell `Start-OwnedBridge`(`scripts/installer-common.ps1:564`)는 `start`의 출력(`running`·`port`·`home`·`pid`)과 `serve.pid`, 프로세스의 실행 파일·명령줄을 확인해 표식을 쓴다. 다만 실행 파일이 `CurrentExe`와 같을 때만이고, `Stop-OwnedBridge`는 표식만 본다(코드 추적, 미실행).

**취약점 알림 (GitHub Dependabot, 열린 것 10건)**
- 8건: `undici` 8.11.2 (`jsdom` 30.1.2의 의존성 `undici ^8.11.2`), 수정 버전 8.12.2.
- 2건: `@vitest/mocker` 4.1.11 (`vitest` 4.1.11), 수정 버전 4.1.12.
- 둘 다 `extension`의 devDependencies 경로이고 `extension/dist`에는 들어 있지 않다(2026-11-15 grep 확인).

**유지보수 exe 캐시**
- `%LOCALAPPDATA%\AgentBrowser-Setup\<해시>\AgentBrowser-Setup.exe`는 만들기만 하고(`installer/SetupForm.cs`의 `RelaunchInstalled`) 지우는 코드가 없다. 개발 PC에 9개가 남아 있다.

## Review Focus

- 글꼴 15pt·20pt에서 라벨 폭을 줄인 뒤 `찾은 OpenCode`·`OpenCode 설정 파일` 같은 긴 라벨이 잘리지 않아야 한다(Task 2의 기존 `Check`가 잡는다).
- `serve.pid`가 이 설치의 Bridge가 아닌 프로세스의 PID를 가리킬 때 그 프로세스를 인수하거나 종료하면 안 된다(Task 3 음성 테스트).
- 같은 실행 파일이지만 다른 데이터 폴더로 뜬 serve가 같은 포트를 잡고 있을 때 인수하면 안 된다(Task 3의 두 번째 음성 테스트).
- 업데이트 도중 이전 버전 프록시가 이전 버전 serve를 다시 띄운 경우에도 업데이트가 끝나야 한다(Task 3의 교차 버전 케이스).
- 0.4.2에서 0.4.3으로 올리는 실제 GUI 업데이트(Task 7). 0.4.2에서는 같은 버전 재적용만 실행했다.

---

### Task 1: 화면 증거를 실제 창 캡처로 교체

**Files:**
- Modify: `tests/install/SetupDisplayTests.cs`(PNG 저장부)
- Modify: `tests/install/GuiSmokeTests.cs`(`Screenshot`, 캡처 지점 추가)
- Modify: `docs/testing.md`(설치 화면 확인 문단)

**Interfaces:**
- Produces: 두 테스트 파일 각각의 `static void Capture(IntPtr window, int width, int height, string path)` — `user32!PrintWindow(hwnd, hdc, 2)`(`PW_RENDERFULLCONTENT`)로 그린 PNG를 저장한다. `PrintWindow`가 false를 돌려주면 `DrawToBitmap`(GuiSmoke는 `CopyFromScreen`)으로 저장하고 `WARN capture fallback: <path>`를 출력한다.

- [ ] **Step 1: `SetupDisplayTests`의 `form.DrawToBitmap`·`dialog.DrawToBitmap` 세 곳을 `Capture(form.Handle, form.Width, form.Height, path)`로 바꾼다.** 캡처 전에 `Application.DoEvents()`와 `form.Update()`를 호출한다.

- [ ] **Step 2: `GuiSmokeTests.Screenshot`을 `Capture(new IntPtr(window.Current.NativeWindowHandle), …)`로 바꾸고 캡처 지점 세 개를 추가한다.** 첫 `Launch` 직후 `p0-welcome.png`, 첫 `Click("Preview")` 직후 `p1-location.png`, `EnterDialog("AgentBrowser 고급 설정")` 직후 `advanced.png`.

- [ ] **Step 3: 실행하고 그림을 직접 본다**

Run: `AB_PACKAGE_ZIP=<개발 패키지 zip> bash scripts/test-installer-windows.sh SetupDisplayTests`, 이어서 `docs/testing.md`의 `GuiSmokeTests` 절차를 `--uia --profiles`로 실행.
Expected: 아직 고치기 전이므로 `font-10-page-0.png`의 `수행할 작업` 칸이 `치`로, `font-10-page-6.png`의 `실행 방식` 칸이 `ndows`로 보인다. 이 그림이 결함을 보여 줘야 새 캡처 방식이 증거로 쓸 수 있다는 뜻이다. 온전하게 보이면 캡처가 실제 z-order를 담지 못한 것이니 이 과제를 끝내지 말고 원인을 찾는다. `WARN capture fallback`이 나오면 그 PNG는 증거로 쓰지 않고 status에 그렇게 적는다.

- [ ] **Step 4: `docs/testing.md`의 "`SetupDisplayTests`의 PNG는 보조 자료다" 문단을 고친다.** 게이트는 겹침·잘림 기하 검사이고, 눈으로 보는 그림은 `PrintWindow` 캡처라는 점, `DrawToBitmap`은 자식 z-order를 재현하지 못한다는 점을 적는다.

- [ ] **Step 5: Commit**

```bash
git add tests/install/SetupDisplayTests.cs tests/install/GuiSmokeTests.cs docs/testing.md
git commit -m "test(install): capture wizard screens from the real window"
```

### Task 2: 형제 컨트롤 겹침 검사와 라벨 폭 수정

**Files:**
- Modify: `tests/install/SetupDisplayTests.cs`
- Modify: `installer/SetupForm.cs:54` 부근(`LabelAt`)과 `LabelAt(welcome|runtime, …)` 호출부

**Interfaces:**
- Consumes: Task 1의 `Capture`.
- Produces: `SetupDisplayTests.CheckOverlap(Control parent, string where)` — 이후 과제의 화면 검사가 그대로 쓴다.

- [ ] **Step 1: 실패하는 검사 추가**

`SetupDisplayTests`에 아래 검사를 넣고, 각 글꼴 크기의 각 페이지 `Check(form)` 다음과 고급 설정 대화상자 `Check(dialog)` 다음에 호출한다.

```csharp
// Sibling controls must not cover each other: the one added first is on top and hides the other's text.
static void CheckOverlap(Control parent, string where) {
    var shown = parent.Controls.Cast<Control>().Where(c => c.Visible).ToList();
    for (int i = 0; i < shown.Count; i++) for (int j = i + 1; j < shown.Count; j++) {
        var hit = Rectangle.Intersect(shown[i].Bounds, shown[j].Bounds);
        // 1 px of tolerance for rounding when the form scales with the font.
        if (hit.Width > 1 && hit.Height > 1)
            throw new Exception("Overlap " + where + ": " + Describe(shown[i]) + " covers " + Describe(shown[j]) + " by " + hit.Width + "x" + hit.Height);
    }
    foreach (var child in shown) CheckOverlap(child, where);
}
static string Describe(Control c) { return (c.Name.Length > 0 ? c.Name : c.GetType().Name) + "[" + (c.Text.Length > 24 ? c.Text.Substring(0, 24) : c.Text) + "]"; }
```

검사가 첫 겹침에서 멈추지 않고 전부 모아 한 번에 보고하도록 예외 대신 목록에 쌓은 뒤 마지막에 던진다(수정 대상 목록이 테스트 출력으로 나오게 하기 위함). 머리글·바닥글의 1px 구분선처럼 도킹된 장식 `Panel`이 15pt·20pt에서 이웃과 1px 넘게 겹쳐 걸리면, 그것은 레이아웃 수정 대상이 아니라 검사 예외다(높이나 폭이 2px 이하인 컨트롤은 건너뛴다).

- [ ] **Step 2: 실패 확인**

Run: `AB_PACKAGE_ZIP=$PWD/release/v0.4.2-main/agent-browser-0.4.2-windows-x64.zip bash scripts/test-installer-windows.sh SetupDisplayTests`
Expected: FAIL. 출력에 `Operation`, `ExistingInstallations`(page 0)와 `RuntimeKind`, `RuntimeCandidates`, `RuntimeExecutable`, `RuntimeDirectory`(page 6)가 16px·20px 겹침으로 나온다. 목록에 다른 쌍이 더 있으면 그것도 이 과제의 수정 대상이다.

- [ ] **Step 3: 라벨 폭 수정**

같은 줄에 입력란이 있는 `LabelAt` 호출에 폭을 명시해 `label.Right <= control.Left - 8`이 되게 한다(시작 화면 146, OpenCode 단계 142). `LabelAt`의 기본 폭 170은 고급 설정이 쓰므로 바꾸지 않는다. 검사 출력에 나온 다른 쌍은 같은 원칙(가리는 쪽의 영역을 줄인다)으로 고친다.

- [ ] **Step 4: 통과 확인**

Run: Step 2와 같은 명령.
Expected: 4개 글꼴 크기 모두 `PASS setup pages, advanced settings and small-window navigation at …pt`. 라벨 잘림 검사(`Clipped label`)도 통과한다. Task 1의 캡처로 찍힌 `font-10-page-0.png`에 `설치`가, `font-10-page-6.png`에 `Windows`가 온전히 보이는지 직접 본다.

- [ ] **Step 5: Commit**

```bash
git add tests/install/SetupDisplayTests.cs installer/SetupForm.cs
git commit -m "fix(install): stop row labels from covering the left edge of their fields"
```

### Task 3: 표식 없는 Bridge를 C#이 인수·중지

**Files:**
- Modify: `installer/InstallerEngine.cs`(`BridgeControl`의 `Stop`·`Start`, 새 `AdoptRunning`)
- Test: `tests/install/InstallerReviewTests.cs`(`Case` 추가. CI의 `NativeEngineTests`가 실행한다)

**Interfaces:**
- Produces: `internal static Dictionary<string,object> BridgeControl.AdoptRunning(InstallState state)` — 아래 조건을 모두 만족하면 `.installer-bridge-process.json` 표식(기존 필드 `Product`·`InstallId`·`Pid`·`Executable`·`Port`·`CreatedAt`)을 쓰고 그 내용을 돌려준다. 하나라도 어긋나면 아무것도 쓰지 않고 `null`을 돌려준다(예외를 던지지 않는다).
  1. `state.DataDir\serve.pid`가 양의 정수 PID다.
  2. 그 PID의 `Win32_Process.ExecutablePath`가 `state.OwnedFiles` 중 파일 이름이 `browser-bridge.exe`인 항목의 전체 경로와 같고, 그 파일의 해시가 기록과 같다.
  3. `CommandLine`이 `(?:^|\s)serve\s+--port\s+<state.Port>(?:\s|$)`에 맞는다.
  4. `BridgeControl.Invoke(state, new[]{"status","--json"})`가 성공한다(이 데이터 폴더의 토큰으로 그 포트의 serve에 인증된다는 뜻).
- Consumes: 기존 `BridgeControl.Verify`, `Marker`, `RemoveStoppedMarker`, `BridgeStartJob.RequireChild`.

- [ ] **Step 1: 실패하는 테스트 추가**

`InstallerReviewTests`에 `Case("an unmarked serve is adopted, stopped, updated and removed", options=>{…})`를 추가한다. 헬퍼 `Unmarked(InstallState state)`: 표식의 PID를 종료하고 `BridgeControl.Run(state,new[]{"start","--port",state.Port.ToString()},30000)`을 실행한 뒤 `serve.pid`의 PID를 돌려준다.

```csharp
options.Start=true;options.Port=<빈 포트>;Apply(options);var state=InstallerEngine.State(options.InstallDir);
int pid=Unmarked(state);
Assert(BridgeControl.Stop(state),"an unmarked serve of this installation was not stopped");
Assert(!Alive(pid),"Stop reported success but the serve is still running");
pid=Unmarked(state);BridgeControl.Start(state);
Assert(Convert.ToInt32(MarkerOf(state)["Pid"])==pid&&Alive(pid),"Start did not adopt the running serve");
Unmarked(state);options.Operation="update";Apply(options);            // same package, Start=true
Unmarked(InstallerEngine.State(options.InstallDir));
Apply(new SetupOptions{Operation="uninstall",InstallDir=options.InstallDir});
Assert(InstallerEngine.State(options.InstallDir)==null,"uninstall left the installation behind");
```

교차 버전 케이스 `Case("an unmarked serve of the previous version does not block an update", …)`: 실제 업데이트는 실행 파일 경로가 바뀐다. 기존 헬퍼 `VersionedPackage(name, version, extra)`로 다른 버전의 패키지를 만들어, 원래 패키지로 설치(Start=true) → `Unmarked(state)` → 새 버전 패키지로 `update`(Start=true)가 성공하고, 끝난 뒤 `serve.pid`의 프로세스 실행 파일이 새 `CurrentExe`이며 이전 serve는 종료됐음을 단언한다.

음성 케이스 `Case("a foreign process named by serve.pid is never adopted", …)`: 설치(Start=false) 뒤 `serve.pid`에 테스트 프로세스 자신의 PID를 쓰고 `BridgeControl.AdoptRunning(state)==null`, 표식 파일이 생기지 않음, `BridgeControl.Stop(state)==false`를 단언한다.

음성 케이스 `Case("a serve of another data folder is never adopted", …)`: 같은 포트로 설치 두 개(A는 Start=true, B는 Start=false)를 만든 뒤 B의 `serve.pid`에 A의 serve PID를 쓴다. `BridgeControl.AdoptRunning(stateB)==null`(B의 토큰으로는 인증되지 않고 실행 파일도 B의 소유 파일이 아니다), A의 serve는 계속 실행 중임을 단언한다.

- [ ] **Step 2: 실패 확인**

Run: `docs/testing.md`의 `NativeEngineTests` 실행 절차(CI 단계 "Native GUI engine install/update/rollback/uninstall regressions"와 같은 인수).
Expected: `FAIL REVIEW an unmarked serve is adopted…: an unmarked serve of this installation was not stopped`. 음성 케이스는 `AdoptRunning`이 없어 컴파일 오류다.

- [ ] **Step 3: `AdoptRunning` 구현, `Stop`·`Start`에 연결**

- `Stop`: 표식이 없거나 `Verify`가 null이면 `AdoptRunning(state)`을 시도하고, 인수되면 그 표식으로 기존 종료 경로를 탄다. 인수되지 않으면 지금처럼 false.
- `Start`: 표식 검증이 null이면 먼저 `AdoptRunning(state)`. 인수한 serve의 `Executable`이 `state.CurrentExe`와 같으면 그대로 반환, 다르면(이전 버전) `Stop` 후 새로 시작한다. `start` 실행 뒤 `RequireChild`가 실패하면 `AdoptRunning`을 한 번 시도하고, 인수한 실행 파일이 `CurrentExe`와 같을 때만 성공으로 본다.
- 종료는 지금처럼 프로세스 kill이다(정상 종료 요청은 이 계획의 범위가 아니다).

- [ ] **Step 4: 통과 확인**

Run: Step 2와 같은 명령. Expected: 두 케이스 `PASS REVIEW …`, 기존 케이스 전부 통과.

- [ ] **Step 5: Commit**

```bash
git add installer/InstallerEngine.cs tests/install/InstallerReviewTests.cs
git commit -m "fix(install): adopt and stop a Bridge that an MCP proxy restarted"
```

### Task 4: 마법사의 무음 재시도와 오류 문구

**Files:**
- Modify: `installer/SetupForm.cs`(`DetectExtension`, `Friendly.Known`)
- Modify: `installer/InstallerEngine.cs`(`BridgeControl.Starts` 카운터)
- Test: `tests/install/SetupFlowTests.cs`

**Interfaces:**
- Produces: `internal static int BridgeControl.Starts` — `Start`가 호출될 때마다 1 증가(기존 `InstallerEngine.OwnedVerifications`와 같은 용도의 테스트 관찰점).

- [ ] **Step 1: 실패하는 테스트 추가**

```csharp
Case("Bridge start errors are explained and not retried on every detection tick",()=>{
  Assert(Friendly.Message(new IOException("Bridge PID does not belong to this startup.")).Contains("포트"),"unverified Bridge");
  Assert(Friendly.Message(new IOException("Owned Bridge startup failed (1).")).Contains("포트"),"failed start");
  // 순서가 중요하다: 엔진으로 설치(Start=false) → 그 포트를 TcpListener로 점유 → 폼에서 Invoke(form,"OpenSetup")
  // (여기서 한 번 시도하고 실패해 확장 추가 화면으로 간다) → before=BridgeControl.Starts → Invoke(form,"DetectExtension") 3회
  Assert(BridgeControl.Starts==before+1,"each detection tick started the Bridge again: "+(BridgeControl.Starts-before));
});
```

- [ ] **Step 2: 실패 확인** — Run: `bash scripts/test-installer-windows.sh SetupFlowTests`. Expected: 새 케이스 FAIL(`Starts`가 없어 컴파일 오류, 추가 후에는 3회 증가).

- [ ] **Step 3: 구현**

- `DetectExtension`: Bridge 시작은 성공·실패와 무관하게 페이지 방문당 한 번만 시도한다(시도 전에 `detectionBridgeStarted=true`).
- `Friendly.Known`에 두 항목 추가. 문구: `Bridge를 시작하지 못했습니다. 포트를 다른 프로그램이 쓰고 있지 않은지 확인하세요. [뒤로] 후 고급 설정에서 포트를 바꾸거나, 설치 폴더의 diagnose.cmd 결과를 확인하세요.`

- [ ] **Step 4: 통과 확인** — Run: Step 2와 같은 명령. Expected: 로컬 `TOTAL 31 PASS / 0 FAIL`(현재 30개 + 새 케이스 1개).

- [ ] **Step 5: Commit**

```bash
git add installer/SetupForm.cs installer/InstallerEngine.cs tests/install/SetupFlowTests.cs
git commit -m "fix(install): explain Bridge start failures and try once per page visit"
```

### Task 5: PowerShell의 같은 인수 규칙

코드 추적으로만 확인한 항목이다. Step 1의 테스트가 수정 없이 통과하면 이 과제는 테스트만 남기고 끝낸다.

**Files:**
- Modify: `scripts/installer-common.ps1`(`Stop-OwnedBridge` 450행 부근, `Start-OwnedBridge` 564행 부근)
- Test: `tests/install/install.tests.ps1`

**Interfaces:**
- Consumes: Task 3의 인수 조건 네 가지(같은 조건을 PowerShell로 옮긴다).

- [ ] **Step 1: 실패하는 테스트 추가** — 설치(-Port 빈 포트) → 표식의 PID 종료 → `browser-bridge.exe start --port P` → `uninstall.ps1 -InstallDir`가 성공하고 serve가 종료됨을 단언. 두 번째: 이전 버전 패키지(기존 버전 조작 fixture)로 설치해 같은 상태를 만든 뒤 새 패키지 `setup.ps1`이 성공함을 단언.
- [ ] **Step 2: 실패 확인** — Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\install\install.tests.ps1 -BridgeExe <exe>`.
- [ ] **Step 3: `Get-VerifiedBridgeProcess`가 null일 때 Task 3의 네 조건으로 `serve.pid` 프로세스를 인수하도록 구현**
- [ ] **Step 4: 통과 확인** — 같은 명령, 전체 통과.
- [ ] **Step 5: Commit** — `fix(install): adopt an unmarked Bridge in the PowerShell scripts`

### Task 6: 테스트 의존성 버전 상향과 유지보수 exe 캐시 정리

**Files:**
- Modify: `extension/package.json`(`vitest` 4.1.11 → 4.1.12), `pnpm-lock.yaml`
- Modify: `installer/SetupForm.cs`(`Program.RelaunchInstalled`)
- Test: `tests/install/InstallerReviewTests.cs`

- [ ] **Step 1: 버전 상향** — `pnpm --filter agent-browser-extension add -D -E vitest@4.1.12`, 이어서 `pnpm update -r --depth Infinity undici`(간접 의존성이라 `--depth`가 필요하다. lockfile만 바뀌고 `jsdom`은 30.1.2 그대로).
- [ ] **Step 2: 확인** — Run: `pnpm why -r undici; pnpm why -r @vitest/mocker`. Expected: `undici` 8.12.2 이상, `@vitest/mocker` 4.1.12. Run: `cd extension && pnpm exec tsc --noEmit && pnpm exec vitest run`. Expected: 71 files / 852 passed. Run: `pnpm --filter agent-browser-extension build && grep -rli 'undici\|vitest' extension/dist`. Expected: 출력 없음. Run: `node scripts/generate-third-party-notices.mjs && python3 tests/install/package_release_test.py`. Expected: 통과, 고지문 목록 변화 없음.
- [ ] **Step 3: Commit** — `chore(deps): update vitest and undici in the test toolchain`
- [ ] **Step 4: 캐시 정리 테스트** — `Case("old maintenance copies are pruned", …)`: 캐시 폴더에 가짜 해시 폴더 두 개를 만들고 `Program.PruneMaintenanceCache(cacheRoot, currentHash)` 호출 뒤 현재 해시 폴더만 남음을 단언. 잠긴 파일이 있는 폴더는 남기고 예외를 던지지 않음을 단언.
- [ ] **Step 5: 구현** — `internal static void Program.PruneMaintenanceCache(string cacheRoot,string keepHash)`를 추가하고 `RelaunchInstalled`에서 복사본을 확인한 직후 호출한다. 이름이 64자리 16진수이고 `keepHash`가 아닌 하위 폴더만 지우며, 실패는 무시한다.
- [ ] **Step 6: 통과 확인 후 Commit** — `fix(install): prune old maintenance copies of the setup executable`
- [ ] **Step 7: push 후 알림 확인** — Run: `gh api 'repos/jihoon22-lee/agent-browser/dependabot/alerts?state=open' -q length`. Expected: `0`. 0이 아니면 남은 항목을 status에 적는다(저장소 설정은 바꾸지 않는다).

### Task 7: 전체 검증과 0.4.3 출시

- [ ] **Step 1: 개발 패키지 빌드** — `docs/testing.md`의 "설치 마법사 C# 회귀" 절차.
- [ ] **Step 2: 설치 테스트 전체** — `SetupFlowTests`, `SetupDisplayTests`, `ManagedPathTests`, `NativeEngineTests`, `install.tests.ps1`. 각각 통과 수를 기록한다.
- [ ] **Step 3: 실제 exe 스모크** — `GuiSmokeTests --uia --profiles`. Expected: 6개 PASS. `p0-welcome.png`, `runtime-step.png`, `managed-profile-saved.png`에서 입력란 글자가 처음부터 보이는지 직접 본다.
- [ ] **Step 4: 교차 버전 GUI 업데이트** — 게시된 v0.4.2 ZIP으로 격리 설치한 뒤 후보 ZIP으로 `GuiSmokeTests --resume --upgrade`를 실행한다. 이전 버전 설치를 준비하는 방법은 `tests/install/UpgradeFixture.cs`와 `GuiSmokeTests.cs`의 `--resume`·`--upgrade` 분기를 읽고 따른다. Expected: 업데이트 PASS, 설치 ID·데이터 보존. 0.4.2에서 실행하지 않은 항목이다.
- [ ] **Step 5: `CHANGELOG.md` 0.4.3, 버전 상향(`Cargo.toml`, `Cargo.lock`, `extension/public/manifest.json`, `README-install.md`의 ZIP 이름), `docs/status.md` 기록.**
- [ ] **Step 6: push → PR → CI(Linux·Windows) → 병합 → main CI의 Windows 패키지로 게시 → 게시본 재검증 → 정리.** `AGENTS.md`의 Git 절을 따른다. 이 계획 파일은 완료 후 삭제한다.
