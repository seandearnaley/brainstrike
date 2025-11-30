import os from 'node:os';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test as base, expect as baseExpect } from '@playwright/test';
import { HomePage } from '../page-objects/home-page';
import type { ElectronAppContext } from '../utils/electron-helpers';
import {
  closeElectronApp,
  launchElectronApp,
  resetAppState,
  waitForAppReady,
} from '../utils/electron-helpers';
import { resetToAppHome } from '../utils/test-reset';

type ElectronHarnessOptions = {
  readonly preserveState?: boolean;
};

class ElectronHarness {
  private context: ElectronAppContext | null = null;

  constructor(
    private readonly debugPort?: number,
    private readonly userDataDir?: string
  ) {}

  async ensureContext(): Promise<ElectronAppContext> {
    if (!this.context) {
      this.context = await launchElectronApp(this.debugPort, this.userDataDir);
      return this.context;
    }

    if (this.context.window.isClosed()) {
      await this.restart();
    }

    return this.context;
  }

  async ensureWindow(options?: ElectronHarnessOptions): Promise<Page> {
    const ctx = await this.ensureContext();
    const page = ctx.window;

    if (!options?.preserveState) {
      await this.resetRenderer(page);
    } else if (page.isClosed()) {
      await this.restart();
      return this.ensureWindow({ preserveState: false });
    }

    return page;
  }

  async restart(): Promise<ElectronAppContext> {
    if (this.context) {
      try {
        await closeElectronApp(this.context);
      } catch (error) {
        console.warn('Failed to close Electron app during restart:', error);
      }
    }

    this.context = await launchElectronApp(this.debugPort, this.userDataDir);
    return this.context;
  }

  async dispose(): Promise<void> {
    if (!this.context) {
      return;
    }

    try {
      await closeElectronApp(this.context);
    } finally {
      this.context = null;
    }
  }

  private async resetRenderer(page: Page): Promise<void> {
    if (page.isClosed()) {
      await this.restart();
      return;
    }

    try {
      await resetAppState(page);
    } catch (error) {
      console.warn('Failed to reset app state before reload:', error);
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);

    try {
      await resetToAppHome(page);
    } catch (error) {
      console.warn('Failed to reset app layout:', error);
    }
  }
}

type ElectronTestFixtures = {
  electronApp: ElectronAppContext;
  window: Page;
  homePage: HomePage;
};

type ElectronWorkerFixtures = {
  electron: ElectronHarness;
};

export const test = base.extend<ElectronTestFixtures, ElectronWorkerFixtures>({
  electron: [
    async ({}, use, workerInfo) => {
      const shardIndex = workerInfo.config.shard?.current ?? 0;
      const runSalt = getRunSalt();

      // Assign a unique debug port based on the shard index to prevent collisions
      // when running shards in parallel on the same host (e.g. in act or CI)
      const debugPort = deriveDebugPort(runSalt, shardIndex);
      // Also isolate user data directory
      const userDataDir = deriveUserDataDir(runSalt, shardIndex);

      const harness = new ElectronHarness(debugPort, userDataDir);
      try {
        await use(harness);
      } finally {
        await harness.dispose();
      }
    },
    { scope: 'worker' },
  ],

  electronApp: async ({ electron }, use) => {
    const context = await electron.ensureContext();
    await use(context);
  },

  window: async ({ electron }, use, testInfo: TestInfo) => {
    const preserveState = testInfo.annotations.some(
      (annotation) => annotation.type === 'preserve-electron-state'
    );

    const page = await electron.ensureWindow({ preserveState });
    await use(page);
  },

  homePage: async ({ window }, use) => {
    const homePage = new HomePage(window);
    await use(homePage);
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

function deriveDebugPort(runSalt: number, shardIndex: number): number | undefined {
  // Spread shards across an isolated slice of the port space that also varies per CI run
  const slot = runSalt % 1000; // keeps us under the 5xxxx range
  const basePort = 42_000 + slot * 10;
  return basePort + shardIndex;
}

function deriveUserDataDir(runSalt: number, shardIndex: number): string | undefined {
  const shardSuffix = Number.isInteger(shardIndex) ? shardIndex : 0;
  return path.join(os.tmpdir(), `brainstrike-test-user-data-${runSalt}-shard-${shardSuffix}`);
}
