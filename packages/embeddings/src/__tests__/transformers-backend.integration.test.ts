import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransformersBackend } from '../transformers-backend';

// Mock @huggingface/transformers to control pipeline behavior
vi.mock('@huggingface/transformers', () => {
  let shouldThrowOnCreate = false;
  const setThrow = (v: boolean) => {
    shouldThrowOnCreate = v;
  };
  const module = {
    pipeline: async (_task: string, _model: string, _config: unknown) => {
      if (shouldThrowOnCreate) {
        // After first failure, next call succeeds
        shouldThrowOnCreate = false;
        throw new Error('creation failed');
      }
      const fn = async (_text: string, _opts: unknown) => ({
        data: new Float32Array([0.1, 0.2, 0.3]),
      });
      return fn;
    },
    __setThrow: setThrow,
  } as unknown as Record<string, unknown>;
  return module;
});

describe('TransformersBackend', () => {
  beforeEach(() => {
    vi.resetModules();
    // Simulate browser with WebGPU availability to exercise fallback
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
  });

  it('selects device and falls back on initialize failure', async () => {
    // Enable failure on first pipeline creation to trigger fallback path
    const mocked = await import('@huggingface/transformers');
    // @ts-expect-error test helper
    mocked.__setThrow?.(true);

    const backend = new TransformersBackend();
    await backend.initialize({
      modelId: 'bge-m3',
      device: 'webgpu',
      quantized: false,
    });

    expect(backend.isInitialized()).toBe(true);
    // In browser fallback, we expect 'wasm' after failing 'webgpu'
    expect(backend.getSelectedDevice()).toBe('wasm');

    const result = await backend.generateEmbedding('hello', 'bge-m3');
    expect(Array.isArray(result.embedding)).toBe(true);
    expect(result.embedding.length).toBe(3);
  });

  it('exposes basic static helpers', () => {
    // Best device for current simulated environment (webgpu available)
    expect(TransformersBackend.getBestDevice()).toBe('webgpu');
    expect(TransformersBackend.isDeviceAvailable('cpu')).toBe(true);
    expect(TransformersBackend.isDeviceAvailable('wasm')).toBe(true);
    expect(TransformersBackend.isDeviceAvailable('webgpu')).toBe(true);
  });
});
