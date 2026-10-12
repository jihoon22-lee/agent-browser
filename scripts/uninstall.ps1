#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDir,
    [switch]$RemoveData,
    [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 -File can evaluate advanced-script defaults before $PSScriptRoot is available.
if (-not $PSBoundParameters.ContainsKey('InstallDir')) { $InstallDir = $PSScriptRoot }
. (Join-Path $PSScriptRoot 'installer-common.ps1')
$root = Assert-InstallRoot $InstallDir
$state = Read-InstallState $root
if ($state -and @($state.Mcps).Count -gt 1) { throw 'This installation has multiple MCP targets. Use AgentBrowser-Setup.exe to update or remove all owned registrations safely.' }
if (-not $state) {
    if (-not $Quiet) { Write-Host 'No owned installation marker was found. No files or settings were removed.' }
    return [pscustomobject]@{ Removed=$false; AlreadyRemoved=$true; InstallDir=$root }
}
Assert-OwnedFiles $root $state
if ($state.Startup -and (Test-Path -LiteralPath $state.Startup.Path)) {
    Assert-PlainPath $state.Startup.Path
    if ((Get-FileSha256 $state.Startup.Path) -ne $state.Startup.Sha256) { throw 'Startup shortcut was modified; uninstall did not remove it.' }
}
$mcpPlan = $null
if ($state.Mcp -and (Test-Path -LiteralPath $state.Mcp.Path)) {
    Assert-PlainPath $state.Mcp.Path
    $originalHash = Get-FileSha256 $state.Mcp.Path
    $original = Read-Utf8Text $state.Mcp.Path
    $edit = Edit-BrowserMcp -Text $original -Remove -ExpectedEntryHash $state.Mcp.EntryHash -RemoveEmptyMcp:([bool]$state.Mcp.CreatedMcp)
    $removeFile = $false
    if ($state.Mcp.CreatedFile -and (Get-JsonMinified $edit.Text) -eq '{}') { $removeFile = $true }
    $mcpPlan = [pscustomobject]@{ Path=$state.Mcp.Path; OriginalHash=$originalHash; Edit=$edit; RemoveFile=$removeFile }
}
if ($RemoveData -and (Test-Path -LiteralPath $state.DataDir)) {
    Assert-PlainPath $state.DataDir
    if ((Get-FullPath $state.DataDir) -ne (Get-FullPath (Join-Path $root 'data'))) { throw 'Data path is outside this installation.' }
    $owner = (Read-Utf8Text (Join-Path $state.DataDir '.agent-browser-data-owner.json')) | ConvertFrom-Json
    if ($owner.Product -ne $script:AgentBrowserProduct -or $owner.InstallId -ne $state.InstallId) { throw 'Data ownership could not be verified.' }
    # Do not traverse a user's junction into a different location.
    $pending = New-Object 'System.Collections.Generic.Queue[string]'; $pending.Enqueue($state.DataDir)
    while ($pending.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Data contains a reparse point; remove that link explicitly before using -RemoveData.' }
            if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
        }
    }
}
$lockPath = Join-Path $root '.agent-browser-install.lock'
$lock = $null; $transaction = $null; $committed = $false; $rollbackOk = $true; $stopped = $false; $stoppedProfiles = @()
try {
    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another installer is using this directory. Wait for it to finish.' }
    $lockedState = Read-InstallState $root
    if (-not $lockedState -or $lockedState.UpdatedAt -ne $state.UpdatedAt) { throw 'Installation changed while uninstall was preparing; try again.' }
    Assert-OwnedFiles $root $state
    $transaction = New-FileTransaction $root
    Save-TransactionFile $transaction (Join-Path $state.DataDir '.installer-bridge-process.json')
    if (Test-Path -LiteralPath (Join-Path $state.DataDir 'runtime.json')) {
        $runtimeReport = $null
        $runtimeResult = Invoke-BridgeCapture $state @('runtime','stop-all','--json') 120000 -ReturnResult
        if ($runtimeResult.Stdout) {
            $runtimeReport = $runtimeResult.Stdout | ConvertFrom-Json
            $stoppedProfiles = @($runtimeReport.stoppedProfiles)
        }
        if ($runtimeResult.ExitCode -ne 0 -or -not $runtimeReport -or @($runtimeReport.errors).Count -gt 0) {
            throw ('Owned OpenCode runtimes could not all be stopped; installation was retained. ' + $runtimeResult.Stderr)
        }
    }
    $stopped = Stop-OwnedBridge $state
    if ($state.Startup -and (Test-Path -LiteralPath $state.Startup.Path)) { Remove-TransactionFile $transaction $state.Startup.Path }
    if ($mcpPlan -and $mcpPlan.Edit.Changed) {
        if ((Get-FileSha256 $mcpPlan.Path) -ne $mcpPlan.OriginalHash) { throw 'OpenCode settings changed during uninstall; no settings were overwritten.' }
        $backup = $mcpPlan.Path + '.agent-browser-uninstall-' + [guid]::NewGuid().ToString('N') + '.bak'
        [IO.File]::Copy($mcpPlan.Path, $backup, $false)
        if ($mcpPlan.RemoveFile) { Remove-TransactionFile $transaction $mcpPlan.Path }
        else { Set-TransactionText $transaction $mcpPlan.Path $mcpPlan.Edit.Text $mcpPlan.OriginalHash }
    }
    foreach ($file in $state.OwnedFiles) {
        $path = Join-SafePath $root $file.Path
        if (Test-Path -LiteralPath $path) { Remove-TransactionFile $transaction $path }
    }
    Remove-TransactionFile $transaction (Join-Path $state.DataDir '.installer-bridge-process.json')
    Remove-TransactionFile $transaction (Join-Path $root $script:AgentBrowserStateName)
    $committed = $true
} catch {
    $failure = $_
    if ($transaction -and -not $committed) {
        try {
            Undo-FileTransaction $transaction
            if ($stopped) { $null = Start-OwnedBridge $state }
            foreach ($profileId in $stoppedProfiles) {
                try { $null = Invoke-BridgeCapture $state @('runtime','start','--profile',[string]$profileId) 60000 }
                catch { $rollbackOk = $false; Write-Warning ('Could not restart managed profile ' + $profileId + ': ' + $_.Exception.Message) }
            }
        }
        catch { $rollbackOk = $false; Write-Warning ('Rollback needs inspection: ' + $transaction.Stage + '. ' + $_.Exception.Message) }
    }
    throw $failure
} finally {
    if ($transaction -and ($committed -or $rollbackOk)) { Remove-Item -LiteralPath $transaction.Stage -Recurse -Force }
    if ($lock) { $lock.Dispose(); if (Test-Path -LiteralPath $lockPath) { Remove-Item -LiteralPath $lockPath -Force } }
}
if ($committed) {
    if ($RemoveData -and (Test-Path -LiteralPath $state.DataDir)) { Remove-Item -LiteralPath $state.DataDir -Recurse -Force }
    $parents = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $state.OwnedFiles) {
        $parent = [IO.Path]::GetDirectoryName((Join-SafePath $root $file.Path))
        while ($parent -and $parent.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { $null = $parents.Add($parent); $parent = [IO.Path]::GetDirectoryName($parent) }
    }
    foreach ($parent in @($parents | Sort-Object Length -Descending)) {
        if ((Test-Path -LiteralPath $parent) -and @(Get-ChildItem -LiteralPath $parent -Force).Count -eq 0) { Remove-Item -LiteralPath $parent -Force }
    }
    if ((Test-Path -LiteralPath $root) -and @(Get-ChildItem -LiteralPath $root -Force).Count -eq 0) { Remove-Item -LiteralPath $root -Force }
    if (-not $Quiet) {
        Write-Host 'AgentBrowser owned managed runtimes, Bridge, application files, Startup shortcut and browser MCP entry were stopped or removed.'
        Write-Host 'Existing OpenCode models, authentication, other MCP servers and sessions were not removed.'
        if (-not $RemoveData) { Write-Host ('Pairing and profile data were kept in ' + $state.DataDir) }
        Write-Host 'Remove the AgentBrowser extension yourself in chrome://extensions.'
    }
    [pscustomobject]@{ Removed=$true; InstallDir=$root; DataPreserved=(-not $RemoveData) }
}
