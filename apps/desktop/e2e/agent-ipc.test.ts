import { expect, test } from './fixtures/electron-fixture';

test('Desktop exposes the shared host and no second aggregate agent loop', async ({
  window: page,
}) => {
  const capabilities = await page.evaluate(() => ({
    legacy: 'agent' in window,
    sharedHost: typeof (window as typeof window & { agentHost?: { connect?: unknown } }).agentHost
      ?.connect,
  }));
  expect(capabilities).toEqual({ legacy: false, sharedHost: 'function' });
});
