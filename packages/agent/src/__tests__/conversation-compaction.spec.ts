import { describe, expect, it, vi } from 'vitest';
import {
  estimateCompactionMessageTokens,
  generateAgenticCompactionSummary,
  projectCompactionMessagesForSummarizer,
} from '../mastra/conversation-compaction';

function invocationMessage(id: string, result: string) {
  return {
    content: {
      format: 2,
      parts: [
        {
          providerMetadata: {
            mastra: { modelOutput: { type: 'text', value: result } },
          },
          toolInvocation: {
            args: { path: 'src/a.ts' },
            result,
            toolCallId: id,
            toolName: 'brainstrike_readWorkspaceFile',
          },
          type: 'tool-invocation',
        },
      ],
    },
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    id: `message-${id}`,
    role: 'assistant' as const,
  };
}

describe('conversation compaction input', () => {
  it('keeps summarizer input bounded to the active projected tool result', () => {
    const rawSentinel = 'RAW_TOOL_RESULT_MUST_NOT_REACH_SUMMARIZER';
    const marker = 'read src/a.ts [pruned from provider context]';
    const projected = projectCompactionMessagesForSummarizer(
      [invocationMessage('read-old', rawSentinel)],
      new Map([
        [
          'read-old',
          {
            kind: 'prune' as const,
            markerText: marker,
            supersededByToolCallId: null,
            toolCallId: 'read-old',
          },
        ],
      ])
    );

    expect(projected).toContain(marker);
    expect(projected).not.toContain(rawSentinel);
  });

  it('walks text, reasoning, tool arguments/results, and attachment markers', () => {
    const messages = [
      {
        content: {
          format: 2,
          parts: [
            { text: 'user text', type: 'text' },
            { text: 'reasoning text', type: 'reasoning' },
            {
              toolInvocation: {
                args: { query: 'needle' },
                result: 'result text',
                toolCallId: 'call-1',
                toolName: 'grep',
              },
              type: 'tool-invocation',
            },
            { data: 'data:image/png;base64,AAAA', mediaType: 'image/png', type: 'file' },
          ],
        },
        id: 'message-1',
        role: 'user' as const,
      },
    ];

    expect(estimateCompactionMessageTokens(messages)).toBeGreaterThan(0);
  });
});

describe('agentic compaction summary generation', () => {
  it('uses the scratch Agent generate result text and provider-reported aggregate usage', async () => {
    const dispose = vi.fn(async () => undefined);
    const generate = vi.fn(async () => ({
      text: 'Goal:\nG\nState:\nS\nDecisions:\nD\nNext:\nN\nFiles touched:\nF',
      totalUsage: { inputTokens: 123, outputTokens: 45 },
    }));
    const result = await generateAgenticCompactionSummary(
      {
        projectedInput: 'projected transcript',
        runtimeData: { apiKey: 'key', model: 'gpt-5.2', provider: 'openai' },
        signal: new AbortController().signal,
      },
      {
        createRuntime: vi.fn(async () => ({ agent: { generate }, dispose }) as never),
      }
    );

    expect(result).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      text: 'Goal:\nG\nState:\nS\nDecisions:\nD\nNext:\nN\nFiles touched:\nF',
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects malformed five-section output so the caller can use deterministic fallback', async () => {
    await expect(
      generateAgenticCompactionSummary(
        {
          projectedInput: 'projected transcript',
          runtimeData: { apiKey: 'key', model: 'gpt-5.2', provider: 'openai' },
          signal: new AbortController().signal,
        },
        {
          createRuntime: vi.fn(
            async () =>
              ({
                agent: {
                  generate: vi.fn(async () => ({
                    text: 'A free-form summary without the required sections.',
                    totalUsage: { inputTokens: 10, outputTokens: 5 },
                  })),
                },
                dispose: vi.fn(async () => undefined),
              }) as never
          ),
        }
      )
    ).rejects.toThrow(/five-section schema/i);
  });
});
