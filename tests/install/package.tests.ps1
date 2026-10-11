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
    $extract=Join-Path $root 'extracted'; [IO.Compression.ZipFile]::ExtractToDirectory($second.Package,$extract)
    $null=Read-VerifiedPackage $extract
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
    $partialManifest=Read-Utf8Text (Join-Path $extract 'package-manifest.json') | ConvertFrom-Json
    $partialManifest.Files=@($partialManifest.Files | Where-Object { $_.Path -ne 'CHANGELOG.md' })
    Write-Utf8Atomic (Join-Path $extract 'package-manifest.json') (ConvertTo-Json $partialManifest -Depth 10)
    Assert-Throws { Read-VerifiedPackage $extract } 'A manifest missing required release documentation was accepted'
    Write-Output 'PASS missing required release documentation is rejected'
    $done=$true
} finally {
    if ($done) { Remove-Item -LiteralPath $root -Recurse -Force }
    else { Write-Output ('Package test artifacts: ' + $root) }
}
