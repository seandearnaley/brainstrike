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

import { createRankedList, fuseRankedLists, normalizeRRFScores } from '@brainstrike/utils/rrf';
import type {
  ThreadMessageFtsMatch,
  ThreadMessageFtsOptions,
  ThreadMessageVectorMatch,
  ThreadMessageVectorOptions,
  ThreadTitleMatch,
  ThreadTitleSearchOptions,
} from '../models/thread-search.js';

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

/** One message match from another owner's arm, best first in its list. */
export interface ThreadSearchArmMessage {
  readonly headline: string | null;
  readonly messageCreatedAt: Date;
  readonly messageId: string;
  readonly role: string;
  readonly threadId: string;
}

/**
 * Gap 10: another owner's ranked arms (the agent host's threads), fused in the
 * same pass as this repository's. Its threads are disjoint from this
 * repository's, so its content and title lists are peers of ours at thread level.
 */
export interface ThreadSearchExtraArms {
  /** Its lexical arm. */
  readonly messages: readonly ThreadSearchArmMessage[];
  /** Its semantic arm, when the query embedding reached it; fused per message with `messages`. */
  readonly similarMessages?: readonly ThreadSearchArmMessage[];
  readonly titles: readonly ThreadTitleMatch[];
}

export interface ThreadSearchQueryOptions {
  /** Another owner's arms, fused in this one pass into the one result list. */
  extraArms?: ThreadSearchExtraArms;
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
  messageCreatedAt: Date;
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
      extraArms,
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

    // The other owner's lexical and semantic arms, fused per message as ours are.
    const extraContent = groupExtraMessages(extraArms, { ftsWeight, rrfK, vectorWeight });
    for (const [threadId, matches] of extraContent) {
      matchesByThreadId.set(threadId, matches);
    }

    // Level 2: fuse content-ranked threads with title-ranked threads, each owner a peer.
    const contentThreadList = [...bestScoreByThreadId.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([threadId, score]) => ({ id: threadId, score }));
    const extraTitles = extraArms?.titles ?? [];
    const titleByThreadId = new Map(
      [...titleResults, ...extraTitles].map((match) => [match.threadId, match])
    );
    const titleList = (matches: readonly ThreadTitleMatch[]) =>
      matches.map((match) => ({ id: match.threadId, score: match.similarity }));
    const fusedThreads = fuseRankedLists(
      [
        createRankedList(contentThreadList, 'content'),
        createRankedList(
          [...extraContent.entries()].map(([threadId, matches]) => ({
            id: threadId,
            score: matches[0]?.rrfScore ?? 0,
          })),
          'extra-content'
        ),
        createRankedList(titleList(titleResults), 'title', { weight: titleWeight }),
        createRankedList(titleList(extraTitles), 'extra-title', { weight: titleWeight }),
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

/**
 * Another owner's two ranked message arms fused per message id, as level 1
 * fuses ours, then grouped by thread in fused order (best first).
 */
function groupExtraMessages(
  extraArms: ThreadSearchExtraArms | undefined,
  options: {
    readonly ftsWeight: number;
    readonly rrfK: number | undefined;
    readonly vectorWeight: number;
  }
): Map<string, ThreadMessageMatchResult[]> {
  const lexical = extraArms?.messages ?? [];
  const semantic = extraArms?.similarMessages ?? [];
  const ranked = (matches: readonly ThreadSearchArmMessage[]) =>
    matches.map((match, index) => ({ id: match.messageId, score: matches.length - index }));
  const fused = fuseRankedLists(
    [
      createRankedList(ranked(lexical), 'extra-fts', { weight: options.ftsWeight }),
      createRankedList(ranked(semantic), 'extra-vector', { weight: options.vectorWeight }),
    ],
    options.rrfK === undefined ? {} : { k: options.rrfK }
  );
  const lexicalById = new Map(lexical.map((match) => [match.messageId, match]));
  const semanticById = new Map(semantic.map((match) => [match.messageId, match]));
  const grouped = new Map<string, ThreadMessageMatchResult[]>();
  for (const { id, rrfScore } of fused) {
    const lexicalMatch = lexicalById.get(id);
    const semanticMatch = semanticById.get(id);
    const match = lexicalMatch ?? semanticMatch;
    if (!match) {
      continue;
    }
    const sources: ThreadMessageMatchSource[] = [];
    if (lexicalMatch) {
      sources.push('fts');
    }
    if (semanticMatch) {
      sources.push('vector');
    }
    const result: ThreadMessageMatchResult = {
      headline: match.headline,
      messageCreatedAt: match.messageCreatedAt,
      messageId: id,
      role: match.role,
      rrfScore,
      sources,
    };
    grouped.set(match.threadId, [...(grouped.get(match.threadId) ?? []), result]);
  }
  return grouped;
}

export function createThreadSearchService(
  repository: ThreadSearchServiceRepository
): ThreadSearchService {
  return new ThreadSearchService(repository);
}
