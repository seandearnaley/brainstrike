// @vitest-environment node

import type { CatalogEmbeddingModel } from '@brainstrike/indexing-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateDesktopQueryEmbedding = vi.hoisted(() => vi.fn(async () => [0.1, 0.2]));
vi.mock('../renderer/query-embeddings', () => ({ generateDesktopQueryEmbedding }));

const {
  downloadDesktopEmbeddingModel,
  readDesktopDownloadedEmbeddingModels,
  resolveModelDownloadDevice,
} = await import('../renderer/settings-model-download');

/** A catalog row that pins its revision, per-device dtype and pooling (BST-1993). */
const GRANITE: CatalogEmbeddingModel = {
  dimensions: 384,
  execution: { wasm: 'q8', webgpu: 'fp16' },
  id: 'onnx-community/granite-embedding-small-english-r2-ONNX',
  pooling: 'cls',
  prompts: { document: '', query: '' },
  revision: '0123456789abcdef0123456789abcdef01234567',
};

beforeEach(() => {
  generateDesktopQueryEmbedding.mockClear();
});

describe('resolveModelDownloadDevice (BST-2230)', () => {
  it('uses a saved device without asking for detection', async () => {
    const detect = vi.fn();
    await expect(
      resolveModelDownloadDevice({ devicePref: 'wasm', devicePrefConfigured: true }, detect)
    ).resolves.toBe('wasm');
    expect(detect).not.toHaveBeenCalled();
  });

  it('picks WebGPU when the host detects an adapter and nothing is saved', async () => {
    await expect(
      resolveModelDownloadDevice(
        { devicePref: 'webgpu', devicePrefConfigured: false },
        async () => ({
          available: true,
          reason: 'adapter found',
        })
      )
    ).resolves.toBe('webgpu');
  });

  it('never picks WASM on its own: it names the reason and the setting to change', async () => {
    await expect(
      resolveModelDownloadDevice(
        { devicePref: 'webgpu', devicePrefConfigured: false },
        async () => ({
          available: false,
          reason: 'No WebGPU adapter found',
        })
      )
    ).rejects.toThrow(
      'WebGPU is not available on this device (No WebGPU adapter found). Choose WASM in Settings → Search & Indexing.'
    );
  });
});

describe('downloadDesktopEmbeddingModel (BST-2230)', () => {
  it('asks the hidden host for the catalog plan indexing pins: revision, device dtype and pooling', async () => {
    await downloadDesktopEmbeddingModel(GRANITE, 'wasm', new AbortController().signal);

    expect(generateDesktopQueryEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: 384,
        inferencePlan: expect.objectContaining({
          device: 'wasm',
          dtype: 'q8',
          modelId: GRANITE.id,
          pooling: 'cls',
          revision: GRANITE.revision,
        }),
        modelId: GRANITE.id,
        modelKey: `local::${GRANITE.id}`,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('loads the WebGPU dtype the row states for WebGPU', async () => {
    await downloadDesktopEmbeddingModel(GRANITE, 'webgpu', new AbortController().signal);

    expect(generateDesktopQueryEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({
        inferencePlan: expect.objectContaining({ device: 'webgpu', dtype: 'fp16' }),
      }),
      expect.anything()
    );
  });
});

describe('readDesktopDownloadedEmbeddingModels (BST-2241)', () => {
  it('asks the host cache about the same plans a download loads, and keeps the cached ids', async () => {
    const readHostCache = vi.fn(async () => [true, false]);
    const MINILM: CatalogEmbeddingModel = {
      dimensions: 384,
      id: 'Xenova/all-MiniLM-L6-v2',
      prompts: { document: '', query: '' },
    };

    await expect(
      readDesktopDownloadedEmbeddingModels([GRANITE, MINILM], 'wasm', readHostCache)
    ).resolves.toEqual([GRANITE.id]);
    expect(readHostCache).toHaveBeenCalledWith([
      { device: 'wasm', dtype: 'q8', modelId: GRANITE.id, revision: GRANITE.revision },
      { device: 'wasm', dtype: 'q4', modelId: MINILM.id },
    ]);
  });
});
