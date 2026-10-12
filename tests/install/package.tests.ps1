#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$BridgeExe, [string]$Scripts)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
if (-not $Scripts) { $Scripts=Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\..\scripts' }
. (Join-Path $Scripts 'installer-common.ps1')
$repo=[IO.Path]::GetFullPath((Join-Path $Scripts '..'))
$root=Join-Path ([IO.Path]::GetTempPath()) ('AgentBrowser-package-test-' + [guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $root
$done=$false
$activeInstalls=New-Object 'System.Collections.Generic.List[string]'
function Assert($Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action,[string]$Message) { $caught=$false; try { $null=& $Action } catch { $caught=$true }; Assert $caught $Message }
try {
    $out=Join-Path $root 'zip output'
    $first=& (Join-Path $Scripts 'build-release.ps1') -SkipBuild -BridgeExe $BridgeExe -OutDir $out
    $hash=$first.Sha256
    $second=& (Join-Path $Scripts 'build-release.ps1') -SkipBuild -BridgeExe $BridgeExe -OutDir $out
    Assert ($hash -eq $second.Sha256) 'Same release inputs produced different zip bytes'
    $archive=[IO.Compression.ZipFile]::OpenRead($second.Package)
    try {
        $names=@($archive.Entries | ForEach-Object { $_.FullName })
        foreach ($required in @('browser-bridge.exe','setup.ps1','uninstall.ps1','start-bridge.cmd','extension/manifest.json','README-install.md','CHANGELOG.md','LICENSE','SECURITY.md','docs/user-guide.md','docs/troubleshooting.md','THIRD_PARTY_NOTICES','third-party-inventory.json','package-manifest.json')) { Assert ($names -contains $required) ('Missing release file: ' + $required) }
        Assert (@($names | Where-Object { $_ -match '(?:node_modules|\.env|\.log$|(^|/)data/|tests/|status\.md|opencode\.json$)' }).Count -eq 0) 'Release contains development/runtime/private files'
    } finally { $archive.Dispose() }
    $extract=Join-Path $root ('extracted ' + [char]0xD55C + [char]0xAE00 + ' spaces'); [IO.Compression.ZipFile]::ExtractToDirectory($second.Package,$extract)
    $null=Read-VerifiedPackage $extract
    $inventory=Read-Utf8Text (Join-Path $extract 'third-party-inventory.json') | ConvertFrom-Json
    Assert (@($inventory.packages | Where-Object { $_.name -eq 'catppuccin/palette' -and $_.version -eq '1.8.0' -and $_.license -eq 'MIT' }).Count -eq 1) 'Vendored palette license/provenance missing from release inventory'
    Assert ((Read-Utf8Text (Join-Path $extract 'THIRD_PARTY_NOTICES')).Contains('catppuccin/palette 1.8.0')) 'Palette license text missing from release notices'
    foreach ($document in Get-ChildItem -LiteralPath $extract -Recurse -Filter '*.md') {
        foreach ($match in [regex]::Matches((Read-Utf8Text $document.FullName), '\]\(([^)]+)\)')) {
            $link=$match.Groups[1].Value
            if ($link -match '^(?:https?://|mailto:|#)') { continue }
            $relative=($link -split '#',2)[0]
            $target=[IO.Path]::GetFullPath((Join-Path $document.DirectoryName $relative))
            Assert ($target.StartsWith($extract + '\',[StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $target -PathType Leaf)) ('Broken packaged documentation link: ' + $document.Name + ' -> ' + $link)
        }
    }
    Assert ((Read-Utf8Text (Join-Path $out 'SHA256SUMS')).StartsWith($hash)) 'SHA256SUMS does not match zip'
    Write-Output 'PASS release allowlist, checksums, manifest and deterministic zip'
    $badExtension=Join-Path $root 'bad extension'; Copy-Item -LiteralPath (Join-Path $repo 'extension\dist') -Destination $badExtension -Recurse
    Write-Utf8Atomic (Join-Path $badExtension 'fixture-results.json') '{"synthetic":"must not ship"}'
    Assert-Throws { & (Join-Path $Scripts 'build-release.ps1') -SkipBuild -BridgeExe $BridgeExe -ExtensionDir $badExtension -OutDir (Join-Path $root 'bad-output') } 'Unexpected JSON artifact entered release'
    Assert-Throws { & (Join-Path $Scripts 'build-release.ps1') -SkipBuild -BridgeExe $BridgeExe -Version '99.99.99' -OutDir (Join-Path $root 'wrong-version') } 'Wrong executable version accepted'
    Write-Output 'PASS unexpected artifacts and mismatched version are rejected'
    # Exercise the documented native entry point: advanced-script defaults differ
    # under Windows PowerShell 5.1 -File, so direct & invocation is insufficient.
    $windowsPowerShell=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
    foreach ($explicitPackage in @($false,$true)) {
        $label=if ($explicitPackage) { 'explicit' } else { 'omitted' }
        $install=Join-Path $root ('installed ' + [char]0xD55C + [char]0xAE00 + ' ' + $label)
        $startup=Join-Path $root ('startup ' + $label)
        $activeInstalls.Add($install)
        $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
        $listener.Start(); $port=$listener.LocalEndpoint.Port; $listener.Stop()
        $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $extract 'setup.ps1'),'-InstallDir',$install,'-StartupDir',$startup,'-Port',[string]$port,'-Quiet')
        if ($explicitPackage) { $arguments+=@('-PackageDir',$extract) }
        $firstInstall=Invoke-NativeCapture $windowsPowerShell $arguments $extract @{} 60000 -ReturnResult
        Assert ($firstInstall.ExitCode -eq 0) ('Windows PowerShell -File setup failed with ' + $label + ' PackageDir: ' + $firstInstall.Stderr)
        $state=Read-InstallState $install
        Assert ($state.InstallDir -eq $install -and $state.Port -eq $port) 'Native setup did not use its isolated installation and port'
        Assert (Test-Path -LiteralPath (Join-Path $startup 'AgentBrowser.lnk')) 'Native setup did not create its isolated Startup shortcut'
        $running=Get-VerifiedBridgeProcess $state
        Assert ($null -ne $running) 'Native setup did not start its verified owned Bridge'
        $firstPid=$running.Marker.Pid
        $doctor=(Invoke-BridgeCapture $state @('doctor','--json')) | ConvertFrom-Json
        Assert (@($doctor.checks | Where-Object { $_.id -eq 'bridge' -and $_.status -eq 'ok' }).Count -eq 1) 'Packaged Bridge did not pass authenticated health'
        $repeated=Invoke-NativeCapture $windowsPowerShell $arguments $extract @{} 60000 -ReturnResult
        Assert ($repeated.ExitCode -eq 0) ('Native reinstall failed: ' + $repeated.Stderr)
        $again=Read-InstallState $install
        Assert ($again.InstallId -eq $state.InstallId -and (Get-VerifiedBridgeProcess $again).Marker.Pid -eq $firstPid) 'Native reinstall did not preserve identity and reuse its process'
        # The installed uninstaller is also an advanced script with a root default.
        $removeArguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $install 'uninstall.ps1'),'-RemoveData','-Quiet')
        if ($explicitPackage) { $removeArguments+=@('-InstallDir',$install) }
        $removed=Invoke-NativeCapture $windowsPowerShell $removeArguments $extract @{} 60000 -ReturnResult
        Assert ($removed.ExitCode -eq 0) ('Native uninstall failed: ' + $removed.Stderr)
        Assert (-not (Test-Path -LiteralPath (Join-Path $install '.agent-browser-install.json'))) 'Native uninstall left its install state'
        Assert (-not (Test-Path -LiteralPath (Join-Path $install 'data'))) 'Native uninstall left its explicitly removed test data'
        Assert (-not (Test-Path -LiteralPath (Join-Path $startup 'AgentBrowser.lnk'))) 'Native uninstall left its Startup shortcut'
        Assert (-not (Get-Process -Id $firstPid -ErrorAction SilentlyContinue)) 'Native uninstall left its owned process running'
        Write-Output ('PASS packaged Windows PowerShell 5.1 -File install, repeat, health and uninstall; ' + $label + ' path defaults')
    }
    $partialManifest=Read-Utf8Text (Join-Path $extract 'package-manifest.json') | ConvertFrom-Json
    $partialManifest.Files=@($partialManifest.Files | Where-Object { $_.Path -ne 'CHANGELOG.md' })
    Write-Utf8Atomic (Join-Path $extract 'package-manifest.json') (ConvertTo-Json $partialManifest -Depth 10)
    Assert-Throws { Read-VerifiedPackage $extract } 'A manifest missing required release documentation was accepted'
    Write-Output 'PASS missing required release documentation is rejected'
    $done=$true
} finally {
    foreach ($install in $activeInstalls) {
        try { $state=Read-InstallState $install; if ($state) { $null=Stop-OwnedBridge $state } }
        catch { Write-Warning ('Owned package-test cleanup needs inspection: ' + $install) }
    }
    if ($done) { Remove-Item -LiteralPath $root -Recurse -Force }
    else { Write-Output ('Package test artifacts: ' + $root) }
}
