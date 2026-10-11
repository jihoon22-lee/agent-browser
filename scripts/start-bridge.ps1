#requires -Version 5.1
param([string]$InstallDir = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'installer-common.ps1')
$root = Assert-InstallRoot $InstallDir
$state = Read-InstallState $root
if (-not $state) { throw 'AgentBrowser is not installed in this directory. Run setup.ps1 from the release package.' }
Start-OwnedBridge $state
