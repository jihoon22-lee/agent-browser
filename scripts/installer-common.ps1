# Shared installer helpers. PowerShell 5.1 / .NET Framework only; no downloads.
$script:AgentBrowserProduct = 'agent-browser.user-install.v1'
$script:AgentBrowserStateName = '.agent-browser-install.json'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-TextHash([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($script:Utf8NoBom.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-FileSha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-FullPath([string]$Path) { return [IO.Path]::GetFullPath($Path).TrimEnd([char]'\', [char]'/') }
function Assert-PlainPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse points are not supported for installation: $current" }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
}
function Assert-InstallRoot([string]$Path) {
    $full = Get-FullPath $Path
    if (-not [IO.Path]::IsPathRooted($full) -or $full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw 'Choose a dedicated absolute installation directory, not a drive root.' }
    foreach ($protected in @([Environment]::GetFolderPath('UserProfile'), [Environment]::GetFolderPath('LocalApplicationData'), [Environment]::GetFolderPath('ApplicationData'), $env:SystemRoot)) {
        if ($protected -and $full -eq (Get-FullPath $protected)) { throw "Choose a dedicated installation subdirectory: $full" }
    }
    Assert-PlainPath $full
    return $full
}
function Join-SafePath([string]$Root, [string]$Relative) {
    if (-not $Relative -or [IO.Path]::IsPathRooted($Relative) -or $Relative -match '[:*?\r\n]' -or @($Relative -split '[/\\]' | Where-Object { $_ -eq '..' }).Count) { throw "Invalid package-relative path: $Relative" }
    $rootPath = Get-FullPath $Root
    $path = [IO.Path]::GetFullPath((Join-Path $rootPath $Relative))
    if (-not $path.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped the installation directory.' }
    Assert-PlainPath $path
    return $path
}
function Read-Utf8Text([string]$Path) { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) }
function Write-Utf8Atomic([string]$Path, [string]$Text) {
    $parent = [IO.Path]::GetDirectoryName($Path)
    if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent -Force }
    Assert-PlainPath $Path
    $temp = Join-Path $parent ('.agent-browser-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temp, $Text, $script:Utf8NoBom)
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temp, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temp, $Path) }
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}
function Read-InstallState([string]$Root) {
    $path = Join-Path $Root $script:AgentBrowserStateName
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    Assert-PlainPath $path
    $state = (Read-Utf8Text $path) | ConvertFrom-Json
    if ($state.Product -ne $script:AgentBrowserProduct -or (Get-FullPath $state.InstallDir) -ne (Get-FullPath $Root)) { throw 'Installation ownership marker does not match this directory.' }
    return $state
}

# JSONC token positions let us edit one property without serializing the user's
# models, credentials, comments, formatting, or other MCP definitions.
function Get-JsonTokens([string]$Text) {
    $items = New-Object 'System.Collections.Generic.List[object]'
    $i = 0
    while ($i -lt $Text.Length) {
        $ch = $Text[$i]
        if ([char]::IsWhiteSpace($ch) -or [int]$ch -eq 65279) { $i++; continue }
        if ($ch -eq '/' -and $i + 1 -lt $Text.Length) {
            if ($Text[$i + 1] -eq '/') { $i += 2; while ($i -lt $Text.Length -and $Text[$i] -ne "`n") { $i++ }; continue }
            if ($Text[$i + 1] -eq '*') {
                $end = $Text.IndexOf('*/', $i + 2, [StringComparison]::Ordinal)
                if ($end -lt 0) { throw 'Unterminated JSONC comment.' }; $i = $end + 2; continue
            }
        }
        $start = $i
        if ($ch -eq '"') {
            $i++; $closed = $false
            while ($i -lt $Text.Length) {
                if ($Text[$i] -eq '\') { $i += 2; continue }
                if ($Text[$i] -eq '"') { $i++; $closed = $true; break }
                $i++
            }
            if (-not $closed) { throw 'Unterminated JSON string.' }
            $raw = $Text.Substring($start, $i - $start)
            $value = ConvertFrom-Json $raw
            $items.Add([pscustomobject]@{ Kind='string'; Start=$start; End=$i; Text=$raw; Value=$value })
            continue
        }
        if ('{}[]:,'.Contains([string]$ch)) { $i++; $items.Add([pscustomobject]@{ Kind=[string]$ch; Start=$start; End=$i; Text=[string]$ch }); continue }
        $match = [regex]::Match($Text.Substring($i), '^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)')
        if (-not $match.Success) { throw "Invalid JSON token at offset $i" }
        $i += $match.Length
        $items.Add([pscustomobject]@{ Kind='scalar'; Start=$start; End=$i; Text=$match.Value })
    }
    return ,$items.ToArray()
}
function Get-JsonMinified([string]$Text) {
    $tokens = Get-JsonTokens $Text
    $parts = New-Object 'System.Collections.Generic.List[string]'
    for ($i=0; $i -lt $tokens.Count; $i++) {
        if ($tokens[$i].Kind -eq ',' -and $i + 1 -lt $tokens.Count -and $tokens[$i + 1].Kind -in @('}', ']')) { continue }
        $parts.Add($tokens[$i].Text)
    }
    $json = $parts -join ''
    $null = ConvertFrom-Json $json
    return $json
}
function Get-JsonValueLast($Tokens, [int]$Index) {
    if ($Tokens[$Index].Kind -notin @('{','[')) { return $Index }
    $depth = 0
    for ($i=$Index; $i -lt $Tokens.Count; $i++) {
        if ($Tokens[$i].Kind -in @('{','[')) { $depth++ }
        if ($Tokens[$i].Kind -in @('}',']')) { $depth--; if ($depth -eq 0) { return $i } }
    }
    throw 'Unclosed JSON value.'
}
function Get-JsonObjectProperties($Tokens, [int]$Index) {
    if ($Tokens[$Index].Kind -ne '{') { throw 'Expected a JSON object.' }
    $properties = New-Object 'System.Collections.Generic.List[object]'
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $i = $Index + 1; $previousComma = -1
    while ($i -lt $Tokens.Count -and $Tokens[$i].Kind -ne '}') {
        if ($Tokens[$i].Kind -ne 'string' -or $Tokens[$i + 1].Kind -ne ':') { throw 'Invalid JSON object property.' }
        $key = $Tokens[$i].Value
        if (-not $seen.Add($key)) { throw "Duplicate JSON property is ambiguous: $key" }
        $first = $i + 2; $last = Get-JsonValueLast $Tokens $first
        $comma = -1
        if ($Tokens[$last + 1].Kind -eq ',') { $comma = $last + 1 }
        $properties.Add([pscustomobject]@{ Name=$key; Key=$i; First=$first; Last=$last; BeforeComma=$previousComma; AfterComma=$comma })
        $i = $last + 1
        if ($comma -ge 0) { $previousComma = $comma; $i++ }
        elseif ($Tokens[$i].Kind -ne '}') { throw 'Missing JSON object comma.' }
    }
    return ,$properties.ToArray()
}
function Insert-JsonProperty([string]$Text, $Tokens, [int]$ObjectIndex, [string]$Name, [string]$Value) {
    $properties = Get-JsonObjectProperties $Tokens $ObjectIndex
    $last = Get-JsonValueLast $Tokens $ObjectIndex
    $prefix = ''
    if ($properties.Count -gt 0 -and $Tokens[$last - 1].Kind -ne ',') { $prefix = ',' }
    $newline = "`n"; if ($Text.Contains("`r`n")) { $newline = "`r`n" }
    $addition = $prefix + $newline + '  ' + (ConvertTo-Json $Name -Compress) + ': ' + $Value + $newline
    return $Text.Substring(0, $Tokens[$last].Start) + $addition + $Text.Substring($Tokens[$last].Start)
}
function Remove-JsonProperty([string]$Text, $Tokens, $Property) {
    $start = $Tokens[$Property.Key].Start; $end = $Tokens[$Property.Last].End
    if ($Property.AfterComma -ge 0) { $end = $Tokens[$Property.AfterComma].End }
    elseif ($Property.BeforeComma -ge 0) { $start = $Tokens[$Property.BeforeComma].Start }
    return $Text.Substring(0, $start) + $Text.Substring($end)
}
function Edit-BrowserMcp {
    param([string]$Text, $Entry, [string]$ExpectedEntryHash, [switch]$Remove, [switch]$RemoveEmptyMcp)
    $null = Get-JsonMinified $Text
    $tokens = Get-JsonTokens $Text
    if (-not $tokens.Count -or $tokens[0].Kind -ne '{') { throw 'OpenCode settings must be a JSON object.' }
    $root = Get-JsonObjectProperties $tokens 0
    $mcp = @($root | Where-Object { $_.Name -ceq 'mcp' })
    $browser = @(); $createdMcp = $false
    if ($mcp.Count) {
        if ($tokens[$mcp[0].First].Kind -ne '{') { throw 'OpenCode mcp must be an object.' }
        $entries = Get-JsonObjectProperties $tokens $mcp[0].First
        $browser = @($entries | Where-Object { $_.Name -ceq 'browser' })
    }
    if ($browser.Count) {
        $property = $browser[0]
        $oldValue = $Text.Substring($tokens[$property.First].Start, $tokens[$property.Last].End - $tokens[$property.First].Start)
        $oldHash = Get-TextHash (Get-JsonMinified $oldValue)
        if (-not $ExpectedEntryHash -or $oldHash -ne $ExpectedEntryHash) { throw 'The mcp.browser entry is not owned by this installation or was modified. It was not overwritten.' }
    } elseif ($ExpectedEntryHash -and -not $Remove) { throw 'The previously registered mcp.browser entry was removed. Refusing to recreate it without an explicit new registration.' }
    if ($Remove) {
        if (-not $browser.Count) { return [pscustomobject]@{ Text=$Text; Changed=$false; EntryHash=$null; CreatedMcp=$false } }
        if ($RemoveEmptyMcp -and $entries.Count -eq 1) { $edited = Remove-JsonProperty $Text $tokens $mcp[0] }
        else { $edited = Remove-JsonProperty $Text $tokens $browser[0] }
        $null = Get-JsonMinified $edited
        return [pscustomobject]@{ Text=$edited; Changed=($edited -ne $Text); EntryHash=$null; CreatedMcp=$false }
    }
    $value = ConvertTo-Json $Entry -Depth 30 -Compress
    if ($browser.Count) {
        if ((Get-TextHash (Get-JsonMinified $value)) -eq $oldHash) { $edited = $Text }
        else { $edited = $Text.Substring(0, $tokens[$property.First].Start) + $value + $Text.Substring($tokens[$property.Last].End) }
    } elseif ($mcp.Count) { $edited = Insert-JsonProperty $Text $tokens $mcp[0].First 'browser' $value }
    else { $edited = Insert-JsonProperty $Text $tokens 0 'mcp' ('{"browser":' + $value + '}'); $createdMcp = $true }
    $null = Get-JsonMinified $edited
    return [pscustomobject]@{ Text=$edited; Changed=($edited -ne $Text); EntryHash=(Get-TextHash (Get-JsonMinified $value)); CreatedMcp=$createdMcp }
}

function Read-VerifiedPackage([string]$Root) {
    $Root = Get-FullPath $Root
    Assert-PlainPath $Root
    $manifestPath = Join-Path $Root 'package-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'package-manifest.json is missing. Extract the complete release zip before running setup.' }
    $manifest = (Read-Utf8Text $manifestPath) | ConvertFrom-Json
    if ($manifest.Product -ne 'agent-browser' -or $manifest.Platform -ne 'windows-x64' -or $manifest.Version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'Invalid AgentBrowser Windows x64 package manifest.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $manifest.Files) {
        if (-not $seen.Add($entry.Path) -or $entry.Sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid or duplicate package file entry.' }
        $path = Join-SafePath $Root $entry.Path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Package file missing: $($entry.Path)" }
        if ((Get-FileSha256 $path) -ne $entry.Sha256.ToLowerInvariant()) { throw "Package checksum mismatch: $($entry.Path)" }
    }
    foreach ($required in @('browser-bridge.exe','extension/manifest.json','setup.ps1','uninstall.ps1','installer-common.ps1','start-bridge.ps1','start-bridge.cmd','show-pairing.ps1','README-install.md','THIRD_PARTY_NOTICES')) {
        if (-not $seen.Contains($required)) { throw "Package manifest must include $required" }
    }
    $bytes = [IO.File]::ReadAllBytes((Join-Path $Root 'browser-bridge.exe'))
    if ($bytes.Length -lt 128 -or $bytes[0] -ne 77 -or $bytes[1] -ne 90) { throw 'The package does not contain a Windows executable.' }
    $pe = [BitConverter]::ToInt32($bytes, 60)
    if ($pe -lt 0 -or $pe + 6 -ge $bytes.Length -or [BitConverter]::ToUInt32($bytes, $pe) -ne 17744 -or [BitConverter]::ToUInt16($bytes, $pe + 4) -ne 34404) { throw 'The Bridge executable is not Windows x64.' }
    $extension = (Read-Utf8Text (Join-Path $Root 'extension\manifest.json')) | ConvertFrom-Json
    if ($extension.manifest_version -ne 3 -or -not $extension.key) { throw 'A keyed Manifest V3 extension is required.' }
    return $manifest
}
function Assert-OwnedFiles([string]$Root, $State) {
    if (-not $State) { return }
    foreach ($file in $State.OwnedFiles) {
        $path = Join-SafePath $Root $file.Path
        if ((Test-Path -LiteralPath $path) -and ((-not (Test-Path -LiteralPath $path -PathType Leaf)) -or (Get-FileSha256 $path) -ne $file.Sha256)) { throw "An installed file was modified and will not be overwritten or deleted: $path" }
    }
}
function New-FileTransaction([string]$Root) {
    $stage = Join-Path $Root ('.transaction-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $stage
    return [pscustomobject]@{ Stage=$stage; Journal=(New-Object 'System.Collections.Generic.List[object]'); Seen=([Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)) }
}
function Save-TransactionFile($Transaction, [string]$Path) {
    Assert-PlainPath $Path
    if (-not $Transaction.Seen.Add($Path)) { return }
    $exists = Test-Path -LiteralPath $Path
    $backup = Join-Path $Transaction.Stage ([guid]::NewGuid().ToString('N') + '.backup')
    if ($exists) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "A directory blocks this file path: $Path" }
        [IO.File]::Copy($Path, $backup, $false)
    }
    $Transaction.Journal.Add([pscustomobject]@{ Path=$Path; Existed=$exists; Backup=$backup })
}
function Set-TransactionText($Transaction, [string]$Path, [string]$Text) { Save-TransactionFile $Transaction $Path; Write-Utf8Atomic $Path $Text }
function Copy-TransactionFile($Transaction, [string]$Source, [string]$Destination) {
    Save-TransactionFile $Transaction $Destination
    $parent = [IO.Path]::GetDirectoryName($Destination)
    if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent -Force }
    [IO.File]::Copy($Source, $Destination, $true)
}
function Remove-TransactionFile($Transaction, [string]$Path) {
    Save-TransactionFile $Transaction $Path
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
}
function Undo-FileTransaction($Transaction) {
    for ($i=$Transaction.Journal.Count-1; $i -ge 0; $i--) {
        $entry = $Transaction.Journal[$i]
        if ($entry.Existed) {
            $parent = [IO.Path]::GetDirectoryName($entry.Path)
            if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent -Force }
            [IO.File]::Copy($entry.Backup, $entry.Path, $true)
        } elseif (Test-Path -LiteralPath $entry.Path) { Remove-Item -LiteralPath $entry.Path -Force }
    }
}
function Set-PrivateDataDirectory([string]$Path, [string]$InstallId) {
    Assert-PlainPath $Path
    $ownerPath = Join-Path $Path '.agent-browser-data-owner.json'
    if (Test-Path -LiteralPath $Path) {
        if (Test-Path -LiteralPath $ownerPath) {
            $owner = (Read-Utf8Text $ownerPath) | ConvertFrom-Json
            if ($owner.Product -ne $script:AgentBrowserProduct -or $owner.InstallId -ne $InstallId) { throw 'Bridge data belongs to a different installation.' }
        } elseif (@(Get-ChildItem -LiteralPath $Path -Force).Count -gt 0) { throw 'Existing unowned data directory will not be changed.' }
    } else { $null = New-Item -ItemType Directory -Path $Path -Force }
    # The directory is now verified as empty or owned; protect credentials even
    # when the caller pre-created an empty data directory.
    $acl = [IO.Directory]::GetAccessControl($Path, [Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { $null = $acl.RemoveAccessRuleAll($existingRule) }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($identity in @($sid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    # Change only the DACL, preserving ownership and audit policy. Set-Acl on a
    # fresh descriptor may request SeSecurityPrivilege on repeated installation.
    [IO.Directory]::SetAccessControl($Path, $acl)
    if (-not (Test-Path -LiteralPath $ownerPath)) { Write-Utf8Atomic $ownerPath (ConvertTo-Json @{ Product=$script:AgentBrowserProduct; InstallId=$InstallId }) }
}
function Get-BridgeProcessMarker([string]$DataHome) {
    $path = Join-Path $DataHome '.installer-bridge-process.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    Assert-PlainPath $path
    return ((Read-Utf8Text $path) | ConvertFrom-Json)
}
function Get-VerifiedBridgeProcess($State) {
    $marker = Get-BridgeProcessMarker $State.DataDir
    if (-not $marker) { return $null }
    if ($marker.Product -ne $script:AgentBrowserProduct -or $marker.InstallId -ne $State.InstallId -or $marker.Pid -le 0) { throw 'Bridge process ownership marker is invalid.' }
    $expectedExe = Get-FullPath $marker.Executable
    $known = @($State.OwnedFiles | Where-Object { (Get-FullPath (Join-SafePath $State.InstallDir $_.Path)) -eq $expectedExe })
    if ($known.Count -ne 1) { throw 'Bridge process executable is not owned by this installation.' }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$marker.Pid)
    if (-not $process) { return $null }
    $created = $process.CreationDate.ToUniversalTime().ToString('o')
    $role = '(?:^|\s)serve\s+--port\s+' + [regex]::Escape([string]$marker.Port) + '(?:\s|$)'
    if ((Get-FullPath $process.ExecutablePath) -ne $expectedExe -or $process.CommandLine -notmatch $role -or $created -ne $marker.CreatedAt) { throw 'Recorded PID identity changed; no process was terminated.' }
    return [pscustomobject]@{ Process=$process; Marker=$marker }
}
function Stop-OwnedBridge($State) {
    $verified = Get-VerifiedBridgeProcess $State
    if (-not $verified) { return $false }
    # Re-read identity immediately before acting; never kill by image name.
    $again = Get-VerifiedBridgeProcess $State
    if (-not $again) { return $false }
    Stop-Process -Id ([int]$again.Marker.Pid) -Force -ErrorAction Stop
    for ($i=0; $i -lt 50; $i++) {
        if (-not (Get-Process -Id ([int]$again.Marker.Pid) -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 100
    }
    throw 'The owned Bridge did not stop within five seconds.'
}
function New-StartupShortcut([string]$Path, [string]$InstallDir) {
    Assert-PlainPath $Path
    $parent = [IO.Path]::GetDirectoryName($Path)
    if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent -Force }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $null
    try {
        $shortcut = $shell.CreateShortcut($Path)
        $shortcut.TargetPath = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
        $shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $InstallDir 'start-bridge.ps1') + '"'
        $shortcut.WorkingDirectory = $InstallDir
        $shortcut.Description = 'AgentBrowser user-session Browser Bridge'
        $shortcut.WindowStyle = 7
        $shortcut.Save()
    } finally {
        if ($shortcut) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }
}
function Get-WslPath([string]$Path, [string]$Distribution) {
    if (-not $Distribution) { throw 'Specify -Distribution when generating a WSL MCP fragment.' }
    $wsl = Join-Path ([Environment]::GetFolderPath('System')) 'wsl.exe'
    $result = Invoke-NativeCapture $wsl @('--distribution',$Distribution,'--exec','wslpath','-u',$Path) ([IO.Path]::GetTempPath()) @{} 15000
    if (-not $result -or -not ([string]$result).StartsWith('/')) { throw 'Could not convert the installed executable path through the selected WSL distribution.' }
    return ([string]$result).Trim()
}
function New-BrowserMcpEntry($State, [string]$Kind='windows', [string]$Distribution) {
    $executable = $State.CurrentExe
    $environment = [ordered]@{ AGENT_BROWSER_HOME=$State.DataDir; AGENT_BROWSER_PORT=[string]$State.Port }
    if ($Kind -eq 'wsl') { $executable = Get-WslPath $executable $Distribution; $environment.WSLENV='AGENT_BROWSER_HOME/w:AGENT_BROWSER_PORT/w' }
    return [ordered]@{ type='local'; command=@($executable, 'mcp'); enabled=$true; environment=$environment }
}
function Quote-NativeArgument([string]$Value) {
    # Win32 argv quoting, including trailing backslashes. No cmd.exe evaluation.
    # wsl.exe recognizes its own switches before CRT-style quote removal.
    if ($Value -and $Value -notmatch '[\s"]') { return $Value }
    return '"' + ([regex]::Replace($Value, '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}
function Invoke-NativeCapture([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [hashtable]$Environment=@{}, [int]$TimeoutMs=20000, [switch]$ReturnResult) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = (@($Arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' ')
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.RedirectStandardInput = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8; $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($key in $Environment.Keys) { $info.EnvironmentVariables[$key] = [string]$Environment[$key] }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        $null = $process.Start(); $process.StandardInput.Close()
        $output = $process.StandardOutput.ReadToEndAsync(); $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) { $process.Kill(); throw 'The command timed out.' }
        $stdout = $output.GetAwaiter().GetResult(); $stderr = $errors.GetAwaiter().GetResult()
        if ($ReturnResult) { return [pscustomobject]@{ ExitCode=$process.ExitCode; Stdout=$stdout.Trim(); Stderr=$stderr.Trim() } }
        if ($process.ExitCode -ne 0) { throw ('Command failed: ' + $stderr.Trim()) }
        return $stdout.Trim()
    } finally { $process.Dispose() }
}
function Invoke-BridgeCapture($State, [string[]]$Arguments, [int]$TimeoutMs=20000, [switch]$ReturnResult) {
    return Invoke-NativeCapture $State.CurrentExe $Arguments $State.InstallDir @{ AGENT_BROWSER_HOME=$State.DataDir; AGENT_BROWSER_PORT=[string]$State.Port } $TimeoutMs -ReturnResult:$ReturnResult
}
function Start-OwnedBridge($State) {
    $existing = Get-VerifiedBridgeProcess $State
    if ($existing -and (Get-FullPath $existing.Marker.Executable) -eq (Get-FullPath $State.CurrentExe) -and [int]$existing.Marker.Port -eq [int]$State.Port) {
        return [pscustomobject]@{ running=$true; pid=[int]$existing.Marker.Pid; port=[int]$State.Port; reused=$true }
    }
    if ($existing) { $null = Stop-OwnedBridge $State }
    $expectedExe = Get-FullPath $State.CurrentExe
    $owned = @($State.OwnedFiles | Where-Object { (Get-FullPath (Join-SafePath $State.InstallDir $_.Path)) -eq $expectedExe })
    if ($owned.Count -ne 1 -or (Get-FileSha256 $expectedExe) -ne $owned[0].Sha256) { throw 'The current Bridge executable does not match the installed package.' }
    $started = (Invoke-BridgeCapture $State @('start','--port',[string]$State.Port)) | ConvertFrom-Json
    if ($started.running -ne $true -or [int]$started.port -ne [int]$State.Port -or (Get-FullPath $started.home) -ne (Get-FullPath $State.DataDir) -or [int]$started.pid -le 0) { throw 'Bridge start did not confirm the requested home and port.' }
    $pidFile = Join-Path $State.DataDir 'serve.pid'
    if (-not (Test-Path -LiteralPath $pidFile) -or [int](Read-Utf8Text $pidFile).Trim() -ne [int]$started.pid) { throw 'Bridge startup PID does not match serve.pid.' }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$started.pid)
    $role = '(?:^|\s)serve\s+--port\s+' + [regex]::Escape([string]$State.Port) + '(?:\s|$)'
    if (-not $process -or (Get-FullPath $process.ExecutablePath) -ne $expectedExe -or $process.CommandLine -notmatch $role) { throw 'Started Bridge process identity could not be verified.' }
    $marker = [ordered]@{ Product=$script:AgentBrowserProduct; InstallId=$State.InstallId; Pid=[int]$started.pid; Executable=$expectedExe; Port=[int]$State.Port; CreatedAt=$process.CreationDate.ToUniversalTime().ToString('o') }
    Write-Utf8Atomic (Join-Path $State.DataDir '.installer-bridge-process.json') (ConvertTo-Json $marker -Depth 5)
    return [pscustomobject]@{ running=$true; pid=[int]$started.pid; port=[int]$State.Port; reused=$false }
}
