/**
 * A provider's HTTP response headers name its account and request; the run log
 * never keeps them, while the step's response identity stays.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { finished, rowsUntil, setupChildRunHost, stream, text } from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

test('a committed step finish keeps its response identity and drops the provider headers', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      ...stream([
        {
          id: 'resp-1',
          modelId: 'served-model',
          timestamp: new Date(0),
          type: 'response-metadata',
        },
        ...text('Hello.'),
      ]),
      response: { headers: { 'openai-organization': 'org-secret', 'x-request-id': 'req-1' } },
    }),
  });
  const harness = await setupChildRunHost(model, cleanup);
  const runId = await harness.start('Say hello.');
  const rows = await rowsUntil(harness, harness.threadId, finished(runId), 5000);

  const finishes = rows.flatMap(({ event }) =>
    event.type === 'stream.chunk' &&
    typeof event.chunk === 'object' &&
    event.chunk !== null &&
    !Array.isArray(event.chunk) &&
    event.chunk['type'] === 'finish-step'
      ? [event.chunk]
      : []
  );
  expect(finishes).not.toHaveLength(0);
  for (const chunk of finishes) {
    expect(chunk['response']).toMatchObject({ id: 'resp-1', modelId: 'served-model' });
    expect(chunk['response']).not.toHaveProperty('headers');
  }
  expect(JSON.stringify(rows)).not.toContain('org-secret');
});
