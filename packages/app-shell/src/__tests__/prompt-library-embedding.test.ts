import { buildPromptItemEmbeddingText, type PromptItem } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import {
  embedPendingPromptItems,
  type PromptLibraryEmbeddingRepository,
  queryPromptSuggestions,
} from '../prompt-library-embedding';

const modelInfo = {
  dimensions: 384,
  modelConfig: {
    description: 'Compact local embedding model',
    dimensions: 384,
    id: 'Xenova/all-MiniLM-L6-v2',
    name: 'MiniLM',
    tags: ['local'],
  },
  modelKey: 'local::Xenova/all-MiniLM-L6-v2',
};

const profile = {
  dimensions: 384,
  distance: 'cosine' as const,
  id: 'default',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: modelInfo.modelKey,
};

const activeSignal = new AbortController().signal;

function makeItem(overrides: Partial<PromptItem> = {}): PromptItem {
  return {
    archivedAt: null,
    content: 'Ask for concrete evidence and cite the source.',
    createdAt: new Date('2026-07-10T10:00:00.000Z'),
    description: 'Evidence-oriented research instruction',
    embeddingError: null,
    embeddingProfileId: null,
    embeddingRevision: null,
    embeddingStatus: 'pending',
    embeddingUpdatedAt: null,
    id: 'prompt-1',
    isFavorite: false,
    kind: 'snippet',
    lastUsedAction: null,
    lastUsedAt: null,
    modelKey: null,
    modelSettings: null,
    rating: null,
    revision: 3,
    sourceUrl: null,
    tags: ['research', 'evidence'],
    title: 'Request evidence',
    updatedAt: new Date('2026-07-10T10:00:00.000Z'),
    useCount: 0,
    ...overrides,
  };
}

function makeRepository(
  overrides: Partial<PromptLibraryEmbeddingRepository> = {}
): PromptLibraryEmbeddingRepository {
  return {
    getEmbeddingProfile: vi.fn().mockResolvedValue(profile),
    listNeedingEmbedding: vi.fn().mockResolvedValue([]),
    markEmbeddingError: vi.fn().mockResolvedValue(true),
    searchSimilar: vi.fn().mockResolvedValue([]),
    storeEmbedding: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('prompt library embedding', () => {
  it('embeds pending items sequentially with document semantics and revision-CAS writes', async () => {
    const first = makeItem();
    const second = makeItem({
      content: 'Summarize this as a decision memo.',
      id: 'prompt-2',
      revision: 8,
      title: 'Decision memo',
    });
    const events: string[] = [];
    const repository = makeRepository({
      listNeedingEmbedding: vi.fn().mockResolvedValue([first, second]),
      storeEmbedding: vi.fn(async ({ itemId }) => {
        events.push(`store:${itemId}`);
        return true;
      }),
    });
    const embedDocumentWithRecovery = vi.fn(async (_info, text: string) => {
      const item = text.includes('Decision memo') ? second : first;
      events.push(`embed:${item.id}`);
      return item === first ? [0.1, 0.2] : [0.3, 0.4];
    });
    const embedQueryWithRecovery = vi.fn();

    await expect(
      embedPendingPromptItems({
        embedder: { embedDocumentWithRecovery, embedQueryWithRecovery },
        modelInfo,
        repository,
      })
    ).resolves.toEqual([
      { itemId: first.id, revision: first.revision, status: 'embedded' },
      { itemId: second.id, revision: second.revision, status: 'embedded' },
    ]);

    expect(events).toEqual([
      'embed:prompt-1',
      'store:prompt-1',
      'embed:prompt-2',
      'store:prompt-2',
    ]);
    expect(embedDocumentWithRecovery).toHaveBeenNthCalledWith(
      1,
      modelInfo,
      buildPromptItemEmbeddingText(first)
    );
    expect(embedDocumentWithRecovery).toHaveBeenNthCalledWith(
      2,
      modelInfo,
      buildPromptItemEmbeddingText(second)
    );
    expect(repository.storeEmbedding).toHaveBeenNthCalledWith(1, {
      embedding: [0.1, 0.2],
      itemId: first.id,
      revision: first.revision,
    });
    expect(embedQueryWithRecovery).not.toHaveBeenCalled();
  });

  it('persists explicit embedding failures and continues with the next item', async () => {
    const failed = makeItem({ id: 'failed' });
    const succeeding = makeItem({ id: 'succeeding', revision: 5 });
    const repository = makeRepository({
      listNeedingEmbedding: vi.fn().mockResolvedValue([failed, succeeding]),
    });
    const embedDocumentWithRecovery = vi
      .fn()
      .mockRejectedValueOnce(new Error('WebGPU adapter unavailable'))
      .mockResolvedValueOnce([0.5, 0.6]);

    await expect(
      embedPendingPromptItems({
        embedder: { embedDocumentWithRecovery, embedQueryWithRecovery: vi.fn() },
        modelInfo,
        repository,
      })
    ).resolves.toEqual([
      {
        error: 'Prompt item "failed" embedding failed: WebGPU adapter unavailable',
        itemId: failed.id,
        revision: failed.revision,
        status: 'error',
      },
      { itemId: succeeding.id, revision: succeeding.revision, status: 'embedded' },
    ]);
    expect(repository.markEmbeddingError).toHaveBeenCalledWith(
      failed.id,
      failed.revision,
      'Prompt item "failed" embedding failed: WebGPU adapter unavailable'
    );
    expect(repository.storeEmbedding).toHaveBeenCalledWith({
      embedding: [0.5, 0.6],
      itemId: succeeding.id,
      revision: succeeding.revision,
    });
  });

  it('reports revision races as stale without overwriting the newer item', async () => {
    const item = makeItem();
    const repository = makeRepository({
      listNeedingEmbedding: vi.fn().mockResolvedValue([item]),
      storeEmbedding: vi.fn().mockResolvedValue(false),
    });

    await expect(
      embedPendingPromptItems({
        embedder: {
          embedDocumentWithRecovery: vi.fn().mockResolvedValue([0.1]),
          embedQueryWithRecovery: vi.fn(),
        },
        modelInfo,
        repository,
      })
    ).resolves.toEqual([{ itemId: item.id, revision: item.revision, status: 'stale' }]);
    expect(repository.markEmbeddingError).not.toHaveBeenCalled();
  });

  it('queries suggestions with query semantics and forwards vector-search options', async () => {
    const suggestion = { ...makeItem({ id: 'suggestion' }), similarity: 0.87 };
    const repository = makeRepository({
      searchSimilar: vi.fn().mockResolvedValue([suggestion]),
    });
    const embedQueryWithRecovery = vi.fn().mockResolvedValue([0.7, 0.8]);
    const embedDocumentWithRecovery = vi.fn();

    await expect(
      queryPromptSuggestions({
        context: 'Help me compare two storage engines',
        embedder: { embedDocumentWithRecovery, embedQueryWithRecovery },
        modelInfo,
        options: { excludeIds: ['current'], kinds: ['snippet'], limit: 4, threshold: 0.5 },
        repository,
        signal: activeSignal,
      })
    ).resolves.toEqual([suggestion]);

    expect(embedQueryWithRecovery).toHaveBeenCalledWith(
      modelInfo,
      'Help me compare two storage engines'
    );
    expect(repository.searchSimilar).toHaveBeenCalledWith([0.7, 0.8], {
      excludeIds: ['current'],
      kinds: ['snippet'],
      limit: 4,
      threshold: 0.5,
    });
    expect(embedDocumentWithRecovery).not.toHaveBeenCalled();
  });

  it('does not start query inference when recall is aborted during profile validation', async () => {
    let resolveProfile!: (value: typeof profile) => void;
    const profileReady = new Promise<typeof profile>((resolve) => {
      resolveProfile = resolve;
    });
    const repository = makeRepository({
      getEmbeddingProfile: vi.fn().mockReturnValue(profileReady),
    });
    const embedQueryWithRecovery = vi.fn().mockResolvedValue([0.7, 0.8]);
    const controller = new AbortController();
    const request = queryPromptSuggestions({
      context: 'Review this context',
      embedder: { embedDocumentWithRecovery: vi.fn(), embedQueryWithRecovery },
      modelInfo,
      repository,
      signal: controller.signal,
    });
    const abortError = new Error('Prompt recall is no longer visible.');
    abortError.name = 'AbortError';

    controller.abort(abortError);
    resolveProfile(profile);

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(embedQueryWithRecovery).not.toHaveBeenCalled();
  });

  it('fails explicitly for blank context, model-profile drift, or query embedding errors', async () => {
    const repository = makeRepository();
    const embedQueryWithRecovery = vi.fn().mockRejectedValue(new Error('provider key missing'));
    const dependencies = {
      embedder: { embedDocumentWithRecovery: vi.fn(), embedQueryWithRecovery },
      modelInfo,
      repository,
      signal: activeSignal,
    };

    await expect(queryPromptSuggestions({ ...dependencies, context: '   ' })).rejects.toThrow(
      'Prompt suggestion context must contain non-whitespace text.'
    );

    await expect(
      queryPromptSuggestions({
        ...dependencies,
        context: 'query',
        modelInfo: { ...modelInfo, dimensions: 768 },
      })
    ).rejects.toThrow(
      'Prompt embedding model does not match profile "default": expected local::Xenova/all-MiniLM-L6-v2 (384 dimensions), received local::Xenova/all-MiniLM-L6-v2 (768 dimensions).'
    );

    await expect(
      queryPromptSuggestions({
        ...dependencies,
        context: 'query',
        modelInfo: {
          ...modelInfo,
          modelConfig: { ...modelInfo.modelConfig, id: 'Xenova/a-different-model' },
        },
      })
    ).rejects.toThrow(
      'Prompt embedding model config does not match profile "default": expected Xenova/all-MiniLM-L6-v2, received Xenova/a-different-model.'
    );

    await expect(queryPromptSuggestions({ ...dependencies, context: 'query' })).rejects.toThrow(
      'provider key missing'
    );
    expect(repository.searchSimilar).not.toHaveBeenCalled();
  });
});
