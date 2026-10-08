/**
 * Thread Search Service
 *
 * Hybrid (lexical + semantic) search over assistant threads, fused with the
 * same generic RRF core (`rrf.ts`) that powers `HybridSearchService`. That
 * service is deliberately bound to `FileChunk` shapes, so this is the
 * thread-native binding of the shared fusion primitive rather than an adapter
 * faking chunk rows. Two fusion levels:
 *
 * 1. MESSAGE level: the FTS arm and (when a query embedding is available)
 *    the vector arm from `ThreadSearchRepository` fuse per message id.
 * 2. THREAD level: threads ranked by their best fused message score fuse with
 *    trigram-ranked title matches, so a thread matching on BOTH content and
 *    title outranks equal content-only peers, and title-only threads still
 *    surface.
 *
 * The semantic arm is opt-in per call (`queryEmbedding: null` = lexical-only)
 * — the CALLER owns surfacing semantic availability to the user; this service
 * never degrades silently (`metadata.semanticArmUsed` is always explicit).
 */

import type {
  ThreadMessageFtsMatch,
  ThreadMessageFtsOptions,
  ThreadMessageVectorMatch,
  ThreadMessageVectorOptions,
  ThreadTitleMatch,
  ThreadTitleSearchOptions,
} from '../models/thread-search.js';
import { createRankedList, fuseRankedLists, normalizeRRFScores } from './rrf.js';

/** The three repository arms this service fuses (structural, DI-friendly). */
export interface ThreadSearchServiceRepository {
  fullTextSearch: (
    query: string,
    options: ThreadMessageFtsOptions
  ) => Promise<ThreadMessageFtsMatch[]>;
  searchSimilar: (
    queryEmbedding: readonly number[],
    options: ThreadMessageVectorOptions
  ) => Promise<ThreadMessageVectorMatch[]>;
  searchThreadTitles: (
    query: string,
    options: ThreadTitleSearchOptions
  ) => Promise<ThreadTitleMatch[]>;
}

export interface ThreadSearchQueryOptions {
  /** FTS weight in message-level fusion (default 1.0). */
  ftsWeight?: number;
  /** Maximum threads in the final result (default 20). */
  limit?: number;
  /** Per-arm message candidate pool size (default 50). */
  messageSourceLimit?: number;
  /** Message matches retained per thread, best first (default 3). */
  perThreadMatchLimit?: number;
  /**
   * Query embedding for the semantic arm; `null` runs lexical-only. The
   * caller owns making semantic unavailability visible to the user.
   */
  queryEmbedding: readonly number[] | null;
  resourceId: string;
  /** RRF k constant for both fusion levels (default 60). */
  rrfK?: number;
  /** Title candidate pool size (default 20). */
  titleSourceLimit?: number;
  /** Title-arm weight in thread-level fusion (default 1.0). */
  titleWeight?: number;
  /** Minimum cosine similarity for the vector arm (default repository's). */
  vectorThreshold?: number;
  /** Vector weight in message-level fusion (default 1.0). */
  vectorWeight?: number;
}

export type ThreadMessageMatchSource = 'fts' | 'vector';

export interface ThreadMessageMatchResult {
  /** `<mark>`-highlighted FTS headline, or the plain vector snippet. */
  headline: string | null;
  /** Null when the owner records no time for the match (agent-host history). */
  messageCreatedAt: Date | null;
  messageId: string;
  role: string;
  rrfScore: number;
  sources: readonly ThreadMessageMatchSource[];
}

export interface ThreadSearchResultItem {
  /** Best message matches, capped at `perThreadMatchLimit`, best first. */
  matches: ThreadMessageMatchResult[];
  /** Normalized (0..1) thread-level fused score. */
  score: number;
  threadId: string;
  /** The matched title when the title arm found this thread, else null. */
  title: string | null;
  titleMatched: boolean;
}

export interface ThreadSearchMetadata {
  ftsResultCount: number;
  semanticArmUsed: boolean;
  titleResultCount: number;
  totalMs: number;
  vectorResultCount: number;
}

export interface ThreadSearchResponse {
  metadata: ThreadSearchMetadata;
  results: ThreadSearchResultItem[];
}

const DEFAULT_THREAD_LIMIT = 20;
const DEFAULT_MESSAGE_SOURCE_LIMIT = 50;
const DEFAULT_PER_THREAD_MATCH_LIMIT = 3;
const DEFAULT_TITLE_SOURCE_LIMIT = 20;

function requirePositiveInteger(value: number, field: string): void {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error(`Thread search ${field} must be a positive integer.`);
  }
}

export class ThreadSearchService {
  constructor(private readonly repository: ThreadSearchServiceRepository) {}

  async searchThreads(
    queryText: string,
    options: ThreadSearchQueryOptions
  ): Promise<ThreadSearchResponse> {
    const startTime = performance.now();
    const trimmed = queryText.trim();
    if (!trimmed) {
      throw new Error('Thread search query must contain non-whitespace text.');
    }

    const {
      ftsWeight = 1.0,
      limit = DEFAULT_THREAD_LIMIT,
      messageSourceLimit = DEFAULT_MESSAGE_SOURCE_LIMIT,
      perThreadMatchLimit = DEFAULT_PER_THREAD_MATCH_LIMIT,
      queryEmbedding,
      resourceId,
      rrfK,
      titleSourceLimit = DEFAULT_TITLE_SOURCE_LIMIT,
      titleWeight = 1.0,
      vectorThreshold,
      vectorWeight = 1.0,
    } = options;
    requirePositiveInteger(limit, 'limit');
    requirePositiveInteger(messageSourceLimit, 'messageSourceLimit');
    requirePositiveInteger(perThreadMatchLimit, 'perThreadMatchLimit');
    requirePositiveInteger(titleSourceLimit, 'titleSourceLimit');

    const vectorOptions: ThreadMessageVectorOptions = {
      limit: messageSourceLimit,
      resourceId,
    };
    if (vectorThreshold !== undefined) {
      vectorOptions.threshold = vectorThreshold;
    }

    const semanticArmUsed = queryEmbedding !== null;
    const [ftsResults, vectorResults, titleResults] = await Promise.all([
      this.repository.fullTextSearch(trimmed, {
        includeHeadline: true,
        limit: messageSourceLimit,
        resourceId,
      }),
      semanticArmUsed
        ? this.repository.searchSimilar(queryEmbedding, vectorOptions)
        : Promise.resolve<ThreadMessageVectorMatch[]>([]),
      this.repository.searchThreadTitles(trimmed, {
        limit: titleSourceLimit,
        resourceId,
      }),
    ]);

    // Level 1: fuse the two message arms per message id.
    const fusedMessages = fuseRankedLists(
      [
        createRankedList(
          ftsResults.map((match) => ({ id: match.messageId, score: match.rank })),
          'fts',
          { weight: ftsWeight }
        ),
        createRankedList(
          vectorResults.map((match) => ({ id: match.messageId, score: match.similarity })),
          'vector',
          { weight: vectorWeight }
        ),
      ],
      rrfK === undefined ? {} : { k: rrfK }
    );

    const ftsByMessageId = new Map(ftsResults.map((match) => [match.messageId, match]));
    const vectorByMessageId = new Map(vectorResults.map((match) => [match.messageId, match]));

    // Group fused messages by thread; matches stay in fused order (best first).
    const matchesByThreadId = new Map<string, ThreadMessageMatchResult[]>();
    const bestScoreByThreadId = new Map<string, number>();
    for (const fused of fusedMessages) {
      const ftsMatch = ftsByMessageId.get(fused.id);
      const vectorMatch = vectorByMessageId.get(fused.id);
      const base = ftsMatch ?? vectorMatch;
      if (!base) {
        continue;
      }
      const sources: ThreadMessageMatchSource[] = [];
      if (ftsMatch) {
        sources.push('fts');
      }
      if (vectorMatch) {
        sources.push('vector');
      }
      const match: ThreadMessageMatchResult = {
        headline: ftsMatch?.headline ?? vectorMatch?.snippet ?? null,
        messageCreatedAt: base.messageCreatedAt,
        messageId: fused.id,
        role: base.role,
        rrfScore: fused.rrfScore,
        sources,
      };
      const existing = matchesByThreadId.get(base.threadId);
      if (existing) {
        existing.push(match);
      } else {
        matchesByThreadId.set(base.threadId, [match]);
        bestScoreByThreadId.set(base.threadId, fused.rrfScore);
      }
    }

    // Level 2: fuse content-ranked threads with title-ranked threads.
    const contentThreadList = [...bestScoreByThreadId.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([threadId, score]) => ({ id: threadId, score }));
    const titleByThreadId = new Map(titleResults.map((match) => [match.threadId, match]));
    const fusedThreads = fuseRankedLists(
      [
        createRankedList(contentThreadList, 'content'),
        createRankedList(
          titleResults.map((match) => ({ id: match.threadId, score: match.similarity })),
          'title',
          { weight: titleWeight }
        ),
      ],
      rrfK === undefined ? { limit } : { k: rrfK, limit }
    );

    const results = normalizeRRFScores(fusedThreads).map((fused): ThreadSearchResultItem => {
      const titleMatch = titleByThreadId.get(fused.id);
      return {
        matches: (matchesByThreadId.get(fused.id) ?? []).slice(0, perThreadMatchLimit),
        score: fused.rrfScore,
        threadId: fused.id,
        title: titleMatch?.title ?? null,
        titleMatched: titleMatch !== undefined,
      };
    });

    return {
      metadata: {
        ftsResultCount: ftsResults.length,
        semanticArmUsed,
        titleResultCount: titleResults.length,
        totalMs: performance.now() - startTime,
        vectorResultCount: vectorResults.length,
      },
      results,
    };
  }
}

export function createThreadSearchService(
  repository: ThreadSearchServiceRepository
): ThreadSearchService {
  return new ThreadSearchService(repository);
}
