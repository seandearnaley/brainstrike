import type { Fixtures, Page, TestInfo } from '@playwright/test';
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

interface ElectronHarnessOptions {
  readonly preserveState?: boolean;
}

class ElectronHarness {
  private context: ElectronAppContext | null = null;

  async ensureContext(): Promise<ElectronAppContext> {
    if (!this.context) {
      this.context = await launchElectronApp();
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

    this.context = await launchElectronApp();
    return this.context;
  }

  async dispose(): Promise<void> {
    if (!this.context) return;

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

export type ElectronWorkerFixtures = {
  electron: ElectronHarness;
};

export type ElectronTestFixtures = {
  electronApp: ElectronAppContext;
  window: Page;
  homePage: HomePage;
};

const electronFixtures: Fixtures<ElectronTestFixtures, ElectronWorkerFixtures> = {
  electron: [
    async ({}, use: (harness: ElectronHarness) => Promise<void>) => {
      const harness = new ElectronHarness();
      try {
        await use(harness);
      } finally {
        await harness.dispose();
      }
    },
    { scope: 'worker' },
  ],

  electronApp: async ({ electron }, use: (context: ElectronAppContext) => Promise<void>) => {
    const context = await electron.ensureContext();
    await use(context);
  },

  window: async ({ electron }, use: (page: Page) => Promise<void>, testInfo: TestInfo) => {
    const preserveState = testInfo.annotations.some((annotation) => {
      return annotation.type === 'preserve-electron-state';
    });

    const page = await electron.ensureWindow({ preserveState });
    await use(page);
  },

  homePage: async ({ window }, use: (homePage: HomePage) => Promise<void>) => {
    const homePage = new HomePage(window);
    await use(homePage);
  },
};

export const test = base.extend<ElectronTestFixtures, ElectronWorkerFixtures>(electronFixtures);

export const expect = baseExpect;
