import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransformersBackend } from '../transformers-backend';

// Mock @huggingface/transformers so importing the backend never pulls in the
// real (heavy) library. The backend is queue-based and does not call `pipeline`
// on the paths exercised here (static helpers + a queue-unavailable rejection),
// so a stub is all that is needed.
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
}));

describe('TransformersBackend', () => {
  beforeEach(() => {
    vi.resetModules();
    // Simulate browser with WebGPU availability
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { gpu: {} });
  });

  it('rejects initialize and stays uninitialized when no worker queue is available', async () => {
    // The backend is queue-based: initialize() requires a Web Worker queue
    // (supportsWorkerQueue()). beforeEach stubs a browser WITHOUT a `Worker`
    // global, so initialize must reject and leave the backend uninitialized.
    // (This replaces a stale assertion from the pre-queue era that expected a
    // 'creation failed' error from a directly-constructed transformers pipeline;
    // initialize no longer reaches that path, and the file was orphaned — run by
    // no lane — before the A4 test-split surfaced it.)
    const backend = new TransformersBackend();
    await expect(
      backend.initialize({
        device: 'webgpu',
        modelId: 'bge-m3',
        quantized: false,
      })
    ).rejects.toThrow('Embedding worker queue required');

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
