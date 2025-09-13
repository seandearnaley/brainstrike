import { test as base } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { closeElectronApp, launchElectronApp, waitForAppReady } from './electron-helpers';

// Module-scoped boot state reused across tests in the same worker
let appRef: ElectronApplication | null = null;
let windowRef: Page | null = null;
let bootingRef: Promise<void> | null = null;

async function ensureBooted(): Promise<void> {
  if (appRef && windowRef) return;
  if (bootingRef) return await bootingRef;
  bootingRef = (async () => {
    const { app, window } = await launchElectronApp();
    await waitForAppReady(window);
    appRef = app;
    windowRef = window;
    bootingRef = null;
  })();
  await bootingRef;
}

export const test = base.extend<{ electronApp: ElectronApplication; electronWindow: Page }>({
  electronApp: async ({}, use) => {
    await ensureBooted();
    if (!appRef) throw new Error('Electron app not booted');
    await use(appRef);
  },
  electronWindow: async ({}, use) => {
    await ensureBooted();
    if (!windowRef) throw new Error('Electron window not available');
    await use(windowRef);
  },
});

base.afterAll(async () => {
  if (appRef && windowRef) {
    try {
      await closeElectronApp({ app: appRef, window: windowRef });
    } catch (error) {
      // Log cleanup errors to aid debugging (non-fatal)
      // eslint-disable-next-line no-console
      console.warn('Failed to cleanup Electron app:', error);
    }
  }
  appRef = null;
  windowRef = null;
  bootingRef = null;
});

export const expect = test.expect;
