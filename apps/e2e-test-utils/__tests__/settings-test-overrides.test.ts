import { describe, expect, it, vi } from 'vitest';
import {
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

    const hookInstallerCalls = page.addInitScript.mock.calls.filter(
      ([script]: [unknown]) =>
        typeof script === 'function' && script.name === 'installSettingsTestHooksOnWindow'
    );

    expect(hookInstallerCalls).toHaveLength(1);
    expect(page.addInitScript).toHaveBeenCalledTimes(2);
  });
});
