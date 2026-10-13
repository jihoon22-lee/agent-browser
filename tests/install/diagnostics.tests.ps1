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

$fixture.checks += [pscustomobject]@{id='runtime';profileId=$private.ToUpperInvariant();status='error';reason=$private;exitCode=$private}
$result=ConvertTo-SafeDiagnostic $fixture $private
$text=$result|ConvertTo-Json -Depth 8
if($text.Contains($private)){throw 'Diagnostic report allowed arbitrary version, reason or exit-code text'}
if($result.checks[3].profile -eq $result.checks[0].profile){throw 'Case-distinct profile IDs were merged'}
Write-Output 'PASS report fields are constrained and case-distinct profiles stay distinct'

$fixture.checks += @(
    [pscustomobject]@{id='opencode';profileId=$private;status='warning';reason='PROFILE_OPERATION_IN_PROGRESS';message=$private},
    [pscustomobject]@{id='opencode';profileId=$private;status='warning';reason='arbitrary-unapproved-reason';message=$private}
)
$result=ConvertTo-SafeDiagnostic $fixture '0.0.0'
if($result.checks[4].reason -ne 'PROFILE_OPERATION_IN_PROGRESS'){throw 'Diagnostic report dropped the in-progress operation reason'}
if($result.checks[5].reason -ne 'unknown'){throw 'Diagnostic report kept an unapproved reason code'}
Write-Output 'PASS in-progress operation reason is retained while unapproved reasons stay unknown'
