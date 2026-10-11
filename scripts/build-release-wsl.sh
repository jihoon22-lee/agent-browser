#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$repo_dir"
cargo xwin build --locked --release --target x86_64-pc-windows-msvc -p agent-browser-bridge
pnpm --filter agent-browser-extension build
node scripts/generate-third-party-notices.mjs
# File.Replace from Windows cannot replace an existing file on WSL's UNC share.
# Build into a fresh directory, then publish local artifacts with WSL's rename.
package_stage=$(mktemp -d "$repo_dir/release/.package-XXXXXX")
trap 'rm -rf -- "$package_stage"' EXIT
'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(wslpath -w "$repo_dir/scripts/build-release.ps1")" -SkipBuild -OutDir "$(wslpath -w "$package_stage")"
mv -- "$package_stage"/*.zip "$package_stage/SHA256SUMS" "$repo_dir/release/"
