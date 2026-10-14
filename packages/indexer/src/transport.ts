import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { runWithTimeout } from '@brainstrike/effect-kit';
import { Schema } from 'effect';
import {
  commitResultSchema,
  commitSchema,
  coverageRequestSchema,
  coverageSchema,
  decoder,
  fileBindingsSchema,
  IndexerError,
  identitySchema,
  identityStateSchema,
  infoSchema,
  manifestRequestSchema,
  manifestResultSchema,
  optionsSchema,
  planSchema,
  profileSchema,
  scopedCommitSchema,
  scopedCoverageBatchRequestSchema,
  scopedCoverageRequestSchema,
  scopedCoverageSchema,
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
  stateSearchCoverageResultSchema,
  stateSearchCoverageSchema,
  stateSearchHitSchema,
  stateSearchPendingRowSchema,
  stateSearchPendingSchema,
  stateSearchSchema,
  stateSearchSimilarHitSchema,
  stateSearchSimilarSchema,
  stateSearchVectorBatchSchema,
  stateSearchVectorsResultSchema,
  stateStatsSchema,
  stateThreadsSchema,
  textCommitSchema,
} from './contracts.js';
import { type CoverageAuthorityPort, coverageAuthoritySchema } from './coverage-authority.js';
import type {
  IndexerPort,
  PurgeIndexerPort,
  ScopedIndexerPort,
  StateIndexerPort,
  StateMessageVectorPort,
  StateObservationVectorPort,
} from './index.js';
import { promptVectorReplySchema, promptVectorRequestSchema } from './prompt-vector-contract.js';
import { RpcClient } from './rpc-client.js';
import { validateStateModule } from './state-projection.js';

const duration = Schema.Finite.check(Schema.isGreaterThan(0));
const deadlinesSchema = Schema.Struct({
  closeMs: duration,
  exitMs: duration,
  requestMs: duration,
  startupMs: duration,
});
export type IndexerDeadlines = typeof deadlinesSchema.Type;
export interface IndexerTransport {
  kill(): boolean;
  onError(listener: (error: unknown) => void): () => void;
  onExit(listener: () => void): () => void;
  onMessage(listener: (message: unknown) => void): () => void;
  send(message: object): void;
}
export class IndexerLifecycleError extends AggregateError {
  constructor(
    errors: unknown[],
    readonly close: () => Promise<void>
  ) {
    super(
      errors,
      'Indexer failed and process cleanup is incomplete; retry close before replacing its owner.'
    );
    this.name = 'IndexerLifecycleError';
  }
}
export function validateIndexerOptions(input: unknown): typeof optionsSchema.Type {
  const options = decoder(optionsSchema)(input);
  if (!path.isAbsolute(options.dbPath) || options.dbPath === ':memory:') {
    throw new TypeError('Indexer requires an absolute persistent database file path.');
  }
  if ((options.stateRoot === undefined) !== (options.stateProjection === undefined)) {
    throw new TypeError('State root and producer schema must be acquired together.');
  }
  if (options.stateProjection) {
    validateStateModule(options.stateProjection.module);
  }
  if (options.stateRoot !== undefined) {
    if (
      !path.isAbsolute(options.stateRoot) ||
      realpathSync(options.stateRoot) !== options.stateRoot
    ) {
      throw new TypeError(
        'State index acquisition requires its trusted canonical absolute truth root.'
      );
    }
    if (path.resolve(options.dbPath) === path.join(options.stateRoot, 'state.db')) {
      throw new TypeError('Derived index cannot use the authoritative state database path.');
    }
  }
  if (options.stateResources !== undefined) {
    if (options.stateRoot === undefined) {
      throw new TypeError('Message resource grants require acquired State truth.');
    }
    const resources = new Set<string>();
    for (const grant of options.stateResources) {
      if (!options.rootIds.includes(grant.rootId) || resources.has(grant.resourceId)) {
        throw new TypeError('A Memory resource requires one authorized immutable Root grant.');
      }
      resources.add(grant.resourceId);
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
  let closing = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let retirement: Promise<void> | undefined;
  let killRequested = false;
  let cleanupFailure: unknown;
  const bounded = <T>(work: Promise<T>, timeoutMs: number, stage: string): Promise<T> =>
    runWithTimeout(() => work, {
      onTimeout: () =>
        new IndexerError(
          `indexer-${stage}-timeout`,
          `Indexer ${stage} exceeded its caller-provided deadline.`
        ),
      timeoutMs,
    });
  const retire = (): Promise<void> => {
    if (exited) {
      return Promise.resolve();
    }
    retirement ??= (async () => {
      const failures: unknown[] = [];
      try {
        if (!killRequested) {
          if (!transport.kill()) {
            throw new IndexerError(
              'indexer-kill-failed',
              'Indexer termination was refused; its process owner remains retained.'
            );
          }
          killRequested = true;
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        await bounded(exit, deadlines.exitMs, 'exit');
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Indexer termination did not complete cleanly.');
      }
    })();
    // Retain the cleanup outcome, including failed kill/exit joins, for close and
    // startup/request callers. The live transport is never discarded on failure.
    retirement.catch((error: unknown) => {
      cleanupFailure = error;
    });
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
    transport.onExit(() => {
      exited = true;
      resolveExit();
      client.fail(new IndexerError('indexer-exited', 'Indexer process exited.'));
      for (const dispose of disposers) {
        dispose();
      }
    }),
  ];
  const failAndJoin = async (error: unknown): Promise<never> => {
    client.fail(error);
    try {
      await retire();
    } catch (failure) {
      throw new IndexerLifecycleError([error, failure], close);
    }
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
      return await bounded(client.call(op, payload, decode), deadlines.requestMs, 'request');
    } catch (error) {
      // Expected remote validation failures leave the host usable. A deadline
      // or transport/protocol failure retires it; never retry the operation.
      if (error instanceof IndexerError && !error.code.endsWith('-timeout')) {
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
  let closeAttempt: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing = true;
    if (exited) {
      return Promise.resolve();
    }
    closeAttempt ??= (async () => {
      if (cleanupFailure !== undefined) {
        retirement = undefined;
        cleanupFailure = undefined;
      }
      const failures: unknown[] = [];
      try {
        await bounded(
          client.call('close', null, decoder(Schema.Boolean)),
          deadlines.closeMs,
          'close'
        );
      } catch (error) {
        failures.push(error);
        client.fail(error);
      }
      try {
        await bounded(exit, deadlines.exitMs, 'exit');
      } catch (error) {
        failures.push(error);
        try {
          await retire();
        } catch (failure) {
          failures.push(failure);
        }
      }
      if (failures.length > 0) {
        if (!exited) {
          throw new IndexerLifecycleError(failures, close);
        }
        throw new AggregateError(failures, 'Indexer close failed; process exit was joined.');
      }
    })().finally(() => {
      if (!exited) {
        closeAttempt = undefined;
      }
    });
    return closeAttempt;
  };
  const port: IndexerPort &
    PurgeIndexerPort &
    ScopedIndexerPort &
    StateIndexerPort &
    StateMessageVectorPort &
    StateObservationVectorPort &
    CoverageAuthorityPort = {
    catchUpState: async (threads) => {
      await call('state-catch-up', decoder(stateThreadsSchema)(threads), decoder(Schema.Boolean));
    },
    close,
    commitFile: async (commit) =>
      call('commit-file', decoder(commitSchema)(commit), decoder(commitResultSchema)),
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
    configureVectorProfile: async (profile) =>
      call(
        'configure-vector-profile',
        decoder(profileSchema)(profile),
        decoder(identityStateSchema)
      ),
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
    promptVectors: (request) =>
      call(
        'prompt-vectors',
        decoder(promptVectorRequestSchema)(request),
        decoder(promptVectorReplySchema)
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
    putStateSearchVectors: (request) =>
      call(
        'state-search-vectors',
        decoder(stateSearchVectorBatchSchema)(request),
        decoder(stateSearchVectorsResultSchema)
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
    searchState: (request) =>
      call(
        'state-search',
        decoder(stateSearchSchema)(request),
        decoder(Schema.Array(stateSearchHitSchema))
      ),
    searchStateCoverage: (request) =>
      call(
        'state-search-coverage',
        decoder(stateSearchCoverageSchema)(request),
        decoder(stateSearchCoverageResultSchema)
      ),
    searchStatePending: (request) =>
      call(
        'state-search-pending',
        decoder(stateSearchPendingSchema)(request),
        decoder(Schema.Array(stateSearchPendingRowSchema))
      ),
    searchStateSimilar: (request) =>
      call(
        'state-search-similar',
        decoder(stateSearchSimilarSchema)(request),
        decoder(Schema.Array(stateSearchSimilarHitSchema))
      ),
    stateBlobCounts: (threads, hashes) =>
      call(
        'state-gc-check',
        decoder(stateGcSchema)({ hashes, threads }),
        decoder(stateCountsSchema)
      ),
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
    try {
      transport.send(options);
      decoder(infoSchema)(await bounded(client.ready, deadlines.startupMs, 'startup'));
      return port;
    } catch (error) {
      return failAndJoin(error);
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
