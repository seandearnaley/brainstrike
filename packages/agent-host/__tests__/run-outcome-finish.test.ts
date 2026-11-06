import { expect, test } from 'vitest';
import { HostRunOutcome } from '../src/run-outcome.ts';

const usage = {
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 12 },
  inputTokens: 12,
  outputTokenDetails: { reasoningTokens: 0, textTokens: 3 },
  outputTokens: 3,
  totalTokens: 15,
};

test('a reply the provider cut off before it finished fails the run with that reason', () => {
  const outcome = new HostRunOutcome(
    { model: 'claude-sonnet-4.6', provider: 'anthropic' },
    'chat',
    false,
    { runId: 'run-1', threadId: 'thread-1' }
  );
  outcome.observe({ id: 'text-1', text: 'The first half of an', type: 'text-delta' });
  // AI SDK providers report a stream that ended without its completion signal as `interrupted`.
  outcome.observe({
    finishReason: 'interrupted',
    rawFinishReason: undefined,
    totalUsage: usage,
    type: 'finish',
  });
  expect(outcome.detail()).toBe(
    'Assistant stopped because the provider cut off the response before it finished.'
  );
});
