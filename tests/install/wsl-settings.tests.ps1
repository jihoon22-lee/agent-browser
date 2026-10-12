#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$Scripts,[Parameter(Mandatory=$true)][string]$WslDistribution)
$ErrorActionPreference='Stop'
. (Join-Path $Scripts 'installer-common.ps1')
function Assert($Condition,[string]$Message){if(-not $Condition){throw $Message}}
$wsl=Join-Path ([Environment]::GetFolderPath('System')) 'wsl.exe'
$linux=(Invoke-NativeCapture $wsl @('-d',$WslDistribution,'--exec','mktemp','-d','/tmp/agent-browser-installer-wsl-XXXXXX') ([IO.Path]::GetTempPath())).Trim()
if($linux -notmatch '^/tmp/agent-browser-installer-wsl-[A-Za-z0-9]+$'){throw 'Unexpected isolated WSL root'}
$unc='\\wsl.localhost\'+$WslDistribution+$linux.Replace('/','\')
$name='config '+[char]0xD55C+[char]0xAE00+'.jsonc'
$path=Join-Path $unc $name;$linuxPath=$linux+'/'+$name
$entry=[ordered]@{type='local';command=@('/mnt/c/example space/browser-bridge.exe','mcp');enabled=$true;environment=@{AGENT_BROWSER_HOME='C:\example space\data'}}
$original="{`n // keep comment`n `"model`":`"keep/model`",`n `"mcp`": { `"other`": {`"enabled`":false}, },`n}`n"
try{
 [IO.File]::WriteAllText($path,$original,$script:Utf8NoBom)
 $null=Invoke-NativeCapture $wsl @('-d',$WslDistribution,'--exec','chmod','600','--',$linuxPath) ([IO.Path]::GetTempPath())
 $identity=Invoke-NativeCapture $wsl @('-d',$WslDistribution,'--exec','stat','-c','%u:%g:%a','--',$linuxPath) ([IO.Path]::GetTempPath())
 $edit=Edit-BrowserMcp -Text $original -Entry $entry
 Write-Utf8Atomic $path $edit.Text
 Assert ((Read-Utf8Text $path) -eq $edit.Text) 'Existing WSL JSONC was not atomically updated'
 Assert ((Invoke-NativeCapture $wsl @('-d',$WslDistribution,'--exec','stat','-c','%u:%g:%a','--',$linuxPath) ([IO.Path]::GetTempPath())) -eq $identity) 'WSL owner/group/mode changed'
 Assert ((Read-Utf8Text $path).Contains('// keep comment')) 'JSONC comment changed'
 Write-Output 'PASS existing WSL JSONC, Unicode path, owner/group and 0600 permissions'
 $hash=Get-FileSha256 $path;$caught=$false
 try{Write-Utf8Atomic $path '{}' ('0'*64)}catch{$caught=$true}
 Assert $caught 'Concurrent settings conflict was not rejected'
 Assert ((Get-FileSha256 $path) -eq $hash) 'Conflict changed original WSL settings'
 Write-Output 'PASS WSL concurrent-change conflict preserves settings'
 $remove=Edit-BrowserMcp -Text (Read-Utf8Text $path) -Remove -ExpectedEntryHash $edit.EntryHash
 Write-Utf8Atomic $path $remove.Text $hash
 $value=Get-JsonMinified (Read-Utf8Text $path) | ConvertFrom-Json
 Assert ($null -eq $value.mcp.browser -and $value.mcp.other.enabled -eq $false -and $value.model -eq 'keep/model') 'Owned removal changed other settings'
 Write-Output 'PASS owned MCP removal preserves model, comments and other MCP'
 $new=Join-Path $unc 'new.jsonc';Write-Utf8Atomic $new '{}' 'missing'
 Assert ((Read-Utf8Text $new) -eq '{}') 'New WSL file was not published'
 Write-Output 'PASS new WSL configuration file'
}finally{
 foreach($leaf in @($path,(Join-Path $unc 'new.jsonc'))){if(Test-Path -LiteralPath $leaf){Remove-Item -LiteralPath $leaf -Force}}
 $null=Invoke-NativeCapture $wsl @('-d',$WslDistribution,'--exec','rmdir','--',$linux) ([IO.Path]::GetTempPath())
}
