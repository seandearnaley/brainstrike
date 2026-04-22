import { describe, expect, it, vi } from 'vitest';
import {
  __installSettingsTestHooksOnWindowForTests,
  installSettingsTestOverrides,
  updateSettingsTestOverrides,
} from '../settings-test-overrides';

interface MockPage {
  addInitScript: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
}

function createMockPage(): MockPage {
  return {
    addInitScript: vi.fn(async () => {}),
    evaluate: vi.fn(async (pageFunction: unknown) => {
      if (
        typeof pageFunction === 'function' &&
        pageFunction
          .toString()
          .includes('return browserWindow.__brainstrikeSettingsTestHooks__ !== undefined')
      ) {
        return true;
      }
      return;
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
    const modulePath = new URL(
      '../../../packages/preferences/src/testing/e2e-settings-test-overrides.ts',
      import.meta.url
    ).pathname;
    const { mergeSettingsTestOverrides } = (await import(modulePath)) as {
      mergeSettingsTestOverrides: (current: unknown, updates: unknown) => unknown;
    };

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
