import agentDevToolsDefaults from '../agent-devtools-defaults.json' with { type: 'json' };
import { expect, test } from './fixtures/electron-fixture';

interface DevtoolsTarget {
  readonly type?: string;
  readonly url?: string;
}

test.describe('Agent DevTools endpoint', { tag: '@smoke' }, () => {
  test.skip(process.env['BRAINSTRIKE_E2E_AGENT_DEVTOOLS'] !== '1', 'Agent DevTools is opt-in.');

  test('is available only when the opt-in debug env is enabled', async ({ electronApp }) => {
    const url = `http://127.0.0.1:${agentDevToolsDefaults.defaultPort}/json/list`;
    await expect
      .poll(
        async (): Promise<boolean> => {
          try {
            const response = await fetch(url);
            if (!response.ok) {
              return false;
            }
            const targets = (await response.json()) as DevtoolsTarget[];
            return targets.some(
              (target: DevtoolsTarget): boolean => target.type === 'page' && Boolean(target.url)
            );
          } catch {
            return false;
          }
        },
        { intervals: [250, 500, 1000], timeout: 10_000 }
      )
      .toBe(true);
    await expect(electronApp.window).toHaveTitle(/BrainStrike/i);
  });
});
