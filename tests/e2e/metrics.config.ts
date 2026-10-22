import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'browser-metrics.spec.ts',workers:1,retries:0,timeout:20*60_000,reporter:'list',outputDir:'.artifacts/metrics'});
