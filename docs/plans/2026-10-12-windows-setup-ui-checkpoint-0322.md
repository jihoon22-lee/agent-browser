# Checkpoint — 2026-10-12 03:22 UTC

Worktree `/home/jihoon/projects/agent-browser-windows-setup`; branch `feat/windows-setup-ui`; local uncommitted changes. No push, PR, release or production update.

## Confirmed results

- **Actual Windows GUI click flow now works.** Foreground activation was not a security rejection. The test checks the process owning the exact screen coordinate, makes only its own GUI visible if needed, and sends a normal mouse click only when that coordinate belongs to the test process. It does not send input to another app. The previous lock-screen limitation is resolved; no further unlock is required.
- **5 real GUI flows passed from the current locally built ZIP**: preview/back/cancel with no install; install with existing actual WSL no-mcp JSONC; managed WSL profile validation/save through the real Bridge CLI; repeat/update with one registration and user settings preserved; uninstall target preview/removal with no-mcp restoration and data preservation. This update reused the same ZIP, not a cross-version GUI upgrade.
- Evidence: `gui-finalzip-retry.log`, screenshots under `gui-finalzip-0320/`, including `managed-profile-saved.png`, `install-complete.png`, `update-complete.png`, `uninstall-complete.png`.
- **12 independent native integration tests remain PASS**, including actual OpenCode 1.18.29 MCP connection and authenticated resident Bridge OPERATION_INVALID reply without model calls, delivered operation, or Chrome page data. Evidence: `native-wsl-tests-final.log` and `isolated-native-0306/WSL native installation/data/isolated-auth-result.json`.
- **Rust runtime suite: 22 PASS** (`cargo test --offline --locked -p agent-browser-bridge --lib runtime:: -- --nocapture`). Includes detailed MCP state/secret filtering and create-only profile preservation. The generic MCP regression failed before its implementation and passed after.
- Windows release Bridge cross-build: PASS (`cargo xwin build --offline --locked --release --target x86_64-pc-windows-msvc -p agent-browser-bridge`). Real Windows GUI compilation and native CLI profile save succeeded.
- Markdown helper check and git diff --check: PASS. Python packager syntax: PASS.

## Implemented

- Managed profile form: Windows/WSL, distribution/user, executable, name/id, working directory, candidate discovery, preview, save. Saves new profiles through Bridge CLI `profile save --create-only`; atomic store check prevents overwriting an existing profile. It does not start a runtime/model. Start remains in Chrome Options after pairing.
- MCP doctor classifies connected, missing registration, disabled, execution path missing, permission denied, connection timeout/failure, auth requirement, unknown response, status query failure/timeout/401/403. Uses explicit managed/external scope; never emits raw subprocess error/config/credentials. Missing global mcp does not prove a managed runtime overlay is missing.
- Discovery skips docker-desktop infrastructure distros and does not auto-start stopped WSL distros; lists stopped candidates with a manual-selection notice. Manual user/executable fields are available in the profile form.
- Build integration: existing Windows build-release.ps1 now compiles/includes the native GUI. WSL build-release-wsl.sh invokes product-specific `scripts/package-release.py` instead of PowerShell Bypass. The packager validates locked notice hashes, PE architecture/version, extension paths and manifest hashes, and emits ZIP + SHA256SUMS.
- Native engine now checks existing data ownership before changing its ACL, and uses the preview's recorded Startup hash. Legacy scripts stop safely if a GUI installation has multiple MCP targets; this avoids silently losing their ownership records.

## Local package

`windows-setup-ui/release-candidate-0318/agent-browser-0.1.4-windows-x64.zip`

SHA256 `2db723f0c8370e1c7321e507a0e8b9bf3bb048418612268be4d4ad303b5a2814`, 32 files. It contains the freshly built diagnostic/create-only Bridge and native profile GUI; extension assets and locked notices reused the unchanged published v0.1.4 outputs. This is an **unreleased local candidate**, not the published v0.1.4 asset. Do not overwrite the real release. The two legacy-script multi-MCP guards were added after this ZIP and need the next package rebuild.

## Tests that failed while developing the test driver

- Accessing readonly text with ValuePattern, modal lookup only at desktop root, and attempting update continuation before a test data sentinel was created caused test-driver failures. The modal had actually opened and uninstall had completed; the fresh complete run after fixing descendant lookup passed all five flows. Keep these distinct from product data-loss claims.
- GUI PIDs from failed runs were normally closed. A modal prevented Process.CloseMainWindow; `CloseOwnedGui.exe` verified exact PID/executable path and sent WM_CLOSE only to that process's windows. Final successful GUI run closed every launched window; uninstall stopped its owned Bridge. Personal v0.1.4 PID 74680 remains running, confirmed at 03:21 UTC.

## Remaining before completion

1. GUI duplicate-click, apply-time cancel/failure rollback, candidate selection/multiple/missing executable paths, cross-version/different-binary update tests; re-run final package after any product changes.
2. Review remaining native rollback edges: newly started Bridge on startup/marker failure, partially stopped managed profiles on stop-all error, current installed-GUI self-uninstall, data-removal preference, WSL nondefault-user writer permissions, and multi-config target mismatch.
3. Add native GUI engine regressions to Windows CI; fix NativeEngineTests.CopyPackage to replace an already-present GUI manifest entry rather than append a duplicate before using new release packages as its input.
4. Broader required final validation, legacy PowerShell compatibility and build script regressions. Native PowerShell 5.1 has default Restricted; tool shell is PowerShell 7.6.5 with RemoteSigned. The prior UNC script invocation was signature blocked. Do not silently change policy or treat native tests as PS5.1 passes.
5. Finish coherent install/pairing/upgrade/uninstall documentation (README first section now uses GUI; later legacy command sections still need review). Full changed source is uncommitted and has not been independently reviewed.

No current UI/security blocker. Operational deployment and remote publication remain unauthorized.
