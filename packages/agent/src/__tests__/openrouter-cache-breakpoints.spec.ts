import { describe, expect, it } from 'vitest';
import { applyOpenRouterCacheBreakpoints } from '../providers/openrouter-cache-breakpoints';
import type { PromptMessageLike } from '../providers/prompt-transform-proxy';

const EPHEMERAL = { openrouter: { cacheControl: { type: 'ephemeral' } } };

describe('applyOpenRouterCacheBreakpoints', () => {
  it('leaves tool-loop turns unmarked and the caller prompt unmutated', () => {
    const prompt: PromptMessageLike[] = [
      { content: 'system prompt', role: 'system' },
      { content: [{ text: 'run the tests', type: 'text' }], role: 'user' },
      { content: [{ toolCallId: 'call-1', type: 'tool-call' }], role: 'assistant' },
      { content: [{ toolCallId: 'call-1', type: 'tool-result' }], role: 'tool' },
    ];
    const snapshot = structuredClone(prompt);

    const result = applyOpenRouterCacheBreakpoints({ prompt });

    expect(result.prompt?.map((message) => message.providerOptions)).toEqual([
      EPHEMERAL,
      EPHEMERAL,
      undefined,
      undefined,
    ]);
    expect(prompt).toEqual(snapshot);
  });

  it('keeps a breakpoint the caller already set, on the message or a part', () => {
    const own = { anthropic: { cacheControl: { ttl: '1h', type: 'ephemeral' } } };
    const prompt: PromptMessageLike[] = [
      { content: 'system prompt', providerOptions: own, role: 'system' },
      {
        content: [{ providerOptions: own, text: 'question', type: 'text' }],
        role: 'user',
      },
    ];

    const result = applyOpenRouterCacheBreakpoints({ prompt });

    expect(result.prompt?.[0]?.providerOptions).toBe(own);
    expect(result.prompt?.[1]?.providerOptions).toBeUndefined();
  });
});
