import { describe, expect, it, vi } from 'vitest';
import {
  embedPendingHostSearchRows,
  type HostThreadSearchVectors,
  threadSearchVectorProfile,
} from '../host-thread-search-vectors';

const LOCAL = {
  dimensions: 384,
  modelConfig: { description: '', dimensions: 384, id: 'bge-small-en-v1.5', name: 'BGE', tags: [] },
  modelKey: 'local::bge-small-en-v1.5',
};

describe('threadSearchVectorProfile', () => {
  it("names a local model's load on its runtime's device, as the shared dtype rule does", () => {
    expect(threadSearchVectorProfile(LOCAL, 'webgpu')).toEqual({
      dimensions: 384,
      distance: 'cosine',
      dtype: 'fp16',
      modelId: 'bge-small-en-v1.5',
      provider: 'local',
    });
    // The same model on WASM is another profile: its vectors are not mixed.
    expect(threadSearchVectorProfile(LOCAL, 'wasm')).toMatchObject({ dtype: 'q4' });
  });

  it('names a hosted model by its provider key', () => {
    expect(
      threadSearchVectorProfile(
        { dimensions: 1536, modelConfig: null, modelKey: 'openai::text-embedding-3-small' },
        'hosted'
      )
    ).toEqual({
      dimensions: 1536,
      distance: 'cosine',
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    });
  });
});

describe('embedPendingHostSearchRows', () => {
  it('stores the rows that embedded, then fails the pass for the one that did not', async () => {
    const host: HostThreadSearchVectors = {
      pending: vi.fn(async () => [
        { seq: 1, sourceHash: 'a'.repeat(64), text: 'first', threadId: 'host-thread' },
        { seq: 2, sourceHash: 'b'.repeat(64), text: 'broken', threadId: 'host-thread' },
      ]),
      put: vi.fn(async () => ({ stale: 0, stored: 1 })),
    };
    const embedder = {
      embedDocumentWithRecovery: vi.fn(async (_info: unknown, text: string) => {
        if (text === 'broken') {
          throw new Error('model unavailable');
        }
        return [1, 0];
      }),
      embedQueryWithRecovery: vi.fn(),
    };
    const profile = threadSearchVectorProfile(LOCAL, 'wasm');

    await expect(
      embedPendingHostSearchRows({ embedder, host, limit: 16, modelInfo: LOCAL, profile })
    ).rejects.toThrow('1 host thread messages failed to embed');
    expect(host.pending).toHaveBeenCalledWith(profile, 16);
    expect(host.put).toHaveBeenCalledWith(profile, [
      { seq: 1, sourceHash: 'a'.repeat(64), threadId: 'host-thread', vector: [1, 0] },
    ]);
  });
});
