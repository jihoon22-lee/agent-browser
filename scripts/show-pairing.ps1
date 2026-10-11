#requires -Version 5.1
param([string]$InstallDir = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'installer-common.ps1')
$state = Read-InstallState (Assert-InstallRoot $InstallDir)
if (-not $state) { throw 'Run setup.ps1 first.' }
# Explicit local user request only. The token is never included in release files.
Invoke-BridgeCapture $state @('pair')
Write-Host ('Bridge URL: ws://127.0.0.1:' + $state.Port + '/extension')
Write-Host 'Paste this token into the AgentBrowser extension Options page on this Windows account.'
