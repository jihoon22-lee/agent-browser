# Windows installer local completion — 2026-10-12

Worktree: `/home/jihoon/projects/agent-browser-windows-setup`  
Branch: `feat/windows-setup-ui`, based on `fb2bcdbb4672a09395c7d7cc2ee75e6796e897c1`.  
All changes remain local and uncommitted. No push, PR, release, deployment, global OpenCode setting change, model call, or user Chrome data access.

## Deliverable

Local, unpublished **0.1.5** candidate:

`C:\Users\USER\Documents\Codex\2026-10-11\task\windows-setup-ui\release-v015-final\agent-browser-0.1.5-windows-x64.zip`

SHA256: `fb3cb446410f74b097e47ffbaaa622f68215b150e6251630a930ac9415e035ec` (32 files).

`release-v015-final-repeat` independently packaged the same inputs and produced the same SHA256. The existing Framework compiler is cached by compiler/source hashes, and the cached executable hash is verified before use; this establishes repeat packaging with identical local inputs, not a claim of clean-machine compiler determinism.

## Completed behavior

- Native .NET Framework WinForms install/update/uninstall, ownership/hash preview, Back, cancel, failure rollback and retry. No PowerShell execution-policy change, administrator request or dependency installation.
- Existing installation selection; Windows and running WSL OpenCode discovery; default WSL user, executable and settings detection; explicit manual paths when needed. Stopped distros are not automatically started; Docker internal distros are excluded.
- Separate managed profile validation/create-only save and ordinary CLI MCP registration. A single installation can own Windows and WSL registrations. JSONC comments, unrelated MCP/model/provider/server settings, file mode/owner/group, pairing and user data are preserved.
- Existing WSL UNC files use checked Linux-side atomic rename instead of unsupported Windows File.Replace.
- Installed GUI verifies ownership and hash, then opens an identical executable in a private hash-specific temporary directory. The original exits, allowing self-uninstall to remove owned installation files. The reusable temporary executable remains a cache; it contains no user data.
- Input revision checks discard stale discovery and profile validation responses. Saving captures the validated values and prevents duplicate submission or closing during the write. Closing read-only validation is safe.
- GUI Bridge start reuses the verified running Bridge. Pairing dialog masks the token and copies it only on the user's explicit click. Tests never read or copy the token.
- MCP diagnostics distinguish missing/disabled registration, executable, permission, authentication, timeout and connection/query failure, without emitting raw error/config secrets. Missing global `mcp` alone does not establish a managed-overlay failure.
- README, user guide, troubleshooting and unreleased changelog now describe the GUI flow; no policy bypass command is required.

## Final verification

| Command / check | Result and evidence |
|---|---|
| Framework `csc.exe` build of installer and regression executables | PASS; existing compiler, no downloads |
| `GuiSmokeTests.exe <final ZIP> <isolated root> <WSL fixture> --profiles --async-profile --installed-uninstall --discovery --failure --double` | PASS, `gui-final.log`: real mouse clicks, automatic discovery/selection/manual-input freshness, preview/Back/cancel, occupied-port startup failure/rollback/retry, stale validation, double Apply/Save, duplicate profile ID, close during validation, managed WSL profile save, existing Bridge start, masked pairing, repeat update, installed self-uninstall |
| `UpgradeFixture.exe <published 0.1.4 package> <final ZIP> ...`; `GuiSmokeTests.exe ... --resume --upgrade --installed-uninstall --double` | PASS, `gui-final-upgrade.log`: actual published 0.1.4 Bridge upgraded to 0.1.5, install identity/pairing hash/user model/other MCP preserved; final GUI self-uninstall passed. Fixture uses native setup to create legacy-shaped state; this is not a claim that the old PowerShell installer ran |
| `NativeEngineTests-multi.exe <final extracted package> <final GUI> <isolated root> <WSL fixture> wsl-auth-check.mjs` | 14 PASS, `native-multi-final.log`: transactions, expected-hash conflicts, ownership, cancellation, startup-child cleanup/retry, Windows+WSL registration/removal, actual OpenCode 1.18.29 MCP connection and Bridge 0.1.5 authentication |
| Authenticated `browser_snapshot` with nonexistent synthetic operation ID | Expected `OPERATION_INVALID`, delivered=false, executed=no, pageDataRead=false; no model or page access |
| `NativeCoreTests-final.exe Ubuntu` | 2 PASS, `native-core-final.log`: Unicode/space/ampersand `.cmd` version probe and actual read-only discovery |
| `cargo test --offline --locked -p agent-browser-bridge` | PASS earlier in this cycle on the same final Rust sources/version; full unit/integration/doc suite, 66 library unit tests |
| `cargo clippy --offline --locked -p agent-browser-bridge --all-targets` | Exit 0; existing style warnings remain |
| `cargo xwin build --offline --locked --release --target x86_64-pc-windows-msvc` | PASS; Windows Bridge from this build is in the final ZIP and was exercised natively |
| `pnpm --filter agent-browser-extension build`; extension test command | PASS: TypeScript and two Vite builds; 30 files / 280 tests. No extension source changes after these checks |
| `actionlint`; `node --test scripts/ci-checks.test.mjs`; Markdown links; `git diff --check` | PASS; CI helper tests 3 PASS. Remote CI was not run |
| Package manifest/hash/PE/version/notices checks and repeated package SHA | PASS, final ZIP above; 163-package third-party inventory |

Regressions were demonstrated before their fixes: WSL File.Replace (`wsl-settings-before.log`), stale profile validation (`gui-stale-before.log`), installed self-uninstall (`gui-self-uninstall-before.log`), failed startup ownership retry (`recovery-before.log`), and the initial MCP diagnostic assertion. Intentional failure fixtures were subsequently cleaned up through their own installer flows.

## Production preservation

`production-final.json` verifies personal **v0.1.4**, PID **74680** still running, unchanged install identity/executable, pairing configuration, data owner, profile definitions and profile IDs. WSL global config SHA256 remains `76d403b78261346d874663c864eaceb90c9758a1c2a7fa366376a32c0c923f91`. A preliminary profile comparison accidentally compared the whole runtime file to the profiles-only hash; the final check uses the original `JSON.stringify(runtime.profiles)` algorithm and passes. No production mutation was used to obtain this result.

Successful test installations removed their owned app files, startup entries and MCP registrations and stopped their owned Bridge. Preserved fixture data and screenshots are local evidence.

## Changed sources

- `installer/{NativeIO,Discovery,Jsonc,InstallerEngine,ProfileForm,SetupForm}.cs`
- `bridge/src/main.rs`, `bridge/src/runtime/mod.rs`, new `bridge/src/runtime/diagnostics.rs`
- `scripts/{build-release-wsl.sh,build-release.ps1,package-release.py,installer-common.ps1,setup.ps1,uninstall.ps1}`
- `tests/install/{NativeCoreTests.cs,NativeEngineTests.cs,GuiSmokeTests.cs,UpgradeFixture.cs,wsl-auth-check.mjs,wsl-settings.tests.ps1,package.tests.ps1}` and `.github/workflows/ci.yml`
- `Cargo.toml`, `Cargo.lock`, `extension/public/manifest.json` (local 0.1.5 version)
- `README-install.md`, `CHANGELOG.md`, `docs/user-guide.md`, `docs/troubleshooting.md`, `docs/status.md`, active plan and checkpoints

Screenshots: `gui-final/automatic-discovery.png`, `wsl-preview.png`, `managed-profile-saved.png`, `pairing-masked.png`, `startup-failure.png`, `uninstall-complete.png`; upgrade screenshots in `gui-final-upgrade/`.

## Explicit limits

- Legacy PS5.1 installer/package tests and `build-release.ps1` were not executed under the current script policy. The native GUI and WSL packager are separately verified; no policy was changed or bypassed.
- Native Windows OpenCode is not installed here. Windows config operations and synthetic `.cmd` probes pass; actual OpenCode execution/authentication was validated with WSL 1.18.29.
- Nondefault WSL account permission combinations, company policy/network/model environment, and full user Chrome end-to-end work were not exercised. Permission failures remain explicit failures; no privileges, firewall or policies are changed.
- The complete native Windows Rust suite was not rerun for installer-only stabilization. Linux Rust tests and actual Windows installer/Bridge/WSL integration are reported separately.
- No remaining local implementation blocker in the requested installer scope. Remote publishing and production update remain outside the current authorization.
