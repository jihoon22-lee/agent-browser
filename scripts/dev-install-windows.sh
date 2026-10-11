#!/usr/bin/env bash
# Build and copy into a new directory; never terminate or overwrite a running Bridge.
set -euo pipefail

usage() {
  cat <<'TEXT'
Usage: bash scripts/dev-install-windows.sh [--dest 'C:\Users\USER\AppData\Local\AgentBrowser-dev']
Builds the Windows Bridge and extension, then copies them into a unique builds/<id>/ directory.
Prints the exact executable and unpacked extension paths. Does not start processes, pair,
install OpenCode, edit global settings, or terminate an existing Bridge.
TEXT
}

dest_windows=''
while (($#)); do
  case "$1" in
    --dest) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; dest_windows=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ -z "$dest_windows" ]]; then
  local_app_data=$('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoProfile -NonInteractive -Command '[Environment]::GetFolderPath("LocalApplicationData")')
  local_app_data=${local_app_data//$'\r'/}
  [[ -n "$local_app_data" ]] || { printf 'Windows LocalApplicationData could not be resolved. Supply --dest.\n' >&2; exit 1; }
  dest_windows="${local_app_data}\\AgentBrowser-dev"
fi
[[ "$dest_windows" =~ ^[A-Za-z]:\\ ]] || { printf '%s\n' '--dest must be an absolute Windows drive path.' >&2; exit 2; }
dest_unix=$(wslpath -u "$dest_windows")

cd -- "$repo_dir"
cargo xwin build --locked -p agent-browser-bridge --release --target x86_64-pc-windows-msvc
pnpm --filter agent-browser-extension build

mkdir -p -- "$dest_unix/builds"
build_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)-$$"
final_dir="$dest_unix/builds/$build_id"
[[ ! -e "$final_dir" ]] || { printf 'Build destination already exists: %s\n' "$final_dir" >&2; exit 1; }
staging_dir=$(mktemp -d "$dest_unix/builds/.staging-XXXXXXXX")
cleanup() { [[ -z "${staging_dir:-}" ]] || rm -rf -- "$staging_dir"; }
trap cleanup EXIT
mkdir -- "$staging_dir/extension"
cp -- "$repo_dir/target/x86_64-pc-windows-msvc/release/browser-bridge.exe" "$staging_dir/browser-bridge.exe"
cp -a -- "$repo_dir/extension/dist/." "$staging_dir/extension/"
mv -- "$staging_dir" "$final_dir"
staging_dir=''

printf 'Windows Bridge: %s\n' "$(wslpath -w "$final_dir/browser-bridge.exe")"
printf 'WSL interop:    %s\n' "$final_dir/browser-bridge.exe"
printf 'Load extension: %s\n' "$(wslpath -w "$final_dir/extension")"
printf 'Use only the isolated AgentBrowser-dev Chrome profile for development.\n'
