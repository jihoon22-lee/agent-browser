param([string]$Scripts = (Join-Path $PSScriptRoot '..\..\scripts'))
$ErrorActionPreference = 'Stop'
. (Join-Path $Scripts 'installer-common.ps1')
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Message) { $failed = $false; try { & $Action } catch { $failed = $true }; Assert $failed $Message }
$entry = [ordered]@{ type='local'; command=@('C:\Agent Browser\app\browser-bridge.exe','mcp'); enabled=$true; environment=@{ AGENT_BROWSER_HOME='C:\Agent Browser\data' } }
$text = '{ // keep this comment' + "`r`n" + '  "model":"corp/model", "provider":{"corp":{"options":{"baseURL":"https://example.test/a//b"}}},' + "`r`n" + '  "mcp": { "other": {"type":"local","command":["other.exe"]}, },' + "`r`n" + '}'
$edit = Edit-BrowserMcp -Text $text -Entry $entry
Assert ($edit.Text.Contains('// keep this comment')) 'Root comment was removed'
Assert ($edit.Text.Contains('https://example.test/a//b')) 'String URL was damaged'
$parsed = ConvertFrom-Json (Get-JsonMinified $edit.Text)
Assert ($parsed.model -eq 'corp/model') 'Model changed'
Assert ($parsed.mcp.other.command[0] -eq 'other.exe') 'Other MCP changed'
Assert ($parsed.mcp.browser.command[0] -eq $entry.command[0]) 'Browser MCP missing'
Assert-Throws { Edit-BrowserMcp -Text $edit.Text -Entry $entry } 'Unowned browser entry must conflict'
$again = Edit-BrowserMcp -Text $edit.Text -Entry $entry -ExpectedEntryHash $edit.EntryHash
Assert (-not $again.Changed) 'Repeated identical merge should not write'
$removed = Edit-BrowserMcp -Text $edit.Text -Remove -ExpectedEntryHash $edit.EntryHash
$parsed = ConvertFrom-Json (Get-JsonMinified $removed.Text)
Assert ($null -eq $parsed.mcp.browser) 'Owned browser entry was not removed'
Assert ($parsed.mcp.other.command[0] -eq 'other.exe') 'Other MCP disappeared on uninstall'
Assert-Throws { Edit-BrowserMcp -Text '{"mcp":{"browser":{},"browser":{}}}' -Entry $entry } 'Duplicate browser keys must conflict'
Assert-Throws { Edit-BrowserMcp -Text '{not json}' -Entry $entry } 'Invalid JSON must be refused'
Assert-Throws { Edit-BrowserMcp -Text '{"mcp":[]}' -Entry $entry } 'Invalid MCP object must be refused'
$empty = Edit-BrowserMcp -Text '{}' -Entry $entry
Assert ((ConvertFrom-Json (Get-JsonMinified $empty.Text)).mcp.browser.enabled) 'Missing MCP object not created'
$changed = $edit.Text.Replace('browser-bridge.exe','different.exe')
Assert-Throws { Edit-BrowserMcp -Text $changed -Entry $entry -ExpectedEntryHash $edit.EntryHash } 'User modified browser entry must conflict'
Write-Output 'PASS JSONC merge, preservation, ownership and conflicts'
