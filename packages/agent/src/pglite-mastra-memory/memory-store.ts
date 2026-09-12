import { createLogger } from '@brainstrike/logging';
import { getErrorMessage } from '@brainstrike/utils';
import type { MastraMessageContentV2 } from '@mastra/core/agent';
import type { MastraDBMessage, StorageThreadType } from '@mastra/core/memory';
import type {
  CreateObservationalMemoryInput,
  CreateReflectionGenerationInput,
  ObservationalMemoryHistoryOptions,
  ObservationalMemoryRecord,
  StorageListMessagesByResourceIdInput,
  StorageListMessagesInput,
  StorageListMessagesOutput,
  StorageListThreadsInput,
  StorageListThreadsOutput,
  StorageResourceType,
  SwapBufferedReflectionToActiveInput,
  SwapBufferedToActiveInput,
  SwapBufferedToActiveResult,
  UpdateActiveObservationsInput,
  UpdateBufferedObservationsInput,
  UpdateBufferedReflectionInput,
  UpdateObservationalMemoryConfigInput,
} from '@mastra/core/storage';
import { MemoryStorage } from '@mastra/core/storage';
import {
  type AssistantRunEventKind,
  type AssistantRunEventMetadata,
  type AssistantRunEventSink,
  type AssistantRunEventStatus,
  emitAssistantRunEventSafely,
} from '../run-events';
import {
  appendLimit,
  compareMessagesByOrder,
  DEFAULT_MESSAGES_PER_PAGE,
  DEFAULT_THREADS_PER_PAGE,
  formatCountDetail,
  type MessageIncludeItem,
  type MessageListArgs,
  messageMatchesListFilters,
  messageMatchesListScope,
  normalizeIncludeThreadId,
  normalizeIncludeWindowCount,
  normalizeMessageOrder,
  normalizePage,
  normalizePerPage,
  orderBySql,
  pagination,
  runTransaction,
  toDate,
  toJsonString,
} from './memory-query-helpers';
import {
  type CountRow,
  chooseBufferedActivationCount,
  emptyBufferedActivation,
  type MessageRow,
  messageFromRow,
  type ObservationalMemoryRow,
  observationalMemoryFromRow,
  observationalMemoryKey,
  type ResourceRow,
  resourceFromRow,
  type ThreadRow,
  threadFromRow,
  withoutBufferedObservationChunks,
  withoutBufferedReflection,
} from './memory-row-mapping';
import {
  ASSISTANT_MESSAGE_TOMBSTONES_TABLE,
  DELEGATED_THREAD_DELETE_CTES,
  MASTRA_MEMORY_SCHEMA_SQL,
  MASTRA_MEMORY_TABLES,
  MIND_OPS_TABLE,
  THREAD_DELETE_SIDECAR_TABLES,
  THREAD_TITLE_SOURCE_METADATA_KEY,
  THREAD_TITLE_SOURCE_OM,
} from './sql';
import { canOverwriteThreadTitle, resolveThreadSave } from './thread-title-policy';
import { throwIfThreadTitleSaveAborted } from './thread-title-save-cancellation';
import { projectMessageContentForTranscript } from './transcript-projection';
import type { PgliteDatabase, PgliteQueryValue } from './types';

const logger = createLogger('PgliteMemoryStore');

interface PgliteMemoryStoreOptions {
  database: PgliteDatabase;
  eventSink?: AssistantRunEventSink;
  runId?: string;
}

/** A window row plus its soft-rewind visibility flag (see `listAdjacentThreadMessageRows`). */
interface AdjacentMessageRow extends MessageRow {
  readonly hidden: boolean;
}

/**
 * "This message is hidden by a soft rewind" (BST-1115). Negate it for the
 * anti-join; use it bare where a row must be FLAGGED rather than dropped.
 *
 * KNOWN LIMITATION — OM residue (accepted, not fixable by filtering). Hiding a
 * message stops it being RE-READ; it cannot retract observations the
 * observational-memory observer already distilled from it into
 * `mastra_observational_memory."activeObservations"`. Mastra exposes no
 * partial un-observe — only `clearObservationalMemory`, which would throw away
 * the whole thread's memory to erase one turn. So after a rewind the model can
 * still carry a summary of what the hidden turn said. Do NOT "fix" this by
 * scrubbing observation text; that is guesswork over prose the observer wrote.
 *
 * Built ON DEMAND, deliberately NOT a module-scope constant: it interpolates
 * `ASSISTANT_MESSAGE_TOMBSTONES_TABLE`, imported from
 * `@brainstrike/assistant-contract`. Reading that binding during chunk
 * initialization is the measured BST-558 failure mode — an uninitialized
 * binding does not throw here, it splices the literal string "undefined" into
 * the DDL/DML. Keep it a function.
 */
function tombstonedPredicateSql(messageIdExpression: string): string {
  return `EXISTS (
      SELECT 1 FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE} AS tombstones
      WHERE tombstones.message_id = ${messageIdExpression}
    )`;
}

export class PgliteMemoryStore extends MemoryStorage {
  override readonly supportsObservationalMemory = true;
  private readonly database: PgliteDatabase;
  private readonly eventSink: AssistantRunEventSink | undefined;
  private readonly runId: string | undefined;
  private initPromise: Promise<void> | null = null;
  /**
   * Soft-rewind sidecar presence, latched TRUE and never back to false.
   *
   * The table is owned by migration 080 / the app-shell bootstrap mirror, not
   * by this class — `initialize()` creates only the Mastra schema, so a
   * STANDALONE store legitimately lacks it (the same reason `deleteThread`
   * probes its cascade tables). Latching only the positive answer is what
   * keeps this from becoming a silent fallback: a store built before the
   * migration ran re-probes on every read until the table appears and then
   * filters forever after, instead of caching "absent" and hiding nothing for
   * the rest of the process's life.
   */
  private tombstoneSidecarInstalled = false;

  constructor(options: PgliteMemoryStoreOptions) {
    super();
    this.database = options.database;
    this.eventSink = options.eventSink;
    this.runId = options.runId;
  }

  override async init(): Promise<void> {
    await this.initialize();
  }

  async initialize(): Promise<void> {
    this.initPromise ??= this.database
      .exec(MASTRA_MEMORY_SCHEMA_SQL)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.initPromise = null;
        throw error;
      });
    await this.initPromise;
  }

  override async dangerouslyClearAll(): Promise<void> {
    await this.database.exec(`
      DELETE FROM ${MASTRA_MEMORY_TABLES.messages};
      DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory};
      DELETE FROM ${MASTRA_MEMORY_TABLES.resources};
      DELETE FROM ${MASTRA_MEMORY_TABLES.threads};
    `);
  }

  override async getThreadById({
    threadId,
    resourceId,
  }: {
    threadId: string;
    resourceId?: string;
  }): Promise<StorageThreadType | null> {
    const values: PgliteQueryValue[] = [threadId];
    const resourcePredicate = resourceId === undefined ? '' : ' AND "resourceId" = $2';
    if (resourceId !== undefined) {
      values.push(resourceId);
    }
    const result = await this.database.query<ThreadRow>(
      `SELECT id, "resourceId", title, metadata, "createdAt", "updatedAt"
       FROM ${MASTRA_MEMORY_TABLES.threads}
       WHERE id = $1${resourcePredicate}`,
      values
    );
    const row = result.rows[0];
    return row ? threadFromRow(row) : null;
  }

  override async saveThread({ thread }: { thread: StorageThreadType }): Promise<StorageThreadType> {
    throwIfThreadTitleSaveAborted(thread);
    return runTransaction(this.database, async (tx) => {
      const existingResult = await tx.query<ThreadRow>(
        `SELECT id, "resourceId", title, metadata, "createdAt", "updatedAt"
         FROM ${MASTRA_MEMORY_TABLES.threads}
         WHERE id = $1`,
        [thread.id]
      );
      throwIfThreadTitleSaveAborted(thread);
      const existingRow = existingResult.rows[0];
      const existing = existingRow ? threadFromRow(existingRow) : null;
      // Mastra bootstraps a thread with an empty title, then its asynchronous
      // `generateTitle` path calls createThread/saveThread again with the real
      // title. Apply only a non-empty proposed title to an existing row, and
      // only while that row is still system-owned. The transaction closes the
      // race where a manual rename lands while title generation is in flight.
      const resolved = resolveThreadSave(existing, thread);
      throwIfThreadTitleSaveAborted(thread);

      if (resolved.preservedGeneratedTitle) {
        logger.debug('Preserving established thread title against generated title', {
          existingTitle: existing?.title,
          proposedTitle: resolved.proposedTitle,
          threadId: thread.id,
        });
      }

      await tx.query(
        `INSERT INTO ${MASTRA_MEMORY_TABLES.threads}
          (id, "resourceId", title, metadata, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
          "resourceId" = EXCLUDED."resourceId",
          title = EXCLUDED.title,
          metadata = EXCLUDED.metadata,
          "updatedAt" = EXCLUDED."updatedAt"`,
        [
          thread.id,
          thread.resourceId,
          resolved.effectiveTitle,
          toJsonString(resolved.effectiveMetadata),
          resolved.effectiveCreatedAt,
          resolved.effectiveUpdatedAt,
        ]
      );
      throwIfThreadTitleSaveAborted(thread);
      const savedResult = await tx.query<ThreadRow>(
        `SELECT id, "resourceId", title, metadata, "createdAt", "updatedAt"
         FROM ${MASTRA_MEMORY_TABLES.threads}
         WHERE id = $1`,
        [thread.id]
      );
      throwIfThreadTitleSaveAborted(thread);
      const savedRow = savedResult.rows[0];
      if (!savedRow) {
        throw new Error(`Failed to save Mastra thread: ${thread.id}`);
      }
      return threadFromRow(savedRow);
    });
  }

  override async updateThread({
    id,
    title,
    metadata,
  }: {
    id: string;
    title: string;
    metadata: Record<string, unknown>;
  }): Promise<StorageThreadType> {
    const existing = await this.getThreadById({ threadId: id });
    const existingTitle = existing?.title ?? '';
    const canOverwrite = canOverwriteThreadTitle(existing);
    const effectiveTitle = canOverwrite ? title : existingTitle;
    const titleChanged = effectiveTitle.trim() !== existingTitle.trim();

    if (existing && !canOverwrite && title.trim() !== existingTitle.trim()) {
      // The observational-memory thread-title extractor is the only actor that
      // writes titles through this adapter; manual rename uses a dedicated
      // raw-SQL path that clears the OM marker on write. Preserve an
      // established title so an auto-generated title never clobbers one the
      // user already set — user-owned titles win.
      logger.debug('Preserving established thread title against auto-title update', {
        existingTitle: existing.title,
        proposedTitle: title,
        threadId: id,
      });
    }

    // Stamp the OM marker only when this write actually changes the title,
    // so a metadata-only OM persist (proposed title unchanged) neither adds
    // nor needs to re-add it — any marker already on the thread already
    // survives via the caller's own metadata merge (see setThreadOMMetadata
    // in @mastra/memory), since it spreads the thread's existing metadata.
    const effectiveMetadata: Record<string, unknown> = titleChanged
      ? { ...metadata, [THREAD_TITLE_SOURCE_METADATA_KEY]: THREAD_TITLE_SOURCE_OM }
      : metadata;

    const now = new Date();
    await this.database.query(
      `UPDATE ${MASTRA_MEMORY_TABLES.threads}
       SET title = $2, metadata = $3::jsonb, "updatedAt" = $4
       WHERE id = $1`,
      [id, effectiveTitle, toJsonString(effectiveMetadata), now]
    );
    const updated = await this.getThreadById({ threadId: id });
    if (!updated) {
      throw new Error(`Mastra thread not found: ${id}`);
    }
    return updated;
  }

  override async deleteThread({ threadId }: { threadId: string }): Promise<void> {
    // Full cascade from the ONE shared spec (BST-993): this override is
    // reachable from @mastra/core's facade and previously deleted only the
    // three Mastra tables, leaking every Brainstrike sidecar row. The
    // sidecar tables are app-owned: a STANDALONE store (this class's own
    // initialize creates only the Mastra schema) legitimately lacks them, so
    // each is probed with to_regclass — the sanctioned in-transaction
    // absence check; catching 42P01 inside a tx would abort it (#1978). On a
    // migrated application database every probe passes. The mind-op INSERT
    // fires only when the thread row actually existed (idempotent deletes
    // emit nothing) and only where the seam table exists (a standalone
    // store has no sync seam to feed).
    await runTransaction(this.database, async (tx) => {
      // ONE set-based probe answers for all app-owned tables (review #2167:
      // five sequential to_regclass round trips collapsed into one).
      const probed = await tx.query<{ table: string }>(
        'SELECT t AS table FROM unnest($1::text[]) AS t WHERE to_regclass(t) IS NOT NULL',
        [
          [
            ...THREAD_DELETE_SIDECAR_TABLES.map((entry) => entry.table),
            MIND_OPS_TABLE,
            'brainstrike_delegated_conversations',
          ],
        ]
      );
      const present = new Set(probed.rows.map((row) => row.table));
      let threadIds = [threadId];
      if (present.has('brainstrike_delegated_conversations')) {
        const scope = await tx.query<{ allAuthorized: boolean; threadIds: string[] }>(
          `WITH RECURSIVE requested(id) AS (VALUES ($1::text)), ${DELEGATED_THREAD_DELETE_CTES}
           SELECT (SELECT all_authorized FROM deletion_scope_validation) AS "allAuthorized",
             ARRAY(SELECT id FROM deletion_threads) AS "threadIds"`,
          [threadId]
        );
        const row = scope.rows[0];
        if (row?.allAuthorized !== true || !Array.isArray(row.threadIds)) {
          throw new Error('Delegated branch deletion requires unchanged native ownership.', {
            cause: { operation: 'delete-delegated-branch', requestedThreadIds: [threadId] },
          });
        }
        threadIds = row.threadIds;
      }
      await tx.query(
        `DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
         WHERE "threadId" = ANY($1::text[]) OR "lookupKey" = ANY($2::text[])`,
        [threadIds, threadIds.map((id) => `thread:${id}`)]
      );
      await tx.query(
        `DELETE FROM ${MASTRA_MEMORY_TABLES.messages} WHERE thread_id = ANY($1::text[])`,
        [threadIds]
      );
      for (const { table, threadColumns } of THREAD_DELETE_SIDECAR_TABLES) {
        if (present.has(table)) {
          await tx.query(
            `DELETE FROM ${table} WHERE ${threadColumns.map((column) => `${column} = ANY($1::text[])`).join(' OR ')}`,
            [threadIds]
          );
        }
      }
      const deleted = await tx.query<{ id: string; resourceId: string | null }>(
        `DELETE FROM ${MASTRA_MEMORY_TABLES.threads} WHERE id = ANY($1::text[]) RETURNING id, "resourceId"`,
        [threadIds]
      );
      if (deleted.rows.length > 0 && present.has(MIND_OPS_TABLE)) {
        await tx.query(
          `INSERT INTO ${MIND_OPS_TABLE} (entity_kind, entity_id, op, resource_id)
           SELECT 'thread', id, 'delete', resource
           FROM unnest($1::text[], $2::text[]) AS deleted(id, resource)`,
          [deleted.rows.map((row) => row.id), deleted.rows.map((row) => row.resourceId)]
        );
      }
    });
  }

  override async listThreads(args: StorageListThreadsInput): Promise<StorageListThreadsOutput> {
    const page = normalizePage(args.page);
    const perPage = normalizePerPage(args.perPage, DEFAULT_THREADS_PER_PAGE);
    const where: string[] = [];
    const values: PgliteQueryValue[] = [];
    const filter = args.filter;

    if (filter?.resourceId !== undefined) {
      values.push(filter.resourceId);
      where.push(`"resourceId" = $${values.length}`);
    }
    if (filter?.metadata && Object.keys(filter.metadata).length > 0) {
      values.push(JSON.stringify(filter.metadata));
      where.push(`metadata @> $${values.length}::jsonb`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this.database.query<CountRow>(
      `SELECT COUNT(*) AS count FROM ${MASTRA_MEMORY_TABLES.threads} ${whereSql}`,
      values
    );
    const total = Number(countResult.rows[0]?.count ?? 0);
    const queryValues = [...values];
    const baseSql = `SELECT id, "resourceId", title, metadata, "createdAt", "updatedAt"
       FROM ${MASTRA_MEMORY_TABLES.threads}
       ${whereSql}
       ORDER BY ${orderBySql(args.orderBy, 'createdAt', 'DESC')}`;
    const rows = await this.database.query<ThreadRow>(
      appendLimit(baseSql, queryValues, page, perPage),
      queryValues
    );

    return {
      threads: rows.rows.map(threadFromRow),
      ...pagination(total, page, perPage),
    };
  }

  override async listMessages(args: StorageListMessagesInput): Promise<StorageListMessagesOutput> {
    const threadIds = Array.isArray(args.threadId) ? args.threadId : [args.threadId];
    if (threadIds.length === 0 || threadIds.some((threadId) => !threadId.trim())) {
      throw new Error('threadId must be a non-empty string or array of non-empty strings');
    }
    const result = await this.listMessagesWhere({ ...args, threadIds });
    this.emitRunEvent(
      'memory.history.loaded',
      'completed',
      'Conversation history loaded',
      {
        count: result.messages.length,
        threadCount: threadIds.length,
      },
      formatCountDetail(result.messages.length, 'message')
    );
    return result;
  }

  override async listMessagesByResourceId(
    args: StorageListMessagesByResourceIdInput
  ): Promise<StorageListMessagesOutput> {
    const result = await this.listMessagesWhere(args);
    this.emitRunEvent(
      'memory.history.loaded',
      'completed',
      'Resource history loaded',
      {
        count: result.messages.length,
        resourceId: args.resourceId,
      },
      formatCountDetail(result.messages.length, 'message')
    );
    return result;
  }

  override async listMessagesById({ messageIds }: { messageIds: string[] }): Promise<{
    messages: MastraDBMessage[];
  }> {
    if (messageIds.length === 0) {
      return { messages: [] };
    }
    const result = await this.database.query<MessageRow>(
      `SELECT id, thread_id AS "threadId", content, role, type, "createdAt", "resourceId"
       FROM ${MASTRA_MEMORY_TABLES.messages}
       WHERE id = ANY($1::text[])`,
      [messageIds]
    );
    const byId = new Map(result.rows.map((row) => [row.id, messageFromRow(row)]));
    return { messages: messageIds.flatMap((id) => byId.get(id) ?? []) };
  }

  override async saveMessages(args: { messages: MastraDBMessage[] }): Promise<{
    messages: MastraDBMessage[];
  }> {
    if (args.messages.length === 0) {
      return { messages: [] };
    }

    const persistedMessages = args.messages.map((message) => ({
      ...message,
      content: projectMessageContentForTranscript(message.content, message.role),
    }));
    const insertValues: PgliteQueryValue[] = [];
    const insertRows = persistedMessages.map((message, index) => {
      const base = index * 7;
      insertValues.push(
        message.id,
        message.threadId ?? '',
        JSON.stringify(message.content),
        message.role,
        message.type ?? 'v2',
        message.createdAt,
        message.resourceId ?? null
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}::jsonb, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });

    const threadUpdates = new Map<string, Date>();
    for (const message of args.messages) {
      if (!message.threadId) {
        continue;
      }
      const currentUpdatedAt = threadUpdates.get(message.threadId);
      if (!(currentUpdatedAt && currentUpdatedAt.getTime() >= message.createdAt.getTime())) {
        threadUpdates.set(message.threadId, message.createdAt);
      }
    }

    // Single transaction: a crash between the message upsert and the thread
    // "updatedAt" bump must not leave saved messages whose thread ordering
    // timestamp lags behind them.
    await runTransaction(this.database, async (tx) => {
      await tx.query(
        `INSERT INTO ${MASTRA_MEMORY_TABLES.messages}
          (id, thread_id, content, role, type, "createdAt", "resourceId")
         VALUES ${insertRows.join(', ')}
         ON CONFLICT (id) DO UPDATE SET
          thread_id = EXCLUDED.thread_id,
          content = EXCLUDED.content,
          role = EXCLUDED.role,
          type = EXCLUDED.type,
          "resourceId" = EXCLUDED."resourceId"`,
        insertValues
      );

      if (threadUpdates.size > 0) {
        const updateValues: PgliteQueryValue[] = [];
        const updateRows = [...threadUpdates.entries()].map(([threadId, updatedAt], index) => {
          const base = index * 2;
          updateValues.push(threadId, updatedAt);
          return `($${base + 1}, $${base + 2}::timestamptz)`;
        });
        await tx.query(
          `UPDATE ${MASTRA_MEMORY_TABLES.threads} AS threads
           SET "updatedAt" = GREATEST(threads."updatedAt", updates.updated_at)
           FROM (VALUES ${updateRows.join(', ')}) AS updates(id, updated_at)
           WHERE threads.id = updates.id`,
          updateValues
        );
      }
    });

    return { messages: persistedMessages };
  }

  override async updateMessages(args: {
    messages: (Partial<Omit<MastraDBMessage, 'createdAt'>> & {
      content?: {
        content?: MastraMessageContentV2['content'];
        metadata?: MastraMessageContentV2['metadata'];
      };
      id: string;
    })[];
  }): Promise<MastraDBMessage[]> {
    const messageIds = args.messages.map((message) => message.id);
    const existing = await this.listMessagesById({ messageIds });
    const existingById = new Map(existing.messages.map((message) => [message.id, message]));
    const mergedMessages: MastraDBMessage[] = [];

    for (const message of args.messages) {
      const current = existingById.get(message.id);
      if (!current) {
        continue;
      }
      mergedMessages.push({
        ...current,
        ...message,
        content:
          message.content === undefined
            ? current.content
            : {
                ...current.content,
                ...message.content,
              },
      } as MastraDBMessage);
    }

    if (mergedMessages.length > 0) {
      await this.saveMessages({ messages: mergedMessages });
    }

    return (await this.listMessagesById({ messageIds })).messages;
  }

  override async deleteMessages(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }
    await this.database.query(
      `DELETE FROM ${MASTRA_MEMORY_TABLES.messages} WHERE id = ANY($1::text[])`,
      [messageIds]
    );
  }

  override async getResourceById({
    resourceId,
  }: {
    resourceId: string;
  }): Promise<StorageResourceType | null> {
    const result = await this.database.query<ResourceRow>(
      `SELECT id, "workingMemory", metadata, "createdAt", "updatedAt"
       FROM ${MASTRA_MEMORY_TABLES.resources}
       WHERE id = $1`,
      [resourceId]
    );
    const row = result.rows[0];
    const resource = row ? resourceFromRow(row) : null;
    const workingMemoryChars = resource?.workingMemory?.length ?? 0;
    this.emitRunEvent(
      'memory.working.loaded',
      'completed',
      'Working memory loaded',
      {
        exists: resource !== null,
        resourceId,
        workingMemoryChars,
      },
      workingMemoryChars > 0 ? `${workingMemoryChars} chars` : 'empty'
    );
    return resource;
  }

  override async saveResource({
    resource,
  }: {
    resource: StorageResourceType;
  }): Promise<StorageResourceType> {
    await this.database.query(
      `INSERT INTO ${MASTRA_MEMORY_TABLES.resources}
        (id, "workingMemory", metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
        "workingMemory" = EXCLUDED."workingMemory",
        metadata = EXCLUDED.metadata,
        "createdAt" = EXCLUDED."createdAt",
        "updatedAt" = EXCLUDED."updatedAt"`,
      [
        resource.id,
        resource.workingMemory ?? null,
        toJsonString(resource.metadata),
        resource.createdAt,
        resource.updatedAt,
      ]
    );
    const saved = await this.getResourceById({ resourceId: resource.id });
    if (!saved) {
      throw new Error(`Failed to save Mastra resource: ${resource.id}`);
    }
    return saved;
  }

  override async updateResource({
    resourceId,
    workingMemory,
    metadata,
  }: {
    metadata?: Record<string, unknown>;
    resourceId: string;
    workingMemory?: string;
  }): Promise<StorageResourceType> {
    const existing = await this.getResourceById({ resourceId });
    const now = new Date();
    const next: StorageResourceType = {
      createdAt: existing?.createdAt ?? now,
      id: resourceId,
      updatedAt: now,
    };
    if (workingMemory === undefined) {
      if (existing?.workingMemory !== undefined) {
        next.workingMemory = existing.workingMemory;
      }
    } else {
      next.workingMemory = workingMemory;
    }
    if (metadata === undefined) {
      if (existing?.metadata !== undefined) {
        next.metadata = existing.metadata;
      }
    } else {
      next.metadata = metadata;
    }
    const saved = await this.saveResource({ resource: next });
    const savedWorkingMemoryChars = saved.workingMemory?.length ?? 0;
    this.emitRunEvent(
      'memory.working.updated',
      'completed',
      'Working memory updated',
      {
        hasWorkingMemory: saved.workingMemory !== undefined,
        resourceId,
        workingMemoryChars: savedWorkingMemoryChars,
      },
      savedWorkingMemoryChars > 0 ? `${savedWorkingMemoryChars} chars` : 'cleared'
    );
    return saved;
  }

  override async getObservationalMemory(
    threadId: string | null,
    resourceId: string
  ): Promise<ObservationalMemoryRecord | null> {
    const result = await this.database.query<ObservationalMemoryRow>(
      `SELECT *
       FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
       WHERE "lookupKey" = $1
       ORDER BY "generationCount" DESC, "createdAt" DESC
       LIMIT 1`,
      [observationalMemoryKey(threadId, resourceId)]
    );
    const row = result.rows[0];
    const record = row ? observationalMemoryFromRow(row) : null;
    this.emitRunEvent(
      'memory.observation.completed',
      'completed',
      'Observational memory read',
      {
        exists: record !== null,
        resourceId,
        scope: threadId ? 'thread' : 'resource',
        ...(record
          ? {
              generationCount: record.generationCount,
              observationChars: record.activeObservations.length,
              observationTokens: record.observationTokenCount,
            }
          : {}),
      },
      record
        ? `generation ${record.generationCount} · ${record.observationTokenCount} observation tokens`
        : 'no observations yet'
    );
    return record;
  }

  override async getObservationalMemoryHistory(
    threadId: string | null,
    resourceId: string,
    limit?: number,
    options?: ObservationalMemoryHistoryOptions
  ): Promise<ObservationalMemoryRecord[]> {
    const values: PgliteQueryValue[] = [observationalMemoryKey(threadId, resourceId)];
    const where = ['"lookupKey" = $1'];
    if (options?.from) {
      values.push(options.from);
      where.push(`"createdAt" >= $${values.length}`);
    }
    if (options?.to) {
      values.push(options.to);
      where.push(`"createdAt" <= $${values.length}`);
    }
    let sql = `SELECT *
       FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
       WHERE ${where.join(' AND ')}
       ORDER BY "generationCount" DESC, "createdAt" DESC`;
    if (options?.offset !== undefined) {
      values.push(options.offset);
      sql = `${sql} OFFSET $${values.length}`;
    }
    if (limit !== undefined) {
      values.push(limit);
      sql = `${sql} LIMIT $${values.length}`;
    }
    const result = await this.database.query<ObservationalMemoryRow>(sql, values);
    const records = result.rows.map(observationalMemoryFromRow);
    this.emitRunEvent(
      'memory.observation.completed',
      'completed',
      'Observation history loaded',
      {
        count: records.length,
        resourceId,
        scope: threadId ? 'thread' : 'resource',
      },
      formatCountDetail(records.length, 'record')
    );
    return records;
  }

  override async initializeObservationalMemory(
    input: CreateObservationalMemoryInput
  ): Promise<ObservationalMemoryRecord> {
    const now = new Date();
    const record: ObservationalMemoryRecord = {
      activeObservations: '',
      config: input.config,
      createdAt: now,
      generationCount: 0,
      id: crypto.randomUUID(),
      isBufferingObservation: false,
      isBufferingReflection: false,
      isObserving: false,
      isReflecting: false,
      lastBufferedAtTime: null,
      lastBufferedAtTokens: 0,
      metadata: {},
      observationTokenCount: 0,
      originType: 'initial',
      pendingMessageTokens: 0,
      resourceId: input.resourceId,
      scope: input.scope,
      threadId: input.threadId,
      totalTokensObserved: 0,
      updatedAt: now,
    };
    if (input.observedTimezone) {
      record.observedTimezone = input.observedTimezone;
    }
    await this.insertObservationalMemoryRecord(record);
    this.emitRunEvent(
      'memory.configured',
      'completed',
      'Observational memory configured',
      {
        resourceId: input.resourceId,
        scope: input.scope,
      },
      `${input.scope} scope`
    );
    return record;
  }

  override async insertObservationalMemoryRecord(record: ObservationalMemoryRecord): Promise<void> {
    await this.saveObservationalMemoryRecord(record);
  }

  override async updateActiveObservations(input: UpdateActiveObservationsInput): Promise<void> {
    const record = await this.findObservationalMemoryRecordById(input.id);
    record.activeObservations = input.observations;
    record.observationTokenCount = input.tokenCount;
    record.totalTokensObserved += input.tokenCount;
    record.pendingMessageTokens = 0;
    record.lastObservedAt = input.lastObservedAt;
    record.updatedAt = new Date();
    if (input.observedMessageIds) {
      record.observedMessageIds = input.observedMessageIds;
    }
    if (input.observedTimezone) {
      record.observedTimezone = input.observedTimezone;
    }
    await this.saveObservationalMemoryRecord(record);
    this.emitRunEvent('memory.observation.completed', 'completed', 'Observations updated', {
      messageCount: input.observedMessageIds?.length ?? 0,
      tokenCount: input.tokenCount,
    });
  }

  override async updateBufferedObservations(input: UpdateBufferedObservationsInput): Promise<void> {
    const record = await this.findObservationalMemoryRecordById(input.id);
    const chunk = {
      ...input.chunk,
      createdAt: new Date(),
      id: `ombuf-${crypto.randomUUID()}`,
    };
    record.bufferedObservationChunks = [...(record.bufferedObservationChunks ?? []), chunk];
    if (input.lastBufferedAtTime) {
      record.lastBufferedAtTime = input.lastBufferedAtTime;
    }
    record.updatedAt = new Date();
    await this.saveObservationalMemoryRecord(record);
    this.emitRunEvent(
      'memory.observation.completed',
      'completed',
      'Buffered observations updated',
      {
        messageCount: input.chunk.messageIds.length,
        tokenCount: input.chunk.tokenCount,
      }
    );
  }

  override async swapBufferedToActive(
    input: SwapBufferedToActiveInput
  ): Promise<SwapBufferedToActiveResult> {
    const record = await this.findObservationalMemoryRecordById(input.id);
    const chunks = input.bufferedChunks ?? record.bufferedObservationChunks ?? [];
    if (chunks.length === 0) {
      return emptyBufferedActivation();
    }

    const chunksToActivate = chooseBufferedActivationCount(chunks, input).count;
    const activatedChunks = chunks.slice(0, chunksToActivate);
    const remainingChunks = chunks.slice(chunksToActivate);
    const activatedContent = activatedChunks.map((chunk) => chunk.observations).join('\n\n');
    const activatedTokens = activatedChunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
    const activatedMessageTokens = activatedChunks.reduce(
      (sum, chunk) => sum + chunk.messageTokens,
      0
    );
    const activatedMessageCount = activatedChunks.reduce(
      (sum, chunk) => sum + chunk.messageIds.length,
      0
    );
    const latestChunk = activatedChunks.at(-1);
    const derivedLastObservedAt = input.lastObservedAt ?? latestChunk?.lastObservedAt ?? new Date();

    if (record.activeObservations) {
      const boundary = `\n\n--- message boundary (${derivedLastObservedAt.toISOString()}) ---\n\n`;
      record.activeObservations = `${record.activeObservations}${boundary}${activatedContent}`;
    } else {
      record.activeObservations = activatedContent;
    }
    record.observationTokenCount += activatedTokens;
    record.pendingMessageTokens = Math.max(0, record.pendingMessageTokens - activatedMessageTokens);
    const recordToSave =
      remainingChunks.length > 0
        ? { ...record, bufferedObservationChunks: remainingChunks }
        : withoutBufferedObservationChunks(record);
    record.lastObservedAt = derivedLastObservedAt;
    record.updatedAt = new Date();
    recordToSave.lastObservedAt = derivedLastObservedAt;
    recordToSave.updatedAt = record.updatedAt;
    await this.saveObservationalMemoryRecord(recordToSave);
    this.emitRunEvent(
      'memory.observation.completed',
      'completed',
      'Buffered observations activated',
      {
        chunksActivated: activatedChunks.length,
        messagesActivated: activatedMessageCount,
        tokenCount: activatedTokens,
      }
    );

    return {
      activatedCycleIds: activatedChunks.map((chunk) => chunk.cycleId).filter(Boolean),
      activatedMessageIds: activatedChunks.flatMap((chunk) => chunk.messageIds),
      chunksActivated: activatedChunks.length,
      messagesActivated: activatedMessageCount,
      messageTokensActivated: activatedMessageTokens,
      observations: activatedContent,
      observationTokensActivated: activatedTokens,
      perChunk: activatedChunks.map((chunk) => ({
        cycleId: chunk.cycleId,
        messageCount: chunk.messageIds.length,
        messageTokens: chunk.messageTokens,
        observations: chunk.observations,
        observationTokens: chunk.tokenCount,
      })),
      ...(latestChunk?.suggestedContinuation
        ? { suggestedContinuation: latestChunk.suggestedContinuation }
        : {}),
      ...(latestChunk?.currentTask ? { currentTask: latestChunk.currentTask } : {}),
    };
  }

  override async createReflectionGeneration(
    input: CreateReflectionGenerationInput
  ): Promise<ObservationalMemoryRecord> {
    const now = new Date();
    const record: ObservationalMemoryRecord = {
      activeObservations: input.reflection,
      config: input.currentRecord.config,
      createdAt: now,
      generationCount: input.currentRecord.generationCount + 1,
      id: crypto.randomUUID(),
      isBufferingObservation: false,
      isBufferingReflection: false,
      isObserving: false,
      isReflecting: false,
      lastBufferedAtTime: null,
      lastBufferedAtTokens: 0,
      lastObservedAt: input.currentRecord.lastObservedAt ?? now,
      metadata: {},
      observationTokenCount: input.tokenCount,
      originType: 'reflection',
      pendingMessageTokens: 0,
      resourceId: input.currentRecord.resourceId,
      scope: input.currentRecord.scope,
      threadId: input.currentRecord.threadId,
      totalTokensObserved: input.currentRecord.totalTokensObserved,
      updatedAt: now,
    };
    if (input.currentRecord.observedTimezone) {
      record.observedTimezone = input.currentRecord.observedTimezone;
    }
    await this.insertObservationalMemoryRecord(record);
    this.emitRunEvent('memory.reflection.completed', 'completed', 'Memory reflection created', {
      generationCount: record.generationCount,
      tokenCount: input.tokenCount,
    });
    return record;
  }

  override async updateBufferedReflection(input: UpdateBufferedReflectionInput): Promise<void> {
    const record = await this.findObservationalMemoryRecordById(input.id);
    record.bufferedReflection = record.bufferedReflection
      ? `${record.bufferedReflection}\n\n${input.reflection}`
      : input.reflection;
    record.bufferedReflectionTokens = (record.bufferedReflectionTokens ?? 0) + input.tokenCount;
    record.bufferedReflectionInputTokens =
      (record.bufferedReflectionInputTokens ?? 0) + input.inputTokenCount;
    record.reflectedObservationLineCount = input.reflectedObservationLineCount;
    record.updatedAt = new Date();
    await this.saveObservationalMemoryRecord(record);
    this.emitRunEvent('memory.reflection.completed', 'completed', 'Buffered reflection updated', {
      inputTokenCount: input.inputTokenCount,
      tokenCount: input.tokenCount,
    });
  }

  override async swapBufferedReflectionToActive(
    input: SwapBufferedReflectionToActiveInput
  ): Promise<ObservationalMemoryRecord> {
    const record = await this.findObservationalMemoryRecordById(input.currentRecord.id);
    if (!record.bufferedReflection) {
      throw new Error('No buffered reflection to swap');
    }
    const reflectedLineCount = record.reflectedObservationLineCount ?? 0;
    const unreflectedContent = record.activeObservations
      .split('\n')
      .slice(reflectedLineCount)
      .join('\n')
      .trim();
    const nextObservations = unreflectedContent
      ? `${record.bufferedReflection}\n\n${unreflectedContent}`
      : record.bufferedReflection;
    const generation = await this.createReflectionGeneration({
      currentRecord: record,
      reflection: nextObservations,
      tokenCount: input.tokenCount,
    });
    await this.saveObservationalMemoryRecord(withoutBufferedReflection(record));
    this.emitRunEvent('memory.reflection.completed', 'completed', 'Buffered reflection activated', {
      generationCount: generation.generationCount,
      tokenCount: input.tokenCount,
    });
    return generation;
  }

  override async setReflectingFlag(id: string, isReflecting: boolean): Promise<void> {
    await this.updateObservationalMemoryColumns(id, [['"isReflecting"', isReflecting]]);
    if (isReflecting) {
      this.emitRunEvent('memory.reflection.started', 'running', 'Memory reflection started');
    }
  }

  override async setObservingFlag(id: string, isObserving: boolean): Promise<void> {
    await this.updateObservationalMemoryColumns(id, [['"isObserving"', isObserving]]);
    if (isObserving) {
      this.emitRunEvent('memory.observation.started', 'running', 'Memory observation started');
    }
  }

  override async setBufferingObservationFlag(
    id: string,
    isBuffering: boolean,
    lastBufferedAtTokens?: number
  ): Promise<void> {
    const updates: [string, PgliteQueryValue][] = [['"isBufferingObservation"', isBuffering]];
    if (lastBufferedAtTokens !== undefined) {
      updates.push(['"lastBufferedAtTokens"', lastBufferedAtTokens]);
    }
    await this.updateObservationalMemoryColumns(id, updates);
  }

  override async setBufferingReflectionFlag(id: string, isBuffering: boolean): Promise<void> {
    await this.updateObservationalMemoryColumns(id, [['"isBufferingReflection"', isBuffering]]);
    if (isBuffering) {
      this.emitRunEvent('memory.reflection.started', 'running', 'Buffered reflection started');
    }
  }

  override async clearObservationalMemory(
    threadId: string | null,
    resourceId: string
  ): Promise<void> {
    await this.database.query(
      `DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory} WHERE "lookupKey" = $1`,
      [observationalMemoryKey(threadId, resourceId)]
    );
  }

  override async setPendingMessageTokens(id: string, tokenCount: number): Promise<void> {
    await this.updateObservationalMemoryColumns(id, [['"pendingMessageTokens"', tokenCount]]);
  }

  override async updateObservationalMemoryConfig(
    input: UpdateObservationalMemoryConfigInput
  ): Promise<void> {
    const record = await this.findObservationalMemoryRecordById(input.id);
    record.config = this.deepMergeConfig(record.config, input.config);
    record.updatedAt = new Date();
    await this.saveObservationalMemoryRecord(record);
  }

  /**
   * `to_regclass` presence check for the soft-rewind tombstone sidecar — the
   * sanctioned absence probe (catching 42P01 cannot work inside a transaction,
   * #1978, and swallowing it outside one would silently disable hiding).
   * Answers from the latch once the table has been seen.
   */
  private async hasTombstoneSidecar(): Promise<boolean> {
    if (this.tombstoneSidecarInstalled) {
      return true;
    }
    const probe = await this.database.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [ASSISTANT_MESSAGE_TOMBSTONES_TABLE]
    );
    const row = probe.rows[0];
    if (!row) {
      throw new Error('Tombstone sidecar presence probe returned no rows.');
    }
    this.tombstoneSidecarInstalled = row.present;
    return row.present;
  }

  private async listMessagesWhere(args: MessageListArgs): Promise<StorageListMessagesOutput> {
    const page = normalizePage(args.page);
    const perPage = normalizePerPage(args.perPage, DEFAULT_MESSAGES_PER_PAGE);
    const where: string[] = [];
    const values: PgliteQueryValue[] = [];

    // Soft-rewind exclusion (BST-1115) goes in BOTH the COUNT and the page
    // query — they share `whereSql` — so `total`/`hasMore` describe the same
    // visible set the caller receives. This covers observational memory, whose
    // only message reads are listMessages / listMessagesByResourceId; semantic
    // recall's include window does NOT pass through here and is filtered at
    // findMessageRowById / listAdjacentThreadMessageRows instead.
    if (await this.hasTombstoneSidecar()) {
      where.push(`NOT ${tombstonedPredicateSql(`${MASTRA_MEMORY_TABLES.messages}.id`)}`);
    }
    if (args.threadIds) {
      values.push(args.threadIds);
      where.push(`thread_id = ANY($${values.length}::text[])`);
    }
    if (args.resourceId !== undefined) {
      values.push(args.resourceId);
      where.push(`"resourceId" = $${values.length}`);
    }
    const dateRange = args.filter?.dateRange;
    if (dateRange?.start) {
      values.push(dateRange.start);
      where.push(`"createdAt" ${dateRange.startExclusive ? '>' : '>='} $${values.length}`);
    }
    if (dateRange?.end) {
      values.push(dateRange.end);
      where.push(`"createdAt" ${dateRange.endExclusive ? '<' : '<='} $${values.length}`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this.database.query<CountRow>(
      `SELECT COUNT(*) AS count FROM ${MASTRA_MEMORY_TABLES.messages} ${whereSql}`,
      values
    );
    const total = Number(countResult.rows[0]?.count ?? 0);
    const queryValues = [...values];
    const baseSql = `SELECT id, thread_id AS "threadId", content, role, type, "createdAt", "resourceId"
       FROM ${MASTRA_MEMORY_TABLES.messages}
       ${whereSql}
       ORDER BY ${orderBySql(args.orderBy, 'createdAt', 'DESC')}`;
    const result = await this.database.query<MessageRow>(
      appendLimit(baseSql, queryValues, page, perPage),
      queryValues
    );
    const messages = result.rows.map(messageFromRow);
    if (args.include?.length) {
      const messageIds = new Set(messages.map((message) => message.id));
      await this.appendIncludedMessages(messages, messageIds, args.include, args);
      const messageOrder = normalizeMessageOrder(args.orderBy);
      messages.sort((left, right) => compareMessagesByOrder(left, right, messageOrder));
    }
    const pageInfo = pagination(total, page, perPage);
    const hasMore = args.include?.length
      ? new Set(
          messages
            .filter((message) => messageMatchesListFilters(message, args))
            .map((message) => message.id)
        ).size < total
      : pageInfo.hasMore;
    return {
      messages,
      ...pageInfo,
      hasMore,
    };
  }

  private async appendIncludedMessages(
    messages: MastraDBMessage[],
    messageIds: Set<string>,
    includeItems: MessageIncludeItem[],
    args: MessageListArgs
  ): Promise<void> {
    for (const includeItem of includeItems) {
      if (!includeItem.id.trim()) {
        throw new Error('include.id must be a non-empty string');
      }

      const targetRow = await this.findMessageRowById(includeItem.id);
      if (!targetRow) {
        continue;
      }
      if (!messageMatchesListScope(targetRow, args)) {
        continue;
      }

      this.appendMessageIfMissing(messages, messageIds, targetRow);

      const withPreviousMessages = normalizeIncludeWindowCount(
        includeItem.withPreviousMessages,
        'include.withPreviousMessages'
      );
      const withNextMessages = normalizeIncludeWindowCount(
        includeItem.withNextMessages,
        'include.withNextMessages'
      );
      if (withPreviousMessages === 0 && withNextMessages === 0) {
        continue;
      }

      const threadId = normalizeIncludeThreadId(includeItem.threadId, targetRow.threadId);
      if (threadId !== targetRow.threadId) {
        continue;
      }

      const previousRows = await this.listAdjacentThreadMessageRows(
        targetRow,
        'previous',
        withPreviousMessages
      );
      for (const row of previousRows) {
        this.appendMessageIfInListScope(messages, messageIds, row, args);
      }

      const nextRows = await this.listAdjacentThreadMessageRows(
        targetRow,
        'next',
        withNextMessages
      );
      for (const row of nextRows) {
        this.appendMessageIfInListScope(messages, messageIds, row, args);
      }
    }
  }

  private appendMessageIfInListScope(
    messages: MastraDBMessage[],
    messageIds: Set<string>,
    row: MessageRow,
    args: MessageListArgs
  ): void {
    if (!messageMatchesListScope(row, args)) {
      return;
    }
    this.appendMessageIfMissing(messages, messageIds, row);
  }

  private appendMessageIfMissing(
    messages: MastraDBMessage[],
    messageIds: Set<string>,
    row: MessageRow
  ): void {
    if (messageIds.has(row.id)) {
      return;
    }
    messages.push(messageFromRow(row));
    messageIds.add(row.id);
  }

  /**
   * Semantic recall's include TARGETS land here. A tombstoned target resolves
   * to null, and `appendIncludedMessages` then skips the whole include item —
   * so a hidden message contributes neither itself nor a neighbour window.
   */
  private async findMessageRowById(id: string): Promise<MessageRow | null> {
    const notTombstonedSql = (await this.hasTombstoneSidecar())
      ? `AND NOT ${tombstonedPredicateSql(`${MASTRA_MEMORY_TABLES.messages}.id`)}`
      : '';
    const result = await this.database.query<MessageRow>(
      `SELECT id, thread_id AS "threadId", content, role, type, "createdAt", "resourceId"
       FROM ${MASTRA_MEMORY_TABLES.messages}
       WHERE id = $1
       ${notTombstonedSql}`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  private async listAdjacentThreadMessageRows(
    targetRow: MessageRow,
    direction: 'previous' | 'next',
    limit: number
  ): Promise<MessageRow[]> {
    if (limit === 0) {
      return [];
    }
    const isPrevious = direction === 'previous';
    const comparisonOperator = isPrevious ? '<' : '>';
    const sortDirection = isPrevious ? 'DESC' : 'ASC';
    // Soft-rewind tombstones TRUNCATE this window; they are deliberately NOT
    // filtered out of the WHERE clause (BST-1115).
    //
    // `withPreviousMessages: 2` means "the two messages immediately before the
    // hit". Excluding hidden rows in the WHERE clause would silently redefine
    // that as "the two nearest VISIBLE messages", so the LIMIT would reach
    // further back than the caller asked for, splice two turns that were never
    // adjacent into one window, and inflate the token budget the recall config
    // was tuned against. Flagging in place and cutting at the first hidden row
    // returns less context instead of fabricated context.
    const hiddenSql = (await this.hasTombstoneSidecar())
      ? tombstonedPredicateSql(`${MASTRA_MEMORY_TABLES.messages}.id`)
      : 'FALSE';
    const result = await this.database.query<AdjacentMessageRow>(
      `SELECT id, thread_id AS "threadId", content, role, type, "createdAt", "resourceId",
              ${hiddenSql} AS hidden
       FROM ${MASTRA_MEMORY_TABLES.messages}
       WHERE thread_id = $1
         AND (
           "createdAt" ${comparisonOperator} $2
           OR ("createdAt" = $2 AND id ${comparisonOperator} $3)
         )
       ORDER BY "createdAt" ${sortDirection}, id ${sortDirection}
       LIMIT $4`,
      [targetRow.threadId, toDate(targetRow.createdAt), targetRow.id, limit]
    );
    // Rows arrive nearest-target-first in BOTH directions, so cutting at the
    // first hidden row walks outward from the target and stops at the hole.
    const firstHiddenIndex = result.rows.findIndex((row) => row.hidden);
    const visibleRows =
      firstHiddenIndex === -1 ? result.rows : result.rows.slice(0, firstHiddenIndex);
    return isPrevious ? [...visibleRows].reverse() : visibleRows;
  }

  private async findObservationalMemoryRecordById(id: string): Promise<ObservationalMemoryRecord> {
    const result = await this.database.query<ObservationalMemoryRow>(
      `SELECT *
       FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
       WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Observational memory record not found: ${id}`);
    }
    return observationalMemoryFromRow(row);
  }

  private async saveObservationalMemoryRecord(record: ObservationalMemoryRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO ${MASTRA_MEMORY_TABLES.observationalMemory}
        (id, "lookupKey", scope, "resourceId", "threadId", "activeObservations",
         "activeObservationsPendingUpdate", "originType", config, "generationCount",
         "lastObservedAt", "lastReflectionAt", "pendingMessageTokens",
         "totalTokensObserved", "observationTokenCount", "isObserving", "isReflecting",
         "observedMessageIds", "observedTimezone", "bufferedObservations",
         "bufferedObservationTokens", "bufferedMessageIds", "bufferedReflection",
         "bufferedReflectionTokens", "bufferedReflectionInputTokens",
         "reflectedObservationLineCount", "bufferedObservationChunks",
         "isBufferingObservation", "isBufferingReflection", "lastBufferedAtTokens",
         "lastBufferedAtTime", metadata, "createdAt", "updatedAt")
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16,
         $17, $18::jsonb, $19, $20, $21, $22::jsonb, $23, $24, $25, $26, $27::jsonb,
         $28, $29, $30, $31, $32::jsonb, $33, $34)
       ON CONFLICT (id) DO UPDATE SET
        "lookupKey" = EXCLUDED."lookupKey",
        scope = EXCLUDED.scope,
        "resourceId" = EXCLUDED."resourceId",
        "threadId" = EXCLUDED."threadId",
        "activeObservations" = EXCLUDED."activeObservations",
        "activeObservationsPendingUpdate" = EXCLUDED."activeObservationsPendingUpdate",
        "originType" = EXCLUDED."originType",
        config = EXCLUDED.config,
        "generationCount" = EXCLUDED."generationCount",
        "lastObservedAt" = EXCLUDED."lastObservedAt",
        "lastReflectionAt" = EXCLUDED."lastReflectionAt",
        "pendingMessageTokens" = EXCLUDED."pendingMessageTokens",
        "totalTokensObserved" = EXCLUDED."totalTokensObserved",
        "observationTokenCount" = EXCLUDED."observationTokenCount",
        "isObserving" = EXCLUDED."isObserving",
        "isReflecting" = EXCLUDED."isReflecting",
        "observedMessageIds" = EXCLUDED."observedMessageIds",
        "observedTimezone" = EXCLUDED."observedTimezone",
        "bufferedObservations" = EXCLUDED."bufferedObservations",
        "bufferedObservationTokens" = EXCLUDED."bufferedObservationTokens",
        "bufferedMessageIds" = EXCLUDED."bufferedMessageIds",
        "bufferedReflection" = EXCLUDED."bufferedReflection",
        "bufferedReflectionTokens" = EXCLUDED."bufferedReflectionTokens",
        "bufferedReflectionInputTokens" = EXCLUDED."bufferedReflectionInputTokens",
        "reflectedObservationLineCount" = EXCLUDED."reflectedObservationLineCount",
        "bufferedObservationChunks" = EXCLUDED."bufferedObservationChunks",
        "isBufferingObservation" = EXCLUDED."isBufferingObservation",
        "isBufferingReflection" = EXCLUDED."isBufferingReflection",
        "lastBufferedAtTokens" = EXCLUDED."lastBufferedAtTokens",
        "lastBufferedAtTime" = EXCLUDED."lastBufferedAtTime",
        metadata = EXCLUDED.metadata,
        "createdAt" = EXCLUDED."createdAt",
        "updatedAt" = EXCLUDED."updatedAt"`,
      [
        record.id,
        observationalMemoryKey(record.threadId, record.resourceId),
        record.scope,
        record.resourceId,
        record.threadId,
        record.activeObservations,
        null,
        record.originType,
        JSON.stringify(record.config),
        record.generationCount,
        record.lastObservedAt ?? null,
        null,
        record.pendingMessageTokens,
        record.totalTokensObserved,
        record.observationTokenCount,
        record.isObserving,
        record.isReflecting,
        record.observedMessageIds ? JSON.stringify(record.observedMessageIds) : null,
        record.observedTimezone ?? null,
        record.bufferedObservations ?? null,
        record.bufferedObservationTokens ?? null,
        record.bufferedMessageIds ? JSON.stringify(record.bufferedMessageIds) : null,
        record.bufferedReflection ?? null,
        record.bufferedReflectionTokens ?? null,
        record.bufferedReflectionInputTokens ?? null,
        record.reflectedObservationLineCount ?? null,
        record.bufferedObservationChunks ? JSON.stringify(record.bufferedObservationChunks) : null,
        record.isBufferingObservation,
        record.isBufferingReflection,
        record.lastBufferedAtTokens,
        record.lastBufferedAtTime,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.createdAt,
        record.updatedAt,
      ]
    );
  }

  private async updateObservationalMemoryColumns(
    id: string,
    updates: [string, PgliteQueryValue][]
  ): Promise<void> {
    const now = new Date();
    const values: PgliteQueryValue[] = [id];
    const setClauses = updates.map(([column, value]) => {
      values.push(value);
      return `${column} = $${values.length}`;
    });
    values.push(now);
    const updatedAtParam = values.length;
    const result = await this.database.query<{ id: string }>(
      `UPDATE ${MASTRA_MEMORY_TABLES.observationalMemory}
       SET ${setClauses.join(', ')}, "updatedAt" = $${updatedAtParam}
       WHERE id = $1
       RETURNING id`,
      values
    );
    if (!result.rows[0]) {
      throw new Error(`Observational memory record not found: ${id}`);
    }
  }

  private emitRunEvent(
    kind: AssistantRunEventKind,
    status: AssistantRunEventStatus,
    label: string,
    metadata?: AssistantRunEventMetadata,
    detail?: string
  ): void {
    emitAssistantRunEventSafely({
      event: {
        kind,
        label,
        status,
        ...(metadata ? { metadata } : {}),
        ...(detail ? { detail } : {}),
      },
      eventSink: this.eventSink,
      onError: (error, event) => {
        logger.error('Assistant run event sink failed during memory operation', {
          code: 'assistant_run_event_sink_failed',
          error: getErrorMessage(error),
          kind: event.kind,
          runId: event.runId,
        });
      },
      runId: this.runId,
    });
  }
}
