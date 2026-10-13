#requires -Version 5.1
param(
    [Parameter(Mandatory=$true)][string]$BridgeExe,
    [string]$Scripts,
    [switch]$SkipProcessTests,
    [string]$WslDistribution,
    [switch]$KeepArtifacts
)
$ErrorActionPreference = 'Stop'
if (-not $Scripts) { $Scripts = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..\scripts' }
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $Scripts 'installer-common.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('AgentBrowser-install-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRoot
$passed = 0
$activeInstalls = New-Object 'System.Collections.Generic.List[string]'
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Message) { $caught=$false; try { $null = & $Action } catch { $caught=$true }; Assert $caught $Message }
function Case([string]$Name, [scriptblock]$Action) { & $Action; $script:passed++; Write-Output ('PASS ' + $Name) }
function New-TestPackage([string]$Name, [string]$Version) {
    $package = Join-Path $testRoot $Name
    $null = New-Item -ItemType Directory -Path (Join-Path $package 'extension') -Force
    foreach ($name in @('setup.ps1','uninstall.ps1','installer-common.ps1','start-bridge.ps1','start-bridge.cmd','show-pairing.ps1')) { Copy-Item -LiteralPath (Join-Path $Scripts $name) -Destination (Join-Path $package $name) }
    Copy-Item -LiteralPath $BridgeExe -Destination (Join-Path $package 'browser-bridge.exe')
    Write-Utf8Atomic (Join-Path $package 'extension\manifest.json') (ConvertTo-Json @{manifest_version=3;version=$Version;key='synthetic-test-key';name='Synthetic installer fixture'})
    Write-Utf8Atomic (Join-Path $package 'extension\background.js') ('// synthetic version ' + $Version)
    Write-Utf8Atomic (Join-Path $package 'README-install.md') 'Synthetic installation fixture, not a release package.'
    foreach ($name in @('CHANGELOG.md','LICENSE','SECURITY.md','docs/user-guide.md','docs/troubleshooting.md')) { Write-Utf8Atomic (Join-Path $package $name) 'Synthetic release documentation.' }
    Write-Utf8Atomic (Join-Path $package 'THIRD_PARTY_NOTICES') 'Synthetic installer test only.'
    $files = @(Get-ChildItem -LiteralPath $package -Recurse -File | ForEach-Object { [pscustomobject]@{ Path=$_.FullName.Substring($package.Length+1).Replace('\','/'); Sha256=(Get-FileSha256 $_.FullName) } })
    Write-Utf8Atomic (Join-Path $package 'package-manifest.json') (ConvertTo-Json @{Product='agent-browser';Platform='windows-x64';Version=$Version;Files=$files} -Depth 10)
    return $package
}
function Free-Port { $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0); $listener.Start(); $number=$listener.LocalEndpoint.Port; $listener.Stop(); return $number }
$success = $false
try {

    Case 'rollback preserves concurrent settings and restores unaffected files' {
        foreach($mutation in @('text','copy','remove')) {
            $transaction=New-FileTransaction $testRoot
            $first=Join-Path $testRoot ('rollback-first-' + $mutation + '.json')
            $conflict=Join-Path $testRoot ('rollback-conflict-' + $mutation + '.json')
            $source=Join-Path $testRoot ('rollback-source-' + $mutation + '.json')
            Write-Utf8Atomic $first 'first-original';Write-Utf8Atomic $conflict 'conflict-original';Write-Utf8Atomic $source 'installer-copy'
            Set-TransactionText $transaction $first 'installer-first'
            if($mutation -eq 'text'){Set-TransactionText $transaction $conflict 'installer-text'}
            elseif($mutation -eq 'copy'){Copy-TransactionFile $transaction $source $conflict}
            else {Remove-TransactionFile $transaction $conflict}
            Write-Utf8Atomic $conflict 'concurrent-user-edit'
            Assert-Throws { Undo-FileTransaction $transaction } 'Rollback did not report a concurrent edit'
            Assert ((Read-Utf8Text $conflict) -eq 'concurrent-user-edit') 'Rollback overwrote a user edit'
            Assert ((Read-Utf8Text $first) -eq 'first-original') 'Rollback skipped unaffected earlier changes'
            Assert (Test-Path -LiteralPath $transaction.Journal[1].Backup) 'Recovery backup is missing'
            Assert (Test-Path -LiteralPath (Join-Path $transaction.Stage 'recovery.json')) 'Recovery path/hash journal is missing'
        }
    }
    $package1 = New-TestPackage 'package 1' '0.1.0'
    $package2 = New-TestPackage 'package 2' '0.2.0'
    $install = Join-Path $testRoot '사용자 설치 & 공백'
    # Include a character outside legacy Windows ANSI code pages on every locale.
    $startup = Join-Path $testRoot ('합성 Startup ' + [char]::ConvertFromUtf32(0x1F9EA))
    $settings = Join-Path $testRoot 'OpenCode 설정.jsonc'
    $original = '{ // keep Korean comment: 보존' + "`r`n" + '"model":"corp/model","provider":{"corp":{"options":{"apiKey":"synthetic-not-a-secret"}}},"mcp":{"other":{"type":"local","command":["other.exe"]},},}'
    Write-Utf8Atomic $settings $original
    $originalHash = Get-FileSha256 $settings
    $activeInstalls.Add($install)
    Case 'first install, Unicode paths, Startup and actual-path MCP fragment' {
        $result = & (Join-Path $package1 'setup.ps1') -InstallDir $install -StartupDir $startup -OpenCodeConfig $settings -NoStart -Quiet
        Assert $result.Installed 'Install result missing'
        Assert (Test-Path -LiteralPath (Join-Path $install 'extension\manifest.json')) 'Stable extension missing'
        Assert (Test-Path -LiteralPath (Join-Path $install 'docs\user-guide.md')) 'Installed user guide missing'
        Assert (Test-Path -LiteralPath (Join-Path $install 'CHANGELOG.md')) 'Installed changelog missing'
        Assert (Test-Path -LiteralPath (Join-Path $startup 'AgentBrowser.lnk')) 'Startup shortcut missing'
        $state = Read-InstallState $install
        Assert ($state.CurrentExe.Contains('\app\')) 'Executable should be versioned'
        Assert ((Get-Acl -LiteralPath $state.DataDir).AreAccessRulesProtected) 'Credential directory still inherits broad access'
        $fragment = (Read-Utf8Text (Join-Path $install 'examples\mcp-windows.json')) | ConvertFrom-Json
        Assert ($fragment.mcp.browser.command[0] -eq $state.CurrentExe) 'Fragment executable not installed path'
        Assert ((Get-FileSha256 $state.Mcp.Backups[0]) -eq $originalHash) 'Original settings backup changed bytes'
    }
    $firstState = Read-InstallState $install
    $afterFirst = Get-FileSha256 $settings
    Case 'repeat install does not replace identity or rewrite settings' {
        $null = & (Join-Path $package1 'setup.ps1') -InstallDir $install -StartupDir $startup -NoStart -Quiet
        $state = Read-InstallState $install
        Assert ($state.InstallId -eq $firstState.InstallId) 'Install identity changed'
        Assert ((Get-FileSha256 $settings) -eq $afterFirst) 'Repeated merge changed settings'
        Assert (@($state.Mcp.Backups).Count -eq 1) 'Repeated merge created another backup'
    }
    Case 'upgrade preserves user model edits, comments, other MCP and data' {
        Write-Utf8Atomic $settings ((Read-Utf8Text $settings).Replace('corp/model','corp/new-model'))
        Write-Utf8Atomic (Join-Path $install 'data\keep-profile.json') '{"synthetic":"preserve"}'
        $null = & (Join-Path $package2 'setup.ps1') -InstallDir $install -StartupDir $startup -NoStart -Quiet
        $state = Read-InstallState $install
        Assert ($state.Version -eq '0.2.0') 'Version not upgraded'
        Assert ($state.InstallId -eq $firstState.InstallId) 'Upgrade changed ownership identity'
        Assert ($state.CurrentExe -ne $firstState.CurrentExe) 'Upgrade did not use a new versioned path'
        $text=Read-Utf8Text $settings; $config=ConvertFrom-Json (Get-JsonMinified $text)
        Assert ($config.model -eq 'corp/new-model') 'User model edit lost'
        Assert ($text.Contains('보존')) 'JSONC comment lost'
        Assert ($config.mcp.other.command[0] -eq 'other.exe') 'Other MCP was changed'
        Assert ($config.provider.corp.options.apiKey -eq 'synthetic-not-a-secret') 'Provider data changed'
        Assert (Test-Path -LiteralPath (Join-Path $install 'data\keep-profile.json')) 'Profile data lost'
    }
    Case 'modified browser entry blocks both upgrade and uninstall without changes' {
        $ownedText=Read-Utf8Text $settings
        Write-Utf8Atomic $settings ($ownedText.Replace('browser-bridge.exe','user-edited.exe'))
        $changedHash=Get-FileSha256 $settings
        Assert-Throws { & (Join-Path $package2 'setup.ps1') -InstallDir $install -StartupDir $startup -NoStart -Quiet } 'Upgrade accepted an edited MCP entry'
        Assert-Throws { & (Join-Path $package2 'uninstall.ps1') -InstallDir $install -Quiet } 'Uninstall removed an edited MCP entry'
        Assert ((Get-FileSha256 $settings) -eq $changedHash) 'Conflicting settings changed'
        Assert (Test-Path -LiteralPath (Join-Path $install 'extension\manifest.json')) 'Conflict partially uninstalled product'
        Write-Utf8Atomic $settings $ownedText
    }
    Case 'missing owned files and user-added files are handled safely on uninstall' {
        Remove-Item -LiteralPath (Join-Path $install 'extension\background.js')
        Write-Utf8Atomic (Join-Path $install 'user-note.txt') 'keep this user file'
        $null = & (Join-Path $package2 'uninstall.ps1') -InstallDir $install -Quiet
        Assert (-not (Test-Path -LiteralPath (Join-Path $startup 'AgentBrowser.lnk'))) 'Startup entry remained'
        $config=ConvertFrom-Json (Get-JsonMinified (Read-Utf8Text $settings))
        Assert ($null -eq $config.mcp.browser) 'Owned MCP was not removed'
        Assert ($config.mcp.other.command[0] -eq 'other.exe' -and $config.model -eq 'corp/new-model') 'User config was not preserved'
        Assert (Test-Path -LiteralPath (Join-Path $install 'data\keep-profile.json')) 'Default uninstall removed data'
        Assert (Test-Path -LiteralPath (Join-Path $install 'user-note.txt')) 'Uninstall removed an unowned file'
        $again=& (Join-Path $package2 'uninstall.ps1') -InstallDir $install -Quiet
        Assert $again.AlreadyRemoved 'Second uninstall was not a safe no-op'
    }
    Case 'reinstall reuses retained pairing/profile ownership' {
        $null = & (Join-Path $package2 'setup.ps1') -InstallDir $install -StartupDir $startup -NoStart -Quiet
        Assert ((Read-InstallState $install).InstallId -eq $firstState.InstallId) 'Reinstall did not reuse retained data identity'
        $null = & (Join-Path $package2 'uninstall.ps1') -InstallDir $install -RemoveData -Quiet
        Assert (-not (Test-Path -LiteralPath (Join-Path $install 'data'))) 'Explicit RemoveData did not remove owned data'
        Assert (Test-Path -LiteralPath (Join-Path $install 'user-note.txt')) 'RemoveData removed unrelated user files'
    }
    Case 'unowned browser entry, invalid JSONC and missing package files fail before installation' {
        $conflict = Join-Path $testRoot 'conflict.jsonc'; Write-Utf8Atomic $conflict '{"model":"keep","mcp":{"browser":{"type":"local","command":["user.exe"]}}}'
        $conflictHash=Get-FileSha256 $conflict; $blocked=Join-Path $testRoot 'blocked install'
        Assert-Throws { & (Join-Path $package1 'setup.ps1') -InstallDir $blocked -StartupDir $startup -OpenCodeConfig $conflict -NoStart -Quiet } 'Unowned MCP was accepted'
        Assert ((Get-FileSha256 $conflict) -eq $conflictHash) 'Unowned MCP was altered'
        Assert (-not (Test-Path -LiteralPath $blocked)) 'Conflict created partial installation'
        Write-Utf8Atomic $conflict '{ broken'
        Assert-Throws { & (Join-Path $package1 'setup.ps1') -InstallDir $blocked -StartupDir $startup -OpenCodeConfig $conflict -NoStart -Quiet } 'Invalid JSONC accepted'
        $missing=New-TestPackage 'missing package' '0.3.0'; Remove-Item -LiteralPath (Join-Path $missing 'extension\background.js')
        Assert-Throws { & (Join-Path $missing 'setup.ps1') -InstallDir $blocked -StartupDir $startup -NoStart -Quiet } 'Incomplete release was accepted'
        Assert (-not (Test-Path -LiteralPath $blocked)) 'Missing file left a partial installation'
    }
    Case 'unowned Startup and modified product files are not overwritten' {
        $customStartup=Join-Path $testRoot 'unowned startup'; $null=New-Item -ItemType Directory -Path $customStartup
        $customLink=Join-Path $customStartup 'AgentBrowser.lnk'; Write-Utf8Atomic $customLink 'user shortcut fixture'
        $customHash=Get-FileSha256 $customLink; $blocked=Join-Path $testRoot 'startup blocked'
        Assert-Throws { & (Join-Path $package1 'setup.ps1') -InstallDir $blocked -StartupDir $customStartup -NoStart -Quiet } 'Unowned Startup shortcut accepted'
        Assert ((Get-FileSha256 $customLink) -eq $customHash) 'Unowned shortcut changed'
        $modified=Join-Path $testRoot 'modified product'; $activeInstalls.Add($modified)
        $null=& (Join-Path $package1 'setup.ps1') -InstallDir $modified -NoStartup -NoStart -Quiet
        Write-Utf8Atomic (Join-Path $modified 'README-install.md') 'user customization'
        Assert-Throws { & (Join-Path $package2 'setup.ps1') -InstallDir $modified -NoStartup -NoStart -Quiet } 'Modified product file was replaced'
        Assert-Throws { & (Join-Path $package1 'uninstall.ps1') -InstallDir $modified -Quiet } 'Modified product file was deleted'
        Remove-Item -LiteralPath (Join-Path $modified 'README-install.md')
        $null=& (Join-Path $package1 'uninstall.ps1') -InstallDir $modified -RemoveData -Quiet
    }
    Case 'junction path cannot redirect installation outside its root' {
        $outside=Join-Path $testRoot 'outside'; $null=New-Item -ItemType Directory -Path $outside
        $link=Join-Path $testRoot 'linked install'
        $null=New-Item -ItemType Junction -Path $link -Target $outside
        try { Assert-Throws { & (Join-Path $package1 'setup.ps1') -InstallDir $link -StartupDir $startup -NoStart -Quiet } 'Junction install was accepted'; Assert (@(Get-ChildItem -LiteralPath $outside -Force).Count -eq 0) 'Junction target was modified' }
        finally { [IO.Directory]::Delete($link) }
    }
    if ($WslDistribution) {
        Case 'WSL fragment uses the selected distribution actual interop path' {
            $wslInstall=Join-Path $testRoot 'WSL 설치'; $wslSettings=Join-Path $testRoot 'wsl-settings.jsonc'; $activeInstalls.Add($wslInstall)
            Write-Utf8Atomic $wslSettings '{"model":"corp/wsl"}'
            $null=& (Join-Path $package1 'setup.ps1') -InstallDir $wslInstall -NoStartup -NoStart -Quiet -OpenCodeKind wsl -Distribution $WslDistribution -OpenCodeConfig $wslSettings
            $wslState=Read-InstallState $wslInstall
            $entry=(ConvertFrom-Json (Get-JsonMinified (Read-Utf8Text $wslSettings))).mcp.browser
            Assert ($entry.command[0].StartsWith('/') -and $entry.command[0].EndsWith('/browser-bridge.exe')) 'WSL executable is not an actual interop path'
            Assert ($entry.environment.AGENT_BROWSER_HOME -eq $wslState.DataDir) 'WSL Bridge home was incorrectly translated'
            Assert ($entry.environment.WSLENV -eq 'AGENT_BROWSER_HOME/w:AGENT_BROWSER_PORT/w') 'WSL variables will not reach Windows'
            $null=& (Join-Path $package1 'uninstall.ps1') -InstallDir $wslInstall -RemoveData -Quiet
            Assert ((ConvertFrom-Json (Get-JsonMinified (Read-Utf8Text $wslSettings))).model -eq 'corp/wsl') 'WSL model config changed'
        }
    }
    if (-not $SkipProcessTests) {
        $liveInstall=Join-Path $testRoot '실행 설치'; $liveStartup=Join-Path $testRoot 'startup live'; $activeInstalls.Add($liveInstall); $port=Free-Port
        Case 'Unicode Startup shortcut launches the installed Bridge' {
            $unicodeStartup=Join-Path $testRoot ('startup launch ' + [char]::ConvertFromUtf32(0x1F9EA))
            $null=& (Join-Path $package1 'setup.ps1') -InstallDir $liveInstall -StartupDir $unicodeStartup -Port $port -NoStart -Quiet
            $liveState=Read-InstallState $liveInstall
            Start-Process -FilePath (Join-Path $unicodeStartup 'AgentBrowser.lnk') -WindowStyle Hidden
            $verified=$null
            for ($attempt=0; $attempt -lt 150; $attempt++) {
                $verified=Get-VerifiedBridgeProcess $liveState
                if ($verified) { break }
                Start-Sleep -Milliseconds 200
            }
            Assert ($null -ne $verified) 'Unicode Startup shortcut did not launch its owned Bridge'
            $null=& (Join-Path $package1 'uninstall.ps1') -InstallDir $liveInstall -RemoveData -Quiet
            Assert (-not (Get-Process -Id ([int]$verified.Marker.Pid) -ErrorAction SilentlyContinue)) 'Shortcut-launched Bridge survived uninstall'
        }
        Case 'immediate detached start, repeated start, upgrade and exact-owned stop' {
            $first=& (Join-Path $package1 'setup.ps1') -InstallDir $liveInstall -StartupDir $liveStartup -Port $port -Quiet
            Assert $first.Running.running 'Setup did not start Bridge'
            $firstPid=$first.Running.pid
            $repeat=& (Join-Path $package1 'setup.ps1') -InstallDir $liveInstall -StartupDir $liveStartup -Quiet
            Assert ($repeat.Running.pid -eq $firstPid -and $repeat.Running.reused) 'Repeated setup created another process'
            $liveState=Read-InstallState $liveInstall
            $markerPath=Join-Path $liveState.DataDir '.installer-bridge-process.json'; $savedMarker=Read-Utf8Text $markerPath
            $unrelated=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden
            try {
                $fakeMarker=$savedMarker | ConvertFrom-Json; $fakeMarker.Pid=$unrelated.Id
                $fakeProcess=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $unrelated.Id); $fakeMarker.CreatedAt=$fakeProcess.CreationDate.ToUniversalTime().ToString('o')
                Write-Utf8Atomic $markerPath (ConvertTo-Json $fakeMarker)
                Assert-Throws { Stop-OwnedBridge $liveState } 'A different process matched a stale PID marker'
                $unrelated.Refresh(); Assert (-not $unrelated.HasExited) 'Ownership check killed an unrelated process'
            } finally { Write-Utf8Atomic $markerPath $savedMarker; if (-not $unrelated.HasExited) { $unrelated.Kill() }; $unrelated.Dispose() }
            $occupied=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0); $occupied.Start()
            try {
                Assert-Throws { & (Join-Path $package2 'setup.ps1') -InstallDir $liveInstall -StartupDir $liveStartup -Port $occupied.LocalEndpoint.Port -Quiet } 'Conflicting upgrade was accepted'
                $restored=Read-InstallState $liveInstall
                Assert ($restored.Version -eq '0.1.0' -and [int]$restored.Port -eq $port) 'Upgrade rollback changed version/port'
                Assert ($null -ne (Get-VerifiedBridgeProcess $restored)) 'Upgrade rollback did not restore the owned Bridge'
            } finally { $occupied.Stop() }
            $upgraded=& (Join-Path $package2 'setup.ps1') -InstallDir $liveInstall -StartupDir $liveStartup -Quiet
            Assert ($upgraded.Running.pid -ne $firstPid) 'Upgrade did not replace its owned process'
            Assert (-not (Get-Process -Id $firstPid -ErrorAction SilentlyContinue)) 'Old owned process survived upgrade'
            $newPid=$upgraded.Running.pid
            $noStart=& (Join-Path $package1 'setup.ps1') -InstallDir $liveInstall -StartupDir $liveStartup -Port $port -NoStart -Quiet
            Assert ($null -eq $noStart.Running) 'NoStart update started a new Bridge'
            Assert (-not (Get-Process -Id $newPid -ErrorAction SilentlyContinue)) 'NoStart update retained the old Bridge process'
            $null=& (Join-Path $package2 'uninstall.ps1') -InstallDir $liveInstall -RemoveData -Quiet
            Assert (-not (Get-Process -Id $newPid -ErrorAction SilentlyContinue)) 'Owned process survived uninstall'
        }
        Case 'occupied port rolls back assets, Startup and user config' {
            $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0); $listener.Start(); $blockedPort=$listener.LocalEndpoint.Port
            $rollbackInstall=Join-Path $testRoot 'rollback install'; $rollbackStartup=Join-Path $testRoot 'rollback startup'; $rollbackConfig=Join-Path $testRoot 'rollback.jsonc'
            Write-Utf8Atomic $rollbackConfig '{"model":"corp/preserved"}'; $before=Get-FileSha256 $rollbackConfig
            try {
                Assert-Throws { & (Join-Path $package1 'setup.ps1') -InstallDir $rollbackInstall -StartupDir $rollbackStartup -OpenCodeConfig $rollbackConfig -Port $blockedPort -Quiet } 'Port conflict was treated as success'
                Assert ((Get-FileSha256 $rollbackConfig) -eq $before) 'Rollback did not restore original config'
                Assert (-not (Test-Path -LiteralPath (Join-Path $rollbackStartup 'AgentBrowser.lnk'))) 'Rollback left Startup entry'
                Assert (-not (Test-Path -LiteralPath (Join-Path $rollbackInstall '.agent-browser-install.json'))) 'Rollback left committed install state'
            } finally { $listener.Stop() }
        }
    }
    $success=$true
    Write-Output ('PASS installer integration cases=' + $passed + '; processTests=' + (-not $SkipProcessTests))
} finally {
    foreach ($path in $activeInstalls) {
        try { $state=Read-InstallState $path; if ($state) { $null=Stop-OwnedBridge $state } } catch { Write-Warning ('Owned cleanup needs inspection: ' + $path) }
    }
    if ($success -and -not $KeepArtifacts) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    else { Write-Output ('Installer test artifacts: ' + $testRoot) }
}
