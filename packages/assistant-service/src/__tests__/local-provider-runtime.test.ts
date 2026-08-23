import { PROVIDER_DEFAULT_MODELS, type RuntimeData } from '@brainstrike/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  collectLocalLlmWarmupModelIds,
  isLocalChatProvider,
  resolveLocalLlmHostClient,
} from '../local-provider-runtime.js';
import { type AssistantLlmHostManager, createMainLlmHostClient } from '../ports.js';

function makeRuntimeData(
  overrides: {
    model?: string;
    observationalMemoryEnabled?: boolean;
    observationalMemoryTarget?: string;
    provider?: string;
  } = {}
): RuntimeData {
  const data: Record<string, unknown> = {};
  if (overrides.provider !== undefined) {
    data['provider'] = overrides.provider;
  }
  if (overrides.model !== undefined) {
    data['model'] = overrides.model;
  }
  if (
    overrides.observationalMemoryEnabled !== undefined ||
    overrides.observationalMemoryTarget !== undefined
  ) {
    data['memory'] = {
      memorySettings: {
        observationalMemory: {
          ...(overrides.observationalMemoryEnabled === undefined
            ? {}
            : { enabled: overrides.observationalMemoryEnabled }),
          ...(overrides.observationalMemoryTarget === undefined
            ? {}
            : { modelTarget: overrides.observationalMemoryTarget }),
        },
      },
    };
  }
  return data as unknown as RuntimeData;
}

function makeManager(): {
  generateForMain: ReturnType<typeof vi.fn<AssistantLlmHostManager['generateForMain']>>;
  warmupForMain: ReturnType<typeof vi.fn<AssistantLlmHostManager['warmupForMain']>>;
} {
  return {
    generateForMain: vi.fn<AssistantLlmHostManager['generateForMain']>(async () => ({
      finishReason: 'stop',
      text: '',
      usage: { completionTokens: 0, promptTokens: 0, totalTokens: 0 },
    })),
    warmupForMain: vi.fn<AssistantLlmHostManager['warmupForMain']>(async () => undefined),
  };
}

describe('isLocalChatProvider', () => {
  it('matches the local provider case-insensitively after trimming', () => {
    expect(isLocalChatProvider(makeRuntimeData({ provider: 'local' }))).toBe(true);
    expect(isLocalChatProvider(makeRuntimeData({ provider: '  LOCAL ' }))).toBe(true);
  });

  it('rejects other providers and missing runtime data', () => {
    expect(isLocalChatProvider(makeRuntimeData({ provider: 'openai' }))).toBe(false);
    expect(isLocalChatProvider(undefined)).toBe(false);
  });
});

describe('resolveLocalLlmHostClient', () => {
  it('returns undefined when nothing needs the local host', () => {
    expect(resolveLocalLlmHostClient(undefined, {})).toBeUndefined();
    expect(resolveLocalLlmHostClient(makeRuntimeData({ provider: 'openai' }), {})).toBeUndefined();
    expect(
      resolveLocalLlmHostClient(
        makeRuntimeData({
          observationalMemoryEnabled: true,
          observationalMemoryTarget: 'openai/gpt-x',
          provider: 'openai',
        }),
        {}
      )
    ).toBeUndefined();
    expect(
      resolveLocalLlmHostClient(
        makeRuntimeData({
          observationalMemoryEnabled: false,
          observationalMemoryTarget: 'local/gemma',
          provider: 'openai',
        }),
        {}
      )
    ).toBeUndefined();
  });

  it('throws the fail-closed diagnostic when the host runs local work without a manager', () => {
    expect(() => resolveLocalLlmHostClient(makeRuntimeData({ provider: 'local' }), {})).toThrow(
      'the assistant server was started without one'
    );
    expect(() =>
      resolveLocalLlmHostClient(
        makeRuntimeData({
          observationalMemoryEnabled: true,
          observationalMemoryTarget: 'local/gemma',
          provider: 'openai',
        }),
        { llmHostManager: null }
      )
    ).toThrow('the assistant server was started without one');
  });

  it('adapts the manager into an agent-compatible client for local chat and local memory targets', () => {
    const manager = makeManager();
    const client = resolveLocalLlmHostClient(makeRuntimeData({ provider: 'local' }), {
      llmHostManager: manager,
    });
    expect(client).toBeDefined();

    const omClient = resolveLocalLlmHostClient(
      makeRuntimeData({
        observationalMemoryEnabled: true,
        observationalMemoryTarget: 'local/gemma',
        provider: 'openai',
      }),
      { llmHostManager: manager }
    );
    expect(omClient).toBeDefined();
  });
});

describe('createMainLlmHostClient', () => {
  it('delegates generation to the manager, forwarding options only when provided', () => {
    const manager = makeManager();
    const client = createMainLlmHostClient(manager);

    const signal = new AbortController().signal;
    void client.generate({ messages: [], modelId: 'gemma-local' }, { signal });
    expect(manager.generateForMain).toHaveBeenCalledTimes(1);
    const [firstRequest, callOptions] = manager.generateForMain.mock.calls[0]!;
    expect(callOptions).toEqual({ signal });
    expect(firstRequest).not.toHaveProperty('options');

    const generationOptions = { maxNewTokens: 16 };
    void client.generate({
      messages: [],
      modelId: 'gemma-local',
      options: generationOptions,
    });
    expect(manager.generateForMain).toHaveBeenCalledTimes(2);
    const [secondRequest, secondOptions] = manager.generateForMain.mock.calls[1]!;
    expect(secondRequest).toMatchObject({ modelId: 'gemma-local', options: generationOptions });
    expect(secondOptions).toEqual({});
  });

  it('delegates warmup to the manager with defaulted options', async () => {
    const manager = makeManager();
    const client = createMainLlmHostClient(manager);

    await client.warmup('gemma-local');
    expect(manager.warmupForMain).toHaveBeenCalledWith('gemma-local', {});
  });
});

describe('collectLocalLlmWarmupModelIds', () => {
  it('returns an empty list when local inference is not involved', () => {
    expect(collectLocalLlmWarmupModelIds(undefined)).toEqual([]);
    expect(collectLocalLlmWarmupModelIds(makeRuntimeData({ provider: 'openai' }))).toEqual([]);
  });

  it('uses the requested local chat model before the provider default', () => {
    expect(
      collectLocalLlmWarmupModelIds(makeRuntimeData({ model: 'gemma-9b', provider: 'local' }))
    ).toEqual(['gemma-9b']);
    expect(
      collectLocalLlmWarmupModelIds(makeRuntimeData({ model: '  ', provider: 'local' }))
    ).toEqual([PROVIDER_DEFAULT_MODELS['local']!]);
    expect(collectLocalLlmWarmupModelIds(makeRuntimeData({ model: 'gemma-9b' }))).toEqual([]);
  });

  it('skips warming an observational-memory target that names no local model', () => {
    expect(
      collectLocalLlmWarmupModelIds(
        makeRuntimeData({
          observationalMemoryEnabled: true,
          observationalMemoryTarget: 'local/',
          provider: 'openai',
        })
      )
    ).toEqual([]);
  });

  it('dedupes identical chat and observational-memory targets into one warmup', () => {
    const ids = collectLocalLlmWarmupModelIds(
      makeRuntimeData({
        model: 'gemma',
        observationalMemoryEnabled: true,
        observationalMemoryTarget: 'local/gemma',
        provider: 'local',
      })
    );
    expect(ids).toEqual(['gemma']);
  });

  it('warms a distinct observational-memory target even when chat is hosted', () => {
    const ids = collectLocalLlmWarmupModelIds(
      makeRuntimeData({
        observationalMemoryEnabled: true,
        observationalMemoryTarget: 'local/gemma-mem',
        provider: 'openai',
      })
    );
    expect(ids).toEqual(['gemma-mem']);
  });
});
