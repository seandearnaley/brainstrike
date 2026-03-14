import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/embeddings/worker', () => ({
  startEmbeddingWorker: vi.fn(async (_opts) => ({ stop: async () => {} })),
}));

describe('startEmbeddingWorkerWeb', () => {
  it('delegates to startEmbeddingWorker with enable=true', async () => {
    const { startEmbeddingWorker } = await import('@brainstrike/embeddings/worker');
    const { startEmbeddingWorkerWeb } = await import('../embedding-worker-web');

    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const controller = await startEmbeddingWorkerWeb(db);
    expect(controller).toBeTruthy();
    expect(startEmbeddingWorker).toHaveBeenCalled();
    const args = (startEmbeddingWorker as Mock).mock.calls[0]?.[0];
    expect(args.enable).toBe(true);
    expect(args.db).toBe(db);
    expect(args.streamingWorkerUrl).toEqual(expect.any(String));
  });
});
