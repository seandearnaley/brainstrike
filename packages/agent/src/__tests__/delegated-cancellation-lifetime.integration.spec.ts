import { expect, it, vi } from 'vitest';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import type { DelegatedRunIdentity } from '../mastra/delegated-run-publication';
import { createBackgroundFixture } from './fixtures/background-worker-runtime';

it('retains selected cancellation authority after native hooks release queued child output', async () => {
  const fixture = await createBackgroundFixture();
  const { runtime, backing, runtimeData, release, hold, database } = fixture;
  const binding = runtime.conversationBinding;
  if (!binding?.hooks?.afterToolCall) {
    throw new Error('Missing native cleanup hook');
  }
  const cleanup = vi.spyOn(binding.hooks, 'afterToolCall');
  release.resolve();
  hold.resolve();
  try {
    let target: DelegatedRunIdentity | undefined;
    for await (const chunk of await createStreamIteratorFromRuntime({
      memory: backing.memory,
      messages: [
        { id: 'queued-child', parts: [{ text: 'Read evidence', type: 'text' }], role: 'user' },
      ],
      runtime,
      runtimeData,
    })) {
      if (chunk.type === 'delegated-conversation-chunk') {
        target = chunk.identity;
      }
    }
    expect(cleanup).toHaveBeenCalled();
    if (!target) {
      throw new Error('Missing native invocation');
    }
    const signal = binding.getInvocationAbortSignal?.(target);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    binding.abortInvocations?.([target]);
    expect(signal?.aborted).toBe(true);
  } finally {
    await runtime.dispose();
    await database.close();
  }
});
