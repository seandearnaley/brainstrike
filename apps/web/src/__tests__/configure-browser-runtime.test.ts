import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const configureBrowserRuntimeAccessMock = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/app-state/stores/assistant-preferences-store', () => ({
  configureBrowserRuntimeAccess: configureBrowserRuntimeAccessMock,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

test.each([true, false])(
  'configures direct runtime access only in production (%s)',
  async (production) => {
    vi.stubEnv('PROD', production);
    await import('../configure-browser-runtime');
    if (!production) {
      expect(configureBrowserRuntimeAccessMock).not.toHaveBeenCalled();
      return;
    }
    expect(configureBrowserRuntimeAccessMock).toHaveBeenCalledExactlyOnceWith(
      'This web app does not permit direct connections to local runtimes. Use the desktop app to connect to Ollama or LM Studio.'
    );
  }
);
