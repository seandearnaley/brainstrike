// @vitest-environment node
import * as providerRuntime from '@brainstrike/agent/provider-runtime';
import type { ProductionHostRunConfiguration } from '@brainstrike/agent-host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopHostMemoryConfiguration } from '../agent-host-platform/memory-model-configuration';
import {
  type PlatformSelection,
  PlatformSelectionSchema,
} from '../agent-host-platform/platform-wire';

const providers = ['openai', 'anthropic', 'google', 'openrouter'] as const;
const syntheticCredential = 'synthetic-memory-fixture';
type MemoryConfiguration = ProductionHostRunConfiguration['memory'];
type Auth = providerRuntime.ProviderAuthInput | undefined;
type ObserverOptions = Exclude<
  NonNullable<MemoryConfiguration['native']['options']>['observationalMemory'],
  boolean | undefined
>;

/** The admitted platform payload shape, parsed by its existing schema. */
function selection(modelTarget = 'openai/observer-fixture'): PlatformSelection {
  return PlatformSelectionSchema.parse({
    configuration: { model: 'chat-fixture', provider: 'anthropic' },
    contextWindow: 32_000,
    durableConfiguration: {},
    inputTokenLimit: 24_000,
    maxSteps: 5,
    memory: {
      options: {
        lastMessages: 12,
        workingMemory: { enabled: true, scope: 'resource', template: 'Fixture notes' },
      },
      settings: {
        observationalMemory: {
          enabled: true,
          messageTokens: 31_000,
          modelTarget,
          observationTokens: 43_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: null,
          enabled: false,
          messageRange: 2,
          scope: 'resource',
          topK: 5,
        },
      },
    },
    nativeRuntime: { provider: 'anthropic', workspaceRoots: [] },
    resourceId: 'workspace-fixture',
    tools: {},
    toolTimeoutMs: 5000,
  });
}

function observerOptions(memory: MemoryConfiguration): ObserverOptions {
  const observation = memory.native.options?.observationalMemory;
  if (!observation || typeof observation !== 'object') {
    throw new Error('Fixture expected enabled public Memory options');
  }
  return observation;
}

/** Inspect only public model identity/capabilities, never credential-bearing objects. */
function modelMetadata(memory: MemoryConfiguration): {
  generate: string;
  modelId: string;
  specificationVersion: string;
  stream: string;
} {
  const model = observerOptions(memory).model;
  if (
    !model ||
    typeof model !== 'object' ||
    !('doGenerate' in model) ||
    !('doStream' in model) ||
    !('modelId' in model) ||
    typeof model.modelId !== 'string' ||
    !('specificationVersion' in model) ||
    typeof model.specificationVersion !== 'string'
  ) {
    throw new Error('Fixture expected a concrete public Memory model');
  }
  return {
    generate: typeof model.doGenerate,
    modelId: model.modelId,
    specificationVersion: model.specificationVersion,
    stream: typeof model.doStream,
  };
}

describe('admitted Memory model configuration', () => {
  const fetch = vi.fn(async () => {
    throw new Error('Provider requests are outside this fixture');
  });

  beforeEach(() => {
    fetch.mockClear();
    vi.stubGlobal('fetch', fetch);
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']) {
      vi.stubEnv(name, 'synthetic-ambient-fixture');
    }
  });
  afterEach(() => {
    expect(fetch.mock.calls.length).toBe(0);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(providers)(
    'materializes %s through the public provider factory with explicit auth',
    async (provider) => {
      const factory = vi.spyOn(providerRuntime, 'createProvider');
      const resolveAuth = vi.fn(
        async (_provider: string): Promise<Auth> => ({
          apiKey: syntheticCredential,
          kind: 'api_key',
        })
      );
      const selected = selection(`${provider}/observer-fixture`);
      const memory = await createDesktopHostMemoryConfiguration(selected, resolveAuth);
      expect(resolveAuth.mock.calls.map(([requested]) => requested)).toEqual([provider]);
      expect(
        factory.mock.calls.map(([resolvedProvider, auth, model]) => ({
          configuredCredential: auth?.kind === 'api_key' && auth.apiKey === syntheticCredential,
          model,
          provider: resolvedProvider,
        }))
      ).toEqual([{ configuredCredential: true, model: 'observer-fixture', provider }]);
      expect(modelMetadata(memory)).toEqual({
        generate: 'function',
        modelId: 'observer-fixture',
        specificationVersion: 'v4',
        stream: 'function',
      });
      expect(memory.resourceId).toBe(selected.resourceId);
      expect(memory.native.options?.lastMessages).toBe(12);
      expect(memory.native.options?.workingMemory).toEqual(selected.memory.options.workingMemory);
      expect(memory.native.options?.workingMemory).not.toBe(selected.memory.options.workingMemory);
      expect(memory.native.options?.semanticRecall).toBe(false);
    }
  );

  it.each(['thread', 'resource'] as const)(
    'preserves %s scope, retrieval, and token thresholds',
    async (scope) => {
      const selected = selection();
      selected.memory.settings.observationalMemory.scope = scope;
      selected.memory.settings.observationalMemory.retrievalMode = 'messages';
      selected.memory.options.lastMessages = false;
      selected.memory.options.workingMemory = { enabled: false, scope, template: 'Saved template' };
      const memory = await createDesktopHostMemoryConfiguration(selected, async () => ({
        apiKey: syntheticCredential,
        kind: 'api_key',
      }));
      const { model: _model, ...options } = observerOptions(memory);
      expect(options).toEqual({
        observation: { messageTokens: 31_000 },
        reflection: { observationTokens: 43_000 },
        retrieval: { scope },
        scope,
      });
      expect(memory.native.options?.lastMessages).toBe(false);
      expect(memory.native.options?.workingMemory).toEqual(selected.memory.options.workingMemory);
    }
  );

  it('normalizes the explicit target and preserves nested OpenRouter model IDs', async () => {
    const factory = vi.spyOn(providerRuntime, 'createProvider');
    const resolveAuth = vi.fn(
      async (_provider: string): Promise<Auth> => ({
        apiKey: syntheticCredential,
        kind: 'api_key',
      })
    );
    const memory = await createDesktopHostMemoryConfiguration(
      selection('  OpenRouter/vendor/observer-fixture  '),
      resolveAuth
    );
    expect(resolveAuth.mock.calls.map(([provider]) => provider)).toEqual(['openrouter']);
    expect(
      factory.mock.calls.map(([provider, _credential, model]) => ({ model, provider }))
    ).toEqual([{ model: 'vendor/observer-fixture', provider: 'openrouter' }]);
    expect(modelMetadata(memory).modelId).toBe('vendor/observer-fixture');
    expect(observerOptions(memory).retrieval).toBeUndefined();
  });

  it.each(['auto', 'unknown/fixture', 'local/fixture'])(
    'does no auth or model work when OM is disabled (%s)',
    async (target) => {
      const selected = selection(target);
      selected.memory.settings.observationalMemory.enabled = false;
      selected.memory.settings.observationalMemory.retrievalMode = 'vector';
      const resolver = vi.fn(async (): Promise<Auth> => {
        throw new Error('Disabled Memory must not request a credential');
      });
      const factory = vi.spyOn(providerRuntime, 'createProvider');
      const memory = await createDesktopHostMemoryConfiguration(selected, resolver);
      expect(memory.native.options?.observationalMemory).toBe(false);
      expect(resolver.mock.calls.length).toBe(0);
      expect(factory.mock.calls.length).toBe(0);
    }
  );

  it.each([
    'auto',
    'openai',
    'openai/',
    'unknown/fixture',
    'bedrock/fixture',
    'openai-codex/fixture',
    'ollama/fixture',
    'lmstudio/fixture',
    'local/fixture',
  ])('rejects unavailable target %s before resolving credentials', async (target) => {
    const resolver = vi.fn(async (): Promise<Auth> => undefined);
    const factory = vi.spyOn(providerRuntime, 'createProvider');
    await expect(
      createDesktopHostMemoryConfiguration(selection(target), resolver)
    ).rejects.toBeInstanceOf(Error);
    expect(resolver.mock.calls.length).toBe(0);
    expect(factory.mock.calls.length).toBe(0);
  });

  it.each(['semanticRecall', 'vector'] as const)(
    'preserves a visible failure for missing %s capability',
    async (feature) => {
      const selected = selection();
      if (feature === 'semanticRecall') {
        selected.memory.settings.semanticRecall.enabled = true;
        selected.memory.settings.semanticRecall.embeddingModelTarget = 'openai/embed-fixture';
      } else {
        selected.memory.settings.observationalMemory.retrievalMode = 'vector';
      }
      const before = structuredClone(selected);
      const resolver = vi.fn(async (): Promise<Auth> => undefined);
      await expect(createDesktopHostMemoryConfiguration(selected, resolver)).rejects.toBeInstanceOf(
        Error
      );
      expect(selected).toEqual(before);
      expect(resolver.mock.calls.length).toBe(0);
    }
  );

  const missingAuth: readonly { label: string; value: Auth }[] = [
    { label: 'undefined', value: undefined },
    {
      label: 'custom fetch',
      value: { apiKey: syntheticCredential, fetch, kind: 'custom_fetch' },
    },
    { label: 'AWS', value: { apiKey: syntheticCredential, kind: 'aws', region: 'fixture-region' } },
    {
      label: 'AWS credential chain',
      value: {
        credentialProvider: async () => {
          throw new Error('Persistent Memory must not invoke an AWS credential chain');
        },
        kind: 'aws',
        region: 'us-east-1',
      },
    },
    { label: 'empty API key', value: { apiKey: '', kind: 'api_key' } },
    { label: 'blank API key', value: { apiKey: '  ', kind: 'api_key' } },
  ];
  for (const provider of providers) {
    it.each(missingAuth)(
      `rejects $label for ${provider} without ambient credential fallback`,
      async ({ value }) => {
        await expect(
          createDesktopHostMemoryConfiguration(
            selection(`${provider}/observer-fixture`),
            async () => value
          )
        ).rejects.toBeInstanceOf(Error);
      }
    );
  }

  it('propagates private credential resolver failures without replacement or model work', async () => {
    const cause = new Error('Synthetic credential owner failure');
    const factory = vi.spyOn(providerRuntime, 'createProvider');
    await expect(
      createDesktopHostMemoryConfiguration(selection(), async () => {
        throw cause;
      })
    ).rejects.toBe(cause);
    expect(factory.mock.calls.length).toBe(0);
  });
});
