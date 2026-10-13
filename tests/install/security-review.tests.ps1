#requires -Version 5.1
param([string]$Scripts = (Join-Path $PSScriptRoot '..\..\scripts'))
$ErrorActionPreference='Stop'
. (Join-Path $Scripts 'installer-common.ps1')
$root=Join-Path ([IO.Path]::GetTempPath()) ('AgentBrowser-security-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $root
$failures=@()
function Reject([string]$Name,[scriptblock]$Action) {
    $rejected=$false
    try { $null=& $Action } catch { $rejected=$true }
    if(-not $rejected){$script:failures+=$Name}
}
try {
    $install=Join-Path $root 'install'
    $null=New-Item -ItemType Directory -Path $install
    $null=Assert-InstallRoot $install # Positive control: failures below must be caused by the fixture mutation.
    $original=[IO.Directory]::GetAccessControl($install)
    $acl=[IO.Directory]::GetAccessControl($install)
    $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow')))
    [IO.Directory]::SetAccessControl($install,$acl)
    Reject 'shared install directory was accepted' {Assert-InstallRoot $install}
    Reject 'replaceable ancestor was accepted' {Assert-InstallRoot (Join-Path $install 'nested')}
    [IO.Directory]::SetAccessControl($install,$original)
    $state=@{Product=$script:AgentBrowserProduct;SchemaVersion=1;InstallDir=$install;InstallId=('a'*32);DataDir=$root;OwnedFiles=@();CurrentExe=(Join-Path $install 'bridge.exe')}
    Write-Utf8Atomic (Join-Path $install $script:AgentBrowserStateName) ($state|ConvertTo-Json)
    Reject 'installation data path escaped the root' {Read-InstallState $install}
    $state.DataDir=Join-Path $install 'data';$state.InstallId='not-an-install-id'
    Write-Utf8Atomic (Join-Path $install $script:AgentBrowserStateName) ($state|ConvertTo-Json)
    Reject 'malformed installation identity was accepted' {Read-InstallState $install}
    if($failures.Count){throw ($failures -join '; ')}
    Write-Output 'PASS script rejects writable roots, replaceable ancestors and untrusted state paths/identity'
} finally {Remove-Item -LiteralPath $root -Recurse -Force}
