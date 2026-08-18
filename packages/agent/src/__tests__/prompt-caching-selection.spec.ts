import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wrapModelWithDeclaredPromptCaching } from '../providers/prompt-caching';

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
