import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted: `vi.mock` factories run before module-scope consts initialize.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn,
  }),
}));

import {
  findModelCapabilities,
  wrapModelWithDeclaredPromptCaching,
} from '../providers/prompt-caching';

interface Message {
  content: unknown;
  providerOptions?: Record<string, Record<string, unknown>>;
  role: string;
}

function stubModel() {
  const calls: { prompt: Message[] }[] = [];
  const model = {
    doStream: (params: { prompt: Message[] }) => {
      calls.push(params);
      return Promise.resolve('ok');
    },
  };
  return { calls, model };
}

const PROMPT: Message[] = [
  { content: 'system', role: 'system' },
  { content: [{ text: 'hi', type: 'text' }], role: 'user' },
];

async function breakpointNamespacesFor(
  provider: 'anthropic' | 'bedrock',
  modelId: string
): Promise<(string[] | undefined)[]> {
  const { calls, model } = stubModel();
  const wrapped = wrapModelWithDeclaredPromptCaching(provider, modelId, model);
  await wrapped.doStream({ prompt: PROMPT });
  return (calls[0]?.prompt ?? []).map((message) =>
    message.providerOptions === undefined ? undefined : Object.keys(message.providerOptions)
  );
}

beforeEach(() => {
  warn.mockClear();
});

describe('registry-driven prompt-caching wrapper selection', () => {
  it('applies the Anthropic dialect to a first-party Anthropic model', async () => {
    expect(await breakpointNamespacesFor('anthropic', 'claude-sonnet-5')).toEqual([
      undefined,
      ['anthropic'],
    ]);
  });

  it('applies the Bedrock dialect to a Claude-on-Bedrock model', async () => {
    expect(await breakpointNamespacesFor('bedrock', 'anthropic.claude-sonnet-5')).toEqual([
      ['bedrock'],
      ['bedrock'],
    ]);
  });

  it('applies the Bedrock dialect to an Amazon Nova model', async () => {
    expect(await breakpointNamespacesFor('bedrock', 'amazon.nova-pro-v1:0')).toEqual([
      ['bedrock'],
      ['bedrock'],
    ]);
  });

  it('sends no breakpoints to a Bedrock route with no declared dialect', async () => {
    // DeepSeek on Bedrock has no documented cache-point support. This is the
    // case a provider-id-driven wrapper got wrong.
    expect(await breakpointNamespacesFor('bedrock', 'deepseek.v3.2')).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('sends no breakpoints for an uncatalogued model id', async () => {
    expect(await breakpointNamespacesFor('bedrock', 'anthropic.claude-not-in-catalog')).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('returns the SAME model object when no dialect is declared', () => {
    const { model } = stubModel();
    expect(wrapModelWithDeclaredPromptCaching('openai', 'gpt-5.6-sol', model)).toBe(model);
  });

  it('WARNS with the id and a typed code when a model is absent from the catalog', () => {
    // Before BST-1354 every hosted Anthropic model was wrapped unconditionally,
    // so an uncatalogued id losing caching is a real regression in cost. It is
    // allowed to ship uncached — the id may be legitimately newer than this
    // build — but it must never do so silently.
    const { model } = stubModel();
    const returned = wrapModelWithDeclaredPromptCaching(
      'anthropic',
      'claude-from-the-future',
      model
    );
    expect(returned).toBe(model);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'prompt_caching_model_not_catalogued',
        model: 'claude-from-the-future',
        provider: 'anthropic',
      }),
      expect.stringContaining('registry')
    );
  });
});

describe('routed-id contract at the capability boundary', () => {
  /**
   * `createProvider` accepts an already-prefixed Bedrock id and passes it
   * through (BST-1350, pinned by provider-factory.bedrock.spec.ts), so routed
   * ids really do reach the capability lookup. A raw registry miss there would
   * cost the route BOTH caching and reasoning while looking exactly like an
   * uncatalogued model — the quietest possible regression.
   */
  it.each([
    ['us.anthropic.claude-sonnet-5'],
    ['eu.anthropic.claude-sonnet-5'],
    ['global.anthropic.claude-sonnet-5'],
  ])('still caches a region-ROUTED id (%s)', async (routedId) => {
    expect(await breakpointNamespacesFor('bedrock', routedId)).toEqual([['bedrock'], ['bedrock']]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('resolves a routed id to the SAME capabilities as its catalog id', () => {
    expect(findModelCapabilities('bedrock', 'us.anthropic.claude-sonnet-5')).toBe(
      findModelCapabilities('bedrock', 'anthropic.claude-sonnet-5')
    );
  });

  it('reports a routed id that is genuinely uncatalogued', async () => {
    expect(await breakpointNamespacesFor('bedrock', 'us.anthropic.claude-not-real')).toEqual([
      undefined,
      undefined,
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'prompt_caching_model_not_catalogued' }),
      expect.any(String)
    );
  });

  it('findModelCapabilities resolves the declared dialects for a catalogued route', () => {
    expect(findModelCapabilities('bedrock', 'anthropic.claude-sonnet-5')?.bedrockReasoning).toBe(
      'adaptive'
    );
    expect(
      findModelCapabilities('bedrock', 'amazon.nova-2-lite-v1:0')?.promptCaching
    ).toBeUndefined();
  });
});

/**
 * Acceptance pin (BST-1354): capability lives in the registry, so the factory
 * and the two wrappers must contain NO model-id literals. A substring match
 * here is how "Claude on Bedrock caches, DeepSeek on Bedrock does not" silently
 * rots the day a vendor renames a route.
 */
describe('no model-id string matching in the factory or wrappers', () => {
  const sources = [
    'providers/provider-factory.ts',
    'providers/prompt-caching.ts',
    'providers/prompt-transform-proxy.ts',
    'providers/anthropic-prompt-caching.ts',
    'providers/bedrock-prompt-caching.ts',
  ];
  // Vendor/model tokens that must never gate behavior in these files.
  const forbidden = [/\bclaude\b/i, /\bnova\b/i, /\bhaiku\b/i, /\bsonnet\b/i, /\bdeepseek\b/i];

  it.each(sources)('%s contains no model-id substring matching', (relativePath) => {
    const source = readFileSync(join(import.meta.dirname, '..', relativePath), 'utf8');
    // Comments legitimately NAME models when explaining the rules; only the
    // executable lines are scanned.
    const code = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
      })
      .join('\n');
    for (const pattern of forbidden) {
      expect(code, `${relativePath} matches ${pattern}`).not.toMatch(pattern);
    }
  });
});
