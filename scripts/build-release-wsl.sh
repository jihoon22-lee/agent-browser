#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$repo_dir"
cargo xwin build --locked --release --target x86_64-pc-windows-msvc -p agent-browser-bridge
pnpm --filter agent-browser-extension build
node scripts/generate-third-party-notices.mjs
'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(wslpath -w "$repo_dir/scripts/build-release.ps1")" -SkipBuild
