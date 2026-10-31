import { rm } from 'node:fs/promises';
import path from 'node:path';
import { runWithTimeout } from '@brainstrike/effect-kit';
import { CHILD_SIGNAL_GRACE_MS, canonicalRoot } from '@brainstrike/state-store';
import { Schema } from 'effect';
import {
  commitResultSchema,
  coverageRequestSchema,
  coverageSchema,
  decoder,
  fileBindingsSchema,
  IndexerError,
  identitySchema,
  infoSchema,
  manifestRequestSchema,
  manifestResultSchema,
  type optionsSchema,
  planSchema,
  STATE_CATCH_UP_STEP_EVENTS,
  scopedCommitSchema,
  scopedCoverageBatchRequestSchema,
  scopedCoverageRequestSchema,
  scopedCoverageSchema,
  scopedFileChunkBoundsRequestSchema,
  scopedFileChunkBoundsSchema,
  scopedFilePageRequestSchema,
  scopedFilePageSchema,
  scopedManifestRequestSchema,
  scopedManifestResultSchema,
  scopedPlanSchema,
  scopedPrepareSchema,
  scopedRemoveSchema,
  scopedSearchResultSchema,
  scopedSearchSchema,
  scopedTextCommitSchema,
  searchResultSchema,
  searchSchema,
  snapshotSchema,
  stateCatchUpStepSchema,
  stateCountsSchema,
  stateEventIdentitySchema,
  stateGcSchema,
  stateHealthSchema,
  stateMatchSchema,
  stateMessageHitSchema,
  stateMessagePlanSchema,
  stateMessagePrepareSchema,
  stateMessagePurgeSchema,
  stateMessageQuerySchema,
  stateMessageUpsertResultSchema,
  stateMessageUpsertSchema,
  stateObservationHitSchema,
  stateObservationPlanSchema,
  stateObservationPrepareSchema,
  stateObservationPurgeSchema,
  stateObservationQuerySchema,
  stateObservationUpsertSchema,
  stateSearchHitSchema,
  stateSearchSchema,
  stateStatsSchema,
  stateThreadsSchema,
  textCommitSchema,
} from './contracts.ts';
import { type CoverageAuthorityPort, coverageAuthoritySchema } from './coverage-authority.ts';
import type {
  IndexerPort,
  PurgeIndexerPort,
  ScopedIndexerPort,
  StateIndexerPort,
  StateMessageVectorPort,
  StateObservationVectorPort,
} from './index.ts';
import { decodeIndexerOptions } from './options.ts';
import { RpcClient } from './rpc-client.ts';
import { validateStateModule } from './state-projection.ts';

const duration = Schema.Finite.check(Schema.isGreaterThan(0));
/**
 * The connection's only clock: its close window (lifecycle R5(b), ADR-0030). A request and the
 * startup have no deadline: a slow reply is load, never death, so the process is retired only on
 * its exit or a transport or protocol fault (R2).
 */
const deadlinesSchema = Schema.Struct({
  /**
   * From the cooperative `close` request to the process's exit, not to its ACK. A process that
   * has not exited by then is killed, and its exit is still joined.
   */
  closeMs: duration,
});
export type IndexerDeadlines = typeof deadlinesSchema.Type;
/**
 * R3: a startup with no ready report after this long is reported stalled, once. It never fails
 * or retires the process; startup fails only on a startup error, a fault or the exit.
 */
export const INDEXER_STARTUP_STALL_WARN_MS = 10_000;
/**
 * A stage that is taking longer than its window: `startup` (R3, nothing happens), `close` (the
 * close window ran out and the process is killed) or `exit` (a killed process has not exited
 * after `CHILD_SIGNAL_GRACE_MS`; its exit is still joined). The host logs it; none is a failure.
 */
export type IndexerStallStage = 'startup' | 'close' | 'exit';
export interface IndexerTransport {
  /** A request: Windows refuses to terminate a process that is already exiting (ADR-0030). */
  kill(): boolean;
  onError(listener: (error: unknown) => void): () => void;
  /** The OS exit, with its code (`null` when a signal ended it). */
  onExit(listener: (code: number | null) => void): () => void;
  /** The host's log of a refused or failed kill request. The exit is still joined. */
  onKillRefused?(cause: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  /** The host's log of a slow stage (`IndexerStallStage`), at the window it outlived. */
  onStall?(stage: IndexerStallStage, elapsedMs: number): void;
  send(message: object): void;
}
/** The desktop's options: the portable rules, then its file-path rules for the database and the state root. */
export function validateIndexerOptions(input: unknown): typeof optionsSchema.Type {
  const options = decodeIndexerOptions(input);
  if (!path.isAbsolute(options.dbPath) || options.dbPath === ':memory:') {
    throw new TypeError('Indexer requires an absolute persistent database file path.');
  }
  if (options.stateProjection) {
    validateStateModule(options.stateProjection.module);
  }
  if (options.stateRoot !== undefined) {
    if (
      !path.isAbsolute(options.stateRoot) ||
      canonicalRoot(options.stateRoot) !== options.stateRoot
    ) {
      throw new TypeError(
        'State index acquisition requires its trusted canonical absolute truth root.'
      );
    }
    if (path.resolve(options.dbPath) === path.join(options.stateRoot, 'state.db')) {
      throw new TypeError('Derived index cannot use the authoritative state database path.');
    }
  }
  return options;
}
export function validateIndexerDeadlines(input: unknown): IndexerDeadlines {
  return decoder(deadlinesSchema)(input);
}
export interface IndexerConnection {
  close(): Promise<void>;
  destroy(): Promise<void>;
  readonly exited: boolean;
  readonly ready: Promise<
    IndexerPort &
      PurgeIndexerPort &
      ScopedIndexerPort &
      StateIndexerPort &
      StateMessageVectorPort &
      StateObservationVectorPort &
      CoverageAuthorityPort
  >;
}
export function createIndexerConnection(
  input: unknown,
  deadlineInput: unknown,
  transport: IndexerTransport
): IndexerConnection {
  const options = validateIndexerOptions(input);
  const deadlines = validateIndexerDeadlines(deadlineInput);
  let exited = false;
  let exitCode: number | null | undefined;
  let closing = false;
  const { promise: exit, resolve: resolveExit } = Promise.withResolvers<void>();
  let retirement: Promise<void> | undefined;
  /** Whether the process exits within `ms`; the exit itself stays joinable either way. */
  const exitsWithin = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const window = setTimeout(() => resolve(false), ms);
      void exit.then(() => {
        clearTimeout(window);
        resolve(true);
      });
    });
  /**
   * R5(b), ADR-0030: one kill request, then the exit, joined for as long as it takes. A refused
   * kill is not a fault (Windows refuses an exiting process); only the exit ends the process.
   */
  const retire = (): Promise<void> => {
    if (exited) {
      return Promise.resolve();
    }
    retirement ??= (async () => {
      try {
        if (!transport.kill()) {
          transport.onKillRefused?.(
            new IndexerError('indexer-kill-refused', 'Indexer termination was refused.')
          );
        }
      } catch (cause) {
        transport.onKillRefused?.(cause);
      }
      if (!(await exitsWithin(CHILD_SIGNAL_GRACE_MS))) {
        transport.onStall?.('exit', CHILD_SIGNAL_GRACE_MS);
        await exit;
      }
    })();
    return retirement;
  };
  const client = new RpcClient(
    (message) => transport.send(message),
    () => {
      void retire();
    }
  );
  const disposers = [
    transport.onMessage((message) => client.receive(message)),
    transport.onError((error) => client.fail(error)),
    transport.onExit((code) => {
      exited = true;
      exitCode = code;
      resolveExit();
      client.fail(new IndexerError('indexer-exited', 'Indexer process exited.'));
      for (const dispose of disposers) {
        dispose();
      }
    }),
  ];
  const failAndJoin = async (error: unknown): Promise<never> => {
    client.fail(error);
    await retire();
    throw error;
  };
  const call = async <T>(
    op: string,
    payload: unknown,
    decode: (value: unknown) => T
  ): Promise<T> => {
    if (closing) {
      throw new IndexerError('indexer-closed', 'Indexer is closing.');
    }
    try {
      return await client.call(op, payload, decode);
    } catch (error) {
      // A remote refusal leaves the process serving. A transport or protocol failure, or
      // the process's exit, retires it; the operation is never retried.
      if (error instanceof IndexerError) {
        try {
          client.assertActive();
        } catch {
          return failAndJoin(error);
        }
        throw error;
      }
      return failAndJoin(error);
    }
  };
  /**
   * The cooperative `close` request, bounded by the close window. Outliving it is the R5(b)
   * escalation (`escalated`), not a failure; any other failure is returned as `refused`. Either
   * way the client fails with it, which retires the process: a kill, then the joined exit.
   */
  const requestClose = async (): Promise<{ escalated: boolean; refused?: unknown }> => {
    try {
      client.assertActive();
    } catch {
      // A failed client takes no request; its failure was already its callers'. Retire it.
      return { escalated: false };
    }
    let escalated = false;
    try {
      await runWithTimeout(() => client.call('close', null, decoder(Schema.Boolean)), {
        onTimeout: () => {
          escalated = true;
          return new IndexerError(
            'indexer-close-escalated',
            'Indexer close outlived its cooperative window; the process was killed.'
          );
        },
        timeoutMs: deadlines.closeMs,
      });
      return { escalated: false };
    } catch (error) {
      client.fail(error);
      return escalated ? { escalated } : { escalated, refused: error };
    }
  };
  let closeAttempt: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing = true;
    if (exited) {
      return Promise.resolve();
    }
    closeAttempt ??= (async () => {
      const requested = Date.now();
      const { escalated, refused } = await requestClose();
      // The window runs from the request to the exit, not to the ACK: after its ACK the process
      // exits on its own, and one that has not by the end of the window is killed.
      let outlived = escalated;
      if (!(exited || retirement)) {
        const remainingMs = deadlines.closeMs - (Date.now() - requested);
        outlived = !(remainingMs > 0 && (await exitsWithin(remainingMs)));
      }
      if (outlived) {
        transport.onStall?.('close', deadlines.closeMs);
      }
      await retire();
      // The exit is the close's completion (ADR-0030); its ACK may never arrive, because
      // the process exits right after sending it. A clean exit is a close that succeeded.
      if (
        refused !== undefined &&
        !(exitCode === 0 && refused instanceof IndexerError && refused.code === 'indexer-exited')
      ) {
        throw new AggregateError([refused], 'Indexer close failed; process exit was joined.');
      }
    })();
    return closeAttempt;
  };
  // Catch-up is a series of bounded steps, so no request carries a whole backlog; a read
  // that catches up first then finds its threads current.
  const catchUp = async (threads: readonly string[]): Promise<void> => {
    const step = decoder(stateCatchUpStepSchema)({
      maxEvents: STATE_CATCH_UP_STEP_EVENTS,
      threads,
    });
    let current = false;
    while (!current) {
      current = await call('state-catch-up-step', step, decoder(Schema.Boolean));
    }
  };
  // A read catches its threads up first. The worker projects at most one more step
  // inside the read and refuses past it as behind (an append raced the last step),
  // so the read is stepped again rather than carrying that backlog.
  const read = async <T>(threads: readonly string[], request: () => Promise<T>): Promise<T> => {
    for (;;) {
      await catchUp(threads);
      try {
        return await request();
      } catch (error) {
        if (!(error instanceof IndexerError && error.code === 'state-behind')) {
          throw error;
        }
      }
    }
  };
  const port: IndexerPort &
    PurgeIndexerPort &
    ScopedIndexerPort &
    StateIndexerPort &
    StateMessageVectorPort &
    StateObservationVectorPort &
    CoverageAuthorityPort = {
    catchUpState: (threads) => catchUp(decoder(stateThreadsSchema)(threads)),
    catchUpStateStep: (threads, maxEvents) =>
      call(
        'state-catch-up-step',
        decoder(stateCatchUpStepSchema)({ maxEvents, threads }),
        decoder(Schema.Boolean)
      ),
    close,
    commitScopedFile: async (request) =>
      call('commit-scoped-file', decoder(scopedCommitSchema)(request), decoder(commitResultSchema)),
    commitScopedTextFile: async (request) =>
      call(
        'commit-scoped-text-file',
        decoder(scopedTextCommitSchema)(request),
        decoder(commitResultSchema)
      ),
    commitTextFile: async (commit) =>
      call('commit-text-file', decoder(textCommitSchema)(commit), decoder(commitResultSchema)),
    coverage: async (request) =>
      call('coverage', decoder(coverageRequestSchema)(request), decoder(coverageSchema)),
    coverageAuthority: () => call('coverage-authority', null, decoder(coverageAuthoritySchema)),
    coverageBatch: async (requests) =>
      call(
        'coverage-batch',
        decoder(scopedCoverageBatchRequestSchema)(requests),
        decoder(Schema.Array(scopedCoverageSchema))
      ),
    coverageScope: async (request) =>
      call(
        'coverage-scope',
        decoder(scopedCoverageRequestSchema)(request),
        decoder(scopedCoverageSchema)
      ),
    destroy: async () => {
      await close();
      for (const file of [options.dbPath, `${options.dbPath}-wal`, `${options.dbPath}-shm`]) {
        await rm(file, { force: true });
      }
    },
    dropStateThread: (threadId) =>
      call(
        'state-drop-thread',
        decoder(Schema.NonEmptyString)(threadId),
        decoder(Schema.Array(Schema.String))
      ),
    info: () => call('info', null, decoder(infoSchema)),
    matchState: (threadId, query) =>
      call(
        'state-match',
        decoder(stateMatchSchema)({ query, threadId }),
        decoder(Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))))
      ),
    prepareFile: async (snapshot) =>
      call('prepare-file', decoder(snapshotSchema)(snapshot), decoder(planSchema)),
    prepareScopedFile: async (request) =>
      call('prepare-scoped-file', decoder(scopedPrepareSchema)(request), decoder(scopedPlanSchema)),
    prepareStateMessageVectors: async (request) =>
      call(
        'state-message-prepare',
        decoder(stateMessagePrepareSchema)(request),
        decoder(stateMessagePlanSchema)
      ),
    prepareStateObservationVectors: async (request) =>
      call(
        'state-observation-prepare',
        decoder(stateObservationPrepareSchema)(request),
        decoder(stateObservationPlanSchema)
      ),
    purgeFile: async (identity) =>
      call('purge-file', decoder(identitySchema)(identity), decoder(Schema.Boolean)),
    purgeStateMessageVectors: async (request) =>
      call(
        'state-message-purge',
        decoder(stateMessagePurgeSchema)(request),
        decoder(Schema.Boolean)
      ),
    purgeStateObservationVectors: async (request) =>
      call(
        'state-observation-purge',
        decoder(stateObservationPurgeSchema)(request),
        decoder(Schema.Boolean)
      ),
    queryStateMessageVectors: async (request) =>
      call(
        'state-message-query',
        decoder(stateMessageQuerySchema)(request),
        decoder(Schema.Array(stateMessageHitSchema))
      ),
    queryStateObservationVectors: async (request) =>
      call(
        'state-observation-query',
        decoder(stateObservationQuerySchema)(request),
        decoder(Schema.Array(stateObservationHitSchema))
      ),
    readScopedFileChunkBounds: async (request) =>
      call(
        'read-scoped-file-chunk-bounds',
        decoder(scopedFileChunkBoundsRequestSchema)(request),
        decoder(scopedFileChunkBoundsSchema)
      ),
    readScopedFilePage: async (request) =>
      call(
        'read-scoped-file-page',
        decoder(scopedFilePageRequestSchema)(request),
        decoder(scopedFilePageSchema)
      ),
    rebuildState: async (threadId) => {
      await call(
        'state-rebuild',
        decoder(Schema.NonEmptyString)(threadId),
        decoder(Schema.Boolean)
      );
      await catchUp([threadId]);
    },
    reindexState: async (threadId, seq) => {
      await call(
        'state-reindex',
        decoder(stateEventIdentitySchema)({ seq, threadId }),
        decoder(Schema.Boolean)
      );
    },
    removeFile: async (identity) =>
      call('remove-file', decoder(identitySchema)(identity), decoder(Schema.Boolean)),
    removeScopedFile: async (request) =>
      call('remove-scoped-file', decoder(scopedRemoveSchema)(request), decoder(Schema.Boolean)),
    replaceFileBindings: async (bindings) => {
      await call(
        'replace-file-bindings',
        decoder(fileBindingsSchema)(bindings),
        decoder(Schema.Boolean)
      );
    },
    search: async (request) =>
      call('search', decoder(searchSchema)(request), decoder(searchResultSchema)),
    searchScopes: async (request) =>
      call(
        'search-scopes',
        decoder(scopedSearchSchema)(request),
        decoder(scopedSearchResultSchema)
      ),
    searchState: async (input) => {
      const request = decoder(stateSearchSchema)(input);
      return read(request.threadIds, () =>
        call('state-search', request, decoder(Schema.Array(stateSearchHitSchema)))
      );
    },
    stateBlobCounts: async (threads, hashes) => {
      const request = decoder(stateGcSchema)({ hashes, threads });
      return read(request.threads, () =>
        call('state-gc-check', request, decoder(stateCountsSchema))
      );
    },
    stateHealth: () => call('state-health', null, decoder(stateHealthSchema)),
    stateStats: (threadId) =>
      call('state-stats', decoder(Schema.NonEmptyString)(threadId), decoder(stateStatsSchema)),
    upsertStateMessageVectors: async (request) =>
      call(
        'state-message-upsert',
        decoder(stateMessageUpsertSchema)(request),
        decoder(stateMessageUpsertResultSchema)
      ),
    upsertStateObservationVectors: async (request) =>
      call(
        'state-observation-upsert',
        decoder(stateObservationUpsertSchema)(request),
        decoder(Schema.Array(Schema.String))
      ),
    verifyManifest: async (request) =>
      call(
        'verify-manifest',
        decoder(manifestRequestSchema)(request),
        decoder(manifestResultSchema)
      ),
    verifyScopedManifest: async (request) =>
      call(
        'verify-scoped-manifest',
        decoder(scopedManifestRequestSchema)(request),
        decoder(scopedManifestResultSchema)
      ),
  };
  const ready = (async () => {
    const stall =
      transport.onStall &&
      setTimeout(
        () => transport.onStall?.('startup', INDEXER_STARTUP_STALL_WARN_MS),
        INDEXER_STARTUP_STALL_WARN_MS
      );
    stall?.unref?.();
    try {
      transport.send(options);
      decoder(infoSchema)(await client.ready);
      return port;
    } catch (error) {
      return failAndJoin(error);
    } finally {
      clearTimeout(stall);
    }
  })();
  return {
    close,
    destroy: port.destroy,
    get exited() {
      return exited;
    },
    ready,
  };
}
