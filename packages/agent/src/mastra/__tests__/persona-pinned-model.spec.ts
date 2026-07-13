/**
 * Pinned-persona model resolver: provider/key selection rules for building a
 * child agent on a DIFFERENT model than the parent. Key selection must be
 * explicit — a hosted pin without a resolvable key throws (the factory then
 * skips the persona with a warn), never a guessed or empty credential.
 */

import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { describe, expect, it } from 'vitest';
import type { RuntimeData } from '../../types';
import { createPersonaPinnedModelResolver } from '../persona-pinned-model';

function personaWithPin(provider: string, modelId = 'some-model'): AssistantPersonaDefinition {
  return {
    allowedToolIds: ['brainstrike.readWorkspaceFile'],
    description: 'd',
    id: 'pinned',
    instructions: 'i',
    label: 'Pinned',
    maxSteps: 4,
    model: { modelId, provider },
    source: 'user',
  };
}

interface InstantiateCall {
  apiKey: string | undefined;
  modelName: string;
  provider: string;
  runtime: RuntimeData | undefined;
}

function makeResolver(overrides: {
  apiKey?: string;
  parentProvider?: string;
  runtime?: RuntimeData;
}) {
  const calls: InstantiateCall[] = [];
  const resolver = createPersonaPinnedModelResolver({
    apiKey: overrides.apiKey,
    instantiate: (provider, apiKey, modelName, runtime) => {
      calls.push({ apiKey, modelName, provider, runtime });
      return `model:${provider}:${modelName}` as never;
    },
    parentProvider: overrides.parentProvider ?? 'anthropic',
    runtime: overrides.runtime,
  });
  return { calls, resolver };
}

describe('createPersonaPinnedModelResolver', () => {
  it('reuses the parent API key when the pin targets the parent provider', () => {
    const { calls, resolver } = makeResolver({ apiKey: 'parent-key' });
    const model = resolver(personaWithPin('anthropic', 'claude-haiku-4-5'));
    expect(model).toBe('model:anthropic:claude-haiku-4-5');
    expect(calls[0]).toMatchObject({ apiKey: 'parent-key', provider: 'anthropic' });
  });

  it('uses the per-provider key map for a cross-provider pin', () => {
    const { calls, resolver } = makeResolver({
      apiKey: 'parent-key',
      runtime: { personaProviderApiKeys: { openai: 'openai-key' } } as RuntimeData,
    });
    resolver(personaWithPin('openai', 'gpt-5-mini'));
    expect(calls[0]).toMatchObject({ apiKey: 'openai-key', provider: 'openai' });
  });

  it('allows keyless local providers (local, ollama, lmstudio)', () => {
    for (const provider of ['local', 'ollama', 'lmstudio']) {
      const { calls, resolver } = makeResolver({});
      resolver(personaWithPin(provider));
      expect(calls[0]).toMatchObject({ apiKey: undefined, provider });
    }
  });

  it('throws for a hosted cross-provider pin with no key available (skip-with-warn upstream)', () => {
    const { resolver } = makeResolver({ apiKey: 'parent-key' });
    expect(() => resolver(personaWithPin('openai'))).toThrow(/api key/i);
  });

  it('throws when called for an un-pinned persona (contract misuse, not a fallback)', () => {
    const { resolver } = makeResolver({});
    const unpinned: AssistantPersonaDefinition = {
      ...personaWithPin('anthropic'),
      model: undefined,
    };
    expect(() => resolver(unpinned)).toThrow(/pin/i);
  });
});
