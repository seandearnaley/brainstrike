import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { describe, expect, it } from 'vitest';
import { rewriteToolProjectionPrompt } from '../mastra/tool-projection-rewrite-processor';
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

function entry(overrides: Partial<ToolProjectionRewriteEntry> = {}): ToolProjectionRewriteEntry {
  return {
    kind: 'supersession',
    markerText: 'read src/a.ts lines 1-20/20 [superseded — see the later read of this file]',
    supersededByToolCallId: 'call-new',
    toolCallId: 'call-old',
    ...overrides,
  };
}

describe('rewriteToolProjectionPrompt', () => {
  it('rewrites only the old result when its superseding call remains in the current prompt', () => {
    const original = promptWithCalls([
      { id: 'call-old', output: 'x'.repeat(80_000) },
      { id: 'call-new', output: 'fresh' },
    ]);
    const before = structuredClone(original);
    const { prompt: rewritten, rewrittenCount } = rewriteToolProjectionPrompt(
      original,
      new Map([['call-old', entry()]])
    );

    expect(rewrittenCount).toBe(1);
    expect(original).toEqual(before);
    expect(JSON.stringify(rewritten)).toContain(entry().markerText);
    expect(JSON.stringify(rewritten)).toContain('fresh');
    expect(JSON.stringify(rewritten)).not.toContain('x'.repeat(1000));
  });

  it('self-heals after rewind by replaying original content when the superseding call is gone', () => {
    const original = promptWithCalls([{ id: 'call-old', output: 'original evidence' }]);
    const { prompt: rewritten, rewrittenCount } = rewriteToolProjectionPrompt(
      original,
      new Map([['call-old', entry()]])
    );

    expect(rewrittenCount).toBe(0);
    expect(rewritten).toEqual(original);
    expect(JSON.stringify(rewritten)).toContain('original evidence');
    expect(JSON.stringify(rewritten)).not.toContain('[superseded');
  });

  it('applies prune rows without a superseder while preserving the supersession presence gate', () => {
    const original = promptWithCalls([
      { id: 'call-pruned', output: 'old prunable evidence' },
      { id: 'call-superseded', output: 'old superseded evidence' },
    ]);
    const pruneMarker =
      '[pruned old tool result — tool=brainstrike.readWorkspaceFile args=0123456789ab; re-run the tool to obtain it again]';
    const { prompt: rewritten, rewrittenToolCallIds } = rewriteToolProjectionPrompt(
      original,
      new Map([
        [
          'call-pruned',
          entry({
            kind: 'prune',
            markerText: pruneMarker,
            supersededByToolCallId: null,
            toolCallId: 'call-pruned',
          }),
        ],
        [
          'call-superseded',
          entry({
            supersededByToolCallId: 'call-missing-superseder',
            toolCallId: 'call-superseded',
          }),
        ],
      ])
    );

    expect(JSON.stringify(rewritten)).toContain(pruneMarker);
    expect(JSON.stringify(rewritten)).toContain('old superseded evidence');
    expect(JSON.stringify(rewritten)).not.toContain('old prunable evidence');
    // Only the results that actually went out as markers are reported.
    expect(rewrittenToolCallIds).toEqual(new Set(['call-pruned']));
  });

  it('keeps repeated growing-file rereads from bloating the next provider request', () => {
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

    const { prompt: rewritten } = rewriteToolProjectionPrompt(original, rewrites);

    expect(JSON.stringify(original).length).toBeGreaterThan(300_000);
    expect(JSON.stringify(rewritten).length).toBeLessThan(10_000);
    expect(JSON.stringify(rewritten)).toContain('fresh tail');
  });
});
