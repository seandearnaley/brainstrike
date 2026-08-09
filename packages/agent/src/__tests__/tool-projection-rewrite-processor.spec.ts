import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';
import {
  buildToolProjectionRewriteInputProcessor,
  ToolProjectionRewriteProcessor,
} from '../mastra/tool-projection-rewrite-processor';
import type { ToolProjectionRewriteEntry } from '../types';

function promptWithCalls(
  calls: readonly { readonly id: string; readonly output: string }[]
): ProcessLLMRequestArgs['prompt'] {
  return calls.flatMap((call) => [
    {
      content: [
        {
          input: {},
          toolCallId: call.id,
          toolName: 'brainstrike_readWorkspaceFile',
          type: 'tool-call' as const,
        },
      ],
      role: 'assistant' as const,
    },
    {
      content: [
        {
          output: { type: 'json' as const, value: { content: call.output } },
          toolCallId: call.id,
          toolName: 'brainstrike_readWorkspaceFile',
          type: 'tool-result' as const,
        },
      ],
      role: 'tool' as const,
    },
  ]);
}

async function process(
  processor: ToolProjectionRewriteProcessor,
  prompt: ProcessLLMRequestArgs['prompt']
): Promise<ProcessLLMRequestArgs['prompt']> {
  const result = await processor.processLLMRequest({
    abort: (reason?: string): never => {
      throw new Error(reason ?? 'processor aborted');
    },
    model: {} as ProcessLLMRequestArgs['model'],
    prompt,
    retryCount: 0,
    state: {},
    stepNumber: 1,
    steps: [],
  });
  return result?.prompt ?? prompt;
}

function entry(overrides: Partial<ToolProjectionRewriteEntry> = {}): ToolProjectionRewriteEntry {
  return {
    markerText: 'read src/a.ts lines 1-20/20 [superseded — see the later read of this file]',
    supersededByToolCallId: 'call-new',
    toolCallId: 'call-old',
    ...overrides,
  };
}

describe('ToolProjectionRewriteProcessor', () => {
  it('is constructed only when lookup capability and thread identity are present', () => {
    const lookup = { listActiveRewrites: async () => new Map() };
    expect(buildToolProjectionRewriteInputProcessor(lookup, 'thread-1')?.id).toBe(
      'tool-projection-rewrite'
    );
    expect(buildToolProjectionRewriteInputProcessor(undefined, 'thread-1')).toBeUndefined();
    expect(buildToolProjectionRewriteInputProcessor(lookup, undefined)).toBeUndefined();
  });

  it('rewrites only the old result when its superseding call remains in the current prompt', async () => {
    const original = promptWithCalls([
      { id: 'call-old', output: 'x'.repeat(80_000) },
      { id: 'call-new', output: 'fresh' },
    ]);
    const before = structuredClone(original);
    const rewritten = await process(
      new ToolProjectionRewriteProcessor('thread-1', {
        listActiveRewrites: async () => new Map([['call-old', entry()]]),
      }),
      original
    );

    expect(original).toEqual(before);
    expect(JSON.stringify(rewritten)).toContain(entry().markerText);
    expect(JSON.stringify(rewritten)).toContain('fresh');
    expect(JSON.stringify(rewritten)).not.toContain('x'.repeat(1000));
  });

  it('self-heals after rewind by replaying original content when the superseding call is gone', async () => {
    const original = promptWithCalls([{ id: 'call-old', output: 'original evidence' }]);
    const rewritten = await process(
      new ToolProjectionRewriteProcessor('thread-1', {
        listActiveRewrites: async () => new Map([['call-old', entry()]]),
      }),
      original
    );

    expect(rewritten).toBe(original);
    expect(JSON.stringify(rewritten)).toContain('original evidence');
    expect(JSON.stringify(rewritten)).not.toContain('[superseded');
  });

  it('keeps repeated growing-file rereads from bloating the next provider request', async () => {
    const oldCalls = Array.from({ length: 12 }, (_, index) => ({
      id: `call-old-${index}`,
      output: 'x'.repeat(20_000 + index * 2000),
    }));
    const original = promptWithCalls([...oldCalls, { id: 'call-new', output: 'fresh tail' }]);
    const rewrites = new Map(
      oldCalls.map((call) => [
        call.id,
        entry({
          markerText:
            'read src/a.ts lines 1-100/100 [superseded — see the later read of this file]',
          toolCallId: call.id,
        }),
      ])
    );

    const rewritten = await process(
      new ToolProjectionRewriteProcessor('thread-1', {
        listActiveRewrites: async () => rewrites,
      }),
      original
    );

    expect(JSON.stringify(original).length).toBeGreaterThan(300_000);
    expect(JSON.stringify(rewritten).length).toBeLessThan(10_000);
    expect(JSON.stringify(rewritten)).toContain('fresh tail');
  });
});
