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
import { loadElectronHelpers } from '../utils/load-electron-helpers';
import { resetToAppHome } from '../utils/test-reset';

interface ElectronHarnessOptions {
  readonly preserveState?: boolean;
}

class ElectronHarness {
  private context: ElectronAppContext | null = null;
  private hasProvidedWindow = false;
  private readonly maxRendererRecoveryAttempts = 1;

  constructor(
    private readonly testInfo: TestInfo,
    private readonly debugPort?: number,
    private readonly userDataDir?: string
  ) {}

  getUserDataDir(): string {
    if (!this.userDataDir) {
      throw new Error('Electron harness requires an isolated userDataDir.');
    }
    return this.userDataDir;
  }

  async ensureContext(): Promise<ElectronAppContext> {
    if (!this.context) {
      const { launchElectronApp } = await loadElectronHelpers();
      this.context = await launchElectronApp(this.debugPort, this.userDataDir, {
        disableExternalLocalRuntimeProbes: shouldDisableExternalLocalRuntimeProbes(this.testInfo),
      });
      return this.context;
    }

    if (!this.isContextAlive(this.context)) {
      await this.restart();
    }

    return this.context;
  }

  async ensureWindow(options?: ElectronHarnessOptions): Promise<Page> {
    const ctx = await this.ensureContext();
    let page = ctx.window;

    if (!options?.preserveState) {
      page = this.hasProvidedWindow
        ? await this.resetRenderer(page)
        : await this.prepareFreshWindow(page);
    } else if (page.isClosed()) {
      await this.restart();
      return this.ensureWindow({ preserveState: false });
    }

    this.hasProvidedWindow = true;
    return page;
  }

  async restart(): Promise<ElectronAppContext> {
    if (this.context) {
      try {
        const { closeElectronApp } = await loadElectronHelpers();
        await closeElectronApp(this.context);
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      } catch (error) {
        console.warn('Failed to close Electron app during restart:', error);
      }
    }

    const { launchElectronApp } = await loadElectronHelpers();
    this.context = await launchElectronApp(this.debugPort, this.userDataDir, {
      disableExternalLocalRuntimeProbes: shouldDisableExternalLocalRuntimeProbes(this.testInfo),
    });
    this.hasProvidedWindow = false;
    return this.context;
  }

  async dispose(): Promise<void> {
    if (!this.context) {
      return;
    }

    try {
      const { closeElectronApp } = await loadElectronHelpers();
      await closeElectronApp(this.context);
    } finally {
      this.context = null;
      this.hasProvidedWindow = false;
    }
  }

  private async prepareFreshWindow(page: Page): Promise<Page> {
    const { waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(page);
    await resetToAppHome(page);
    return page;
  }

  private async resetRenderer(page: Page): Promise<Page> {
    return this.resetRendererWithRecovery(page, 0);
  }

  private async resetRendererWithRecovery(page: Page, recoveryAttempt: number): Promise<Page> {
    if (page.isClosed()) {
      return this.restartAndResetRenderer(recoveryAttempt, 'Renderer page was already closed.');
    }

    const { reloadRenderer, resetAppState, waitForAppReady } = await loadElectronHelpers();
    await page.addInitScript(() => {
      (
        window as Window & {
          // biome-ignore lint/style/useNamingConvention: Test-only global flag uses double underscores by convention
          __brainstrike_e2e_expose_file_explorer_store__?: boolean;
        }
      ).__brainstrike_e2e_expose_file_explorer_store__ = true;
    });
    await waitForAppReady(page);

    try {
      await resetAppState(page);
    } catch (error) {
      if (this.isRecoverableRendererError(error)) {
        return this.restartAndResetRenderer(
          recoveryAttempt,
          `Renderer state reset failed due to page crash/closure: ${String(error)}`
        );
      }
      throw error;
    }

    try {
      await reloadRenderer(page, 'playwright-reset-renderer');
    } catch (error) {
      if (this.isRecoverableRendererError(error)) {
        return this.restartAndResetRenderer(
          recoveryAttempt,
          `Renderer reset failed due to page crash/closure: ${String(error)}`
        );
      }
      throw error;
    }

    await resetToAppHome(page);

    return page;
  }

  private isContextAlive(context: ElectronAppContext): boolean {
    if (context.window.isClosed()) {
      return false;
    }

    const process = context.app.process();
    if (process.exitCode !== null || process.killed) {
      return false;
    }

    try {
      return context.app.windows().some((window) => !window.isClosed());
    } catch {
      return false;
    }
  }

  private isRecoverableRendererError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const normalizedMessage = error.message.toLowerCase();
    return (
      normalizedMessage.includes('page crashed') ||
      normalizedMessage.includes('net::err_file_not_found') ||
      normalizedMessage.includes('target page, context or browser has been closed') ||
      normalizedMessage.includes('navigation failed because page crashed') ||
      normalizedMessage.includes('navigation failed because page was closed')
    );
  }

  private async restartAndResetRenderer(recoveryAttempt: number, reason: string): Promise<Page> {
    if (recoveryAttempt >= this.maxRendererRecoveryAttempts) {
      throw new Error(
        `Renderer reset failed after ${this.maxRendererRecoveryAttempts + 1} attempt(s). ${reason}`
      );
    }

    console.warn(`Restarting Electron app during renderer reset. ${reason}`);
    const restartedContext = await this.restart();
    return this.resetRendererWithRecovery(restartedContext.window, recoveryAttempt + 1);
  }
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

function shouldDisableExternalLocalRuntimeProbes(testInfo: TestInfo): boolean {
  return !testInfo.file.endsWith(`${path.sep}local-runtime-probe.desktop.test.ts`);
}

export const test = base.extend<ElectronTestFixtures>({
  electron: async ({}, use, testInfo) => {
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

    const harness = new ElectronHarness(testInfo, undefined, userDataDir);
    try {
      await use(harness);
    } finally {
      await harness.dispose();
      await removeElectronUserDataDir(userDataDir);
    }
  },

  electronApp: async ({ electron }, use) => {
    const context = await electron.ensureContext();
    await use(context);
  },

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

// NOTE: deriveDebugPort was removed - Playwright now manages CDP ports automatically
// to prevent "Waiting for debugger to disconnect" hangs in CI.

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
