import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const source = readFileSync(new URL("../../installer/Discovery.cs", import.meta.url), "utf8");
const match = /internal const string WslProbe=@"((?:[^"]|"")*)";/.exec(source);

test("the WSL probe finds OpenCode installed through nvm or bun without a login PATH", () => {
  assert.ok(match, "WslProbe must be a verbatim constant so it can be tested");
  const probe = match[1].replaceAll('""', '"').replaceAll("\r\n", "\n");
  const home = mkdtempSync(join(tmpdir(), "ab-probe-"));
  for (const dir of [".nvm/versions/node/v22.0.0/bin", ".bun/bin"]) {
    mkdirSync(join(home, dir), { recursive: true });
    const exe = join(home, dir, "opencode"); writeFileSync(exe, "#!/bin/sh\necho 1.18.29\n"); chmodSync(exe, 0o755);
  }
  const output = execFileSync("/bin/sh", ["-c", probe], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.match(output, new RegExp(`EXE\\t${home}/\\.nvm/versions/node/v22\\.0\\.0/bin/opencode`));
  assert.match(output, new RegExp(`EXE\\t${home}/\\.bun/bin/opencode`));
  assert.match(output, /^USER\t/m);
});
