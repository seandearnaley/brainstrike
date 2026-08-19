import { describe, expect, it } from 'vitest';
import {
  applyBedrockPromptCacheBreakpoints,
  wrapBedrockModelWithPromptCaching,
} from '../providers/bedrock-prompt-caching';

interface Message {
  content: unknown;
  providerOptions?: Record<string, Record<string, unknown>>;
  role: string;
}

const CACHE_POINT = { type: 'default' };

function message(role: string, text: string): Message {
  return { content: [{ text, type: 'text' }], role };
}

function cachePointsOf(prompt: readonly Message[]): (string | undefined)[] {
  return prompt.map((entry) =>
    entry.providerOptions?.['bedrock']?.['cachePoint'] === undefined ? undefined : entry.role
  );
}

describe('applyBedrockPromptCacheBreakpoints', () => {
  it('marks the first two system messages and the last two non-system messages', () => {
    const prompt: Message[] = [
      message('system', 'stable instructions'),
      message('system', 'volatile task list'),
      message('system', 'third system block'),
      message('user', 'turn one'),
      message('assistant', 'answer one'),
      message('user', 'turn two'),
    ];

    const result = applyBedrockPromptCacheBreakpoints({ prompt });

    expect(cachePointsOf(result.prompt)).toEqual([
      'system',
      'system',
      undefined,
      undefined,
      'assistant',
      'user',
    ]);
    // AWS caps a Converse request at FOUR cache checkpoints; the policy must
    // never be able to exceed it.
    expect(result.prompt.filter((entry) => entry.providerOptions?.['bedrock']).length).toBe(4);
  });

  it('writes the documented Converse cache-point shape', () => {
    const result = applyBedrockPromptCacheBreakpoints({
      prompt: [message('user', 'only turn')],
    });
    expect(result.prompt.at(-1)?.providerOptions).toEqual({ bedrock: { cachePoint: CACHE_POINT } });
  });

  it('preserves unrelated provider-option namespaces on a decorated message', () => {
    const result = applyBedrockPromptCacheBreakpoints({
      prompt: [{ ...message('user', 'hi'), providerOptions: { anthropic: { ttl: '1h' } } }],
    });
    expect(result.prompt[0]?.providerOptions).toEqual({
      anthropic: { ttl: '1h' },
      bedrock: { cachePoint: CACHE_POINT },
    });
  });

  it('honors a pre-existing explicit cachePoint instead of overwriting it', () => {
    const explicit = { ttl: '1h', type: 'default' };
    const result = applyBedrockPromptCacheBreakpoints({
      prompt: [
        { ...message('system', 'sys'), providerOptions: { bedrock: { cachePoint: explicit } } },
        message('user', 'hi'),
      ],
    });
    expect(result.prompt[0]?.providerOptions?.['bedrock']?.['cachePoint']).toBe(explicit);
  });

  it('honors an explicit breakpoint written under the amazonBedrock alias', () => {
    // The SDK reads `amazonBedrock` in preference to `bedrock`; adding our own
    // `bedrock` breakpoint alongside it would silently double-count against
    // the four-checkpoint ceiling.
    const result = applyBedrockPromptCacheBreakpoints({
      prompt: [
        {
          ...message('user', 'hi'),
          providerOptions: { amazonBedrock: { cachePoint: { type: 'default' } } },
        },
      ],
    });
    expect(result.prompt[0]?.providerOptions?.['bedrock']).toBeUndefined();
  });

  it('honors an explicit cache point declared on a content PART', () => {
    // The SDK reads part-level provider metadata too, so a part-level point is
    // a real checkpoint that must count against the ceiling — adding ours to
    // the same message would spend two of the four on one boundary.
    const result = applyBedrockPromptCacheBreakpoints({
      prompt: [
        {
          content: [
            { providerOptions: { bedrock: { cachePoint: CACHE_POINT } }, text: 'hi', type: 'text' },
          ],
          role: 'user',
        },
      ],
    });
    expect(result.prompt[0]?.providerOptions).toBeUndefined();
  });

  it('honors a part-level explicit point under the amazonBedrock alias', () => {
    const result = applyBedrockPromptCacheBreakpoints({
      prompt: [
        {
          content: [
            {
              providerOptions: { amazonBedrock: { cachePoint: CACHE_POINT } },
              text: 'hi',
              type: 'text',
            },
          ],
          role: 'user',
        },
      ],
    });
    expect(result.prompt[0]?.providerOptions).toBeUndefined();
  });

  it('never exceeds the four-checkpoint ceiling when explicit points exist mid-history', () => {
    // Two explicit points buried in history leave room for only two of ours.
    const explicit = { bedrock: { cachePoint: CACHE_POINT } };
    const result = applyBedrockPromptCacheBreakpoints({
      prompt: [
        message('system', 'a'),
        message('system', 'b'),
        { ...message('user', 'old one'), providerOptions: explicit },
        { ...message('assistant', 'old two'), providerOptions: explicit },
        message('user', 'turn'),
        message('assistant', 'answer'),
        message('user', 'newest'),
      ],
    });
    const total = result.prompt.filter(
      (entry) => entry.providerOptions?.['bedrock']?.['cachePoint'] !== undefined
    ).length;
    expect(total).toBe(4);
    // Ours were dropped lowest-priority-first, so the two SYSTEM blocks (the
    // largest stable prefix) survive and the tail placements yield.
    expect(cachePointsOf(result.prompt)).toEqual([
      'system',
      'system',
      'user',
      'assistant',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('adds nothing once four explicit points already exist', () => {
    const explicit = { bedrock: { cachePoint: CACHE_POINT } };
    const prompt = [
      { ...message('system', 'a'), providerOptions: explicit },
      { ...message('system', 'b'), providerOptions: explicit },
      { ...message('user', 'c'), providerOptions: explicit },
      { ...message('assistant', 'd'), providerOptions: explicit },
      message('user', 'newest'),
    ];
    const result = applyBedrockPromptCacheBreakpoints({ prompt });
    expect(result.prompt.at(-1)?.providerOptions).toBeUndefined();
    expect(result).toEqual({ prompt });
  });

  it('drops the second-to-last tail placement before the last one', () => {
    // Three explicit points leave budget for exactly one of ours: the newest
    // boundary, which is what the NEXT step reads back.
    const explicit = { bedrock: { cachePoint: CACHE_POINT } };
    const result = applyBedrockPromptCacheBreakpoints({
      prompt: [
        { ...message('system', 'a'), providerOptions: explicit },
        { ...message('system', 'b'), providerOptions: explicit },
        { ...message('user', 'old'), providerOptions: explicit },
        message('assistant', 'answer'),
        message('user', 'newest'),
      ],
    });
    expect(cachePointsOf(result.prompt)).toEqual(['system', 'system', 'user', undefined, 'user']);
  });

  it('never mutates the input prompt', () => {
    const original = message('user', 'hi');
    const prompt = [original];
    applyBedrockPromptCacheBreakpoints({ prompt });
    expect(original.providerOptions).toBeUndefined();
    expect(prompt[0]).toBe(original);
  });

  it('returns an empty prompt untouched', () => {
    const params = { prompt: [] as Message[] };
    expect(applyBedrockPromptCacheBreakpoints(params)).toBe(params);
  });

  it('marks a system-only prompt without inventing a non-system tail', () => {
    const result = applyBedrockPromptCacheBreakpoints({
      prompt: [message('system', 'a'), message('system', 'b'), message('system', 'c')],
    });
    expect(cachePointsOf(result.prompt)).toEqual(['system', 'system', undefined]);
  });
});

describe('wrapBedrockModelWithPromptCaching', () => {
  it('applies breakpoints on doStream and doGenerate, and delegates everything else', async () => {
    const calls: { prompt: Message[] }[] = [];
    const model = {
      doGenerate: (params: { prompt: Message[] }) => {
        calls.push(params);
        return Promise.resolve('generated');
      },
      doStream: (params: { prompt: Message[] }) => {
        calls.push(params);
        return Promise.resolve('streamed');
      },
      modelId: 'anthropic.claude-sonnet-5',
      provider: 'amazon-bedrock',
      specificationVersion: 'v3',
    };

    const wrapped = wrapBedrockModelWithPromptCaching(model);
    expect(wrapped.modelId).toBe('anthropic.claude-sonnet-5');
    expect(wrapped.specificationVersion).toBe('v3');

    await wrapped.doStream({ prompt: [message('system', 'sys'), message('user', 'hi')] });
    await wrapped.doGenerate({ prompt: [message('user', 'hi')] });

    expect(calls).toHaveLength(2);
    expect(cachePointsOf(calls[0]?.prompt ?? [])).toEqual(['system', 'user']);
    expect(cachePointsOf(calls[1]?.prompt ?? [])).toEqual(['user']);
  });
});
