# Windows GUI installer checkpoint — 2026-10-12 02:54 UTC

Worktree `/home/jihoon/projects/agent-browser-windows-setup`, branch `feat/windows-setup-ui`; base `fb2bcdb`. Local uncommitted changes only.

## Delivered in this interval

- Compiled a real .NET Framework WinForms `AgentBrowser-Setup.exe` without downloads or execution-policy changes. The form has operation selection, installation/package/Startup paths, Bridge port/start controls, OpenCode discovery, Windows/WSL CLI registration list, preview, back, apply, cancellation and status/error display.
- Added `installer/Jsonc.cs`, `InstallerEngine.cs`, `SetupForm.cs`. Native transactional file install/update/uninstall connects to the form; existing install IDs/data are retained, package hashes and owned-file hashes checked, concurrent settings changes rejected, and canceled operations rolled back. Startup targets the native GUI executable with `--start`, without PowerShell policy overrides. Bridge start/stop checks the recorded executable/PID/creation identity. Uninstall preserves data by default.
- Added native engine and own-window click test sources under `tests/install/`. A local test ZIP includes the compiled GUI and the published v0.1.4 Bridge. Its manifest version is `0.1.4-gui-test1`; it is a local test artifact, not a new release. Repository release scripts are not integrated with the new executable yet.

## Actual tests

- GUI compilation using existing Windows `csc.exe`: PASS.
- `NativeEngineTests.exe <stock package> <GUI exe> <isolated root>`: **8 PASS**: JSONC comments/other MCP and ownership, preview + pre-cancel, install + synthetic Startup, preview concurrency conflict, update preserving identity/data/user edits, modified-file uninstall rejection, uninstall preservation, mid-install cancel rollback.
- Earlier WSL atomic writer tests remain 4 PASS; earlier native discovery/cmd probe remain 2 PASS. These are separate checks.
- `git diff --check`: PASS.
- `GuiSmokeTests.exe <local ZIP> <isolated root> <WSL temp config>`: **FAILED/BLOCKED before preview**. First attempt used an unsupported accessibility ValuePattern for a readonly textbox; corrected to support TextPattern. Second attempt could read the launched form's initial status but actual mouse clicks did not reach it: the active desktop was Windows' lock screen. No GUI flow completed and no GUI install/update/uninstall success is claimed. Test GUI PIDs 5344 and 65012 were closed through CloseMainWindow after exact executable-path checks.
- Legacy full PowerShell installer tests remain blocked by script signature policy; no policy changes or bypass was used. Native engine success does not replace those results.

Evidence: `native-engine-tests.log`, `gui-smoke.log`, source files and local ZIP at `windows-setup-ui/isolated-native-0250/agent-browser-gui-test1-windows-x64.zip`.

## New user evidence and next steps

- Company WSL config exists but has **no mcp property**. Created an isolated actual WSL fixture `/tmp/agent-browser-gui-FUHTy9/opencode.jsonc` with existing model/provider/server fields, a comment and mode 0600 for this exact case. Actual WSL no-mcp add/repeat/remove and auth validation **have not run yet**, because the GUI stopped before preview. The missing property is a normal starting state, distinct from the existing-file File.Replace defect.
- User sees Bridge and OpenCode ready but a generic MCP warning; their later 'nothing displayed' does not establish which part was absent. In `bridge/src/runtime/mod.rs:317–319`, failed GET `/mcp`, missing browser, disabled, and failed connection all collapse to one warning. Registration missing is **not confirmed**. Next change should expose a bounded classification and safe per-browser diagnostic, not raw configuration, credentials or full responses. No further UI scavenger hunt, reinstall or re-pairing is justified by this evidence.
- Remaining GUI/product work: managed profile executable/user/work-folder selection and save, filtering infrastructure/stopped WSL distros before automatic probes, full multi-user/config selection UI, native WSL writer tests, explicit data-removal option if required, self-uninstall of a running installed GUI, stronger rollback/start-failure tests, legacy CLI multi-registration compatibility, release build integration/docs, complete GUI click tests after Windows is unlocked, and isolated WSL MCP authentication proof.
- Review native transaction edge cases before production: verify an existing data-owner marker before ACL changes, capture exact Startup preview hashes, ensure a new Bridge started just before failure is cleaned up, and restore any partially stopped managed profiles on failure. No production use is authorized by these partial checks.

Personal v0.1.4 installation and global OpenCode configuration were not changed during this interval. No model request or Chrome page read. No push/PR/release.
