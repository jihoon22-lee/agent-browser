#requires -Version 5.1
param([string]$Scripts = (Join-Path $PSScriptRoot '..\..\scripts'))
$ErrorActionPreference='Stop'
. (Join-Path $Scripts 'diagnose.ps1')
$private='fixture-secret-must-not-appear'
$fixture=[pscustomobject]@{ok=$false;checks=@(
    [pscustomobject]@{id='runtime';profileId=$private;status='error';message=$private;runtime=[pscustomobject]@{directory=$private;password=$private;wslProbe=[pscustomobject]@{reason='WSL_OWNER_FILE_MISSING';exitCode=21}}},
    [pscustomobject]@{id='mcp';profileId=$private;status='warning';reason='connection_failed';message=$private},
    [pscustomobject]@{id='executable';profileId=$private;status='ok';version='1.18.29';message=$private}
)}
$result=ConvertTo-SafeDiagnostic $fixture '0.0.0'
$text=$result | ConvertTo-Json -Depth 8
if($text.Contains($private)){throw 'Diagnostic report leaked unapproved fields'}
if($result.checks[0].reason -ne 'WSL_OWNER_FILE_MISSING' -or $result.checks[0].exitCode -ne 21){throw 'Diagnostic report lost the actionable WSL reason'}
if($result.checks[0].profile -ne 1 -or $result.checks[1].profile -ne 1){throw 'Profile numbering was inconsistent'}
if($result.checks[2].version -ne '1.18.29'){throw 'Diagnostic report lost the verified executable version'}
Write-Output 'PASS safe diagnostic report retains reason codes without credentials, paths, names or raw errors'
