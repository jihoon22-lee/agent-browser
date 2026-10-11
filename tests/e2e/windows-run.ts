import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runtimeConfig } from "./runtime.ts";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const forwarded = separator < 0 ? [] : args.slice(separator + 1);
const { values } = parseArgs({
  args: separator < 0 ? args : args.slice(0, separator),
  options: {
    exe: { type: "string" }, extension: { type: "string" }, chrome: { type: "string" },
    headed: { type: "boolean" }, "work-root": { type: "string" }, demo: { type: "boolean" }, help: { type: "boolean" },
  },
});
if (values.help) {
  console.log("Native Windows Node 24: node windows-run.ts --exe <browser-bridge.exe> --extension <dist> [--chrome <installed chrome.exe>] [--headed] [--work-root <directory>] [--demo] -- [Playwright test arguments]");
  console.log("Demo mode requires AB_DEMO_INFO; optional AB_DEMO_STOP_FILE and AB_DEMO_TIMEOUT_MS. External fixture: AB_FIXTURE_BASE plus AB_FIXTURE_ALT.");
  process.exit(0);
}
const env = {
  ...process.env, AB_E2E_PLATFORM: "windows", AB_E2E_DEMO: values.demo ? "1" : "0",
  ...(values.exe ? { AB_BRIDGE_EXE: values.exe } : {}),
  ...(values.extension ? { AB_EXTENSION_DIR: values.extension } : {}),
  ...(values.chrome ? { AB_BROWSER_EXECUTABLE: values.chrome } : {}),
  ...(values.headed ? { AB_HEADED: "1" } : {}),
  ...(values["work-root"] ? { AB_WORK_ROOT: values["work-root"] } : {}),
};
const config = runtimeConfig(env); // Fails before launching anything under WSL/Linux.
if (!config.bridgeExe.toLowerCase().endsWith(".exe")) throw new Error("Windows validation requires browser-bridge.exe");
const cwd = dirname(fileURLToPath(import.meta.url));
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const result = spawnSync(process.execPath, [cli, "test", "--config", join(cwd, "playwright.config.ts"), ...forwarded], { cwd, env, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
