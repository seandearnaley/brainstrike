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

export async function installSettingsTestOverrides(
  page: Page,
  overrides: SerializableSettingsTestOverrides
): Promise<void> {
  await page.addInitScript((payload: SerializableSettingsTestOverrides) => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    browserWindow.__brainstrike_e2e_enable_settings_test_api__ = true;
    browserWindow.__brainstrikePendingSettingsTestOverrides__ = payload;
  }, overrides);

  const hooksInstalled = await page.evaluate((payload: SerializableSettingsTestOverrides) => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    browserWindow.__brainstrike_e2e_enable_settings_test_api__ = true;
    browserWindow.__brainstrikePendingSettingsTestOverrides__ = payload;
    browserWindow.__brainstrikeSettingsTestHooks__?.setSettingsTestOverrides(payload);
    return browserWindow.__brainstrikeSettingsTestHooks__ !== undefined;
  }, overrides);

  if (!hooksInstalled) {
    await page.reload({ waitUntil: 'load' });
    await page.evaluate((payload: SerializableSettingsTestOverrides) => {
      const browserWindow = window as unknown as BrowserOverrideWindow;
      browserWindow.__brainstrikeSettingsTestHooks__?.setSettingsTestOverrides(payload);
    }, overrides);
  }
}

export async function updateSettingsTestOverrides(
  page: Page,
  overrides: SerializableSettingsTestOverrides
): Promise<void> {
  await page.evaluate((payload: SerializableSettingsTestOverrides) => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    browserWindow.__brainstrike_e2e_enable_settings_test_api__ = true;
    const current = browserWindow.__brainstrikePendingSettingsTestOverrides__ ?? {};
    const nextOverrides: BrowserSettingsTestOverrides = { ...current };

    if (payload['accurateRuntimeAvailable'] !== undefined) {
      nextOverrides.accurateRuntimeAvailable = payload['accurateRuntimeAvailable'];
    }

    if (payload['modelRegistry']) {
      nextOverrides.modelRegistry = {
        ...(current.modelRegistry ?? {}),
        ...payload['modelRegistry'],
      };
    }

    if (payload['localRuntime']) {
      const nextLocalRuntime: LocalRuntimeProbeOverride = {
        ...(current.localRuntime ?? {}),
        ...(payload['localRuntime']['statuses']
          ? { statuses: payload['localRuntime']['statuses'] }
          : {}),
      };

      nextOverrides.localRuntime = nextLocalRuntime;
    }

    browserWindow.__brainstrikePendingSettingsTestOverrides__ = nextOverrides;
    browserWindow.__brainstrikeSettingsTestHooks__?.updateSettingsTestOverrides(payload);
  }, overrides);
}

export async function readLocalRuntimeProbeCounts(
  page: Page
): Promise<Partial<Record<LocalRuntimeId, number>>> {
  return await page.evaluate(() => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    return browserWindow.__brainstrikeSettingsTestHooks__?.readLocalRuntimeProbeCounts() ?? {};
  });
}

export async function resetLocalRuntimeProbeCounts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    browserWindow.__brainstrikeSettingsTestHooks__?.resetLocalRuntimeProbeCounts();
  });
}
