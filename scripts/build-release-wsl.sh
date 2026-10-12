#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$repo_dir"
cargo xwin build --locked --release --target x86_64-pc-windows-msvc -p agent-browser-bridge
pnpm --filter agent-browser-extension build
node scripts/generate-third-party-notices.mjs
# Native compilation and ZIP packaging do not invoke PowerShell or change policy.
python3 scripts/package-release.py --bridge target/x86_64-pc-windows-msvc/release/browser-bridge.exe --extension extension/dist --notices release/notices --out release
