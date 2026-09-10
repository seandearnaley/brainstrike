import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import { createProviderCallWarningSink } from '../providers/provider-call-warnings';
import type { StreamChunk } from '../types';
import { resetMastraStreamHarness, setStreamPartFailure } from './fixtures/mastra-stream-harness';

vi.mock(
  '@ai-sdk/openai',
  async () => (await import('./fixtures/mastra-stream-harness')).openAiSdkMock
);
vi.mock(
  '@mastra/core/agent',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraAgentModuleMock
);
vi.mock(
  '@mastra/core/mastra',
  async () => (await import('./fixtures/mastra-stream-harness')).mastraCoreModuleMock
);

describe('provider warnings when the Mastra stream throws', () => {
  beforeEach(resetMastraStreamHarness);

  it('drains a captured warning before propagating an error with no mapped parts', async () => {
    const failure = new Error('Provider stream failed before its first mapped part');
    setStreamPartFailure(0, failure);
    const runtime = await createMastraAgentRuntime({
      runtime: { apiKey: 'test-key', provider: 'openai' },
    });
    // The adapter already reported stream-start under Mastra. This unit test
    // isolates the consumer throwing before it yields its first mapped part.
    runtime.providerCallWarnings = createProviderCallWarningSink();
    runtime.providerCallWarnings.record([{ feature: 'temperature', type: 'unsupported' }]);
    const iterator = await createStreamIteratorFromRuntime({
      messages: [{ id: 'u1', parts: [{ text: 'Answer.', type: 'text' }], role: 'user' }],
      runtime,
    });
    const chunks: StreamChunk[] = [];
    let caught: unknown;
    try {
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(
      chunks.filter(
        (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'provider.request.warned'
      )
    ).toHaveLength(1);
    expect(runtime.providerCallWarnings.drain()).toEqual([]);
  });
});
