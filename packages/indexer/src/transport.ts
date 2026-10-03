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
  scopedCoverageRequestSchema,
  scopedCoverageSchema,
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
  textCommitSchema,
} from './contracts.js';
import type { IndexerPort, ScopedIndexerPort } from './index.js';
import { RpcClient } from './rpc-client.js';

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
  return options;
}
export function validateIndexerDeadlines(input: unknown): IndexerDeadlines {
  return decoder(deadlinesSchema)(input);
}
export interface IndexerConnection {
  close(): Promise<void>;
  destroy(): Promise<void>;
  readonly exited: boolean;
  readonly ready: Promise<IndexerPort & ScopedIndexerPort>;
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
  const port: IndexerPort & ScopedIndexerPort = {
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
    info: () => call('info', null, decoder(infoSchema)),
    prepareFile: async (snapshot) =>
      call('prepare-file', decoder(snapshotSchema)(snapshot), decoder(planSchema)),
    prepareScopedFile: async (request) =>
      call('prepare-scoped-file', decoder(scopedPrepareSchema)(request), decoder(scopedPlanSchema)),
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
