import { test, expect } from "@playwright/test";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { startWorld } from "./harness";

const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };

/** Keeps only this test's Chrome/bridge alive for WSL OpenCode; it does not grade model behavior. */
test("Windows agent demo environment readiness and owned cleanup", async ({}, testInfo) => {
  if (process.platform !== "win32") throw new Error("Demo mode requires native Windows Node and installed Windows Chrome");
  const infoPath = process.env.AB_DEMO_INFO;
  if (!infoPath || !isAbsolute(infoPath)) throw new Error("AB_DEMO_INFO must be an absolute native Windows JSON output path");
  const stopPath = process.env.AB_DEMO_STOP_FILE || `${infoPath}.stop`;
  if (!isAbsolute(stopPath)) throw new Error("AB_DEMO_STOP_FILE must be an absolute native Windows path");
  const timeout = Number(process.env.AB_DEMO_TIMEOUT_MS || 15 * 60_000);
  if (!Number.isInteger(timeout) || timeout < 10_000 || timeout > 60 * 60_000) throw new Error("AB_DEMO_TIMEOUT_MS must be between 10000 and 3600000");
  test.setTimeout(timeout + 60_000);
  if (await exists(stopPath)) throw new Error(`A previous stop file exists: ${stopPath}`);
  await mkdir(dirname(infoPath), { recursive: true });
  const world = await startWorld();
  let info: Record<string, unknown> | undefined;
  const publish = async (value: unknown) => {
    const temp = `${infoPath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temp, infoPath);
  };
  try {
    const page = await world.open("search.html");
    info = {
      state: "ready", startedAt: new Date().toISOString(),
      platform: process.platform, bridgeHome: world.bridge.home, bridgePort: world.bridge.port,
      bridgeExecutable: world.config.bridgeExe, fixtureBase: world.fixture.base, fixtureAlt: world.fixture.alt,
      tabId: await world.tabId(page), extensionId: world.extensionId, runtime: world.runtime, stopFile: stopPath,
    };
    // Deliberately select fields above instead of serializing world.bridge, which includes the token.
    await publish(info);
    await testInfo.attach("runtime", { body: JSON.stringify(world.runtime, null, 2), contentType: "application/json" });
    console.log(`Windows demo ready: ${infoPath}`);
    await expect.poll(() => exists(stopPath), { timeout, intervals: [500], message: "waiting for the owned demo stop file" }).toBe(true);
    // Keep the startup assertion separate from the external OpenCode result scoring.
    expect((await world.admin("status.get")).browsers.some((browser: any) => browser.selected && browser.connected)).toBe(true);
  } finally {
    await world.stop();
    if (info) await publish({ ...info, state: "stopped", stoppedAt: new Date().toISOString() });
  }
});
