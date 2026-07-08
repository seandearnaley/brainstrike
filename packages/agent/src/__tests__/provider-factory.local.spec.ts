import { beforeEach, describe, expect, it, vi } from 'vitest';

const createLocalLanguageModelMock = vi.fn((modelId: string, settings?: unknown) => ({
  modelId,
  provider: 'local',
  settings,
  specificationVersion: 'v2',
}));

vi.mock('../providers/local', () => ({
  createLocalLanguageModel: createLocalLanguageModelMock,
}));

describe('provider-factory local provider', () => {
  beforeEach(() => {
    vi.resetModules();
    createLocalLanguageModelMock.mockClear();
  });

  it('uses Gemma 4 E2B as the default local model', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    const model = createProvider('local') as { modelId: string };

    expect(model.modelId).toBe('onnx-community/gemma-4-E2B-it-ONNX');
    expect(createLocalLanguageModelMock).toHaveBeenCalledWith(
      'onnx-community/gemma-4-E2B-it-ONNX',
      undefined
    );
  });

  it('forwards local thinking settings into the local language model', async () => {
    const { createProvider } = await import('../providers/provider-factory');

    createProvider('local', undefined, 'onnx-community/gemma-4-E2B-it-ONNX', {
      providerOptions: {
        local: {
          thinking: {
            enabled: false,
          },
        },
      },
    });

    expect(createLocalLanguageModelMock).toHaveBeenCalledWith(
      'onnx-community/gemma-4-E2B-it-ONNX',
      expect.objectContaining({
        thinking: {
          enabled: false,
        },
      })
    );
  });
});
