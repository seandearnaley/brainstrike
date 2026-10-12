import { describe, expect, it, vi } from 'vitest';
import { type AssistantLlmHostManager, createMainLlmHostClient } from '../ports.js';

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
