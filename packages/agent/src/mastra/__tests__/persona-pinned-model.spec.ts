/**
 * Pinned-persona model resolver: provider/key selection rules for building a
 * child agent on a DIFFERENT model than the parent. Key selection must be
 * explicit — a hosted pin without a resolvable key throws (the factory then
 * skips the persona with a warn), never a guessed or empty credential.
 */

import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { describe, expect, it } from 'vitest';
import type { ProviderAuthInput } from '../../providers/provider-auth-input';
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
  auth: ProviderAuthInput | undefined;
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
    auth:
      overrides.apiKey === undefined ? undefined : { apiKey: overrides.apiKey, kind: 'api_key' },
    instantiate: (provider, auth, modelName, runtime) => {
      calls.push({ auth, modelName, provider, runtime });
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
    expect(calls[0]).toMatchObject({
      auth: { apiKey: 'parent-key', kind: 'api_key' },
      provider: 'anthropic',
    });
  });

  it('uses the per-provider key map for a cross-provider pin', () => {
    const { calls, resolver } = makeResolver({
      apiKey: 'parent-key',
      runtime: { personaProviderApiKeys: { openai: 'openai-key' } } as RuntimeData,
    });
    resolver(personaWithPin('openai', 'gpt-5-mini'));
    expect(calls[0]).toMatchObject({
      auth: { apiKey: 'openai-key', kind: 'api_key' },
      provider: 'openai',
    });
  });

  it('allows keyless local-server providers (ollama, lmstudio)', () => {
    for (const provider of ['ollama', 'lmstudio']) {
      const { calls, resolver } = makeResolver({});
      resolver(personaWithPin(provider));
      expect(calls[0]).toMatchObject({ auth: undefined, provider });
    }
  });

  it('routes a local pin through the llm host client when present (renderer-only inference)', () => {
    const { calls, resolver } = makeResolver({
      runtime: { localLlmHostClient: {} } as RuntimeData,
    });
    resolver(personaWithPin('local'));
    expect(calls[0]).toMatchObject({ auth: undefined, provider: 'local' });
  });

  it('throws for a local pin with NO llm host client (never Electron-main inference)', () => {
    // docs/agents/local-inference.md: renderer-only inference is mandatory.
    // Without a host client, createProvider('local') would fall through to the
    // in-process backend in Electron main — so the resolver must throw and the
    // factory skips the persona with a warn.
    const { resolver } = makeResolver({});
    expect(() => resolver(personaWithPin('local'))).toThrow(/host/i);
  });

  it('throws for a hosted cross-provider pin with no key available (skip-with-warn upstream)', () => {
    const { resolver } = makeResolver({ apiKey: 'parent-key' });
    expect(() => resolver(personaWithPin('openai'))).toThrow(/api key/i);
  });

  it('throws NAMING the limitation for a cross-provider pin to an aws-authType provider (BST-1350)', () => {
    // A cross-provider pin resolves keys through personaProviderApiKeys —
    // bearer STRINGS with no region seat, so a Bedrock pin cannot be built
    // until BST-1353/BST-1358 design region-carrying pins. The throw must
    // name that limitation (skip-with-warn upstream), and it must fire even
    // when a bedrock bearer string is present in the key map — a bearer
    // without a region must not reach the factory as an api_key input.
    const { resolver } = makeResolver({
      apiKey: 'parent-key',
      runtime: {
        personaProviderApiKeys: { bedrock: 'mapped-bedrock-bearer' },
      } as unknown as RuntimeData,
    });
    expect(() => resolver(personaWithPin('bedrock'))).toThrow(/BST-1353|BST-1358/);
  });

  it('reuses the parent aws auth for a SAME-provider bedrock pin (region rides along)', () => {
    const calls: InstantiateCall[] = [];
    const awsAuth: ProviderAuthInput = { apiKey: 'bearer', kind: 'aws', region: 'us-east-1' };
    const resolver = createPersonaPinnedModelResolver({
      auth: awsAuth,
      instantiate: (provider, auth, modelName, runtime) => {
        calls.push({ auth, modelName, provider, runtime });
        return `model:${provider}:${modelName}` as never;
      },
      parentProvider: 'bedrock',
      runtime: undefined,
    });
    expect(resolver(personaWithPin('bedrock', 'anthropic.claude-haiku-4-5-20251001-v1:0'))).toBe(
      'model:bedrock:anthropic.claude-haiku-4-5-20251001-v1:0'
    );
    expect(calls[0]?.auth).toEqual(awsAuth);
  });

  it('throws when called for an un-pinned persona (contract misuse, not a fallback)', () => {
    const { resolver } = makeResolver({});
    // exactOptionalPropertyTypes: omit `model` rather than assigning undefined.
    const { model: _model, ...unpinned } = personaWithPin('anthropic');
    expect(() => resolver(unpinned)).toThrow(/pin/i);
  });
});
