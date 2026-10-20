import path from 'node:path';
import { defineConfig } from '@playwright/test';

function directory(name) {
  const value = process.env[name];
  if (!(value && path.isAbsolute(value))) {
    throw new Error(`${name} must name an absolute scratch directory.`);
  }
  return value;
}

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  globalTimeout: 30_000,
  maxFailures: 0,
  outputDir: directory('NIGHTLY_PROOF_DIAGNOSTICS_DIR'),
  projects: [{ name: 'nightly-fix-proof' }],
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(directory('NIGHTLY_PROOF_RESULTS_DIR'), 'canary.json') }],
  ],
  retries: 0,
  testDir: import.meta.dirname,
  testMatch: 'canary.spec.mjs',
  timeout: 10_000,
  use: { trace: 'retain-on-failure' },
  workers: 1,
});
