import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: process.env.AB_E2E_DEMO === "1" ? "windows-demo.spec.ts" : ["cdp-capabilities.spec.ts", "advanced-browser.spec.ts", "journeys.spec.ts", "scenarios.spec.ts", "workbench.spec.ts", "new-tabs.spec.ts", "board-navigation.spec.ts", "browser-capabilities.spec.ts", "bookmarks.spec.ts", "issue8-content.spec.ts", "issue8-requests.spec.ts", "issue8-timing.spec.ts", "reliability.spec.ts", "trusted-input.spec.ts", "pointer-keys-upload.spec.ts", "browser-quality.spec.ts", "input-safety.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: "list",
  outputDir: ".artifacts",
});
