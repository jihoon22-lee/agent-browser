import { defineConfig } from '@playwright/test';
// Explicit opt-in only; never part of the deterministic CI testMatch.
export default defineConfig({testDir:'.',testMatch:'agent-metrics.spec.ts',workers:1,retries:0,timeout:20*60_000,reporter:'list',outputDir:'.artifacts/agent-metrics'});
