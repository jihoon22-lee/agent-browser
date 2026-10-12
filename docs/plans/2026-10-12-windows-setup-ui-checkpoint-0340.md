# Checkpoint — 2026-10-12 03:40 UTC

Same worktree `/home/jihoon/projects/agent-browser-windows-setup`, branch `feat/windows-setup-ui`, uncommitted local changes. Candidate version now **0.1.5** in Cargo.toml/Cargo.lock/extension manifest. No remote publishing or operational update.

## New completed validation

- **Actual GUI cross-version update PASS:** prepared an isolated legacy-shape installation with the published v0.1.4 Bridge and package files (native fixture setup because PS5.1 execution remains policy blocked), then used the v0.1.5 ZIP GUI to update. Version changed to 0.1.5; install ID, pairing config hash, user-edited model and unrelated WSL MCP were preserved. GUI uninstall then preserved unrelated MCP/data. Evidence `gui-cross-version.log`, `gui-upgrade-014-015/`. This is actual different-version/binary upgrade, distinct from the earlier same-ZIP repeat test.
- **GUI failure/retry/duplicate clicks PASS:** v0.1.5 ZIP, actual temp port conflict during Bridge start, file/settings rollback confirmed, Back→Preview→Apply retry succeeded. Every Apply received two real mouse click sequences 15 ms apart. The rest of install/profile/repeat/uninstall passed. Evidence `gui-v015-recovery.log`, screenshots in `gui-v015-recovery/`.
- **13 independent native tests PASS against v0.1.5 ZIP:** the earlier 12 plus startup marker failure/child cleanup/retry. Actual OpenCode 1.18.29 MCP connection and authenticated resident **Bridge 0.1.5** OPERATION_INVALID roundtrip passed without model calls or Chrome data. Evidence `native-v015-final.log`, `isolated-native-v015-final/WSL native installation/data/isolated-auth-result.json`.
- **Found and fixed a real recovery bug:** a failed first start created pairing config but rollback deleted its data-owner marker, causing retry to reject its own data. Failing regression `recovery-before.log`; fix retains the data owner with pairing data. `recovery-after.log`: 9 native tests PASS. Marker-write failure now also terminates the exact verified newly-started Bridge. Partially stopped runtime IDs are retained for rollback even on a stop-all error. Startup removal/replacement uses the preview hash; WSL config/distribution mismatch is rejected.
- **Extension typecheck/Vite build PASS; 30 test files / 280 tests PASS.** Offline dependency restore reused 142 cached packages, downloaded 0; no global software installed.
- **Rust full unit/integration/doc tests PASS** at v0.1.5. `cargo clippy --offline --locked -p agent-browser-bridge --all-targets` exited 0 with existing style warnings (6 library warnings plus repeated test-helper collapsible-if). Native Windows release Bridge build PASS.
- Third-party inventory regenerated: 163 packages. CI helper tests 3 PASS, Markdown link check PASS, diff check PASS.
- Native installer tests wired into existing Windows CI after package creation; remote CI has **not run** because nothing was pushed. Existing package tests now require AgentBrowser-Setup.exe.
- GUI compile cache keyed by compiler/source hashes and verified binary hash prevents the old Framework compiler's changing MVID/timestamp from needlessly changing repeated package bytes. Actual repeated ZIP SHA256 matched.

## Candidate package

`windows-setup-ui/release-v015-0333/agent-browser-0.1.5-windows-x64.zip`

SHA256 **354134bf580a66d6fb252ba62c7797147a8c0e51d99e4ce7f49d16713e215e9b**, 32 files. `release-v015-repeat/` produced the same hash. This includes current native engine recovery changes, source-built v0.1.5 Bridge/extension, current notices, GUI/profile/MCP diagnostic changes, and legacy multi-MCP guards. It is local and unpublished.

## Remaining final review/work

1. Running the GUI from its installed versioned executable currently locks itself during uninstall; finish safe self-relaunch outside the installation, then test that path. Current GUI uninstall PASS was launched from the extracted ZIP.
2. Automatic discovery currently reports existing installation count and offers OpenCode candidates, but should offer discovered install roots as selectable entries. Keep fixture paths from being overwritten by delayed discovery; any auto-discovery should have an explicit no-discovery test option. Final manual/multiple/missing candidate UI checks remain.
3. Review async profile dialog close/edit behavior during validation/save; avoid a late validation response enabling save for edited fields.
4. Finish GUI-first documentation (later README/guide legacy policy-bypass commands remain and must not be the required path), add changelog entry, run final package/docs/workflow checks. Review actionlint availability instead of installing it globally. Self-review native source in full; no subagents used/authorized.
5. Optional remaining native edge checks: WSL nondefault-user settings access can safely fail if UNC/default-user permissions differ; do not claim that untested case passed. Startup CLI failure before returning JSON has less cleanup evidence than the marker-write failure. Native Windows Rust test suite / full Chrome E2E have not been rerun for these installer changes; existing Linux Rust and actual Windows installer/WSL integration passed.

Operational v0.1.4 PID 74680 was checked again and remains running. All successful tests uninstalled their own app/registration and stopped their Bridge; data retained as test evidence. No actual personal OpenCode config changes, no model calls, no user Chrome access, no execution-policy/firewall/security changes.

The scripts/build-release.ps1 and legacy PS5.1 tests remain unexecuted here due the previously recorded script policy constraints; the WSL product packager and actual Windows .NET executable path were tested separately. Native tests are not claimed as PowerShell compatibility tests.
