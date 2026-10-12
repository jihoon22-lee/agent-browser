# WSL interop follow-up review (2026-10-12)

Reviewed implementation: `748f8d584b8abe279e70e891d01b300ce965c781`, based on
`v0.1.4` (`fb2bcdbb4672a09395c7d7cc2ee75e6796e897c1`). Branch:
`fix/wsl-interop-compat`; worktree: `/home/jihoon/projects/agent-browser-wsl-interop`.
This was a fresh manual review and fault-driven verification, not a second human
or agent review. No push, PR, merge, release, or operating installation update was performed.

## Findings and fixes

1. **Live server child hidden by an exited group leader.** The old ownership
   check returned stopped when the recorded leader disappeared or became a
   zombie, even if its nonce-bound process group still contained a live server.
   Stop could then forget the record and stop its keeper while leaving that child.
   The Linux regression failed on the reviewed implementation. Its actual native
   Windows binary also reported stopped after the fixture leader was killed,
   while the child continued returning HTTP 401. The fix checks live members of
   the original group for the exact instance nonce and rereads member start tick
   and group before accepting ownership. A PID start-tick mismatch remains stale;
   a live group with no matching nonce remains unknown and is not killed.
   Keeper readiness still requires its actual leader to be alive.
2. **Previous-boot remnants blocked by missing keeper.** Inspect previously
   checked the keeper first, turning a positively old-boot server record into
   unknown ownership when its keeper was also gone. The regression returned 12
   instead of the expected stopped code 11. The fix validates the server record
   first, so an absent previous boot is stopped; a running server still requires
   its keeper. Windows verification used an isolated previous-boot marker and
   absent identities, then successfully started a new runtime. It did not shut
   down WSL or claim to reproduce a real host reboot.

## Actual execution environment

Windows 11 `10.0.26200.9457`, WSL `2.7.12.0`, Ubuntu, running kernel
`6.18.33.2-microsoft-standard-WSL2`, OpenCode `1.18.29`, fixture Node
`/usr/bin/node` `22.22.1` (distinct from other Node installations on the host).
WSL's version command reports packaged kernel `6.18.33.2-2`; this is distinct
from the running kernel string. The Windows Bridge reports `browser-bridge 0.1.4`.
The reviewed Windows debug binary was built with `cargo xwin` targeting
`x86_64-pc-windows-msvc`, with dependencies locked/offline and output under the
worktree's `target/`. Its SHA-256 is
`a3341c9fd9f067075f601a30ebc16cdac5a3ad3d4d3790fe3bacfe640c42fc07`.
Tests ran that actual native executable, not a Linux Bridge.

All fixture HOME/XDG paths, project directories, owner records, credentials,
servers, and ports were separate from the user's operating installation.
Project paths include Korean characters and spaces. No real Chrome pages,
model inference, global OpenCode configuration, or user conversations were used.

## Verification and observed results

| Check or injected fault | Expected and observed result |
|---|---|
| Linux full Bridge suite | `cargo test --locked --offline -p agent-browser-bridge`: 139 passed, 0 failed, 1 ignored. Includes 72 library tests; runtime-focused 28 and runtime-management 10 also passed separately. |
| Three native Windows persistence/Stop unit tests | Keeper initial persist failure, pending server owner persist failure, and Stop revoking a delayed launch permit: 3/3 passed. |
| Orphan leader | Old Windows binary failed as described above. Fixed binary retains ownership; Stop closes the live child listener and cleans the keeper. A foreign-nonce group survives the negative Linux test. |
| Previous boot | Both server and keeper markers refer to an impossible previous boot. Status is stopped and a fresh start succeeds, without host shutdown. |
| Bridge crash during startup | Kill only the fixture's resident Bridge after the server record is durable and before readiness. Restart retains the same instance, does not claim ready, and explicit Stop cleans it before a new successful start. |
| Bridge crash after readiness | Restart reuses the same server URL and keeper launcher PID. |
| Concurrent calls | Same resident Bridge accepts concurrent ensure calls into one runtime. Two independent native CLI processes produce one ready result and one explicit profile-lock rejection; one owned runtime record remains and survives caller exit. |
| Keeper loss | Kill only the verified fixture keeper. Status/ensure report error, preserve the original instance, and do not create a replacement; explicit Stop cleans server and keeper. |
| Legacy record without keeper | Existing server is retained and refresh requires explicit Stop/start. |
| Missing socket | Guard refuses native launch before executing the Windows MCP command. |
| Stalled private socket | A fixture AF_UNIX peer accepts but never completes handshake. Canary fails within 11.24 seconds in the final run. This is not the WSL kernel vsock leak reproduction. |
| Existing settings | With an existing schema-bearing config file, its bytes, other disabled MCP entries, profile environment sentinel, and actual working directory are preserved. |
| Real MCP initialization failure | Through OpenCode v1 `POST /mcp`, replace only the fixture browser command with `/bin/sleep 15`, configured timeout 1,200ms. HTTP remains healthy, MCP becomes failed, manager status/ensure become error, and its owned record/instance remain. Restore the prior browser configuration: MCP connected and ready recover on the same server. |

The real initialization-timeout request took 3,600ms; the full verification
including follow-up status/ensure checks took 5,025ms. The configured 1,200ms
timeout is not reported as the measured end-to-end request duration.

Real HTTP/protocol evidence from the final binary:

- Unauthenticated `/global/health`: **401**. Basic-authenticated request:
  **200**, `healthy: true`, `version: 1.18.29`; required v1 API discovery passed.
- OpenCode's browser MCP status: **connected**. Resident Bridge and native MCP
  proxy were observed as two actual Windows processes using the test executable.
- Keeper socket canary: actual Windows `browser-bridge --version` succeeded.
- A separate test client executed OpenCode's configured MCP command and received
  `initialize`: protocol `2025-06-18`, server `agent-browser`, version `0.1.4`.
- First `browser_tabs` request (id 2): `isError: false`, synthetic tab title
  `interop-synthetic`, 4ms in the settings/failure case and 5ms in the keeper case.
  This proves the configured command and protocol/tool path. It does not claim
  an OpenCode model-driven request or real Chrome extension E2E run.

Probe comparison was repeated with the same isolated synthetic server fixture.
The baseline is v0.1.4 with only a control-probe debug log added:

| Measurement | Baseline | Final review binary |
|---|---:|---:|
| Startup WSL control probes | 6 | 2 |
| Five normal status calls: WSL control probes | 15 | 5 |
| Five status calls elapsed, one illustrative run | 3,425ms | 1,223ms |

These are control probes, not all WSL launches. The implementation adds a
separate long-lived keeper session. Timing is not a benchmark guarantee.

Two fixture issues were corrected without changing product behavior: an initial
byte-equality test omitted `$schema`, which OpenCode itself added; an initial
concurrent-caller assertion did not match the actual profile-lock message.
Successful reruns are reported above; those fixture failures are not product findings.

## Evidence and integration

The final sanitized stage results are in
`docs/reference/wsl-interop-review-results.json`. They contain no passwords,
tokens, original runtime records, user conversations, or page content. The full
Linux command output remains locally in `target/interop-review-linux-tests.log`
(ignored build output). Native fixture reproduction instructions are in
[testing.md](./testing.md#wsl-interop-follow-up-review-scenarios).

The follow-up changes are limited to `bridge/src/runtime/mod.rs`,
`bridge/src/runtime/interop_tests.rs`, the two runtime fixture files, and review
documentation/evidence. The prior implementation adds `interop.rs`, profile
environment guards, the synthetic OpenCode fixture, and readiness handling.
Integrate the branch's two commits after the v0.1.4 base; the follow-up alone
depends on `748f8d5`. No GUI or iframe/active-tab code was edited in this worktree.

At final cleanup check on 2026-10-12 07:03 UTC, test-path native Windows Bridge
processes numbered **0**. The existing installation remained on port 4317 with
PID **74680**, executable
`%LOCALAPPDATA%/AgentBrowser/app/0.1.4-a756bddac167/browser-bridge.exe`.

## Remaining limits

The application cannot repair an already exhausted/leaking WSL runtime. The
currently installed WSL 2.7.12 was exercised, but no separate older WSL package
VM, host exhaustion stress, or original kernel vsock defect reproduction was
performed. No accessible isolated Windows VM was confirmed. Actual WSL shutdown
was deliberately omitted because other user sessions were active; the old-boot
case is metadata fault injection. See the official-source analysis and separate
issue distinctions in [wsl-interop-validation.md](./wsl-interop-validation.md).
MCP connection and synthetic first-tool success do not cover model inference or
the real Chrome extension. Partial startup and legacy keeper-less records remain
conservative explicit Stop/start recovery cases.
