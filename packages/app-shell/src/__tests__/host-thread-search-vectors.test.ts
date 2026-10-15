// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  combineThreadSearchCoverage,
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
  it("hands back a row that failed with its error, as history's embedding_error, beside the rest", async () => {
    const host: HostThreadSearchVectors = {
      coverage: vi.fn(),
      pending: vi.fn(async () => [
        { seq: 1, sourceHash: 'a'.repeat(64), text: 'first', threadId: 'host-thread' },
        { seq: 2, sourceHash: 'b'.repeat(64), text: 'broken', threadId: 'host-thread' },
      ]),
      put: vi.fn(async () => ({ failed: 1, stale: 0, stored: 1 })),
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

    expect(
      await embedPendingHostSearchRows({ embedder, host, limit: 16, modelInfo: LOCAL, profile })
    ).toBe(2);
    expect(host.pending).toHaveBeenCalledWith(profile, 16);
    expect(host.put).toHaveBeenCalledWith(profile, [
      { seq: 1, sourceHash: 'a'.repeat(64), threadId: 'host-thread', vector: [1, 0] },
      {
        error: 'Host thread message host-thread#2 embedding failed: model unavailable',
        seq: 2,
        sourceHash: 'b'.repeat(64),
        threadId: 'host-thread',
      },
    ]);
  });
});

describe('combineThreadSearchCoverage', () => {
  it("adds the host's rows to history's, as one embedding progress", () => {
    const history = {
      embeddableMessages: 4,
      embeddedMessages: 2,
      erroredMessages: 1,
      indexedMessages: 5,
      totalMessages: 6,
    };
    expect(combineThreadSearchCoverage(history, { embedded: 3, errored: 1, rows: 10 })).toEqual({
      embeddableMessages: 14,
      embeddedMessages: 5,
      erroredMessages: 2,
      indexedMessages: 15,
      totalMessages: 16,
    });
    expect(combineThreadSearchCoverage(history, null)).toBe(history);
  });
});
