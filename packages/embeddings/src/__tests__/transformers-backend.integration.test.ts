import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransformersBackend } from '../transformers-backend';

// Mock @huggingface/transformers to control pipeline behavior
vi.mock('@huggingface/transformers', () => {
  let shouldThrowOnCreate = false;
  const setThrow = (v: boolean) => {
    shouldThrowOnCreate = v;
  };
  const module = {
    __setThrow: setThrow,
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
  } as unknown as Record<string, unknown>;
  return module;
});

describe('TransformersBackend', () => {
  beforeEach(() => {
    vi.resetModules();
    // Simulate browser with WebGPU availability
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
  });

  it('throws when initialize fails for the selected device', async () => {
    // Enable failure on first pipeline creation
    const mocked = await import('@huggingface/transformers');
    // @ts-expect-error test helper
    mocked.__setThrow?.(true);

    const backend = new TransformersBackend();
    await expect(
      backend.initialize({
        device: 'webgpu',
        modelId: 'bge-m3',
        quantized: false,
      })
    ).rejects.toThrow('creation failed');

    expect(backend.isInitialized()).toBe(false);
  });

  it('exposes basic static helpers', () => {
    // Best device for current simulated environment (webgpu available)
    expect(TransformersBackend.getBestDevice()).toBe('webgpu');
    expect(TransformersBackend.isDeviceAvailable('cpu')).toBe(false);
    expect(TransformersBackend.isDeviceAvailable('wasm')).toBe(true);
    expect(TransformersBackend.isDeviceAvailable('webgpu')).toBe(true);
  });
});
