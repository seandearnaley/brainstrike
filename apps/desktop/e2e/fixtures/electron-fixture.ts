import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createFailureCollector,
  type FailureArtifactCollector,
} from '@brainstrike/test-utils/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { test as base, expect as baseExpect } from '@playwright/test';
import { HomePage } from '../page-objects/home-page';
import type { ElectronAppContext } from '../utils/electron-helpers.mts';
import { ElectronHarness } from './electron-harness';

interface ElectronTestOptions {
  /** Extra environment for every launch of the app in a spec (`test.use({ electronEnv: { LOG_LEVEL: 'info' } })`). */
  electronEnv: Readonly<Record<string, string>>;
}

interface ElectronTestFixtures {
  electron: ElectronHarness;
  electronApp: ElectronAppContext;
  electronHarness: ElectronHarness;
  /** Failure artifact collector - automatically captures diagnostics on test failure */
  failureCollector: FailureArtifactCollector;
  homePage: HomePage;
  window: Page;
}

export const test = base.extend<ElectronTestFixtures & ElectronTestOptions>({
  electron: async ({ electronEnv }, use, testInfo) => {
    const shardIndex = testInfo.config.shard?.current ?? 0;
    const workerIndex = testInfo.workerIndex;
    const runSalt = getRunSalt();
    const userDataDir = deriveUserDataDir(
      runSalt,
      shardIndex,
      workerIndex,
      testInfo.testId,
      testInfo.retry
    );

    const harness = new ElectronHarness(testInfo, undefined, userDataDir, electronEnv);
    try {
      await use(harness);
    } finally {
      try {
        await harness.dispose();
      } finally {
        await removeElectronUserDataDir(userDataDir);
      }
    }
  },

  electronApp: async ({ electron }, use) => {
    const context = await electron.ensureContext();
    await use(context);
  },
  electronEnv: [{}, { option: true }],

  electronHarness: async ({ electron }, use) => {
    await use(electron);
  },

  // BST-180: Failure artifact collector for enhanced test diagnostics
  failureCollector: async ({ window }, use, testInfo: TestInfo) => {
    const collector = createFailureCollector(window);

    await use(collector);

    // After test completes, attach diagnostics if the test failed
    await collector.attachDiagnosticsOnFailure(testInfo);
    collector.detach();
  },

  homePage: async ({ window }, use) => {
    const homePage = new HomePage(window);
    await use(homePage);
  },

  window: async ({ electron }, use, testInfo: TestInfo) => {
    const preserveState = testInfo.annotations.some(
      (annotation) => annotation.type === 'preserve-electron-state'
    );

    const page = await electron.ensureWindow({ preserveState });
    await use(page);
  },
});

export const expect = baseExpect;

function getRunSalt(): number {
  const candidates = [
    process.env['RUN_SALT'],
    process.env['GITHUB_RUN_ID'],
    process.env['GITHUB_RUN_NUMBER'],
  ];

  for (const value of candidates) {
    if (!value) {
      continue;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Fallback for local runs: wall-clock salt with modest bound to keep ports reasonable
  return Date.now() % 1_000_000;
}

function deriveUserDataDir(
  runSalt: number,
  shardIndex: number,
  workerIndex: number,
  testId: string,
  retry: number
): string | undefined {
  const shardSuffix = Number.isInteger(shardIndex) ? shardIndex : 0;
  const workerSuffix = Number.isInteger(workerIndex) ? workerIndex : 0;
  const retrySuffix = Number.isInteger(retry) ? retry : 0;
  const testSuffix = createHash('sha256').update(testId).digest('hex').slice(0, 12);
  return path.join(
    os.tmpdir(),
    `brainstrike-test-user-data-${runSalt}-shard-${shardSuffix}-worker-${workerSuffix}-test-${testSuffix}-retry-${retrySuffix}`
  );
}

async function removeElectronUserDataDir(userDataDir: string | undefined): Promise<void> {
  if (!userDataDir) {
    return;
  }

  try {
    await rm(userDataDir, { force: true, recursive: true });
  } catch (error) {
    console.warn('Failed to remove Electron userData directory after fixture teardown:', {
      error,
      userDataDir,
    });
  }
}
