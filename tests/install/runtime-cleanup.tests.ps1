#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$BridgeExe, [string]$Scripts)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
if (-not $Scripts) { $Scripts=Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..\scripts' }
. (Join-Path $Scripts 'installer-common.ps1')
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('AgentBrowser-runtime-cleanup-' + [guid]::NewGuid().ToString('N'))
$package=Join-Path $testRoot 'package'; $install=Join-Path $testRoot 'install'
$null=New-Item -ItemType Directory -Path (Join-Path $package 'extension') -Force
function Assert($Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function New-SleepFixture {
    $process=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 180') -PassThru -WindowStyle Hidden
    $info=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $process.Id)
    return [pscustomobject]@{ Process=$process; Identity=@{pid=$process.Id;created=[uint64]$process.StartTime.ToFileTimeUtc();image=$info.ExecutablePath} }
}
$owned=$null; $external=$null; $done=$false
try {
    foreach ($name in @('setup.ps1','uninstall.ps1','installer-common.ps1','start-bridge.ps1','start-bridge.cmd','show-pairing.ps1')) { Copy-Item -LiteralPath (Join-Path $Scripts $name) -Destination (Join-Path $package $name) }
    Copy-Item -LiteralPath $BridgeExe -Destination (Join-Path $package 'browser-bridge.exe')
    Write-Utf8Atomic (Join-Path $package 'extension\manifest.json') '{"manifest_version":3,"name":"Synthetic runtime cleanup test","version":"0.1.0","key":"synthetic-test-key"}'
    Write-Utf8Atomic (Join-Path $package 'README-install.md') 'Synthetic fixture'
    foreach ($name in @('CHANGELOG.md','LICENSE','SECURITY.md','docs/user-guide.md','docs/troubleshooting.md')) { Write-Utf8Atomic (Join-Path $package $name) 'Synthetic release documentation.' }
    Write-Utf8Atomic (Join-Path $package 'THIRD_PARTY_NOTICES') 'Synthetic fixture'
    $files=@(Get-ChildItem -LiteralPath $package -Recurse -File | ForEach-Object { @{Path=$_.FullName.Substring($package.Length+1).Replace('\','/');Sha256=(Get-FileSha256 $_.FullName)} })
    Write-Utf8Atomic (Join-Path $package 'package-manifest.json') (ConvertTo-Json @{Product='agent-browser';Platform='windows-x64';Version='0.1.0';Files=$files} -Depth 10)
    $null=& (Join-Path $package 'setup.ps1') -InstallDir $install -NoStartup -NoStart -Quiet
    $state=Read-InstallState $install
    $owned=New-SleepFixture; $external=New-SleepFixture
    $profiles=@{
        owned=@{id='owned';name='Synthetic managed fixture';kind='windows';directory=$testRoot;executable=$owned.Identity.image}
        external=@{id='external';name='Synthetic external fixture';kind='external';directory=$testRoot;baseUrl='http://127.0.0.1:9'}
    }
    $records=@{}
    foreach ($entry in @(@{Name='owned';Value=$owned},@{Name='external';Value=$external})) {
        $records[$entry.Name]=@{profileId=$entry.Name;instance='synthetic';baseUrl='http://127.0.0.1:9';username='synthetic';password='synthetic-not-a-secret';launcher=$entry.Value.Identity;server=$entry.Value.Identity;wslOwnerFile=$null;version=$null}
    }
    Write-Utf8Atomic (Join-Path $state.DataDir 'runtime.json') (ConvertTo-Json @{version=1;profiles=$profiles;defaultProfileId='owned';runtimes=$records} -Depth 10)
    $validRuntime=Read-Utf8Text (Join-Path $state.DataDir 'runtime.json')
    Write-Utf8Atomic (Join-Path $state.DataDir 'runtime.json') '{invalid synthetic fixture'
    $rejected=$false
    try { $null=& (Join-Path $package 'uninstall.ps1') -InstallDir $install -Quiet } catch { $rejected=$true }
    Assert $rejected 'Uninstall accepted invalid runtime ownership data'
    Assert (Test-Path -LiteralPath $state.CurrentExe) 'Failed runtime cleanup removed the installed executable'
    Assert (Test-Path -LiteralPath (Join-Path $install '.agent-browser-install.json')) 'Failed runtime cleanup removed installation ownership'
    $owned.Process.Refresh(); $external.Process.Refresh()
    Assert (-not $owned.Process.HasExited -and -not $external.Process.HasExited) 'Invalid ownership data terminated a process'
    Write-Utf8Atomic (Join-Path $state.DataDir 'runtime.json') $validRuntime
    Write-Output 'PASS failed runtime cleanup retains installation and running processes'
    $manifest=Read-Utf8Text (Join-Path $package 'package-manifest.json') | ConvertFrom-Json
    $manifest.Version='0.2.0'
    Write-Utf8Atomic (Join-Path $package 'package-manifest.json') (ConvertTo-Json $manifest -Depth 10)
    $null=& (Join-Path $package 'setup.ps1') -InstallDir $install -NoStartup -NoStart -Quiet
    $state=Read-InstallState $install
    $owned.Process.Refresh(); $external.Process.Refresh()
    Assert ($state.Version -eq '0.2.0' -and -not $owned.Process.HasExited -and -not $external.Process.HasExited) 'Upgrade did not preserve managed and external runtimes'
    Write-Output 'PASS upgrade preserves managed and external runtimes'
    $null=& (Join-Path $package 'uninstall.ps1') -InstallDir $install -Quiet
    $owned.Process.Refresh(); $external.Process.Refresh()
    Assert $owned.Process.HasExited 'Owned managed runtime survived uninstall'
    Assert (-not $external.Process.HasExited) 'External runtime was terminated during uninstall'
    Assert (Test-Path -LiteralPath (Join-Path $state.DataDir 'runtime.json')) 'Default uninstall removed profile data'
    $retained=Read-Utf8Text (Join-Path $state.DataDir 'runtime.json') | ConvertFrom-Json
    Assert ($null -eq $retained.runtimes.owned -and $null -ne $retained.profiles.owned) 'Stopped ownership record/profile retention is incorrect'
    Write-Output 'PASS uninstall stops verified managed runtime and preserves external runtime and profile data'
    $done=$true
} finally {
    foreach ($fixture in @($owned,$external)) { if ($fixture) { $fixture.Process.Refresh(); if (-not $fixture.Process.HasExited) { $fixture.Process.Kill() }; $fixture.Process.Dispose() } }
    if ($done) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    else { Write-Output ('Runtime cleanup test artifacts: ' + $testRoot) }
}
