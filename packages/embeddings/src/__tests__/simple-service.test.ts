import { describe, expect, it, vi } from 'vitest';

vi.mock('../transformers-backend', () => {
  class MockBackend {
    private _inited = false;
    private _device: string | null = null;
    async initialize(cfg: { device?: string | null }) {
      this._inited = true;
      this._device = cfg?.device ?? null;
    }
    isInitialized() {
      return this._inited;
    }
    async generateEmbedding(text: string, _modelId: string) {
      const n = Math.min(5, Math.max(3, text.length));
      return { embedding: Array.from({ length: n }, (_, i) => i * 0.01) };
    }
    getSelectedDevice() {
      return this._device;
    }
    async dispose() {
      this._inited = false;
      this._device = null;
    }
    setTargetDimensions() {}
  }
  return { TransformersBackend: MockBackend };
});

describe('SimpleEmbeddingService (lightweight)', () => {
  it('initializes with model and generates embedding', async () => {
    const { SimpleEmbeddingService } = await import('../bge-m3-service');
    const svc = new SimpleEmbeddingService();
    await svc.initializeWithModel('jinaai/jina-embeddings-v2-base-code', undefined, 'cpu');
    const out = await svc.generateEmbedding('hello');
    expect(Array.isArray(out.embedding)).toBe(true);
    expect(out.embedding.length).toBeGreaterThan(0);
    await svc.dispose();
  });
});
