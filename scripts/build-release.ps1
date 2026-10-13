#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Version,
    [string]$BridgeExe,
    [string]$ExtensionDir,
    [string]$NoticesDir,
    [string]$OutDir,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'installer-common.ps1')
if (-not $Version) {
    $cargo = Read-Utf8Text (Join-Path $repo 'Cargo.toml')
    $match = [regex]::Match($cargo, '(?m)^version\s*=\s*"([^"]+)"')
    if (-not $match.Success) { throw 'Workspace version was not found.' }; $Version=$match.Groups[1].Value
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'Invalid release version.' }
if (-not $BridgeExe) { $BridgeExe=Join-Path $repo 'target\x86_64-pc-windows-msvc\release\browser-bridge.exe' }
if (-not $ExtensionDir) { $ExtensionDir=Join-Path $repo 'extension\dist' }
if (-not $NoticesDir) { $NoticesDir=Join-Path $repo 'release\notices' }
if (-not $OutDir) { $OutDir=Join-Path $repo 'release' }
if (-not $SkipBuild) {
    Push-Location $repo
    try {
        & cargo build --locked --release --target x86_64-pc-windows-msvc -p agent-browser-bridge
        if ($LASTEXITCODE -ne 0) { throw 'Windows Bridge build failed.' }
        & pnpm --filter agent-browser-extension build
        if ($LASTEXITCODE -ne 0) { throw 'Extension build failed.' }
        & node (Join-Path $PSScriptRoot 'generate-third-party-notices.mjs') $NoticesDir
        if ($LASTEXITCODE -ne 0) { throw 'Third-party notice generation failed.' }
    } finally { Pop-Location }
}
foreach ($path in @($BridgeExe, (Join-Path $ExtensionDir 'manifest.json'), (Join-Path $NoticesDir 'THIRD_PARTY_NOTICES'), (Join-Path $NoticesDir 'third-party-inventory.json'))) {
    Assert-PlainPath $path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required release input missing: $path" }
}
$binaryVersion = & $BridgeExe --version
if ($LASTEXITCODE -ne 0 -or ([string]$binaryVersion).Trim() -ne ('browser-bridge ' + $Version)) { throw 'Executable version does not match the requested release.' }
$inventory = (Read-Utf8Text (Join-Path $NoticesDir 'third-party-inventory.json')) | ConvertFrom-Json
if ($inventory.cargoLockSha256 -ne (Get-FileSha256 (Join-Path $repo 'Cargo.lock')) -or $inventory.pnpmLockSha256 -ne (Get-FileSha256 (Join-Path $repo 'pnpm-lock.yaml')) -or $inventory.extensionPackageSha256 -ne (Get-FileSha256 (Join-Path $repo 'extension\package.json')) -or $inventory.assetsManifestSha256 -ne (Get-FileSha256 (Join-Path $repo 'scripts\licenses\assets.json'))) { throw 'Third-party inventory is stale. Regenerate it from the current locked dependencies and assets.' }
Assert-PlainPath $OutDir
if (-not (Test-Path -LiteralPath $OutDir)) { $null=New-Item -ItemType Directory -Path $OutDir -Force }
$stage=Join-Path $OutDir ('.package-' + [guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $stage
$zipPath=Join-Path $OutDir ('agent-browser-' + $Version + '-windows-x64.zip')
$tempZip=$zipPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
try {
    Copy-Item -LiteralPath $BridgeExe -Destination (Join-Path $stage 'browser-bridge.exe')
    $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { throw 'The built-in .NET Framework compiler is unavailable; no dependency was installed.' }
    $sources=@('NativeIO.cs','Discovery.cs','Jsonc.cs','InstallerEngine.cs','ProfileForm.cs','SetupForm.cs') | ForEach-Object { Join-Path $repo ('installer\' + $_) }
    $guiCache=Join-Path $repo 'target\installer'; $null=New-Item -ItemType Directory -Path $guiCache -Force
    $guiExe=Join-Path $guiCache 'AgentBrowser-Setup.exe'; $guiStamp=Join-Path $guiCache 'build-powershell.json'
    $sourceHash=Get-TextHash ((@((Get-FileSha256 $compiler)) + @($sources | ForEach-Object { Get-FileSha256 $_ })) -join [Environment]::NewLine)
    $previous=$null; if (Test-Path -LiteralPath $guiStamp) { $previous=(Read-Utf8Text $guiStamp) | ConvertFrom-Json }
    if (-not (Test-Path -LiteralPath $guiExe) -or -not $previous -or $previous.Source -ne $sourceHash -or $previous.Binary -ne (Get-FileSha256 $guiExe)) {
        & $compiler /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ ('/out:' + $guiExe) /r:System.Web.Extensions.dll /r:System.Core.dll /r:System.Management.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll @sources
        if ($LASTEXITCODE -ne 0) { throw 'Native GUI installer build failed.' }
        Write-Utf8Atomic $guiStamp (ConvertTo-Json @{ Source=$sourceHash; Binary=(Get-FileSha256 $guiExe) })
    }
    Copy-Item -LiteralPath $guiExe -Destination (Join-Path $stage 'AgentBrowser-Setup.exe')

    $extensionRoot=Get-FullPath $ExtensionDir
    $queue=New-Object 'System.Collections.Generic.Queue[string]'; $queue.Enqueue($extensionRoot)
    while ($queue.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $queue.Dequeue() -Force) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Extension build contains a reparse point.' }
            if ($item.PSIsContainer) { if ($item.Name -eq 'node_modules') { throw 'node_modules must not be packaged.' }; $queue.Enqueue($item.FullName); continue }
            if ($item.Extension -notin @('.js','.css','.html','.json','.png','.svg','.webp','.woff','.woff2','.ico')) { throw "Unexpected extension build artifact: $($item.Name)" }
            $relative=$item.FullName.Substring($extensionRoot.Length+1)
            $forward=$relative.Replace('\','/')
            if ($forward -notmatch '^(?:manifest\.json|(?:background|content|options|sidepanel)\.js|src/(?:options|sidepanel)/index\.html|(?:assets|chunks)/[^\r\n]+)$') { throw ('Unrecognized extension output path: ' + $forward) }
            if ($item.Extension -eq '.json' -and $forward -ne 'manifest.json') { throw 'Only the extension manifest may be packaged as JSON.' }
            $destination=Join-SafePath $stage ('extension/' + $relative.Replace('\','/'))
            $parent=[IO.Path]::GetDirectoryName($destination); if (-not (Test-Path -LiteralPath $parent)) { $null=New-Item -ItemType Directory -Path $parent -Force }
            Copy-Item -LiteralPath $item.FullName -Destination $destination
        }
    }
    foreach ($name in @('setup.ps1','uninstall.ps1','installer-common.ps1','start-bridge.ps1','start-bridge.cmd','show-pairing.ps1','diagnose.ps1','diagnose.cmd')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $stage $name) }
    foreach ($name in @('README-install.md','CHANGELOG.md','LICENSE','SECURITY.md','docs/user-guide.md','docs/troubleshooting.md','docs/browser-capabilities.md')) {
        $source=Join-SafePath $repo $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('Required release documentation missing: ' + $name) }
        $destination=Join-SafePath $stage $name
        $parent=[IO.Path]::GetDirectoryName($destination)
        if (-not (Test-Path -LiteralPath $parent)) { $null=New-Item -ItemType Directory -Path $parent -Force }
        Copy-Item -LiteralPath $source -Destination $destination
    }
    foreach ($name in @('THIRD_PARTY_NOTICES','third-party-inventory.json')) { Copy-Item -LiteralPath (Join-Path $NoticesDir $name) -Destination (Join-Path $stage $name) }
    $null=New-Item -ItemType Directory -Path (Join-Path $stage 'examples')
    foreach ($name in @('profile-windows.json.template','profile-wsl.json.template','mcp-windows.json.template','mcp-wsl.json.template')) { Copy-Item -LiteralPath (Join-Path $repo ('examples\' + $name)) -Destination (Join-Path $stage ('examples\' + $name)) }
    $files=@(Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object { [pscustomobject]@{ Path=$_.FullName.Substring($stage.Length+1).Replace('\','/'); Sha256=(Get-FileSha256 $_.FullName) } })
    Write-Utf8Atomic (Join-Path $stage 'package-manifest.json') (ConvertTo-Json ([ordered]@{ Product='agent-browser'; Version=$Version; Platform='windows-x64'; Files=$files }) -Depth 10)
    $null=Read-VerifiedPackage $stage
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream=[IO.File]::Open($tempZip,[IO.FileMode]::CreateNew)
    $archive=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName) {
            $entry=$archive.CreateEntry($file.FullName.Substring($stage.Length+1).Replace('\','/'),[IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime=[DateTimeOffset]::new(2000,1,1,0,0,0,[TimeSpan]::Zero)
            $inputStream=[IO.File]::OpenRead($file.FullName); $entryStream=$entry.Open()
            try { $inputStream.CopyTo($entryStream) } finally { $inputStream.Dispose(); $entryStream.Dispose() }
        }
    } finally { $archive.Dispose(); $stream.Dispose() }
    if (Test-Path -LiteralPath $zipPath) { [IO.File]::Replace($tempZip,$zipPath,[NullString]::Value) } else { [IO.File]::Move($tempZip,$zipPath) }
    $sum=(Get-FileSha256 $zipPath) + '  ' + [IO.Path]::GetFileName($zipPath) + "`n"
    Write-Utf8Atomic (Join-Path $OutDir 'SHA256SUMS') $sum
    [pscustomobject]@{ Package=$zipPath; Sha256=(Get-FileSha256 $zipPath); Files=($files.Count+1); ThirdPartyPackages=@($inventory.packages).Count }
} finally {
    if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip -Force }
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
