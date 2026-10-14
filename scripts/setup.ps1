#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$PackageDir,
    [string]$InstallDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AgentBrowser'),
    [string]$StartupDir = [Environment]::GetFolderPath('Startup'),
    [ValidateRange(0,65535)][int]$Port = 0,
    [string]$OpenCodeConfig,
    [ValidateSet('windows','wsl')][string]$OpenCodeKind = 'windows',
    [string]$Distribution,
    [switch]$NoStart,
    [switch]$NoStartup,
    [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 -File can evaluate advanced-script defaults before $PSScriptRoot is available.
if (-not $PSBoundParameters.ContainsKey('PackageDir')) { $PackageDir = $PSScriptRoot }
. (Join-Path $PSScriptRoot 'installer-common.ps1')
$manifest = Read-VerifiedPackage $PackageDir
$root = Assert-InstallRoot $InstallDir
if ((Get-FullPath $PackageDir) -eq $root) { throw 'Extract the release to a separate directory, then install into the dedicated AgentBrowser directory.' }
$old = Read-InstallState $root
if ($old -and @($old.Mcps).Count -gt 1) { throw 'This installation has multiple MCP targets. Use AgentBrowser-Setup.exe to update or remove all owned registrations safely.' }
Assert-OwnedFiles $root $old
if ($Port -eq 0) { if ($old) { $Port = [int]$old.Port } else { $Port = 4317 } }
$dataDir = Join-Path $root 'data'
$installId = [guid]::NewGuid().ToString('N')
if ($old) { $installId = $old.InstallId }
elseif (Test-Path -LiteralPath (Join-Path $dataDir '.agent-browser-data-owner.json')) {
    $dataOwner = (Read-Utf8Text (Join-Path $dataDir '.agent-browser-data-owner.json')) | ConvertFrom-Json
    if ($dataOwner.Product -ne $script:AgentBrowserProduct) { throw 'Existing data directory is not an AgentBrowser installation.' }
    $installId = $dataOwner.InstallId
}
$exeInfo = @($manifest.Files | Where-Object { $_.Path -eq 'browser-bridge.exe' })[0]
$exeRelative = 'app/' + $manifest.Version + '-' + $exeInfo.Sha256.Substring(0,12) + '/browser-bridge.exe'
$owned = [ordered]@{}
if ($old) { foreach ($file in $old.OwnedFiles) { $owned[$file.Path] = $file.Sha256 } }
$copies = New-Object 'System.Collections.Generic.List[object]'
foreach ($file in $manifest.Files) {
    $relative = $file.Path
    if ($relative -eq 'browser-bridge.exe') { $relative = $exeRelative }
    $target = Join-SafePath $root $relative
    if ((Test-Path -LiteralPath $target) -and -not $owned.Contains($relative)) { throw "An unowned file blocks installation: $target" }
    $copies.Add([pscustomobject]@{ Source=(Join-SafePath $PackageDir $file.Path); Target=$target; Relative=$relative; Sha256=$file.Sha256.ToLowerInvariant() })
    $owned[$relative] = $file.Sha256.ToLowerInvariant()
}
$state = [pscustomobject][ordered]@{
    Product=$script:AgentBrowserProduct; SchemaVersion=1; InstallId=$installId; InstallDir=$root; DataDir=$dataDir;
    Version=$manifest.Version; CurrentExe=(Join-SafePath $root $exeRelative); Port=$Port;
    InstalledAt=$(if ($old) { $old.InstalledAt } else { [DateTime]::UtcNow.ToString('o') }); UpdatedAt=[DateTime]::UtcNow.ToString('o');
    Startup=$null; Mcp=$null; OwnedFiles=@()
}

$startupPath = $null
if (-not $NoStartup) {
    if (-not $StartupDir) { throw 'Windows Startup folder is unavailable. Specify a user Startup directory or -NoStartup.' }
    Assert-PlainPath $StartupDir
    $startupPath = Join-Path (Get-FullPath $StartupDir) 'AgentBrowser.lnk'
    if ((Test-Path -LiteralPath $startupPath) -and (-not $old -or -not $old.Startup -or $old.Startup.Path -ne $startupPath)) { throw 'An unowned AgentBrowser Startup shortcut already exists. Retry with -NoStartup to preserve it, then use start-bridge.cmd for manual start.' }
}
if ($old -and $old.Startup -and (Test-Path -LiteralPath $old.Startup.Path)) {
    Assert-PlainPath $old.Startup.Path
    if ((Get-FileSha256 $old.Startup.Path) -ne $old.Startup.Sha256) { throw 'The existing Startup shortcut was modified; it was not replaced.' }
}
if ($old -and $old.Mcp) {
    if ($OpenCodeConfig -and (Get-FullPath $OpenCodeConfig) -ne (Get-FullPath $old.Mcp.Path)) { throw 'A different OpenCode config is already registered. Uninstall its owned registration before changing targets.' }
    $OpenCodeConfig = $old.Mcp.Path; $OpenCodeKind = $old.Mcp.Kind; $Distribution = $old.Mcp.Distribution
}
$nativeEntry = New-BrowserMcpEntry $state 'windows'
$fragments = [ordered]@{ 'examples/mcp-windows.json'=(ConvertTo-Json @{ mcp=@{ browser=$nativeEntry } } -Depth 30) }
$selectedEntry = $nativeEntry
if ($OpenCodeKind -eq 'wsl') {
    $selectedEntry = New-BrowserMcpEntry $state 'wsl' $Distribution
    $fragments['examples/mcp-wsl.json'] = ConvertTo-Json @{ mcp=@{ browser=$selectedEntry } } -Depth 30
}
foreach ($relative in $fragments.Keys) {
    $target = Join-SafePath $root $relative
    if ((Test-Path -LiteralPath $target) -and -not $owned.Contains($relative)) { throw "An unowned generated fragment already exists: $target" }
    $owned[$relative] = Get-TextHash $fragments[$relative]
}
$mcpPlan = $null
if ($OpenCodeConfig) {
    $settingsPath = [IO.Path]::GetFullPath($OpenCodeConfig)
    Assert-PlainPath $settingsPath
    $existed = Test-Path -LiteralPath $settingsPath
    $original = '{}'; $originalHash = $null
    if ($existed) { $original = Read-Utf8Text $settingsPath; $originalHash = Get-FileSha256 $settingsPath }
    $expected = $null; if ($old -and $old.Mcp) { $expected = $old.Mcp.EntryHash }
    $edit = Edit-BrowserMcp -Text $original -Entry $selectedEntry -ExpectedEntryHash $expected
    $backups = @(); if ($old -and $old.Mcp) { $backups = @($old.Mcp.Backups) }
    $backupPath = $null
    if ($edit.Changed -and $existed) { $backupPath = $settingsPath + '.agent-browser-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8) + '.bak'; $backups += $backupPath }
    $state.Mcp = [pscustomobject]@{ Path=$settingsPath; Kind=$OpenCodeKind; Distribution=$Distribution; EntryHash=$edit.EntryHash; CreatedMcp=($edit.CreatedMcp -or ($old -and $old.Mcp -and $old.Mcp.CreatedMcp)); CreatedFile=((-not $existed) -or ($old -and $old.Mcp -and $old.Mcp.CreatedFile)); Backups=$backups }
    $mcpPlan = [pscustomobject]@{ Path=$settingsPath; Existed=$existed; OriginalHash=$originalHash; Edit=$edit; Backup=$backupPath }
}
$state.OwnedFiles = @($owned.GetEnumerator() | ForEach-Object { [pscustomobject]@{ Path=$_.Key; Sha256=$_.Value } })

New-InstallDirectory $root
$lockPath = Join-Path $root '.agent-browser-install.lock'
$lock = $null; $transaction = $null; $committed = $false; $rollbackOk = $true; $stoppedOld = $false; $startedNew = $false
try {
    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another installer is using this directory. Wait for it to finish.' }
    # Re-check after taking the installer lock.
    $lockedState = Read-InstallState $root
    if (($old -and -not $lockedState) -or ($old -and $lockedState.UpdatedAt -ne $old.UpdatedAt) -or (-not $old -and $lockedState)) { throw 'Installation changed while setup was preparing; run setup again.' }
    Assert-OwnedFiles $root $old
    $changesRuntime=$old -and ((Get-FullPath $old.CurrentExe) -ne (Get-FullPath $state.CurrentExe) -or [int]$old.Port -ne [int]$state.Port)
    if($changesRuntime){Assert-NoManagedRuntimeForScriptUpdate $old}
    Set-PrivateDataDirectory $dataDir $installId
    $transaction = New-FileTransaction $root
    $null = Save-TransactionFile $transaction (Join-Path $dataDir '.installer-bridge-process.json')
    foreach ($copy in $copies) {
        if (-not (Test-Path -LiteralPath $copy.Target) -or (Get-FileSha256 $copy.Target) -ne $copy.Sha256) { Copy-TransactionFile $transaction $copy.Source $copy.Target }
    }
    foreach ($relative in $fragments.Keys) {
        $target = Join-SafePath $root $relative
        if (-not (Test-Path -LiteralPath $target) -or (Get-FileSha256 $target) -ne $owned[$relative]) { Set-TransactionText $transaction $target $fragments[$relative] }
    }
    if ($old -and $old.Startup -and $old.Startup.Path -ne $startupPath -and (Test-Path -LiteralPath $old.Startup.Path)) { Remove-TransactionFile $transaction $old.Startup.Path }
    if ($startupPath) {
        $shortcutSource = Join-Path $transaction.Stage 'startup.lnk'
        New-StartupShortcut $shortcutSource $root
        $shortcutHash = Get-FileSha256 $shortcutSource
        Copy-TransactionFile $transaction $shortcutSource $startupPath
        $state.Startup = [pscustomobject]@{ Path=$startupPath; Sha256=$shortcutHash }
    }
    if ($mcpPlan -and $mcpPlan.Edit.Changed) {
        if ((Test-Path -LiteralPath $mcpPlan.Path) -ne $mcpPlan.Existed -or ($mcpPlan.Existed -and (Get-FileSha256 $mcpPlan.Path) -ne $mcpPlan.OriginalHash)) { throw 'OpenCode settings changed while setup was preparing; no settings were overwritten.' }
        if ($mcpPlan.Backup) { [IO.File]::Copy($mcpPlan.Path, $mcpPlan.Backup, $false) }
        Set-TransactionText $transaction $mcpPlan.Path $mcpPlan.Edit.Text $(if ($mcpPlan.Existed) { $mcpPlan.OriginalHash } else { 'missing' })
    }
    Set-TransactionText $transaction (Join-Path $root $script:AgentBrowserStateName) (ConvertTo-Json $state -Depth 40)
    $running = $null
    if($changesRuntime) {
        Assert-NoManagedRuntimeForScriptUpdate $old
        $stoppedOld=Stop-OwnedBridge $old
        Assert-NoManagedRuntimeForScriptUpdate $old
    }
    if (-not $NoStart) {
        $running = Start-OwnedBridge $state -Transaction $transaction
        $startedNew = -not $running.reused
    }
    $committed = $true
    if (-not $Quiet) {
        Write-Host ('Installed AgentBrowser ' + $state.Version + ' in ' + $root)
        Write-Host ('Chrome: load the unpacked extension from ' + (Join-Path $root 'extension'))
        Write-Host ('Pairing: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $root 'show-pairing.ps1') + '"')
        Write-Host ('Bridge URL: ws://127.0.0.1:' + $state.Port + '/extension')
        Write-Host 'In Options, create a Windows or WSL profile for your existing OpenCode v1 installation and working directory.'
        Write-Host 'Existing model/provider/auth/session settings are preserved. No OpenCode installation or model request was performed.'
        if ($old) { Write-Host 'Reload AgentBrowser in chrome://extensions after this update.' }
    }
    [pscustomobject]@{ Installed=$true; Version=$state.Version; InstallDir=$root; ExtensionDir=(Join-Path $root 'extension'); Startup=$startupPath; Running=$running; McpFragment=(Join-Path $root 'examples\mcp-windows.json') }
} catch {
    $failure = $_
    if ($transaction -and -not $committed) {
        try {
            if ($startedNew) { $null = Stop-OwnedBridge $state }
            Undo-FileTransaction $transaction
            if ($stoppedOld) { $null = Start-OwnedBridge $old }
        } catch { $rollbackOk = $false; Write-Warning ('Rollback needs inspection: ' + $transaction.Stage + '. ' + $_.Exception.Message) }
    }
    throw $failure
} finally {
    if ($transaction -and ($committed -or $rollbackOk)) { Remove-Item -LiteralPath $transaction.Stage -Recurse -Force }
    if ($lock) { $lock.Dispose(); if (Test-Path -LiteralPath $lockPath) { Remove-Item -LiteralPath $lockPath -Force } }
}
