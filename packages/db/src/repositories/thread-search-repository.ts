import type {
  MarkThreadMessageEmbeddingErrorInput,
  StoreThreadMessageEmbeddingInput,
  ThreadMessageFtsMatch,
  ThreadMessageFtsOptions,
  ThreadMessagePendingEmbedding,
  ThreadMessageVectorMatch,
  ThreadMessageVectorOptions,
  ThreadSearchCoverage,
  ThreadSearchDatabase,
  ThreadSearchEmbeddingProfile,
  ThreadSearchSyncOptions,
  ThreadSearchSyncResult,
  ThreadTitleMatch,
  ThreadTitleSearchOptions,
} from '../models/thread-search.js';
import { escapeLikeLiteral } from '../search/grep-pattern.js';
import { hnswSearchTuningStatements } from './_shared.js';

const PROFILE_ID = 'default';
const INDEX_TABLE = 'brainstrike_thread_message_index';
const PROFILES_TABLE = 'brainstrike_thread_search_profiles';
const STATE_TABLE = 'brainstrike_thread_search_state';
const TOMBSTONES_TABLE = 'brainstrike_assistant_message_tombstones';

/**
 * Soft-rewind exclusion for the SEARCH ARMS only (BST-1115): a message hidden
 * from its thread must not surface as an Explorer hit, or the hit navigates to
 * a message the thread no longer shows.
 *
 * Deliberately NOT applied to `sync` / `refreshActiveThreads` / `getCoverage`:
 * the index row and its embedding stay put while a message is tombstoned.
 * 1. Rewind is undoable — redo must restore visibility instantly, not schedule
 *    a re-embed of everything it hid.
 * 2. The sync membership fast path compares `COUNT(*) FROM mastra_messages`
 *    against `COUNT(*) FROM the index`. Skipping tombstoned rows on insert
 *    would hold those counts permanently unequal, so every pass would run the
 *    full anti-join and orphan GC — and the GC keys off a MISSING source row,
 *    so it would never converge either.
 * Finalization deletes the message through Mastra, and the orphan GC then
 * reaps the index row on its own.
 */
const NOT_TOMBSTONED_SQL = `NOT EXISTS (
           SELECT 1 FROM ${TOMBSTONES_TABLE} ts WHERE ts.message_id = i.message_id
         )`;

const DEFAULT_SYNC_BATCH_SIZE = 500;
const DEFAULT_SYNC_MAX_BATCHES = 20;
const DEFAULT_SYNC_GC_LIMIT = 1000;
/** Max threads re-extracted per refresh pass (keeps the statement bounded). */
const DEFAULT_REFRESH_THREAD_BATCH = 200;
/** Threads active within this trailing window are re-extracted every pass. */
const LIVE_THREAD_WINDOW_MS = 120_000;
/**
 * An errored row becomes eligible for a re-attempt this long after the failed
 * attempt — so a transient failure (worker crash, model still initializing,
 * document-hidden invalidation) self-heals instead of parking the message in
 * the "could not be embedded" state forever on immutable assistant history.
 */
const EMBEDDING_ERROR_RETRY_MS = 300_000;
const DEFAULT_VECTOR_THRESHOLD = 0.35;
/** Bound on extracted text per message; search-relevant prose fits well under it. */
const MAX_CONTENT_TEXT_CHARS = 8000;
const SNIPPET_CHARS = 240;

/**
 * Extracts the searchable plain text of a `mastra_messages` row (aliased `m`)
 * entirely in SQL:
 * - only conversational roles are indexed (tool/system rows keep '' so the
 *   anti-join sync still sees them as processed),
 * - Mastra v2 content (`{format:2, parts:[...]}`): text parts joined in order
 *   (tool invocations and bookkeeping parts are never indexed),
 * - legacy plain-string content is taken verbatim,
 * - v2 rows without text parts fall back to the flattened `content` string.
 */
const CONTENT_TEXT_SQL = `
  COALESCE(
    left(
      CASE
        WHEN m.role NOT IN ('user', 'assistant') THEN ''
        WHEN jsonb_typeof(m.content) = 'string' THEN m.content #>> '{}'
        ELSE COALESCE(
          (
            SELECT string_agg(part.value ->> 'text', E'\n' ORDER BY part.ordinality)
            FROM jsonb_array_elements(m.content -> 'parts') WITH ORDINALITY AS part
            WHERE part.value ->> 'type' = 'text'
              AND COALESCE(part.value ->> 'text', '') <> ''
          ),
          CASE
            WHEN jsonb_typeof(m.content -> 'content') = 'string' THEN m.content ->> 'content'
          END
        )
      END,
      ${MAX_CONTENT_TEXT_CHARS}
    ),
    ''
  )
`;

/**
 * Shared SELECT list for the sync INSERT ... SELECT statements. The hash
 * covers role + raw content because extraction depends on BOTH (a same-id
 * resave that only flips the role must still refresh the row).
 */
const SYNC_SELECT_SQL = `
  SELECT
    m.id,
    m.thread_id,
    COALESCE(m."resourceId", t."resourceId"),
    m.role,
    ${CONTENT_TEXT_SQL},
    md5(m.role || ':' || m.content::text),
    m."createdAt"
  FROM mastra_messages m
  JOIN mastra_threads t ON t.id = m.thread_id
`;

const UPSERT_CONFLICT_SQL = `
  ON CONFLICT (message_id) DO UPDATE SET
    content_text = EXCLUDED.content_text,
    content_hash = EXCLUDED.content_hash,
    role = EXCLUDED.role,
    thread_id = EXCLUDED.thread_id,
    resource_id = EXCLUDED.resource_id,
    message_created_at = EXCLUDED.message_created_at,
    embedding = NULL,
    embedding_profile_id = NULL,
    embedding_error = NULL,
    embedding_updated_at = NULL,
    updated_at = CURRENT_TIMESTAMP
  WHERE ${INDEX_TABLE}.content_hash IS DISTINCT FROM EXCLUDED.content_hash
`;

/** Search visibility follows every native parent boundary from an owned root. */
function ownedThreadsSql(ownerParameter: string): string {
  return `WITH RECURSIVE search_owned_threads AS (
    SELECT native.id AS thread_id, native."resourceId" AS resource_id, native.id AS root_thread_id
    FROM mastra_threads native
    LEFT JOIN brainstrike_delegated_conversations root ON root.thread_id = native.id
    WHERE native."resourceId" = ${ownerParameter}
      AND (root.thread_id IS NULL OR (root.parent_thread_id IS NULL
        AND root.root_thread_id = native.id AND root.owner_resource_id = ${ownerParameter}
        AND root.resource_id = native."resourceId"))
    UNION ALL
    SELECT child.thread_id, child.resource_id, parent.root_thread_id
    FROM search_owned_threads parent
    JOIN brainstrike_delegated_conversations child ON child.parent_thread_id = parent.thread_id
      AND child.root_thread_id = parent.root_thread_id AND child.owner_resource_id = ${ownerParameter}
    JOIN mastra_threads native ON native.id = child.thread_id AND native."resourceId" = child.resource_id
  )`;
}

function requirePositiveInteger(value: number, field: string): void {
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error(`Thread search ${field} must be a positive integer.`);
  }
}

function toVectorLiteral(embedding: readonly number[], expectedDimensions: number): string {
  if (embedding.length !== expectedDimensions) {
    throw new Error(
      `Thread search embedding dimension mismatch: received ${embedding.length}, expected ${expectedDimensions}.`
    );
  }
  embedding.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new Error(`Thread search embedding contains a non-finite value at index ${index}.`);
    }
  });
  return `[${embedding.join(',')}]`;
}

function asDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Thread search returned an invalid ${field} timestamp.`);
  }
  return date;
}

function requireQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('Thread search query must contain non-whitespace text.');
  }
  return trimmed;
}

interface FtsRow {
  headline: string | null;
  messageCreatedAt: Date | string;
  messageId: string;
  rank: number | string;
  role: string;
  threadId: string;
}

interface VectorRow {
  messageCreatedAt: Date | string;
  messageId: string;
  role: string;
  similarity: number | string;
  snippet: string;
  threadId: string;
}

/**
 * Repository for the Brainstrike thread search index (migration 067): batched
 * sync from the Mastra tables, the lexical (tsvector) and semantic (pgvector)
 * search arms, the per-message embedding lifecycle, and honest coverage
 * counters. Fusion lives in `search/thread-search-service.ts`.
 */
export class ThreadSearchRepository {
  constructor(private readonly db: ThreadSearchDatabase) {}

  async getNavigationTarget(
    ownerResourceId: string,
    threadId: string,
    messageId?: string
  ): Promise<{
    readonly rootThreadId: string;
    readonly resourceId: string;
    readonly title: string | null;
    readonly displayName: string | null;
  } | null> {
    const result = await this.db.query<{
      rootThreadId: string;
      resourceId: string;
      title: string | null;
      displayName: string | null;
    }>(
      `${ownedThreadsSql('$1')}
      SELECT owned.root_thread_id AS "rootThreadId", owned.resource_id AS "resourceId",
        native.title, child.display_name AS "displayName"
      FROM search_owned_threads owned
      JOIN mastra_threads native ON native.id = owned.thread_id AND native."resourceId" = owned.resource_id
      LEFT JOIN brainstrike_delegated_conversations child ON child.thread_id = owned.thread_id
      WHERE owned.thread_id = $2 AND ($3::text IS NULL OR EXISTS (
        SELECT 1 FROM mastra_messages message WHERE message.id = $3 AND message.thread_id = owned.thread_id
          AND COALESCE(message."resourceId", native."resourceId") = owned.resource_id
          AND NOT EXISTS (SELECT 1 FROM ${TOMBSTONES_TABLE} hidden WHERE hidden.message_id = message.id)
      ))`,
      [ownerResourceId, threadId, messageId ?? null]
    );
    return result.rows[0] ?? null;
  }

  async getEmbeddingProfile(): Promise<ThreadSearchEmbeddingProfile> {
    const result = await this.db.query<ThreadSearchEmbeddingProfile>(
      `SELECT id, model_id AS "modelId", model_key AS "modelKey", dimensions, distance
       FROM ${PROFILES_TABLE}
       WHERE id = $1`,
      [PROFILE_ID]
    );
    const profile = result.rows[0];
    if (!profile) {
      throw new Error('Thread search embedding profile is missing. Run database migrations.');
    }
    if (!(Number.isInteger(profile.dimensions) && profile.dimensions > 0)) {
      throw new Error('Thread search embedding profile has invalid dimensions.');
    }
    return { ...profile };
  }

  /**
   * One bounded sync pass:
   * 1. membership fast path — when source and index row counts agree, the
   *    missing-row anti-join and orphan GC are skipped entirely (the common
   *    idle case pays two COUNTs, not two full scans). A same-count
   *    delete+insert pair can defer both arms for one pass; the next count
   *    divergence heals it, and thread deletion clears its rows eagerly.
   * 2. missing rows are inserted in bounded batches,
   * 3. a bounded batch of threads whose content changed (or are within the
   *    trailing live window) is re-extracted with the hash CAS, resetting
   *    changed rows' embeddings to pending (never the whole corpus — see
   *    refreshActiveThreads),
   * 4. errored rows whose failed attempt has aged out are revived to pending,
   * 5. orphaned index rows are garbage-collected (bounded).
   * Every statement is bounded, so a pass never monopolizes the single
   * PGlite connection.
   */
  async sync(options: ThreadSearchSyncOptions = {}): Promise<ThreadSearchSyncResult> {
    const batchSize = options.batchSize ?? DEFAULT_SYNC_BATCH_SIZE;
    const maxBatches = options.maxBatches ?? DEFAULT_SYNC_MAX_BATCHES;
    const gcLimit = options.gcLimit ?? DEFAULT_SYNC_GC_LIMIT;
    requirePositiveInteger(batchSize, 'batchSize');
    requirePositiveInteger(maxBatches, 'maxBatches');
    requirePositiveInteger(gcLimit, 'gcLimit');

    const counts = await this.db.query<{ indexed: number | string; source: number | string }>(
      `SELECT
         (SELECT COUNT(*) FROM mastra_messages) AS source,
         (SELECT COUNT(*) FROM ${INDEX_TABLE}) AS indexed`
    );
    const membershipInSync =
      Number(counts.rows[0]?.source ?? 0) === Number(counts.rows[0]?.indexed ?? -1);

    let inserted = 0;
    if (!membershipInSync) {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const result = await this.db.query<{ message_id: string }>(
          `INSERT INTO ${INDEX_TABLE} (
             message_id, thread_id, resource_id, role, content_text, content_hash, message_created_at
           )
           ${SYNC_SELECT_SQL}
           LEFT JOIN ${INDEX_TABLE} i ON i.message_id = m.id
           WHERE i.message_id IS NULL
           LIMIT $1
           ON CONFLICT (message_id) DO NOTHING
           RETURNING message_id`,
          [batchSize]
        );
        inserted += result.rows.length;
        if (result.rows.length < batchSize) {
          break;
        }
      }
    }

    const refreshed = await this.refreshActiveThreads(options.refreshThreadBatch);
    await this.reviveAgedEmbeddingErrors(gcLimit);
    const deletedOrphans = membershipInSync ? 0 : await this.collectOrphans(gcLimit);
    return { deletedOrphans, inserted, refreshed };
  }

  /**
   * Re-extracts messages of threads whose content changed, WITHOUT ever
   * extracting the whole corpus in one statement:
   *
   * 1. A never-seen thread is SEEDED into the refresh state WITHOUT
   *    extraction — its rows were just inserted with current content by the
   *    anti-join, so it has nothing to re-extract (missing rows are always
   *    handled by the insert arm, never this one). This is the fix for the
   *    unbounded first-sync / post-reset scan: an empty state table no longer
   *    means "re-extract every message".
   * 2. Then a BOUNDED batch of threads whose `updatedAt` advanced past their
   *    recorded state (genuinely changed content), plus threads within the
   *    trailing live window (same-id progressive saves can land without
   *    advancing `updatedAt` past an equal timestamp), is re-extracted with
   *    the hash CAS. Changed threads are ordered ahead of live-window-only
   *    threads so a busy live thread can never starve a genuinely-changed one;
   *    the cap keeps the statement bounded even under a bulk content change.
   *
   * Per-thread state — never a global watermark — so one busy thread can never
   * push a quiet thread's pending change out of the refresh window.
   */
  private async refreshActiveThreads(threadBatch = DEFAULT_REFRESH_THREAD_BATCH): Promise<number> {
    requirePositiveInteger(threadBatch, 'refreshThreadBatch');

    // (1) Seed never-seen threads at their current activity — no extraction.
    await this.db.query(
      `INSERT INTO ${STATE_TABLE} (thread_id, last_activity_at, updated_at)
       SELECT t.id, t."updatedAt", CURRENT_TIMESTAMP
       FROM mastra_threads t
       LEFT JOIN ${STATE_TABLE} s ON s.thread_id = t.id
       WHERE s.thread_id IS NULL
       ON CONFLICT (thread_id) DO NOTHING`
    );

    // (2) Re-extract a bounded batch of changed / live-window threads.
    const result = await this.db.query<{ message_id: string }>(
      `WITH threads_to_refresh AS (
         SELECT t.id, t."updatedAt"
         FROM mastra_threads t
         JOIN ${STATE_TABLE} s ON s.thread_id = t.id
         WHERE t."updatedAt" > s.last_activity_at
            OR t."updatedAt" >= CURRENT_TIMESTAMP - make_interval(secs => ${LIVE_THREAD_WINDOW_MS / 1000})
         ORDER BY (t."updatedAt" > s.last_activity_at) DESC, t."updatedAt" DESC
         LIMIT $1
       ), refreshed AS (
         INSERT INTO ${INDEX_TABLE} (
           message_id, thread_id, resource_id, role, content_text, content_hash, message_created_at
         )
         ${SYNC_SELECT_SQL}
         JOIN threads_to_refresh tr ON tr.id = t.id
         ${UPSERT_CONFLICT_SQL}
         RETURNING message_id
       ), advanced AS (
         UPDATE ${STATE_TABLE} s
         SET last_activity_at = tr."updatedAt", updated_at = CURRENT_TIMESTAMP
         FROM threads_to_refresh tr
         WHERE s.thread_id = tr.id AND tr."updatedAt" > s.last_activity_at
       )
       SELECT message_id FROM refreshed`,
      [threadBatch]
    );

    return result.rows.length;
  }

  /**
   * Bounded revive of errored rows whose failed attempt has aged past the
   * retry cooldown: clears the error so the row returns to the pending set and
   * the backlog drain re-attempts it. Index-backed
   * (`idx_thread_message_index_errored_embedding`) so it is cheap even when no
   * rows have errored.
   */
  private async reviveAgedEmbeddingErrors(limit: number): Promise<number> {
    const result = await this.db.query<{ message_id: string }>(
      `UPDATE ${INDEX_TABLE}
       SET embedding_error = NULL,
           embedding_updated_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE message_id IN (
         SELECT message_id FROM ${INDEX_TABLE}
         WHERE embedding_error IS NOT NULL
           AND embedding_updated_at < CURRENT_TIMESTAMP - make_interval(secs => ${EMBEDDING_ERROR_RETRY_MS / 1000})
         LIMIT $1
       )
       RETURNING message_id`,
      [limit]
    );
    return result.rows.length;
  }

  /**
   * Bounded delete of index rows (and refresh-state rows) whose source no
   * longer exists.
   */
  private async collectOrphans(limit: number): Promise<number> {
    const result = await this.db.query<{ message_id: string }>(
      `DELETE FROM ${INDEX_TABLE}
       WHERE message_id IN (
         SELECT i.message_id
         FROM ${INDEX_TABLE} i
         LEFT JOIN mastra_messages m ON m.id = i.message_id
         WHERE m.id IS NULL
         LIMIT $1
       )
       RETURNING message_id`,
      [limit]
    );
    await this.db.query(
      `DELETE FROM ${STATE_TABLE}
       WHERE thread_id IN (
         SELECT s.thread_id
         FROM ${STATE_TABLE} s
         LEFT JOIN mastra_threads t ON t.id = s.thread_id
         WHERE t.id IS NULL
         LIMIT $1
       )`,
      [limit]
    );
    return result.rows.length;
  }

  async fullTextSearch(
    query: string,
    options: ThreadMessageFtsOptions
  ): Promise<ThreadMessageFtsMatch[]> {
    const trimmed = requireQuery(query);
    requirePositiveInteger(options.limit, 'limit');
    const includeHeadline = options.includeHeadline ?? true;

    const headlineSql = includeHeadline
      ? `ts_headline(
           'english', i.content_text, q.query,
           'StartSel=<mark>, StopSel=</mark>, MaxWords=18, MinWords=6, MaxFragments=2, FragmentDelimiter=" … "'
         )`
      : 'NULL';

    const result = await this.db.query<FtsRow>(
      `${ownedThreadsSql('$2')}
       SELECT
         i.message_id AS "messageId",
         i.thread_id AS "threadId",
         i.role,
         i.message_created_at AS "messageCreatedAt",
         ts_rank_cd(i.content_tsvector, q.query) AS rank,
         ${headlineSql} AS headline
       FROM ${INDEX_TABLE} i
       JOIN mastra_threads t ON t.id = i.thread_id
       CROSS JOIN (SELECT websearch_to_tsquery('english', $1) AS query) q
       JOIN search_owned_threads owned ON owned.thread_id = i.thread_id AND owned.resource_id = i.resource_id
       WHERE TRUE
         AND i.content_tsvector @@ q.query
         AND ${NOT_TOMBSTONED_SQL}
       ORDER BY rank DESC, i.message_created_at DESC
       LIMIT $3`,
      [trimmed, options.resourceId, options.limit]
    );

    return result.rows.map((row) => ({
      headline: row.headline,
      messageCreatedAt: asDate(row.messageCreatedAt, 'messageCreatedAt'),
      messageId: row.messageId,
      rank: Number(row.rank),
      role: row.role,
      threadId: row.threadId,
    }));
  }

  async searchSimilar(
    queryEmbedding: readonly number[],
    options: ThreadMessageVectorOptions
  ): Promise<ThreadMessageVectorMatch[]> {
    requirePositiveInteger(options.limit, 'limit');
    const threshold = options.threshold ?? DEFAULT_VECTOR_THRESHOLD;
    if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
      throw new Error(
        'Thread search similarity threshold must be a finite value between -1 and 1.'
      );
    }
    const profile = await this.getEmbeddingProfile();
    if (profile.distance !== 'cosine') {
      throw new Error(
        `Thread similarity search only supports cosine distance; profile "${profile.id}" uses "${profile.distance}".`
      );
    }
    const queryVector = toVectorLiteral(queryEmbedding, profile.dimensions);

    const result = await this.runVectorSearchInTransaction<VectorRow>(
      `${ownedThreadsSql('$2')}
       SELECT
         i.message_id AS "messageId",
         i.thread_id AS "threadId",
         i.role,
         i.message_created_at AS "messageCreatedAt",
         left(i.content_text, ${SNIPPET_CHARS}) AS snippet,
         1 - (i.embedding <=> $1::vector) AS similarity
       FROM ${INDEX_TABLE} i
       JOIN mastra_threads t ON t.id = i.thread_id
       JOIN search_owned_threads owned ON owned.thread_id = i.thread_id AND owned.resource_id = i.resource_id
       WHERE TRUE
         AND i.embedding IS NOT NULL
         AND i.embedding_profile_id = $3
         AND 1 - (i.embedding <=> $1::vector) >= $4
         AND ${NOT_TOMBSTONED_SQL}
       ORDER BY i.embedding <=> $1::vector ASC, i.message_created_at DESC
       LIMIT $5`,
      [queryVector, options.resourceId, profile.id, threshold, options.limit]
    );

    return result.rows.map((row) => ({
      messageCreatedAt: asDate(row.messageCreatedAt, 'messageCreatedAt'),
      messageId: row.messageId,
      role: row.role,
      similarity: Number(row.similarity),
      snippet: row.snippet,
      threadId: row.threadId,
    }));
  }

  /**
   * Run the pgvector ANN search with HNSW tuning (`SET LOCAL hnsw.ef_search` +
   * `iterative_scan`) applied inside a single transaction — `SET LOCAL` outside
   * a transaction is a silent no-op, leaving filtered ANN at the pgvector
   * default `ef_search=40` (the under-return failure mode from #1141). Mirrors
   * `ElectronFileChunkRepository.runVectorSearchInTransaction`. Path order:
   * 1. `runTransaction` (DESKTOP DbHandle): atomic IPC statements-array, one
   *    main-process `pglite.transaction()`, connection-lock isolated.
   * 2. Callback `transaction` (WEB ScheduledDbHandle / raw PGlite): holds the
   *    connection lock for the callback, so concurrent scheduled work — e.g.
   *    the controller's embedding-backlog WRITES that run alongside a search —
   *    cannot interleave inside the open transaction and get caught in a
   *    rollback.
   * 3. Raw BEGIN/COMMIT over `query` (legacy/mock seams only): tuned, but a
   *    concurrent statement on the shared connection can interleave inside
   *    the open transaction (#1141 residual).
   */
  private async runVectorSearchInTransaction<T>(
    searchSql: string,
    params: unknown[]
  ): Promise<{ rows: T[] }> {
    const tuning = hnswSearchTuningStatements().map((sql) => ({ sql }));
    const statements = [...tuning, { params, sql: searchSql }];

    if (this.db.runTransaction) {
      const result = await this.db.runTransaction(statements, statements.length - 1);
      return { rows: result.rows as T[] };
    }

    if (this.db.transaction) {
      const result = await this.db.transaction(async (tx) => {
        for (const statement of tuning) {
          await tx.query(statement.sql);
        }
        return await tx.query<T>(searchSql, params);
      });
      if (!result) {
        // PGlite's transaction resolves undefined only when the callback
        // signalled a rollback — which this callback never does.
        throw new Error('Thread search vector transaction returned no result.');
      }
      return result;
    }

    await this.db.query('BEGIN');
    try {
      for (const statement of tuning) {
        await this.db.query(statement.sql);
      }
      const result = await this.db.query<T>(searchSql, params);
      await this.db.query('COMMIT');
      return result;
    } catch (err) {
      await this.db.query('ROLLBACK').catch(() => {
        // Surface the original failure, not a secondary rollback error.
      });
      throw err;
    }
  }

  /**
   * Trigram-ranked, case-insensitive title matching straight off
   * `mastra_threads` — titles are few and mutable, so they are matched live
   * rather than copied into the index.
   */
  async searchThreadTitles(
    query: string,
    options: ThreadTitleSearchOptions
  ): Promise<ThreadTitleMatch[]> {
    const trimmed = requireQuery(query);
    requirePositiveInteger(options.limit, 'limit');

    // Every query token must appear somewhere in the title (order-free),
    // ranked by whole-query trigram similarity.
    const tokens = trimmed.split(/\s+/u);
    const params: unknown[] = [trimmed, options.resourceId];
    const tokenClauses = tokens.map((token) => {
      params.push(`%${escapeLikeLiteral(token)}%`);
      return `t.title ILIKE $${params.length} ESCAPE '\\'`;
    });
    params.push(options.limit);

    const result = await this.db.query<{
      similarity: number | string;
      threadId: string;
      title: string;
    }>(
      `${ownedThreadsSql('$2')}
       SELECT
         t.id AS "threadId",
         t.title,
         similarity(t.title, $1) AS similarity
       FROM mastra_threads t
       JOIN search_owned_threads owned ON owned.thread_id = t.id AND owned.resource_id = t."resourceId"
       WHERE TRUE
         AND ${tokenClauses.join(' AND ')}
       ORDER BY similarity DESC, t."updatedAt" DESC
       LIMIT $${params.length}`,
      params
    );

    return result.rows.map((row) => ({
      similarity: Number(row.similarity),
      threadId: row.threadId,
      title: row.title,
    }));
  }

  async listNeedingEmbedding(options: {
    limit: number;
    resourceId: string;
  }): Promise<ThreadMessagePendingEmbedding[]> {
    requirePositiveInteger(options.limit, 'limit');
    const result = await this.db.query<ThreadMessagePendingEmbedding>(
      `${ownedThreadsSql('$1')}
       SELECT
         message_id AS "messageId",
         content_hash AS "contentHash",
         content_text AS "contentText"
       FROM ${INDEX_TABLE} i
       JOIN search_owned_threads owned ON owned.thread_id = i.thread_id AND owned.resource_id = i.resource_id
       WHERE TRUE
         AND embedding IS NULL
         AND embedding_error IS NULL
         AND content_text <> ''
       ORDER BY message_created_at DESC
       LIMIT $2`,
      [options.resourceId, options.limit]
    );
    return result.rows.map((row) => ({ ...row }));
  }

  /**
   * Stores an embedding iff the row's content hash still matches (a changed
   * hash means the text was re-extracted since listing — the stale vector is
   * discarded and the row stays pending) AND the singleton profile still
   * names the model that produced the vector (a mid-flight profile swap to a
   * same-dimension model must not land a cross-space vector). Returns
   * whether the store landed.
   */
  async storeEmbedding(input: StoreThreadMessageEmbeddingInput): Promise<boolean> {
    const profile = await this.getEmbeddingProfile();
    if (input.modelKey !== profile.modelKey) {
      return false;
    }
    const vector = toVectorLiteral(input.embedding, profile.dimensions);
    const result = await this.db.query<{ message_id: string }>(
      `UPDATE ${INDEX_TABLE}
       SET embedding = $1::vector,
           embedding_profile_id = $2,
           embedding_error = NULL,
           embedding_updated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE message_id = $3
         AND content_hash = $4
         AND EXISTS (
           SELECT 1 FROM ${PROFILES_TABLE}
           WHERE id = $2 AND model_key = $5
         )
       RETURNING message_id`,
      [vector, profile.id, input.messageId, input.contentHash, input.modelKey]
    );
    return result.rows.length > 0;
  }

  /** CAS error mark, mirroring `storeEmbedding` semantics. */
  async markEmbeddingError(input: MarkThreadMessageEmbeddingErrorInput): Promise<boolean> {
    const message = input.error.trim();
    if (!message) {
      throw new Error('Thread search embedding errors must include a message.');
    }
    const result = await this.db.query<{ message_id: string }>(
      `UPDATE ${INDEX_TABLE}
       SET embedding = NULL,
           embedding_profile_id = NULL,
           embedding_error = $1,
           embedding_updated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE message_id = $2 AND content_hash = $3
       RETURNING message_id`,
      [message, input.messageId, input.contentHash]
    );
    return result.rows.length > 0;
  }

  async getCoverage(resourceId: string): Promise<ThreadSearchCoverage> {
    const result = await this.db.query<{
      embeddableMessages: number | string;
      embeddedMessages: number | string;
      erroredMessages: number | string;
      indexedMessages: number | string;
      totalMessages: number | string;
    }>(
      `${ownedThreadsSql('$1')}
       SELECT
         (
           SELECT COUNT(*)::int
           FROM mastra_messages m
           JOIN mastra_threads t ON t.id = m.thread_id
           JOIN search_owned_threads owned ON owned.thread_id = t.id
             AND owned.resource_id = COALESCE(m."resourceId", t."resourceId")
         ) AS "totalMessages",
         COUNT(*)::int AS "indexedMessages",
         COUNT(*) FILTER (WHERE content_text <> '')::int AS "embeddableMessages",
         COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS "embeddedMessages",
         COUNT(*) FILTER (WHERE embedding_error IS NOT NULL)::int AS "erroredMessages"
       FROM ${INDEX_TABLE} i
       JOIN search_owned_threads owned ON owned.thread_id = i.thread_id AND owned.resource_id = i.resource_id`,
      [resourceId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('Thread search coverage query returned no rows.');
    }
    return {
      embeddableMessages: Number(row.embeddableMessages),
      embeddedMessages: Number(row.embeddedMessages),
      erroredMessages: Number(row.erroredMessages),
      indexedMessages: Number(row.indexedMessages),
      totalMessages: Number(row.totalMessages),
    };
  }

  /**
   * Removes index + refresh-state rows for deleted threads (called from
   * thread deletion).
   */
  async deleteThreads(threadIds: readonly string[]): Promise<void> {
    if (threadIds.length === 0) {
      return;
    }
    const placeholders = threadIds.map((_, index) => `$${index + 1}`).join(', ');
    await this.db.query(`DELETE FROM ${INDEX_TABLE} WHERE thread_id IN (${placeholders})`, [
      ...threadIds,
    ]);
    await this.db.query(`DELETE FROM ${STATE_TABLE} WHERE thread_id IN (${placeholders})`, [
      ...threadIds,
    ]);
  }
}
