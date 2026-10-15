#!/usr/bin/env bash
# Development verification only: compile installer C# tests with Windows' .NET Framework compiler and run one.
# Uses only an isolated %LOCALAPPDATA%\AgentBrowser-dev\installer-tests folder; never the user's installation.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
name="${1:?usage: test-installer-windows.sh <TestClass, e.g. SetupFlowTests>}"
ps=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
local_app="$("$ps" -NoProfile -NonInteractive -Command '[Environment]::GetFolderPath("LocalApplicationData")' | tr -d '\r\n')"
dest_win="$local_app\\AgentBrowser-dev\\installer-tests"
dest="$(wslpath -u "$dest_win")"
case "$dest" in */AgentBrowser-dev/installer-tests) ;; *) echo "unexpected test folder: $dest" >&2; exit 2;; esac
rm -rf -- "$dest"; mkdir -p "$dest/src" "$dest/package"
# Same source set as CI: installer sources, the shared test fixtures, and the selected class.
cp "$repo_dir"/installer/*.cs "$dest/src/"
for f in NativeEngineTests InstallerReviewTests UpgradeFixture ManagedRuntimeUpgradeTests "$name"; do cp "$repo_dir/tests/install/$f.cs" "$dest/src/"; done
# Package the current checkout into a fresh development folder; published ZIPs in release/ stay untouched.
zip="${AB_PACKAGE_ZIP:-}"
if [ -z "$zip" ]; then
  out="$repo_dir/release/dev-$(git -C "$repo_dir" rev-parse --short HEAD)-$(date +%s)"
  (cd "$repo_dir" && cargo xwin build --locked --release --target x86_64-pc-windows-msvc -p agent-browser-bridge >/dev/null \
    && pnpm --filter agent-browser-extension build >/dev/null && node scripts/generate-third-party-notices.mjs >/dev/null \
    && python3 scripts/package-release.py --bridge target/x86_64-pc-windows-msvc/release/browser-bridge.exe --extension extension/dist --notices release/notices --out "$out" >/dev/null)
  zip="$(ls "$out"/agent-browser-*-windows-x64.zip)"
fi
unzip -q "$zip" -d "$dest/package"
"$ps" -NoProfile -ExecutionPolicy Bypass -Command "& {
  \$c = Join-Path \$env:WINDIR 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
  \$src = (Get-ChildItem '$dest_win\\src\\*.cs').FullName
  & \$c /nologo /codepage:65001 /target:exe /main:AgentBrowser.Installer.$name '/out:$dest_win\\$name.exe' /r:System.Web.Extensions.dll /r:System.Core.dll /r:System.Management.dll /r:System.IO.Compression.FileSystem.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll @src
  if (\$LASTEXITCODE -ne 0) { exit 1 }
  & '$dest_win\\$name.exe' '$dest_win\\fixture' '$dest_win\\package'
  exit \$LASTEXITCODE
}"
