#requires -Version 5.1
param([string]$InstallDir = $PSScriptRoot)
$ErrorActionPreference='Stop'

function ConvertTo-SafeDiagnostic($Doctor,[string]$Version) {
    $profiles=New-Object 'System.Collections.Generic.Dictionary[string,int]' ([StringComparer]::Ordinal)
    $checks=@()
    $reasons=@('query_timeout','query_authentication_failed','query_failed','invalid_response','registration_missing','connected','disabled','authentication_required','executable_missing','permission_denied','connection_timeout','connection_failed','unknown_status',
        'WSL_PROCESS_STILL_RUNNING','WSL_PROCESS_STOPPED_KEEPER_UNVERIFIED','WSL_PROBE_TIMEOUT','WSL_LAUNCH_UNAVAILABLE','WSL_START_PENDING','WSL_OWNER_FILE_MISSING','WSL_OWNER_FILE_UNREADABLE','WSL_OWNER_RECORD_INVALID','WSL_OWNER_NONCE_MISMATCH','WSL_KEEPER_UNVERIFIED','WSL_DIRECTORY_UNAVAILABLE','WSL_EXECUTABLE_UNAVAILABLE','WSL_DATA_ACCESS_DENIED','WSL_REQUIRED_TOOL_MISSING','WSL_PROC_ACCESS_DENIED','WSL_WINDOWS_EXECUTION_FAILED','WSL_INTEROP_REGISTRATION_UNAVAILABLE','WSL_PROCESS_OR_KEEPER_UNVERIFIED','WSL_PROBE_RECORD_UNAVAILABLE','WSL_CONTROL_FAILED','WSL_PREREQUISITES_AVAILABLE')
    foreach($check in $Doctor.checks) {
        $number=$null
        if($check.profileId) {
            $key=[string]$check.profileId
            if(-not $profiles.ContainsKey($key)){$profiles[$key]=$profiles.Count+1}
            $number=$profiles[$key]
        }
        $id=if($check.id -cin @('bridge','extension','wslPrerequisites','opencode','model','mcp','executable','runtime')){[string]$check.id}else{'unknown'}
        $status=if($check.status -cin @('ok','warning','error')){[string]$check.status}else{'unknown'}
        $item=[ordered]@{check=$id;profile=$number;status=$status}
        if($check.version -and ([string]$check.version).Length -lt 40 -and $check.version -match '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$'){$item.version=[string]$check.version}
        $reason=$check.reason; $code=$check.exitCode
        if($check.runtime.wslProbe){$reason=$check.runtime.wslProbe.reason;$code=$check.runtime.wslProbe.exitCode}
        if($reason){$item.reason=if($reason -cin $reasons){[string]$reason}else{'unknown'}}
        $parsed=0
        if($null -ne $code -and [int]::TryParse([string]$code,[ref]$parsed)){$item.exitCode=$parsed}
        $checks+=[pscustomobject]$item
    }
    $safeVersion=if($Version.Length -lt 40 -and $Version -match '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$'){$Version}else{'unknown'}
    [pscustomobject]@{schema=1;version=$safeVersion;ok=($Doctor.ok -eq $true);checks=$checks}
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
