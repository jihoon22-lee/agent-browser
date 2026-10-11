#!/usr/bin/env bash
# Development verification only: copy pinned test dependencies, then run native Windows Chrome + exe.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
prepare_only=false
if [[ "${1:-}" == --prepare-only ]]; then prepare_only=true; shift; fi
cd "$repo_dir"
cargo xwin build --offline --locked -p agent-browser-bridge --release --target x86_64-pc-windows-msvc
pnpm --filter agent-browser-extension build
windows_local="$('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoProfile -NonInteractive -Command '[Environment]::GetFolderPath("LocalApplicationData")' | tr -d '\r\n')"
windows_dest="${AGENT_BROWSER_WINDOWS_TEST_DIR:-$windows_local\\AgentBrowser-dev\\testing}"
wsl_dest="$(wslpath -u "$windows_dest")"
# This directory is reserved for generated, synthetic development verification artifacts.
node --input-type=module - "$repo_dir" "$wsl_dest" <<'JS'
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [root,dest]=process.argv.slice(2);
const load=createRequire(join(root,'tests/e2e/package.json'));
const testPkg=load.resolve('@playwright/test/package.json');
const playwrightPkg=createRequire(testPkg).resolve('playwright/package.json');
const corePkg=createRequire(playwrightPkg).resolve('playwright-core/package.json');
mkdirSync(dest,{recursive:true});
for(const [source,target] of [[testPkg,'@playwright/test'],[playwrightPkg,'playwright'],[corePkg,'playwright-core'],[load.resolve('ws/package.json'),'ws']]){
 cpSync(dirname(realpathSync(source)),join(dest,'node_modules',target),{recursive:true,dereference:true});
}
cpSync(join(root,'tests/e2e'),join(dest,'tests/e2e'),{recursive:true,filter:p=>!/(?:^|\/)(?:node_modules|\.artifacts|test-results)(?:\/|$)/.test(p)});
cpSync(join(root,'tests/fixtures'),join(dest,'tests/fixtures'),{recursive:true});
mkdirSync(join(dest,'docs/reference'),{recursive:true});
cpSync(join(root,'docs/reference/opencode-1.18.29-openapi.json'),join(dest,'docs/reference/opencode-1.18.29-openapi.json'));
cpSync(join(root,'extension/dist'),join(dest,'extension/dist'),{recursive:true});
mkdirSync(join(dest,'target/x86_64-pc-windows-msvc/release'),{recursive:true});
cpSync(join(root,'target/x86_64-pc-windows-msvc/release/browser-bridge.exe'),join(dest,'target/x86_64-pc-windows-msvc/release/browser-bridge.exe'));
writeFileSync(join(dest,'package.json'),JSON.stringify({private:true,type:'module'}));
console.log('Prepared native Windows verification workspace: '+dest);
JS
if $prepare_only; then exit 0; fi
cd "$wsl_dest/tests/e2e"
exec '/mnt/c/Program Files/nodejs/node.exe' "$(wslpath -w "$wsl_dest/tests/e2e/windows-run.ts")" "$@"
