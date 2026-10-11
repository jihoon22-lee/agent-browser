import { join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export function runtimeConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, root = ROOT) {
  if (env.AB_E2E_PLATFORM === "windows" && platform !== "win32") {
    throw new Error("Windows validation requires native Windows Node; a Linux process is not Windows evidence.");
  }
  const nativeWindows = platform === "win32";
  const pathJoin = nativeWindows ? win32.join : join;
  const browserExecutable = env.AB_BROWSER_EXECUTABLE || (nativeWindows
    ? pathJoin(env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe") : undefined);
  if (env.AB_HEADED && !["0", "1"].includes(env.AB_HEADED)) throw new Error("AB_HEADED must be 0 or 1");
  let externalFixture: { base: string; alt: number } | undefined;
  if (env.AB_FIXTURE_BASE || env.AB_FIXTURE_ALT) {
    if (!env.AB_FIXTURE_BASE || !env.AB_FIXTURE_ALT) throw new Error("AB_FIXTURE_BASE and AB_FIXTURE_ALT must be supplied together");
    const base = new URL(env.AB_FIXTURE_BASE);
    const alt = Number(env.AB_FIXTURE_ALT);
    if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
      throw new Error("The external fixture must be an HTTP loopback origin without credentials or a path");
    }
    if (!Number.isInteger(alt) || alt < 1 || alt > 65535) throw new Error("AB_FIXTURE_ALT must be a valid TCP port");
    externalFixture = { base: base.origin, alt };
  }
  return {
    nativeWindows,
    bridgeExe: env.AB_BRIDGE_EXE || pathJoin(root, nativeWindows
      ? "target/x86_64-pc-windows-msvc/release/browser-bridge.exe" : "target/debug/browser-bridge"),
    extensionDir: env.AB_EXTENSION_DIR || pathJoin(root, "extension/dist"),
    browserExecutable,
    headless: env.AB_HEADED !== "1",
    workRoot: env.AB_WORK_ROOT || tmpdir(),
    externalFixture,
  };
}
