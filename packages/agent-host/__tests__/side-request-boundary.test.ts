/**
 * BST-2532: a compaction's summary call goes through the run's provider
 * request boundary. Over the run's input limit it refuses: trimming the
 * oldest messages, as the boundary does for a run's own request, would leave
 * a summary of only the newest part, and the compaction would then drop the
 * rest unsummarized.
 */
import { generateText, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, test } from 'vitest';
import { hostSideRequestBoundary } from '../src/run-provider-request.ts';

const turn = (index: number): ModelMessage[] => [
  { content: `question ${index} ${'q'.repeat(2000)}`, role: 'user' },
  { content: [{ text: `answer ${index} ${'a'.repeat(2000)}`, type: 'text' }], role: 'assistant' },
];

test('a side call over the run’s input limit is refused, never trimmed and sent', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ text: 'Summarized.', type: 'text' }],
      finishReason: { raw: 'stop', unified: 'stop' },
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
        outputTokens: { reasoning: 0, text: 2, total: 2 },
      },
      warnings: [],
    }),
  });
  // Four turns of about 1,000 estimated tokens against a 2,500-token limit:
  // the two newest would fit, the whole conversation does not.
  const boundary = hostSideRequestBoundary(
    { inputTokenLimit: 2500, provider: 'openai' },
    [],
    new Map()
  );
  await expect(
    generateText({
      maxRetries: 0,
      messages: [0, 1, 2, 3].flatMap(turn).concat({ content: 'Summarize.', role: 'user' }),
      model: boundary(model),
    })
  ).rejects.toMatchObject({ failure: { code: 'provider.context-overflow' } });
  expect(model.doGenerateCalls).toEqual([]);
});
