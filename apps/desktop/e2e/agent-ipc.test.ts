import type { StreamChunk } from '@brainstrike/agent';
import { expect, test } from './fixtures/electron-fixture';

test.describe('Agent IPC', () => {
  test('returns streamed chunks for a simple prompt', async ({ window }) => {
    const result = await window.evaluate(async () => {
      const msgs = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello world' }] }];
      const globals = window as unknown as {
        agent?: { chat?: (messages: typeof msgs, runtime?: unknown) => Promise<unknown[]> };
      };
      const chunks = await globals.agent?.chat?.(msgs, { projectId: 'e2e', provider: 'openai' });
      return chunks;
    });

    expect(Array.isArray(result)).toBe(true);
    // Expect at least a tool-event or text-delta
    const types = new Set((result as StreamChunk[]).map((c) => c.type));
    expect(types.has('text-delta') || types.has('tool-event')).toBe(true);
  });
});
