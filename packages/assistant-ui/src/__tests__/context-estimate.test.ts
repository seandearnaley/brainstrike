import { countTokensHeuristic } from '@brainstrike/tokenization';
import { describe, expect, it } from 'vitest';
import { estimateConversationTokens, resolveDisplayedContextUsage } from '../context-estimate.js';

const USER_TEXT = 'Please refactor the auth module and run the tests.';
const ASSISTANT_TEXT = 'I refactored the module; the tests are green.';
const REASONING_TEXT = 'The user wants a refactor; start by reading the file.';
const TOOL_ARGS = JSON.stringify({ path: 'src/auth.ts', root: 'root-main' });
const TOOL_RESULT = { content: 'x'.repeat(4000), path: 'src/auth.ts' };

function makeMessages(): unknown[] {
  return [
    { content: [{ text: USER_TEXT, type: 'text' }], role: 'user' },
    {
      content: [
        { text: REASONING_TEXT, type: 'reasoning' },
        {
          argsText: TOOL_ARGS,
          result: TOOL_RESULT,
          toolName: 'brainstrike.readWorkspaceFile',
          type: 'tool-call',
        },
        { text: ASSISTANT_TEXT, type: 'text' },
      ],
      role: 'assistant',
    },
  ];
}

describe('estimateConversationTokens (BST-940 estimator v2)', () => {
  it('counts tool args and results — the dominant context in coding threads', () => {
    const estimate = estimateConversationTokens(makeMessages());
    const toolExpected =
      countTokensHeuristic(TOOL_ARGS) + countTokensHeuristic(JSON.stringify(TOOL_RESULT));
    expect(estimate.toolTokens).toBe(toolExpected);
    // The old text-only walk missed all of this: the total MUST dominate text.
    expect(estimate.totalTokens).toBeGreaterThan(estimate.userTextTokens * 5);
  });

  it('attributes tool tokens per tool name, sorted descending', () => {
    const messages = [
      ...makeMessages(),
      {
        content: [
          {
            argsText: '{}',
            result: { ok: true },
            toolName: 'small_tool',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ];
    const estimate = estimateConversationTokens(messages);
    expect(estimate.byTool.map((entry) => entry.name)).toEqual([
      'brainstrike.readWorkspaceFile',
      'small_tool',
    ]);
    expect(estimate.byTool[0]?.tokens).toBeGreaterThan(estimate.byTool[1]?.tokens ?? 0);
  });

  it('counts reasoning and splits user vs assistant text', () => {
    const estimate = estimateConversationTokens(makeMessages());
    expect(estimate.reasoningTokens).toBe(countTokensHeuristic(REASONING_TEXT));
    expect(estimate.userTextTokens).toBe(countTokensHeuristic(USER_TEXT));
    expect(estimate.assistantTextTokens).toBe(countTokensHeuristic(ASSISTANT_TEXT));
    expect(estimate.totalTokens).toBe(
      estimate.userTextTokens +
        estimate.assistantTextTokens +
        estimate.reasoningTokens +
        estimate.toolTokens
    );
  });

  it('counts attachments without fabricating token figures for them', () => {
    const estimate = estimateConversationTokens([
      {
        content: [
          { text: 'look', type: 'text' },
          { image: 'data:image/png;base64,AAAA', type: 'image' },
          { data: 'data:image/png;base64,BBBB', mediaType: 'image/png', type: 'file' },
        ],
        role: 'user',
      },
    ]);
    expect(estimate.attachmentsCount).toBe(2);
  });

  it('memoizes per message object (same objects → same result, no recount)', () => {
    const messages = makeMessages();
    const first = estimateConversationTokens(messages);
    const second = estimateConversationTokens(messages);
    expect(second).toEqual(first);
  });

  it('counts a streaming tool call again once its result arrives', () => {
    const call = {
      argsText: TOOL_ARGS,
      toolName: 'brainstrike.readWorkspaceFile',
      type: 'tool-call',
    };
    const tail = (part: object) => [{ content: [part], role: 'assistant' }];
    const pending = estimateConversationTokens(tail(call));
    const settled = estimateConversationTokens(tail({ ...call, result: TOOL_RESULT }));
    expect(settled.toolTokens - pending.toolTokens).toBe(
      countTokensHeuristic(JSON.stringify(TOOL_RESULT))
    );
  });

  it('returns an all-zero estimate for an empty thread', () => {
    const estimate = estimateConversationTokens([]);
    expect(estimate.totalTokens).toBe(0);
    expect(estimate.byTool).toEqual([]);
  });

  it('survives a tool part with an unserializable result (skips it, keeps counting)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const estimate = estimateConversationTokens([
      {
        content: [
          { args: circular, result: circular, toolName: 'weird', type: 'tool-call' },
          { text: 'still counted', type: 'text' },
        ],
        role: 'assistant',
      },
    ]);
    expect(estimate.assistantTextTokens).toBe(countTokensHeuristic('still counted'));
  });
});

describe('resolveDisplayedContextUsage', () => {
  const conversation = 12_000;
  const baseline = 8000;

  it('prefers exact usage when idle', () => {
    expect(
      resolveDisplayedContextUsage({
        breakdownBaselineTokens: baseline,
        conversationEstimateTokens: conversation,
        exact: { inputTokens: 50_000, outputTokens: 2000 },
        isRunning: false,
      })
    ).toEqual({ isEstimated: false, usedTokens: 52_000 });
  });

  it('keeps provider-exact usage independent of the heuristic estimator surface (BST-1205)', () => {
    const providerActual = { inputTokens: 12_345, outputTokens: 678 };
    const tinyEstimate = estimateConversationTokens([
      { content: [{ text: 'short', type: 'text' }], role: 'user' },
    ]).totalTokens;
    const largeEstimate = estimateConversationTokens([
      {
        content: [
          {
            result: { content: 'x'.repeat(40_000) },
            toolName: 'brainstrike.readWorkspaceFile',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ]).totalTokens;

    expect(largeEstimate).toBeGreaterThan(tinyEstimate);
    for (const conversationEstimateTokens of [tinyEstimate, largeEstimate]) {
      expect(
        resolveDisplayedContextUsage({
          breakdownBaselineTokens: 999_999,
          conversationEstimateTokens,
          exact: providerActual,
          isRunning: false,
        })
      ).toEqual({ isEstimated: false, usedTokens: 13_023 });
    }
  });

  it('shows the live estimate while a run streams, floored at the last exact figure', () => {
    // Live estimate below the last exact prompt → exact is the floor (context
    // never shrinks mid-conversation).
    expect(
      resolveDisplayedContextUsage({
        breakdownBaselineTokens: baseline,
        conversationEstimateTokens: conversation,
        exact: { inputTokens: 50_000, outputTokens: 2000 },
        isRunning: true,
      })
    ).toEqual({ isEstimated: true, usedTokens: 52_000 });
    // Live estimate above the last exact figure → the estimate leads.
    expect(
      resolveDisplayedContextUsage({
        breakdownBaselineTokens: baseline,
        conversationEstimateTokens: 60_000,
        exact: { inputTokens: 50_000, outputTokens: 2000 },
        isRunning: true,
      })
    ).toEqual({ isEstimated: true, usedTokens: 68_000 });
  });

  it('uses baseline + conversation before any exact usage exists', () => {
    expect(
      resolveDisplayedContextUsage({
        breakdownBaselineTokens: baseline,
        conversationEstimateTokens: conversation,
        exact: undefined,
        isRunning: false,
      })
    ).toEqual({ isEstimated: true, usedTokens: 20_000 });
  });

  it('shows an honest zero (not estimated) for an empty thread with no exact usage', () => {
    expect(
      resolveDisplayedContextUsage({
        breakdownBaselineTokens: 0,
        conversationEstimateTokens: 0,
        exact: undefined,
        isRunning: false,
      })
    ).toEqual({ isEstimated: false, usedTokens: 0 });
  });
});
