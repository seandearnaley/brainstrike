import type { Page } from '@playwright/test';
import { resolveDesktopDevRendererConfig } from '../../src/desktop-renderer-config';
import { loadElectronHelpers } from '../utils/load-electron-helpers';

export type { Page } from '@playwright/test';
export type { ElectronApplication } from 'playwright';
export { expect, test } from '../fixtures/electron-fixture';

const desktopDevRendererConfig = resolveDesktopDevRendererConfig(
  process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']
);
if (desktopDevRendererConfig.kind === 'invalid-override') {
  throw new Error(
    `Invalid BRAINSTRIKE_DESKTOP_DEV_SERVER_URL override: ${desktopDevRendererConfig.configuredUrl}`
  );
}

export async function waitForAppReadyInTest(page: Page): Promise<void> {
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(page);
}

export function withTemporaryProcessEnv(overrides: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
