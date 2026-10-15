import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalLlmHostClient } from '../providers/local/llm-host-client';

const createLlmHostChatModelMock = vi.fn(
  (modelId: string, _client: unknown, settings?: unknown) => ({
    modelId,
    provider: 'local',
    settings,
    specificationVersion: 'v2',
  })
);

vi.mock('../providers/local/llm-host-chat-model', () => ({
  createLlmHostChatModel: createLlmHostChatModelMock,
}));

const hostClient = {
  cancel: vi.fn(),
  generate: vi.fn(),
  warmup: vi.fn(),
} as unknown as LocalLlmHostClient;

describe('provider-factory local provider', () => {
  beforeEach(() => {
    vi.resetModules();
    createLlmHostChatModelMock.mockClear();
  });

  it('uses Gemma 4 E2B as the default local model', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    const model = createProvider('local', undefined, undefined, {
      localLlmHostClient: hostClient,
    }) as { modelId: string };

    expect(model.modelId).toBe('onnx-community/gemma-4-E2B-it-ONNX');
    expect(createLlmHostChatModelMock).toHaveBeenCalledWith(
      'onnx-community/gemma-4-E2B-it-ONNX',
      hostClient,
      undefined
    );
  });

  it('forwards local thinking settings to the llm-host chat model', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    createProvider('local', undefined, 'onnx-community/gemma-4-E2B-it-ONNX', {
      localLlmHostClient: hostClient,
      providerOptions: {
        local: {
          thinking: {
            enabled: false,
          },
        },
      },
    });

    expect(createLlmHostChatModelMock).toHaveBeenCalledWith(
      'onnx-community/gemma-4-E2B-it-ONNX',
      hostClient,
      expect.objectContaining({
        thinking: {
          enabled: false,
        },
      })
    );
  });

  // The llm-host renderer is the ONLY local engine (ADR-0007/0015). A run that
  // reaches here without a host client — Electron main with no llm-host, a Node
  // server, the headless CLI — must fail, never silently pick another engine.
  it('refuses the local provider when no llm-host client is injected', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    expect(() => createProvider('local')).toThrow(
      /requires the local LLM host client \(renderer-only inference\)/
    );
    expect(createLlmHostChatModelMock).not.toHaveBeenCalled();
  });

  it('refuses the local provider from the broad package entrypoint too', async () => {
    const { createProvider } = await import('..');

    expect(() => createProvider('local', undefined, 'onnx-community/gemma-4-E2B-it-ONNX')).toThrow(
      /requires the local LLM host client \(renderer-only inference\)/
    );
    expect(createLlmHostChatModelMock).not.toHaveBeenCalled();
  });
});
