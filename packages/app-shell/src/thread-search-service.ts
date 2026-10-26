/**
 * Thread Search Service
 *
 * Text search over assistant threads, ranked with the same generic RRF core
 * (`rrf.ts`) that powers `HybridSearchService`. That service is deliberately
 * bound to `FileChunk` shapes, so this is the thread-native binding of the
 * shared fusion primitive rather than an adapter faking chunk rows. Threads
 * ranked by their best message match fuse with trigram-ranked title matches,
 * so a thread matching on BOTH content and title outranks equal content-only
 * peers, and title-only threads still surface.
 */

import { createRankedList, fuseRankedLists, normalizeRRFScores } from '@brainstrike/utils/rrf';

interface ThreadMessageFtsOptions {
  /** Generate `<mark>`-highlighted headlines (default true). */
  includeHeadline?: boolean;
  limit: number;
  resourceId: string;
}

export interface ThreadMessageFtsMatch {
  headline: string | null;
  messageCreatedAt: Date;
  messageId: string;
  rank: number;
  role: string;
  threadId: string;
}

interface ThreadTitleSearchOptions {
  limit: number;
  resourceId: string;
}

export interface ThreadTitleMatch {
  similarity: number;
  threadId: string;
  title: string;
}

/** The two repository arms this service fuses (structural, DI-friendly). */
export interface ThreadSearchServiceRepository {
  fullTextSearch: (
    query: string,
    options: ThreadMessageFtsOptions
  ) => Promise<ThreadMessageFtsMatch[]>;
  searchThreadTitles: (
    query: string,
    options: ThreadTitleSearchOptions
  ) => Promise<ThreadTitleMatch[]>;
}

/** One message match from another owner's arm, best first in its list. */
interface ThreadSearchArmMessage {
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
  readonly messages: readonly ThreadSearchArmMessage[];
  readonly titles: readonly ThreadTitleMatch[];
}

export interface ThreadSearchQueryOptions {
  /** Another owner's arms, fused in this one pass into the one result list. */
  extraArms?: ThreadSearchExtraArms;
  /** Maximum threads in the final result (default 20). */
  limit?: number;
  /** Per-arm message candidate pool size (default 50). */
  messageSourceLimit?: number;
  /** Message matches retained per thread, best first (default 3). */
  perThreadMatchLimit?: number;
  resourceId: string;
  /** RRF k constant (default 60). */
  rrfK?: number;
  /** Title candidate pool size (default 20). */
  titleSourceLimit?: number;
  /** Title-arm weight in thread-level fusion (default 1.0). */
  titleWeight?: number;
}

interface ThreadMessageMatchResult {
  /** `<mark>`-highlighted FTS headline. */
  headline: string | null;
  messageCreatedAt: Date;
  messageId: string;
  role: string;
  rrfScore: number;
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

interface ThreadSearchMetadata {
  ftsResultCount: number;
  titleResultCount: number;
  totalMs: number;
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
  private readonly repository: ThreadSearchServiceRepository | null;

  constructor(repository: ThreadSearchServiceRepository | null) {
    this.repository = repository;
  }

  private async readRepositoryArms(
    query: string,
    options: {
      extraArms: ThreadSearchExtraArms | undefined;
      messageSourceLimit: number;
      resourceId: string;
      titleSourceLimit: number;
    }
  ): Promise<[ThreadMessageFtsMatch[], ThreadTitleMatch[]]> {
    if (!this.repository) {
      if (!options.extraArms) {
        throw new Error('Thread search requires an authoritative source.');
      }
      return [[], []];
    }
    return Promise.all([
      this.repository.fullTextSearch(query, {
        includeHeadline: true,
        limit: options.messageSourceLimit,
        resourceId: options.resourceId,
      }),
      this.repository.searchThreadTitles(query, {
        limit: options.titleSourceLimit,
        resourceId: options.resourceId,
      }),
    ]);
  }

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
      limit = DEFAULT_THREAD_LIMIT,
      messageSourceLimit = DEFAULT_MESSAGE_SOURCE_LIMIT,
      perThreadMatchLimit = DEFAULT_PER_THREAD_MATCH_LIMIT,
      resourceId,
      rrfK,
      titleSourceLimit = DEFAULT_TITLE_SOURCE_LIMIT,
      titleWeight = 1.0,
    } = options;
    requirePositiveInteger(limit, 'limit');
    requirePositiveInteger(messageSourceLimit, 'messageSourceLimit');
    requirePositiveInteger(perThreadMatchLimit, 'perThreadMatchLimit');
    requirePositiveInteger(titleSourceLimit, 'titleSourceLimit');

    const [ftsResults, titleResults] = await this.readRepositoryArms(trimmed, {
      extraArms,
      messageSourceLimit,
      resourceId,
      titleSourceLimit,
    });

    const rankedMessages = fuseRankedLists(
      [
        createRankedList(
          ftsResults.map((match) => ({ id: match.messageId, score: match.rank })),
          'fts'
        ),
      ],
      rrfK === undefined ? {} : { k: rrfK }
    );

    const ftsByMessageId = new Map(ftsResults.map((match) => [match.messageId, match]));

    // Group ranked messages by thread; matches stay in rank order (best first).
    const matchesByThreadId = new Map<string, ThreadMessageMatchResult[]>();
    const bestScoreByThreadId = new Map<string, number>();
    for (const ranked of rankedMessages) {
      const ftsMatch = ftsByMessageId.get(ranked.id);
      if (!ftsMatch) {
        continue;
      }
      const match: ThreadMessageMatchResult = {
        headline: ftsMatch.headline,
        messageCreatedAt: ftsMatch.messageCreatedAt,
        messageId: ranked.id,
        role: ftsMatch.role,
        rrfScore: ranked.rrfScore,
      };
      const existing = matchesByThreadId.get(ftsMatch.threadId);
      if (existing) {
        existing.push(match);
      } else {
        matchesByThreadId.set(ftsMatch.threadId, [match]);
        bestScoreByThreadId.set(ftsMatch.threadId, ranked.rrfScore);
      }
    }

    // The other owner's message arm, ranked as ours is.
    const extraContent = groupExtraMessages(extraArms, rrfK);
    for (const [threadId, matches] of extraContent) {
      matchesByThreadId.set(threadId, matches);
    }

    // Fuse content-ranked threads with title-ranked threads, each owner a peer.
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
        titleResultCount: titleResults.length,
        totalMs: performance.now() - startTime,
      },
      results,
    };
  }
}

/** Another owner's message arm, ranked as ours is, then grouped by thread in rank order. */
function groupExtraMessages(
  extraArms: ThreadSearchExtraArms | undefined,
  rrfK: number | undefined
): Map<string, ThreadMessageMatchResult[]> {
  const lexical = extraArms?.messages ?? [];
  const ranked = fuseRankedLists(
    [
      createRankedList(
        lexical.map((match, index) => ({ id: match.messageId, score: lexical.length - index })),
        'extra-fts'
      ),
    ],
    rrfK === undefined ? {} : { k: rrfK }
  );
  const lexicalById = new Map(lexical.map((match) => [match.messageId, match]));
  const grouped = new Map<string, ThreadMessageMatchResult[]>();
  for (const { id, rrfScore } of ranked) {
    const match = lexicalById.get(id);
    if (!match) {
      continue;
    }
    const result: ThreadMessageMatchResult = {
      headline: match.headline,
      messageCreatedAt: match.messageCreatedAt,
      messageId: id,
      role: match.role,
      rrfScore,
    };
    grouped.set(match.threadId, [...(grouped.get(match.threadId) ?? []), result]);
  }
  return grouped;
}

export function createThreadSearchService(
  repository: ThreadSearchServiceRepository | null
): ThreadSearchService {
  return new ThreadSearchService(repository);
}
