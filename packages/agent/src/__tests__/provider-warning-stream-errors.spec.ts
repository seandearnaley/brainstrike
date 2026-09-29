/** Production attempt-stream warning drains across synthetic terminal/error parts. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMastraAgentRuntime } from '../mastra/agent-runtime';
import { createStreamIteratorFromRuntime } from '../mastra/attempt-legs';
import type { StreamChunk } from '../types';
import {
  resetMastraStreamHarness,
  setMockStreamParts,
  setStreamPartFailure,
} from './fixtures/mastra-stream-harness';

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

  it.each(['finish', 'missing-finish'] as const)(
    'publishes late warnings before the %s stops the consumer',
    async (ending) => {
      setMockStreamParts([
        { textDelta: 'Answer.', type: 'text-delta' },
        ...(ending === 'finish'
          ? [
              {
                finishReason: 'stop',
                type: 'finish',
                usage: { completionTokens: 1, promptTokens: 1 },
              },
            ]
          : []),
      ]);
      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });
      const chunks: StreamChunk[] = [];
      try {
        const iterator = await createStreamIteratorFromRuntime({
          messages: [{ id: 'u1', parts: [{ text: 'Answer.', type: 'text' }], role: 'user' }],
          runtime,
        });
        for await (const chunk of iterator) {
          chunks.push(chunk);
          if (chunk.type === 'text-delta') {
            runtime.providerCallWarnings.record([{ feature: 'temperature', type: 'unsupported' }]);
          }
          if (chunk.type === 'run-event' && chunk.event.kind === 'provider.request.warned') {
            runtime.providerCallWarnings.record([{ setting: 'maxTokens', type: 'deprecated' }]);
          }
          if (chunk.type === 'message-finish') {
            break;
          }
        }
        expect(chunks.at(-1)?.type).toBe('message-finish');
        expect(
          chunks.filter(
            (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'provider.request.warned'
          )
        ).toHaveLength(2);
        expect(runtime.providerCallWarnings.drain()).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    }
  );

  it.each([false, true])(
    'drains captured warnings before propagating an error (late warning: %s)',
    async (lateWarning) => {
      const failure = new Error('Provider stream failed before its first mapped part');
      setStreamPartFailure(0, failure);
      const runtime = await createMastraAgentRuntime({
        runtime: { apiKey: 'test-key', provider: 'openai' },
      });
      // The adapter already reported stream-start under Mastra. This unit test
      // isolates the consumer throwing before it yields its first mapped part.
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
          if (
            lateWarning &&
            chunk.type === 'run-event' &&
            chunk.event.kind === 'provider.request.warned'
          ) {
            runtime.providerCallWarnings.record([{ setting: 'maxTokens', type: 'deprecated' }]);
          }
        }
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(
        chunks.filter(
          (chunk) => chunk.type === 'run-event' && chunk.event.kind === 'provider.request.warned'
        )
      ).toHaveLength(lateWarning ? 2 : 1);
      expect(runtime.providerCallWarnings.drain()).toEqual([]);
    }
  );
});
