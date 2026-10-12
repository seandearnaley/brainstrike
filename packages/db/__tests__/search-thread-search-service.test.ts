import { describe, expect, it, vi } from 'vitest';
import type {
  ThreadMessageFtsMatch,
  ThreadMessageVectorMatch,
  ThreadTitleMatch,
} from '../src/models/thread-search.js';
import {
  createThreadSearchService,
  type ThreadSearchServiceRepository,
} from '../src/search/thread-search-service.js';

const RESOURCE_ID = 'workspace-memory';
const NOW = new Date('2026-07-19T00:00:00Z');

function ftsMatch(overrides: Partial<ThreadMessageFtsMatch> = {}): ThreadMessageFtsMatch {
  return {
    headline: '<mark>hnsw</mark> tuning',
    messageCreatedAt: NOW,
    messageId: 'msg-1',
    rank: 0.5,
    role: 'assistant',
    threadId: 'thread-1',
    ...overrides,
  };
}

function vectorMatch(overrides: Partial<ThreadMessageVectorMatch> = {}): ThreadMessageVectorMatch {
  return {
    messageCreatedAt: NOW,
    messageId: 'msg-1',
    role: 'assistant',
    similarity: 0.9,
    snippet: 'hnsw tuning details',
    threadId: 'thread-1',
    ...overrides,
  };
}

function titleMatch(overrides: Partial<ThreadTitleMatch> = {}): ThreadTitleMatch {
  return {
    similarity: 0.8,
    threadId: 'thread-1',
    title: 'HNSW tuning',
    ...overrides,
  };
}

function createStubRepository(data: {
  fts?: ThreadMessageFtsMatch[];
  titles?: ThreadTitleMatch[];
  vector?: ThreadMessageVectorMatch[];
}): ThreadSearchServiceRepository {
  return {
    fullTextSearch: vi.fn(async () => data.fts ?? []),
    searchSimilar: vi.fn(async () => data.vector ?? []),
    searchThreadTitles: vi.fn(async () => data.titles ?? []),
  };
}

describe('ThreadSearchService', () => {
  it('rejects a blank query', async () => {
    const service = createThreadSearchService(createStubRepository({}));
    await expect(
      service.searchThreads('   ', { queryEmbedding: null, resourceId: RESOURCE_ID })
    ).rejects.toThrow(/query/i);
  });

  it('runs lexical-only when no query embedding is provided', async () => {
    const repository = createStubRepository({ fts: [ftsMatch()] });
    const service = createThreadSearchService(repository);

    const response = await service.searchThreads('hnsw', {
      queryEmbedding: null,
      resourceId: RESOURCE_ID,
    });

    expect(repository.searchSimilar).not.toHaveBeenCalled();
    expect(response.metadata.semanticArmUsed).toBe(false);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.threadId).toBe('thread-1');
    expect(response.results[0]?.matches[0]?.sources).toEqual(['fts']);
  });

  it('fuses both arms: a dual-source message outranks single-source peers', async () => {
    const repository = createStubRepository({
      fts: [
        ftsMatch({ messageId: 'msg-both', rank: 0.4, threadId: 'thread-both' }),
        ftsMatch({ messageId: 'msg-fts-only', rank: 0.9, threadId: 'thread-fts' }),
      ],
      vector: [
        vectorMatch({ messageId: 'msg-both', similarity: 0.8, threadId: 'thread-both' }),
        vectorMatch({ messageId: 'msg-vec-only', similarity: 0.95, threadId: 'thread-vec' }),
      ],
    });
    const service = createThreadSearchService(repository);

    const response = await service.searchThreads('hnsw', {
      queryEmbedding: [0.1, 0.2],
      resourceId: RESOURCE_ID,
    });

    expect(response.metadata.semanticArmUsed).toBe(true);
    expect(response.results[0]?.threadId).toBe('thread-both');
    const bothMatch = response.results[0]?.matches[0];
    expect(bothMatch?.sources).toEqual(['fts', 'vector']);
    // Vector-only matches fall back to their plain snippet for display.
    const vecThread = response.results.find((result) => result.threadId === 'thread-vec');
    expect(vecThread?.matches[0]?.headline).toBe('hnsw tuning details');
  });

  it('groups messages by thread, capping matches per thread best-first', async () => {
    const repository = createStubRepository({
      fts: [
        ftsMatch({ messageId: 'msg-a', rank: 0.9 }),
        ftsMatch({ messageId: 'msg-b', rank: 0.7 }),
        ftsMatch({ messageId: 'msg-c', rank: 0.5 }),
        ftsMatch({ messageId: 'msg-d', rank: 0.3 }),
      ],
    });
    const service = createThreadSearchService(repository);

    const response = await service.searchThreads('hnsw', {
      perThreadMatchLimit: 2,
      queryEmbedding: null,
      resourceId: RESOURCE_ID,
    });

    expect(response.results).toHaveLength(1);
    const matches = response.results[0]?.matches ?? [];
    expect(matches).toHaveLength(2);
    expect(matches.map((match) => match.messageId)).toEqual(['msg-a', 'msg-b']);
  });

  it('surfaces title-only matches with no message matches', async () => {
    const repository = createStubRepository({
      titles: [titleMatch({ threadId: 'thread-title-only' })],
    });
    const service = createThreadSearchService(repository);

    const response = await service.searchThreads('hnsw', {
      queryEmbedding: null,
      resourceId: RESOURCE_ID,
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.threadId).toBe('thread-title-only');
    expect(response.results[0]?.titleMatched).toBe(true);
    expect(response.results[0]?.title).toBe('HNSW tuning');
    expect(response.results[0]?.matches).toEqual([]);
  });

  it('ranks a title+content thread above an equally-ranked content-only thread', async () => {
    const repository = createStubRepository({
      fts: [
        ftsMatch({ messageId: 'msg-1', rank: 0.9, threadId: 'thread-content-only' }),
        ftsMatch({ messageId: 'msg-2', rank: 0.9, threadId: 'thread-title-too' }),
      ],
      titles: [titleMatch({ threadId: 'thread-title-too' })],
    });
    const service = createThreadSearchService(repository);

    const response = await service.searchThreads('hnsw', {
      queryEmbedding: null,
      resourceId: RESOURCE_ID,
    });

    expect(response.results.map((result) => result.threadId)).toEqual([
      'thread-title-too',
      'thread-content-only',
    ]);
    expect(response.results[0]?.titleMatched).toBe(true);
    expect(response.results[1]?.titleMatched).toBe(false);
  });

  it('applies the thread limit and reports arm counts', async () => {
    const repository = createStubRepository({
      fts: [
        ftsMatch({ messageId: 'm1', rank: 0.9, threadId: 't1' }),
        ftsMatch({ messageId: 'm2', rank: 0.8, threadId: 't2' }),
        ftsMatch({ messageId: 'm3', rank: 0.7, threadId: 't3' }),
      ],
      titles: [titleMatch({ threadId: 't4', title: 'Other' })],
    });
    const service = createThreadSearchService(repository);

    const response = await service.searchThreads('hnsw', {
      limit: 2,
      queryEmbedding: null,
      resourceId: RESOURCE_ID,
    });

    expect(response.results).toHaveLength(2);
    expect(response.metadata.ftsResultCount).toBe(3);
    expect(response.metadata.titleResultCount).toBe(1);
    expect(response.metadata.vectorResultCount).toBe(0);
  });

  it("fuses another owner's arms in the same pass, interleaving their threads by rank", async () => {
    // Legacy: thread-1 best, thread-2 second. Host: host-a best, host-b second.
    const repository = createStubRepository({
      fts: [
        ftsMatch({ messageId: 'legacy-1', threadId: 'thread-1' }),
        ftsMatch({ messageId: 'legacy-2', rank: 0.2, threadId: 'thread-2' }),
      ],
      titles: [titleMatch({ threadId: 'thread-9', title: 'HNSW notes' })],
    });
    const service = createThreadSearchService(repository);
    const hostMessage = (messageId: string, threadId: string) => ({
      headline: `<mark>hnsw</mark> in ${threadId}`,
      messageCreatedAt: NOW,
      messageId,
      role: 'user',
      threadId,
    });

    const response = await service.searchThreads('hnsw', {
      extraArms: {
        messages: [hostMessage('host-1', 'host-a'), hostMessage('host-2', 'host-b')],
        titles: [titleMatch({ threadId: 'host-c', title: 'HNSW host plan' })],
      },
      queryEmbedding: null,
      resourceId: RESOURCE_ID,
    });

    // One list whose owners are peers: each owner's rank-1 content thread ties with
    // each rank-1 title thread, as legacy's content and title lists do, then rank 2.
    expect(response.results.map(({ threadId }) => threadId)).toEqual([
      'thread-1',
      'host-a',
      'thread-9',
      'host-c',
      'thread-2',
      'host-b',
    ]);
    expect(response.results.find(({ threadId }) => threadId === 'host-a')?.matches).toEqual([
      {
        headline: '<mark>hnsw</mark> in host-a',
        messageCreatedAt: NOW,
        messageId: 'host-1',
        role: 'user',
        rrfScore: expect.any(Number),
        sources: ['fts'],
      },
    ]);
    expect(response.results.find(({ threadId }) => threadId === 'host-c')).toMatchObject({
      matches: [],
      title: 'HNSW host plan',
      titleMatched: true,
    });
  });

  it("fuses another owner's lexical and semantic arms per message, as its own", async () => {
    const service = createThreadSearchService(createStubRepository({}));
    const hostMessage = (messageId: string, threadId: string, headline: string) => ({
      headline,
      messageCreatedAt: NOW,
      messageId,
      role: 'assistant',
      threadId,
    });

    const response = await service.searchThreads('orchid', {
      extraArms: {
        messages: [hostMessage('host-1', 'host-a', '<mark>orchid</mark> care')],
        similarMessages: [
          hostMessage('host-2', 'host-b', 'Watering the flowers weekly'),
          hostMessage('host-1', 'host-a', 'Orchid care'),
        ],
        titles: [],
      },
      queryEmbedding: [0.5],
      resourceId: RESOURCE_ID,
    });

    // Found by both arms, host-1 outranks host-2, which only meaning found.
    expect(response.results.map(({ threadId }) => threadId)).toEqual(['host-a', 'host-b']);
    expect(response.results.map(({ matches }) => matches)).toEqual([
      [
        expect.objectContaining({
          headline: '<mark>orchid</mark> care',
          messageId: 'host-1',
          sources: ['fts', 'vector'],
        }),
      ],
      [
        expect.objectContaining({
          headline: 'Watering the flowers weekly',
          messageId: 'host-2',
          sources: ['vector'],
        }),
      ],
    ]);
  });

  it('threads scoped options through to the repository arms', async () => {
    const repository = createStubRepository({});
    const service = createThreadSearchService(repository);

    await service.searchThreads('hnsw', {
      messageSourceLimit: 33,
      queryEmbedding: [0.5],
      resourceId: RESOURCE_ID,
      vectorThreshold: 0.6,
    });

    expect(repository.fullTextSearch).toHaveBeenCalledWith('hnsw', {
      includeHeadline: true,
      limit: 33,
      resourceId: RESOURCE_ID,
    });
    expect(repository.searchSimilar).toHaveBeenCalledWith([0.5], {
      limit: 33,
      resourceId: RESOURCE_ID,
      threshold: 0.6,
    });
    expect(repository.searchThreadTitles).toHaveBeenCalledWith('hnsw', {
      limit: 20,
      resourceId: RESOURCE_ID,
    });
  });
});
