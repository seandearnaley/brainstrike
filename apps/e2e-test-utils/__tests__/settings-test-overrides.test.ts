import { describe, expect, it, vi } from 'vitest';
import {
  __installSettingsTestHooksOnWindowForTests,
  installSettingsTestOverrides,
  readLocalRuntimeProbeCounts,
  resetLocalRuntimeProbeCounts,
  updateSettingsTestOverrides,
} from '../settings-test-overrides';

interface BrowserWindowStub {
  // biome-ignore lint/style/useNamingConvention: mirrors the browser hook key the helper sets.
  __brainstrike_e2e_enable_settings_test_api__?: boolean;
  __brainstrikeLocalRuntimeProbeCounts__?: Record<string, number>;
  __brainstrikePendingSettingsTestOverrides__?: unknown;
  __brainstrikeSettingsTestHooks__?: unknown;
}

interface MockPage {
  addInitScript: ReturnType<typeof vi.fn>;
  browserWindow: BrowserWindowStub;
  evaluate: ReturnType<typeof vi.fn>;
}

/**
 * Runs a page callback with `window` bound to a stub, the way Playwright would run it
 * in the browser. Executing the callbacks — rather than only recording that they were
 * passed — is what lets these tests cover the hook installation and merge behaviour.
 */
function runInBrowser<T>(browserWindow: BrowserWindowStub, run: () => T): T {
  const globalObject = globalThis as { window?: unknown };
  const originalWindow = globalObject.window;
  globalObject.window = browserWindow;
  try {
    return run();
  } finally {
    globalObject.window = originalWindow;
  }
}

function createMockPage(
  options: { beforeEvaluate?: (browserWindow: BrowserWindowStub) => void } = {}
): MockPage {
  const browserWindow: BrowserWindowStub = {};
  return {
    addInitScript: vi.fn(async (script: unknown, argument?: unknown) => {
      if (typeof script === 'function') {
        runInBrowser(browserWindow, () => (script as (value?: unknown) => void)(argument));
      }
    }),
    browserWindow,
    evaluate: vi.fn(async (pageFunction: unknown, argument?: unknown) => {
      options.beforeEvaluate?.(browserWindow);
      if (typeof pageFunction !== 'function') {
        return;
      }
      return runInBrowser(browserWindow, () =>
        (pageFunction as (value?: unknown) => unknown)(argument)
      );
    }),
  };
}

describe('settings test overrides helper', () => {
  it('registers the hook installer init script only once per page', async () => {
    const page = createMockPage();

    await installSettingsTestOverrides(page as never, {
      accurateRuntimeAvailable: true,
    });
    await updateSettingsTestOverrides(page as never, {
      modelRegistry: { fetchErrorMessage: 'retry failed' },
    });

    const hookInstallerCalls = page.addInitScript.mock.calls.filter((call) => {
      const [script] = call;
      return typeof script === 'function' && script.name === 'installSettingsTestHooksOnWindow';
    });

    expect(hookInstallerCalls).toHaveLength(1);
    expect(page.addInitScript).toHaveBeenCalledTimes(2);
  });

  it('applies overrides through the browser hooks and enables the test API', async () => {
    const page = createMockPage();

    await installSettingsTestOverrides(page as never, {
      accurateRuntimeAvailable: true,
      modelRegistry: { fetchErrorMessage: 'initial error' },
    });

    expect(page.browserWindow.__brainstrike_e2e_enable_settings_test_api__).toBe(true);
    expect(page.browserWindow.__brainstrikePendingSettingsTestOverrides__).toEqual({
      accurateRuntimeAvailable: true,
      modelRegistry: { fetchErrorMessage: 'initial error' },
    });
  });

  it('merges successive updates into the pending overrides', async () => {
    const page = createMockPage();

    await installSettingsTestOverrides(page as never, {
      accurateRuntimeAvailable: true,
      modelRegistry: { fetchErrorMessage: 'initial error' },
    });
    await updateSettingsTestOverrides(page as never, {
      modelRegistry: { snapshot: { downloadedModels: { 'local:test-model': true } } },
    });

    expect(page.browserWindow.__brainstrikePendingSettingsTestOverrides__).toEqual({
      accurateRuntimeAvailable: true,
      modelRegistry: {
        fetchErrorMessage: 'initial error',
        snapshot: { downloadedModels: { 'local:test-model': true } },
      },
    });
  });

  it('reads probe counts, defaulting to an empty record', async () => {
    const page = createMockPage();

    expect(await readLocalRuntimeProbeCounts(page as never)).toEqual({});

    page.browserWindow.__brainstrikeLocalRuntimeProbeCounts__ = { ollama: 3 };
    expect(await readLocalRuntimeProbeCounts(page as never)).toEqual({ ollama: 3 });
  });

  it('resets probe counts', async () => {
    const page = createMockPage();
    page.browserWindow.__brainstrikeLocalRuntimeProbeCounts__ = { lmstudio: 2 };

    await resetLocalRuntimeProbeCounts(page as never);

    expect(page.browserWindow.__brainstrikeLocalRuntimeProbeCounts__).toEqual({});
  });

  it('throws when the page never installs the hooks', async () => {
    // A page whose init scripts and evaluations never take effect — the hook-presence
    // probe returns undefined, so installation must be reported rather than assumed.
    const inertPage = { addInitScript: vi.fn(async () => {}), evaluate: vi.fn(async () => {}) };

    await expect(installSettingsTestOverrides(inertPage as never, {})).rejects.toThrow(
      'Failed to install settings test hooks'
    );
  });

  it('throws when the hooks disappear between installation and use', async () => {
    let evaluateCount = 0;
    const page = createMockPage({
      beforeEvaluate: (browserWindow) => {
        evaluateCount += 1;
        // The first two evaluations install and verify the hooks; drop them
        // immediately before the payload is applied.
        if (evaluateCount === 3) {
          Reflect.deleteProperty(browserWindow, '__brainstrikeSettingsTestHooks__');
        }
      },
    });

    await expect(
      installSettingsTestOverrides(page as never, { accurateRuntimeAvailable: true })
    ).rejects.toThrow('Settings test hooks were not installed before applying overrides');
  });

  it('keeps browser hook merge behavior aligned with the canonical merge helper', async () => {
    const globalObject = globalThis as {
      window?:
        | {
            __brainstrikePendingSettingsTestOverrides__?: unknown;
            __brainstrikeSettingsTestHooks__?: {
              updateSettingsTestOverrides: (overrides: unknown) => void;
            };
          }
        | undefined;
    };
    const originalWindow = globalObject.window;
    const browserWindow = {} as NonNullable<typeof globalObject.window>;
    const { mergeSettingsTestOverrides } = await import(
      '@brainstrike/preferences/testing/e2e-settings-test-overrides'
    );

    try {
      globalObject.window = browserWindow;
      __installSettingsTestHooksOnWindowForTests();

      const current = {
        accurateRuntimeAvailable: true,
        localRuntime: {
          statuses: {
            ollama: {
              checkedAt: 1,
              endpoint: 'http://localhost:11434',
              latencyMs: 10,
              state: 'available' as const,
            },
          },
        },
        modelRegistry: {
          fetchErrorMessage: 'initial error',
        },
      };
      const updates = {
        accurateRuntimeAvailable: null,
        localRuntime: {
          statuses: {
            lmstudio: {
              checkedAt: 2,
              message: 'blocked',
              state: 'blocked_web' as const,
            },
          },
        },
        modelRegistry: {
          snapshot: {
            downloadedModels: { 'local:test-model': true },
          },
        },
      };

      browserWindow.__brainstrikePendingSettingsTestOverrides__ = current;
      browserWindow.__brainstrikeSettingsTestHooks__?.updateSettingsTestOverrides(updates);

      expect(browserWindow.__brainstrikePendingSettingsTestOverrides__).toEqual(
        mergeSettingsTestOverrides(current, updates)
      );
    } finally {
      globalObject.window = originalWindow;
    }
  });
});
