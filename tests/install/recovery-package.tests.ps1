#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$PackageDir,[Parameter(Mandatory=$true)][string]$PreviousPackageDir,[string]$WslDistribution='Ubuntu')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
. (Join-Path $PackageDir 'installer-common.ps1')
function Assert($Value,[string]$Message){if(-not $Value){throw $Message}}
$root=Join-Path ([IO.Path]::GetTempPath()) ('AgentBrowser-recovery-'+[guid]::NewGuid().ToString('N'))
$install=Join-Path $root 'installed spaces';$startup=Join-Path $root 'startup'
$null=New-Item -ItemType Directory -Path $startup -Force
$foreign=Join-Path $startup 'AgentBrowser.lnk';Write-Utf8Atomic $foreign 'synthetic unrelated shortcut'
$foreignHash=Get-FileSha256 $foreign
$ps=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
function Script([string]$Path,[string[]]$Arguments){Invoke-NativeCapture $ps (@('-NoProfile','-ExecutionPolicy','Bypass','-File',$Path)+$Arguments) $root @{} 180000 -ReturnResult}
$syntheticRuntimePath=$null;$runtimeOriginal=$null
try {
    $argsInstall=@('-InstallDir',$install,'-StartupDir',$startup,'-Port',[string]$port,'-NoStart','-Quiet')
    $blocked=Script (Join-Path $PreviousPackageDir 'setup.ps1') $argsInstall
    Assert ($blocked.ExitCode -ne 0) 'Foreign Startup shortcut should block registration'
    $installed=Script (Join-Path $PreviousPackageDir 'setup.ps1') ($argsInstall+@('-NoStartup'))
    Assert ($installed.ExitCode -eq 0) 'Documented NoStartup fallback failed'
    $state=Read-InstallState $install
    $oldExeHash=Get-FileSha256 $state.CurrentExe
    $started=Script (Join-Path $install 'start-bridge.ps1') @()
    Assert ($started.ExitCode -eq 0) 'Documented manual Bridge start failed'
    $pair=Invoke-BridgeCapture $state @('pair')
    Assert ($pair -match '[a-f0-9]{64}') 'Pair command did not return a token'
    $null=Stop-OwnedBridge $state
    $wsl=Join-Path ([Environment]::GetFolderPath('System')) 'wsl.exe'
    $user=(Invoke-NativeCapture $wsl @('-d',$WslDistribution,'--exec','id','-un') $root).Trim()
    $profile=Join-Path $root 'profile.json'
    Write-Utf8Atomic $profile (ConvertTo-Json @{id='fixture-private-name';name='fixture-private-name';kind='wsl';distribution=$WslDistribution;user=$user;directory='/tmp';executable='/bin/true'})
    $null=Invoke-BridgeCapture $state @('profile','save','--file',$profile)
    $syntheticRuntimePath=Join-Path $state.DataDir 'runtime.json';$runtimeOriginal=Read-Utf8Text $syntheticRuntimePath
    $runtime=$runtimeOriginal | ConvertFrom-Json
    # The deliberately missing marker belongs to no process. Never use a real PID
    # or alter an operational runtime record in this recovery fixture.
    $record=@{profileId='fixture-private-name';instance='fixture';baseUrl='http://127.0.0.1:65531';username='opencode';password='fixture-private-password';launcher=@{pid=0;created=0;image='absent'};server=$null;wslOwnerFile='/tmp/agent-browser-deliberately-absent-fixture.owner';version=$null}
    $runtime.runtimes | Add-Member -NotePropertyName 'fixture-private-name' -NotePropertyValue $record
    Write-Utf8Atomic $syntheticRuntimePath (ConvertTo-Json $runtime -Depth 20)
    $recordHash=Get-FileSha256 $syntheticRuntimePath
    $diagnosis=Script (Join-Path $PackageDir 'diagnose.ps1') @('-InstallDir',$install)
    Assert ($diagnosis.ExitCode -eq 1 -and $diagnosis.Stdout.Contains('WSL_OWNER_FILE_MISSING')) 'New package failed to diagnose retained ownership in the old installation'
    $report=Read-Utf8Text (Join-Path $state.DataDir 'diagnostic-report.json')
    foreach($private in @('fixture-private-name','fixture-private-password',$state.DataDir,'/tmp')){Assert (-not $report.Contains($private)) 'Report leaked a private fixture field'}
    Assert ((Get-FileSha256 $syntheticRuntimePath) -eq $recordHash -and (Get-FileSha256 $state.CurrentExe) -eq $oldExeHash) 'Package diagnosis changed old ownership or executable'
    Write-Output 'PASS actual Windows package diagnosis of old blocked installation, reason code and private-field exclusion'
    Write-Utf8Atomic $syntheticRuntimePath $runtimeOriginal;$syntheticRuntimePath=$null
    $null=Invoke-BridgeCapture $state @('profile','delete','--id','fixture-private-name')
    $updated=Script (Join-Path $PackageDir 'setup.ps1') ($argsInstall+@('-NoStartup'))
    Assert ($updated.ExitCode -eq 0) 'Documented script update failed'
    $current=Read-InstallState $install
    Assert ($current.InstallId -eq $state.InstallId) 'Update changed install identity'
    $started=Script (Join-Path $install 'start-bridge.ps1') @()
    Assert ($started.ExitCode -eq 0) 'Updated manual start failed'
    $diagnosis=Script (Join-Path $install 'diagnose.ps1') @()
    Assert ($diagnosis.ExitCode -eq 0 -and $diagnosis.Stdout.Contains('Report saved')) 'Installed diagnostic entry point failed'
    Assert ((Get-FileSha256 $foreign) -eq $foreignHash) 'NoStartup modified the unrelated shortcut'
    $removed=Script (Join-Path $install 'uninstall.ps1') @('-InstallDir',$install)
    Assert ($removed.ExitCode -eq 0) 'Documented script uninstall failed'
    Assert (Test-Path -LiteralPath (Join-Path $install 'data\diagnostic-report.json')) 'Default uninstall deleted diagnostic data'
    Assert ((Get-FileSha256 $foreign) -eq $foreignHash) 'Uninstall modified the unrelated shortcut'
    Write-Output 'PASS actual Windows script Startup conflict, NoStartup install, manual start, pairing, update, installed diagnosis and uninstall'
} finally {
    if($syntheticRuntimePath -and $runtimeOriginal){Write-Utf8Atomic $syntheticRuntimePath $runtimeOriginal}
    $state=Read-InstallState $install
    if($state){$null=Script (Join-Path $install 'uninstall.ps1') @('-InstallDir',$install)}
}
