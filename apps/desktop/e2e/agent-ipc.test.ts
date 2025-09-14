import type { StreamChunk } from '@brainstrike/agent';
import { expect, test } from '@playwright/test';
import type { ElectronAppContext } from './utils/electron-helpers';
import { closeElectronApp, launchElectronApp, waitForAppReady } from './utils/electron-helpers';

test.describe('Agent IPC', () => {
  let appContext: ElectronAppContext;

  test.beforeEach(async () => {
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
  });

  test.afterEach(async () => {
    if (appContext) await closeElectronApp(appContext);
  });

  test('returns streamed chunks for a simple prompt', async () => {
    const result = await appContext.window.evaluate(async () => {
      const msgs = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello world' }] }];
      const chunks = await window.agent?.chat?.(msgs, { projectId: 'e2e' });
      return chunks;
    });

    expect(Array.isArray(result)).toBe(true);
    // Expect at least a tool-event or text-delta
    const types = new Set((result as StreamChunk[]).map((c) => c.type));
    expect(types.has('text-delta') || types.has('tool-event')).toBe(true);
  });
});
