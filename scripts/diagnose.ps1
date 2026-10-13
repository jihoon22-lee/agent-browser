#requires -Version 5.1
param([string]$InstallDir = $PSScriptRoot)
$ErrorActionPreference='Stop'

function ConvertTo-SafeDiagnostic($Doctor,[string]$Version) {
    $profiles=@{}; $checks=@()
    foreach($check in $Doctor.checks) {
        $number=$null
        if($check.profileId) {
            $key=[string]$check.profileId
            if(-not $profiles.ContainsKey($key)){$profiles[$key]=$profiles.Count+1}
            $number=$profiles[$key]
        }
        $item=[ordered]@{check=[string]$check.id;profile=$number;status=[string]$check.status}
        if($check.reason){$item.reason=[string]$check.reason}
        if($null -ne $check.exitCode){$item.exitCode=$check.exitCode}
        if($check.runtime.wslProbe){$item.reason=[string]$check.runtime.wslProbe.reason;$item.exitCode=$check.runtime.wslProbe.exitCode}
        $checks+=[pscustomobject]$item
    }
    [pscustomobject]@{schema=1;version=$Version;ok=($Doctor.ok -eq $true);checks=$checks}
}

# Dot sourcing exposes only the report formatter to its synthetic regression test.
if($MyInvocation.InvocationName -eq '.'){return}
$failureCode='DIAG_INSTALLATION_UNVERIFIED'
try {
    . (Join-Path $PSScriptRoot 'installer-common.ps1')
    if(-not (Test-Path -LiteralPath (Join-Path $InstallDir '.agent-browser-install.json')) -and -not $PSBoundParameters.ContainsKey('InstallDir')) {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog=New-Object Windows.Forms.FolderBrowserDialog
        $dialog.Description='Select the installed AgentBrowser folder (contains data and extension).'
        $dialog.ShowNewFolderButton=$false
        $dialog.SelectedPath=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AgentBrowser'
        try {
            if($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK){exit 0}
            $InstallDir=$dialog.SelectedPath
        } finally {$dialog.Dispose()}
    }
    $root=Assert-InstallRoot $InstallDir
    $state=Read-InstallState $root
    if(-not $state){Write-Output 'DIAG_NOT_INSTALLED: Run diagnose.cmd from the installed AgentBrowser folder.';exit 1}
    Assert-OwnedFiles $root $state
    # A verified package can diagnose an older installation even when updating
    # is blocked by its retained runtime. Keep its data home and port unchanged.
    if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'package-manifest.json')) {
        $failureCode='DIAG_PACKAGE_UNVERIFIED'
        $package=Read-VerifiedPackage $PSScriptRoot
        $state.CurrentExe=Join-Path $PSScriptRoot 'browser-bridge.exe'
        $state.Version=$package.Version
    }
    $failureCode='DIAG_QUERY_FAILED'
    Write-Output 'Collecting diagnostics (up to 3 minutes)...'
    $doctor=(Invoke-BridgeCapture $state @('doctor','--json') -TimeoutMs 180000) | ConvertFrom-Json
    $report=ConvertTo-SafeDiagnostic $doctor ([string]$state.Version)
    $text=$report | ConvertTo-Json -Depth 8
    $reportPath=Join-Path $state.DataDir 'diagnostic-report.json'
    $failureCode='DIAG_REPORT_WRITE_FAILED'
    Write-Utf8Atomic $reportPath $text
    Write-Output $text
    Write-Output 'Report saved: data\diagnostic-report.json'
    Write-Output 'No model request or browser operation was performed.'
    if(-not $report.ok){exit 1}
} catch {
    # Native errors can contain a private command, path, or environment. Do not dump them.
    Write-Output ($failureCode + ': Could not complete diagnostics. No runtime was started or stopped.')
    exit 1
}
