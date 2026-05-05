import type { Page } from '@playwright/test';

type LocalRuntimeId = 'ollama' | 'lmstudio';

type LocalRuntimeAvailabilityState =
  | {
      readonly checkedAt: number;
      readonly endpoint: string;
      readonly latencyMs: number;
      readonly state: 'available';
    }
  | {
      readonly checkedAt: number;
      readonly detail?: string;
      readonly hint?: string;
      readonly message?: string;
      readonly state: 'unavailable';
    }
  | {
      readonly checkedAt: number;
      readonly message: string;
      readonly state: 'blocked_web';
    }
  | {
      readonly checkedAt: number;
      readonly endpoint: string;
      readonly state: 'auth_required';
      readonly status: 401 | 403;
    }
  | {
      readonly checkedAt: number;
      readonly endpoint: string;
      readonly message: string;
      readonly state: 'incompatible';
    }
  | {
      readonly checkedAt: number;
      readonly endpoint: string;
      readonly lastSuccessfulAt: number;
      readonly message?: string;
      readonly reason: 'unavailable' | 'blocked_web' | 'auth_required' | 'incompatible';
      readonly state: 'stale';
    };

type LocalRuntimeProbeOverride = {
  statuses?: Partial<Record<LocalRuntimeId, LocalRuntimeAvailabilityState>>;
};

type SerializableSettingsTestOverrides = {
  accurateRuntimeAvailable?: boolean | null;
  localRuntime?: Omit<LocalRuntimeProbeOverride, 'onProbe'> & {
    trackProbeCounts?: boolean;
  };
  modelRegistry?: {
    cacheDirectorySelection?: {
      errorMessage?: string;
      path?: string | null;
      unavailable?: boolean;
    } | null;
    fetchErrorMessage?: string | null;
    snapshot?: {
      downloadedModels?: Record<string, boolean>;
      modelCacheDir?: string | null;
      models?: unknown[];
      providers?: unknown[];
    };
  };
};

type BrowserSettingsTestOverrides = Omit<SerializableSettingsTestOverrides, 'localRuntime'> & {
  localRuntime?: LocalRuntimeProbeOverride;
};

type BrowserOverrideWindow = {
  __brainstrikeLocalRuntimeProbeCounts__?: Partial<Record<LocalRuntimeId, number>>;
  __brainstrikePendingSettingsTestOverrides__?: BrowserSettingsTestOverrides;
  __brainstrikeSettingsTestHooks__?: {
    readLocalRuntimeProbeCounts: () => Partial<Record<LocalRuntimeId, number>>;
    resetLocalRuntimeProbeCounts: () => void;
    resetSettingsTestOverrides: () => void;
    setSettingsTestOverrides: (overrides: BrowserSettingsTestOverrides) => void;
    updateSettingsTestOverrides: (overrides: BrowserSettingsTestOverrides) => void;
  };
  __brainstrike_e2e_enable_settings_test_api__?: boolean;
};

declare global {
  interface Window {
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

export async function readLocalRuntimeProbeCounts(
  page: Page
): Promise<Partial<Record<LocalRuntimeId, number>>> {
  await ensureSettingsTestHooksInstalled(page);
  return await page.evaluate(() => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    return browserWindow.__brainstrikeSettingsTestHooks__?.readLocalRuntimeProbeCounts() ?? {};
  });
}

export async function resetLocalRuntimeProbeCounts(page: Page): Promise<void> {
  await ensureSettingsTestHooksInstalled(page);
  await page.evaluate(() => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    browserWindow.__brainstrikeSettingsTestHooks__?.resetLocalRuntimeProbeCounts();
  });
}

function installSettingsTestHooksOnWindow(): void {
  type HookApi = NonNullable<BrowserOverrideWindow['__brainstrikeSettingsTestHooks__']>;

  const browserWindow = window as unknown as BrowserOverrideWindow;
  if (browserWindow.__brainstrikeSettingsTestHooks__) {
    return;
  }

  const resetProbeCounts = (): void => {
    browserWindow.__brainstrikeLocalRuntimeProbeCounts__ = {};
  };

  // Keep this browser-serialized merge behavior aligned with
  // `packages/preferences/src/testing/e2e-settings-test-overrides.ts`.
  const mergeOverrides = (
    current: BrowserSettingsTestOverrides | undefined,
    updates: BrowserSettingsTestOverrides
  ): BrowserSettingsTestOverrides => {
    return {
      ...(current ?? {}),
      ...(updates.accurateRuntimeAvailable === undefined
        ? {}
        : { accurateRuntimeAvailable: updates.accurateRuntimeAvailable }),
      ...(updates.localRuntime
        ? {
            localRuntime: {
              ...(current?.localRuntime ?? {}),
              ...updates.localRuntime,
            },
          }
        : {}),
      ...(updates.modelRegistry
        ? {
            modelRegistry: {
              ...(current?.modelRegistry ?? {}),
              ...updates.modelRegistry,
            },
          }
        : {}),
    };
  };

  const hooks: HookApi = {
    readLocalRuntimeProbeCounts: () => browserWindow.__brainstrikeLocalRuntimeProbeCounts__ ?? {},
    resetLocalRuntimeProbeCounts: () => {
      resetProbeCounts();
    },
    resetSettingsTestOverrides: () => {
      delete browserWindow.__brainstrikePendingSettingsTestOverrides__;
      resetProbeCounts();
    },
    setSettingsTestOverrides: (overrides: BrowserSettingsTestOverrides) => {
      browserWindow.__brainstrikePendingSettingsTestOverrides__ = overrides;
      resetProbeCounts();
    },
    updateSettingsTestOverrides: (overrides: BrowserSettingsTestOverrides) => {
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
