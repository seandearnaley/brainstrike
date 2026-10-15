// @vitest-environment node
import type { EmbeddingSetModelInfo } from '@brainstrike/vector-management';
import { describe, expect, it, vi } from 'vitest';
import {
  embedPendingThreadMessages,
  type ThreadSearchEmbeddingRepository,
} from '../thread-search-embedding';

const PROFILE = {
  dimensions: 3,
  distance: 'cosine' as const,
  id: 'default',
  modelId: 'test-model',
  modelKey: 'local::test-model',
};

const MODEL_INFO: EmbeddingSetModelInfo = {
  dimensions: 3,
  modelConfig: null,
  modelKey: 'local::test-model',
};

function createRepository(
  overrides: Partial<ThreadSearchEmbeddingRepository> = {}
): ThreadSearchEmbeddingRepository {
  return {
    getEmbeddingProfile: vi.fn(async () => PROFILE),
    listNeedingEmbedding: vi.fn(async () => []),
    markEmbeddingError: vi.fn(async () => true),
    storeEmbedding: vi.fn(async () => true),
    ...overrides,
  };
}

describe('embedPendingThreadMessages', () => {
  it('embeds pending rows sequentially with the CAS content hash', async () => {
    const repository = createRepository({
      listNeedingEmbedding: vi.fn(async () => [
        { contentHash: 'hash-1', contentText: 'first', messageId: 'msg-1' },
        { contentHash: 'hash-2', contentText: 'second', messageId: 'msg-2' },
      ]),
    });
    const embedDocumentWithRecovery = vi.fn(async () => [0.1, 0.2, 0.3]);

    const outcomes = await embedPendingThreadMessages({
      embedder: { embedDocumentWithRecovery, embedQueryWithRecovery: vi.fn() },
      limit: 10,
      modelInfo: MODEL_INFO,
      repository,
      resourceId: 'workspace-memory',
    });

    expect(outcomes).toEqual([
      { messageId: 'msg-1', status: 'embedded' },
      { messageId: 'msg-2', status: 'embedded' },
    ]);
    expect(repository.listNeedingEmbedding).toHaveBeenCalledWith({
      limit: 10,
      resourceId: 'workspace-memory',
    });
    expect(repository.storeEmbedding).toHaveBeenCalledWith({
      contentHash: 'hash-1',
      embedding: [0.1, 0.2, 0.3],
      messageId: 'msg-1',
      modelKey: 'local::test-model',
    });
  });

  it('reports a stale outcome when the CAS store is rejected', async () => {
    const repository = createRepository({
      listNeedingEmbedding: vi.fn(async () => [
        { contentHash: 'hash-1', contentText: 'first', messageId: 'msg-1' },
      ]),
      storeEmbedding: vi.fn(async () => false),
    });

    const outcomes = await embedPendingThreadMessages({
      embedder: {
        embedDocumentWithRecovery: vi.fn(async () => [1, 2, 3]),
        embedQueryWithRecovery: vi.fn(),
      },
      limit: 10,
      modelInfo: MODEL_INFO,
      repository,
      resourceId: 'workspace-memory',
    });

    expect(outcomes).toEqual([{ messageId: 'msg-1', status: 'stale' }]);
  });

  it('marks embedding errors per row instead of aborting the pass', async () => {
    const repository = createRepository({
      listNeedingEmbedding: vi.fn(async () => [
        { contentHash: 'hash-1', contentText: 'boom', messageId: 'msg-1' },
        { contentHash: 'hash-2', contentText: 'fine', messageId: 'msg-2' },
      ]),
    });
    const embedDocumentWithRecovery = vi
      .fn(async () => [1, 2, 3])
      .mockRejectedValueOnce(new Error('model exploded'));

    const outcomes = await embedPendingThreadMessages({
      embedder: { embedDocumentWithRecovery, embedQueryWithRecovery: vi.fn() },
      limit: 10,
      modelInfo: MODEL_INFO,
      repository,
      resourceId: 'workspace-memory',
    });

    expect(outcomes[0]?.status).toBe('error');
    expect(outcomes[1]?.status).toBe('embedded');
    expect(repository.markEmbeddingError).toHaveBeenCalledWith(
      expect.objectContaining({ contentHash: 'hash-1', messageId: 'msg-1' })
    );
  });

  it('rejects a model that does not match the stored profile', async () => {
    const repository = createRepository();
    await expect(
      embedPendingThreadMessages({
        embedder: { embedDocumentWithRecovery: vi.fn(), embedQueryWithRecovery: vi.fn() },
        limit: 10,
        modelInfo: { dimensions: 999, modelConfig: null, modelKey: 'local::other-model' },
        repository,
        resourceId: 'workspace-memory',
      })
    ).rejects.toThrow(/does not match profile/);
    expect(repository.listNeedingEmbedding).not.toHaveBeenCalled();
  });
});
