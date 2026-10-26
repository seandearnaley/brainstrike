import type { Page } from '@playwright/test';

interface SerializableSettingsTestOverrides {
  accurateRuntimeAvailable?: boolean | null;
  modelRegistry?: {
    fetchErrorMessage?: string | null;
    snapshot?: {
      models?: unknown[];
      providers?: unknown[];
    };
  };
}

interface BrowserOverrideWindow {
  // biome-ignore lint/style/useNamingConvention: E2E browser test hook key intentionally uses double underscores.
  __brainstrike_e2e_enable_settings_test_api__?: boolean;
  __brainstrikePendingSettingsTestOverrides__?: SerializableSettingsTestOverrides;
  __brainstrikeSettingsTestHooks__?: {
    resetSettingsTestOverrides: () => void;
    setSettingsTestOverrides: (overrides: SerializableSettingsTestOverrides) => void;
    updateSettingsTestOverrides: (overrides: SerializableSettingsTestOverrides) => void;
  };
}

declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: E2E browser test hook key intentionally uses double underscores.
    __brainstrike_e2e_enable_settings_test_api__?: boolean;
  }
}

const pagesWithInstalledSettingsTestHooks = new WeakSet<Page>();

export async function installSettingsTestOverrides(
  page: Page,
  overrides: SerializableSettingsTestOverrides
): Promise<void> {
  await ensureSettingsTestHooksInstalled(page);
  await page.addInitScript((payload: SerializableSettingsTestOverrides) => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    browserWindow.__brainstrike_e2e_enable_settings_test_api__ = true;
    browserWindow.__brainstrikePendingSettingsTestOverrides__ = payload;
  }, overrides);

  await page.evaluate((payload: SerializableSettingsTestOverrides) => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    browserWindow.__brainstrike_e2e_enable_settings_test_api__ = true;
    const hooks = browserWindow.__brainstrikeSettingsTestHooks__;
    if (!hooks) {
      throw new Error('Settings test hooks were not installed before applying overrides');
    }
    hooks.setSettingsTestOverrides(payload);
  }, overrides);
}

export async function updateSettingsTestOverrides(
  page: Page,
  overrides: SerializableSettingsTestOverrides
): Promise<void> {
  await ensureSettingsTestHooksInstalled(page);
  await page.evaluate((payload: SerializableSettingsTestOverrides) => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    browserWindow.__brainstrike_e2e_enable_settings_test_api__ = true;
    const hooks = browserWindow.__brainstrikeSettingsTestHooks__;
    if (!hooks) {
      throw new Error('Settings test hooks were not installed before updating overrides');
    }
    hooks.updateSettingsTestOverrides(payload);
  }, overrides);
}

function installSettingsTestHooksOnWindow(): void {
  type HookApi = NonNullable<BrowserOverrideWindow['__brainstrikeSettingsTestHooks__']>;

  const browserWindow = window as unknown as BrowserOverrideWindow;
  if (browserWindow.__brainstrikeSettingsTestHooks__) {
    return;
  }

  // This function is serialized into Playwright's browser context, so keep the
  // merge explicit and cover every retained/updated field in the unit test.
  const mergeOverrides = (
    current: SerializableSettingsTestOverrides | undefined,
    updates: SerializableSettingsTestOverrides
  ): SerializableSettingsTestOverrides => ({
    ...(current ?? {}),
    ...(updates.accurateRuntimeAvailable === undefined
      ? {}
      : { accurateRuntimeAvailable: updates.accurateRuntimeAvailable }),
    ...(updates.modelRegistry
      ? {
          modelRegistry: {
            ...(current?.modelRegistry ?? {}),
            ...updates.modelRegistry,
          },
        }
      : {}),
  });

  const hooks: HookApi = {
    resetSettingsTestOverrides: () => {
      Reflect.deleteProperty(browserWindow, '__brainstrikePendingSettingsTestOverrides__');
    },
    setSettingsTestOverrides: (overrides: SerializableSettingsTestOverrides) => {
      browserWindow.__brainstrikePendingSettingsTestOverrides__ = overrides;
    },
    updateSettingsTestOverrides: (overrides: SerializableSettingsTestOverrides) => {
      browserWindow.__brainstrikePendingSettingsTestOverrides__ = mergeOverrides(
        browserWindow.__brainstrikePendingSettingsTestOverrides__,
        overrides
      );
    },
  };

  browserWindow.__brainstrikeSettingsTestHooks__ = hooks;
}

export function __installSettingsTestHooksOnWindowForTests(): void {
  installSettingsTestHooksOnWindow();
}

async function ensureSettingsTestHooksInstalled(page: Page): Promise<void> {
  if (!pagesWithInstalledSettingsTestHooks.has(page)) {
    await page.addInitScript(installSettingsTestHooksOnWindow);
    pagesWithInstalledSettingsTestHooks.add(page);
  }
  await page.evaluate(installSettingsTestHooksOnWindow);
  const hooksInstalled = await page.evaluate(() => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    return browserWindow.__brainstrikeSettingsTestHooks__ !== undefined;
  });

  if (!hooksInstalled) {
    throw new Error('Failed to install settings test hooks');
  }
}
