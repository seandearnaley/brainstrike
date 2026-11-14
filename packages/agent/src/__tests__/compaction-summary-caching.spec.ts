/**
 * BST-2532: a compaction's summary call is the run's next request with one
 * host message after it. The cache breakpoints the run's model carries land on
 * it as they land on the run's own requests, so the call reads the run's
 * cached prefix.
 */
import { describe, expect, it } from 'vitest';
import { COMPACTION_SUMMARIZER_INSTRUCTIONS } from '../compaction-summary-schema';
import { applyAnthropicPromptCacheBreakpoint } from '../providers/anthropic-prompt-caching';
import { applyOpenRouterCacheBreakpoints } from '../providers/openrouter-cache-breakpoints';
import { applyOpenRouterAutomaticCaching } from '../providers/openrouter-prompt-caching';

interface PromptMessageLike {
  content: unknown;
  providerOptions?: Record<string, Record<string, unknown>>;
  role: string;
}

/** A run's request after one tool step: its instructions, a turn, a call and its result. */
const RUN_REQUEST: PromptMessageLike[] = [
  { content: 'You are the coding agent.', role: 'system' },
  {
    content: [
      { text: '<brainstrike_notice>\nEarlier summary\n</brainstrike_notice>', type: 'text' },
    ],
    providerOptions: { brainstrike: { intake: true } },
    role: 'user',
  },
  { content: [{ text: 'Move the port.', type: 'text' }], role: 'user' },
  {
    content: [
      {
        input: { path: 'src/server.ts' },
        toolCallId: 'call-1',
        toolName: 'read',
        type: 'tool-call',
      },
    ],
    role: 'assistant',
  },
  {
    content: [
      {
        output: { type: 'text', value: 'export const PORT = 8080;' },
        toolCallId: 'call-1',
        toolName: 'read',
        type: 'tool-result',
      },
    ],
    role: 'tool',
  },
];

/** The summary call: the run's request, then the host's instruction to summarize it. */
const SUMMARY_REQUEST: PromptMessageLike[] = [
  ...RUN_REQUEST,
  {
    content: [{ text: COMPACTION_SUMMARIZER_INSTRUCTIONS, type: 'text' }],
    providerOptions: { brainstrike: { intake: true } },
    role: 'user',
  },
];

describe('the cache breakpoints on a compaction’s summary call (BST-2532)', () => {
  it('Anthropic: the breakpoint lands on the instruction, after the run’s whole prefix', () => {
    const { prompt } = applyAnthropicPromptCacheBreakpoint({ prompt: SUMMARY_REQUEST });
    expect(prompt.slice(0, -1)).toEqual(RUN_REQUEST);
    expect(prompt.at(-1)?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
      brainstrike: { intake: true },
    });
  });

  it('OpenRouter to Anthropic: the call asks for automatic caching, as the run’s requests do', () => {
    /** A call's parameters: its prompt and its call-level provider options. */
    interface Call {
      prompt: PromptMessageLike[];
      providerOptions?: Record<string, Record<string, unknown>>;
    }
    const run = applyOpenRouterAutomaticCaching<Call>({ prompt: RUN_REQUEST });
    const summary = applyOpenRouterAutomaticCaching<Call>({ prompt: SUMMARY_REQUEST });
    expect(summary.providerOptions).toEqual({
      openrouter: { cacheControl: { type: 'ephemeral' } },
    });
    expect(summary.providerOptions).toEqual(run.providerOptions);
  });

  it('OpenRouter with explicit breakpoints: the system prompt, the run’s last user message and the instruction', () => {
    const { prompt } = applyOpenRouterCacheBreakpoints({ prompt: SUMMARY_REQUEST });
    const marked = prompt.flatMap((message, index) =>
      message.providerOptions?.['openrouter']?.['cacheControl'] ? [index] : []
    );
    // The run's request marked its system prompt and its last two user
    // messages; the summary call keeps the system and the turn's message.
    expect(marked).toEqual([0, 2, 5]);
    const run = applyOpenRouterCacheBreakpoints({ prompt: RUN_REQUEST }).prompt;
    expect(
      run.flatMap((message, index) => (message.providerOptions?.['openrouter'] ? [index] : []))
    ).toEqual([0, 1, 2]);
  });
});
