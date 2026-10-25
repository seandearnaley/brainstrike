import type {
  IndexConfig,
  IndexConfigCapability,
  IndexConfigPatch,
} from '@brainstrike/assistant-contract/index-config';
import type { Page } from '@playwright/test';

/**
 * The profile's search index config, read and changed through the renderer's production
 * `indexSearch` adapter: a refusal or fault rejects with the failure's own sentence.
 */

type ConfigHooks = typeof globalThis & {
  readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexConfigCapability };
};

/** Changes the profile's search index config through the agent host, as the Settings page does. */
export async function updateIndexConfig(page: Page, patch: IndexConfigPatch): Promise<IndexConfig> {
  return await page.evaluate(async (change) => {
    const capability = (globalThis as ConfigHooks).__brainstrikeTestHooks__?.indexSearch;
    if (!capability) {
      throw new Error('The index search capability is unavailable.');
    }
    return await capability.updateConfig(change);
  }, patch);
}

/** The profile's search index config as its owner saved it. */
export async function readIndexConfig(page: Page): Promise<IndexConfig> {
  return await page.evaluate(async () => {
    const capability = (globalThis as ConfigHooks).__brainstrikeTestHooks__?.indexSearch;
    if (!capability) {
      throw new Error('The index search capability is unavailable.');
    }
    return await capability.readConfig();
  });
}
