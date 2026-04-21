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
  onProbe?: (runtimeId: LocalRuntimeId, options?: { readonly force?: boolean }) => void;
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
  __brainstrikeSettingsTestOverrides__?: BrowserSettingsTestOverrides;
};

declare global {
  interface Window {
    __brainstrikeLocalRuntimeProbeCounts__?: Partial<Record<LocalRuntimeId, number>>;
  }
}

export async function installSettingsTestOverrides(
  page: Page,
  overrides: SerializableSettingsTestOverrides
): Promise<void> {
  await page.addInitScript((payload: SerializableSettingsTestOverrides) => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    const nextOverrides: BrowserSettingsTestOverrides = {};

    if (payload['accurateRuntimeAvailable'] !== undefined) {
      nextOverrides.accurateRuntimeAvailable = payload['accurateRuntimeAvailable'];
    }

    if (payload['modelRegistry']) {
      nextOverrides.modelRegistry = payload['modelRegistry'];
    }

    if (payload['localRuntime']) {
      const nextLocalRuntime: LocalRuntimeProbeOverride = {};

      if (payload['localRuntime']['statuses']) {
        nextLocalRuntime.statuses = payload['localRuntime']['statuses'];
      }

      if (payload['localRuntime']['trackProbeCounts']) {
        nextLocalRuntime.onProbe = (runtimeId: LocalRuntimeId) => {
          browserWindow.__brainstrikeLocalRuntimeProbeCounts__ = {
            ...(browserWindow.__brainstrikeLocalRuntimeProbeCounts__ ?? {}),
            [runtimeId]: (browserWindow.__brainstrikeLocalRuntimeProbeCounts__?.[runtimeId] ?? 0) + 1,
          };
        };
      }

      nextOverrides.localRuntime = nextLocalRuntime;
    }

    browserWindow.__brainstrikeSettingsTestOverrides__ = nextOverrides;
    browserWindow.__brainstrikeLocalRuntimeProbeCounts__ = {};
  }, overrides);
}

export async function updateSettingsTestOverrides(
  page: Page,
  overrides: SerializableSettingsTestOverrides
): Promise<void> {
  await page.evaluate((payload: SerializableSettingsTestOverrides) => {
    const browserWindow = window as unknown as BrowserOverrideWindow;
    const current = browserWindow.__brainstrikeSettingsTestOverrides__ ?? {};
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

      if (payload['localRuntime']['trackProbeCounts']) {
        nextLocalRuntime.onProbe = (runtimeId: LocalRuntimeId) => {
          browserWindow.__brainstrikeLocalRuntimeProbeCounts__ = {
            ...(browserWindow.__brainstrikeLocalRuntimeProbeCounts__ ?? {}),
            [runtimeId]: (browserWindow.__brainstrikeLocalRuntimeProbeCounts__?.[runtimeId] ?? 0) + 1,
          };
        };
      }

      nextOverrides.localRuntime = nextLocalRuntime;
    }

    browserWindow.__brainstrikeSettingsTestOverrides__ = nextOverrides;
  }, overrides);
}

export async function readLocalRuntimeProbeCounts(
  page: Page
): Promise<Partial<Record<LocalRuntimeId, number>>> {
  return await page.evaluate(() => window.__brainstrikeLocalRuntimeProbeCounts__ ?? {});
}

export async function resetLocalRuntimeProbeCounts(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__brainstrikeLocalRuntimeProbeCounts__ = {};
  });
}
