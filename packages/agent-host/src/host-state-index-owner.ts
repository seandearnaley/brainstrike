import { rm } from 'node:fs/promises';
import { BoundaryFailureError, fault, refusal } from '@brainstrike/assistant-contract';
import type {
  IndexerPort,
  StateIndexerPort,
  StateMessageVectorPort,
  StateObservationVectorPort,
} from '@brainstrike/indexer';
import { type IndexerConnection, IndexerLifecycleError } from '@brainstrike/indexer/transport';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('AgentHostStateIndex');

/** Replacements in a row, none of whose workers served a request, before the owner stops. */
const STATE_INDEX_REPLACEMENTS = 3;

/** Every state port the host hands out; each call reaches the owner's current worker. */
export type HostStateIndexPort = StateIndexerPort &
  StateMessageVectorPort &
  StateObservationVectorPort &
  Pick<IndexerPort, 'destroy'>;

type ConnectedPort = Awaited<IndexerConnection['ready']>;

/**
 * The owner's one worker, as one value. `retired` is the owner's decision (a
 * request the connection retired, a failed start, an observed exit), never read
 * off a physical exit. A retired worker still owns the SQLite writer until a join
 * of its exit succeeds, so nothing starts beside it before then.
 */
type WorkerState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting'; readonly connection: IndexerConnection }
  | { readonly kind: 'live'; readonly connection: IndexerConnection; readonly port: ConnectedPort }
  | { readonly kind: 'retired'; readonly connection: IndexerConnection; readonly cause: unknown }
  /** Nothing owned: the last worker was joined, or failed before it existed. Next is a replacement. */
  | { readonly kind: 'stopped'; readonly cause: unknown };

type Live = Extract<WorkerState, { readonly kind: 'live' }>;

export interface StateIndexOwner {
  close(): Promise<void>;
  /** Start the first worker. Register `close` first: it also stops a worker still starting. */
  open(): Promise<void>;
  readonly port: HostStateIndexPort;
}

const closingError = (): Error => new Error('Host resource owner is closing');

/**
 * The connection retires its worker on a request deadline or a transport or
 * protocol failure. Afterwards the worker has exited, or the connection reports
 * that it could not join the exit. Any other failure is the live worker's answer.
 */
function retires(connection: IndexerConnection, cause: unknown): boolean {
  return connection.exited || cause instanceof IndexerLifecycleError;
}

/** A retired worker, as the host's boundary reports it: the next request restarts it. */
function retiredFailure(cause: unknown): BoundaryFailureError {
  const timeout =
    cause instanceof Error &&
    cause.name === 'IndexerError' &&
    String(Reflect.get(cause, 'code')).endsWith('-timeout');
  return new BoundaryFailureError(
    timeout
      ? fault({
          category: 'timeout',
          code: 'state-index.request-timeout',
          message:
            "The agent host's state index did not answer in time. It restarts on the next request.",
        })
      : fault({
          category: 'availability',
          code: 'state-index.unavailable',
          message: "The agent host's state index stopped. It restarts on the next request.",
        }),
    { cause }
  );
}

/**
 * A startup failure carries the writer's remote error code. Match that code, not
 * a class identity, which differs between the root and transport entries'
 * module instances wherever they load separately.
 */
function isRebuildRequired(cause: unknown): cause is Error {
  return (
    cause instanceof Error &&
    cause.name === 'IndexerError' &&
    Reflect.get(cause, 'code') === 'rebuild-required'
  );
}

/** Ownership ends when the exit is joined; a close that failed after joining it owns nothing. */
async function join(connection: IndexerConnection): Promise<void> {
  try {
    await connection.close();
  } catch (error) {
    if (!connection.exited) {
      throw error;
    }
  }
}

/**
 * The host's one state-index owner: one worker at a time, started by `start`.
 * Every acquisition that does not find a live worker takes the one `advance`
 * path: join the retired worker's exit, then start its replacement. The request
 * that retired a worker is never retried. Replacement stops after
 * `STATE_INDEX_REPLACEMENTS` in a row with no request served, refused from then on.
 */
export function createStateIndexOwner(options: {
  readonly dbPath: string;
  readonly start: () => IndexerConnection;
}): StateIndexOwner {
  let state: WorkerState = { kind: 'idle' };
  let advancing: Promise<Live> | undefined;
  /** Set by the first close, for good: nothing is acquired or started after it. */
  let closed = false;
  /** The close attempt in flight. A failed attempt is cleared, so the next close retries it. */
  let closing: Promise<void> | undefined;
  /** Replacements since a worker last served a request. */
  let replacements = 0;

  const removeFiles = (): Promise<unknown> =>
    Promise.all(
      ['', '-wal', '-shm'].map((suffix) => rm(`${options.dbPath}${suffix}`, { force: true }))
    );
  const retire = (connection: IndexerConnection, cause: unknown): void => {
    // Only the worker that failed retires; a request that outlived its worker changes nothing.
    if ((state.kind === 'live' || state.kind === 'starting') && state.connection === connection) {
      state = { cause, connection, kind: 'retired' };
      logger.warn('Host state index worker retired', {
        code: 'host_state_index_retired',
        error: cause,
      });
    }
  };
  const start = async (): Promise<Live> => {
    for (let rebuilt = false; ; rebuilt = true) {
      if (closed) {
        throw closingError();
      }
      let connection: IndexerConnection;
      try {
        connection = options.start();
      } catch (cause) {
        // No worker exists to own; the next advance replaces it as it would a retired one.
        state = { cause, kind: 'stopped' };
        throw cause;
      }
      state = { connection, kind: 'starting' };
      try {
        const live: Live = { connection, kind: 'live', port: await connection.ready };
        state = live;
        return live;
      } catch (cause) {
        // A failed start is a retired worker: the next advance joins its exit.
        state = { cause, connection, kind: 'retired' };
        if (rebuilt || !isRebuildRequired(cause)) {
          throw cause;
        }
        // The index is derived from the state log, so the host rebuilds a store whose
        // derived identity changed (for example its memory resource grants). Vectors
        // of a superseded identity are not recoverable and are not carried over.
        await join(connection);
        state = { kind: 'idle' };
        logger.warn('Rebuilding the host state index from the state log', {
          code: 'host_state_index_rebuilt',
          reason: cause.message,
        });
        await removeFiles();
      }
    }
  };
  const replace = async (
    previous: Extract<WorkerState, { kind: 'retired' | 'stopped' }>
  ): Promise<Live> => {
    if (replacements >= STATE_INDEX_REPLACEMENTS) {
      // Final, with a remedy: a refusal, so nothing re-opens it automatically.
      throw new BoundaryFailureError(
        refusal({
          category: 'availability',
          code: 'state-index.retired',
          message: `The agent host's state index stopped ${STATE_INDEX_REPLACEMENTS + 1} times in a row and was not restarted again.`,
          remedy: 'Restart BrainStrike.',
        }),
        { cause: previous.cause }
      );
    }
    if (previous.kind === 'retired') {
      try {
        await join(previous.connection);
      } catch (error) {
        // Still owned, and possibly alive: nothing starts beside it.
        throw retiredFailure(error);
      }
    }
    replacements += 1;
    logger.warn('Replacing the host state index after its worker retired', {
      attempt: replacements,
      code: 'host_state_index_replaced',
      error: previous.cause,
      limit: STATE_INDEX_REPLACEMENTS,
    });
    state = { cause: previous.cause, kind: 'stopped' };
    try {
      return await start();
    } catch (cause) {
      throw closed ? cause : retiredFailure(cause);
    }
  };
  // The one path out of `idle`, `retired` and `stopped`. A first start's failure is the host startup's to report.
  const advance = (): Promise<Live> =>
    state.kind === 'retired' || state.kind === 'stopped' ? replace(state) : start();
  const acquire = (): Promise<Live> => {
    if (closed) {
      return Promise.reject(closingError());
    }
    if (state.kind === 'live') {
      if (!state.connection.exited) {
        return Promise.resolve(state);
      }
      retire(state.connection, new Error('Host state index worker exited between requests.'));
    }
    advancing ??= advance().finally(() => {
      advancing = undefined;
    });
    return advancing;
  };
  const use = async <T>(work: (port: ConnectedPort) => Promise<T>): Promise<T> => {
    const live = await acquire();
    try {
      const value = await work(live.port);
      replacements = 0;
      return value;
    } catch (cause) {
      // A live worker's refusal is the request's own answer; only retirement is the owner's.
      if (!retires(live.connection, cause)) {
        throw cause;
      }
      retire(live.connection, cause);
      throw retiredFailure(cause);
    }
  };
  const close = (): Promise<void> => {
    closed = true;
    closing ??= (async () => {
      if (state.kind === 'starting') {
        // Stop a start still pending rather than wait out its startup deadline.
        await join(state.connection);
      }
      await advancing?.catch(() => undefined);
      if ('connection' in state) {
        await join(state.connection);
      }
    })().catch((error: unknown) => {
      // The worker stays owned and the owner fenced; a later close retries the join.
      closing = undefined;
      throw error;
    });
    return closing;
  };
  const port: HostStateIndexPort = {
    catchUpState: (threads) => use((live) => live.catchUpState(threads)),
    catchUpStateStep: (threads, maxEvents) =>
      use((live) => live.catchUpStateStep(threads, maxEvents)),
    destroy: async () => {
      await close();
      await removeFiles();
    },
    dropStateThread: (threadId) => use((live) => live.dropStateThread(threadId)),
    matchState: (threadId, query) => use((live) => live.matchState(threadId, query)),
    prepareStateMessageVectors: (request) =>
      use((live) => live.prepareStateMessageVectors(request)),
    prepareStateObservationVectors: (request) =>
      use((live) => live.prepareStateObservationVectors(request)),
    promptVectors: (request) => use((live) => live.promptVectors(request)),
    purgeStateMessageVectors: (request) => use((live) => live.purgeStateMessageVectors(request)),
    purgeStateObservationVectors: (request) =>
      use((live) => live.purgeStateObservationVectors(request)),
    putStateSearchVectors: (request) => use((live) => live.putStateSearchVectors(request)),
    queryStateMessageVectors: (request) => use((live) => live.queryStateMessageVectors(request)),
    queryStateObservationVectors: (request) =>
      use((live) => live.queryStateObservationVectors(request)),
    rebuildState: (threadId) => use((live) => live.rebuildState(threadId)),
    reindexState: (threadId, seq) => use((live) => live.reindexState(threadId, seq)),
    searchState: (request) => use((live) => live.searchState(request)),
    searchStateCoverage: (request) => use((live) => live.searchStateCoverage(request)),
    searchStatePending: (request) => use((live) => live.searchStatePending(request)),
    searchStateSimilar: (request) => use((live) => live.searchStateSimilar(request)),
    stateBlobCounts: (threads, hashes) => use((live) => live.stateBlobCounts(threads, hashes)),
    stateHealth: () => use((live) => live.stateHealth()),
    stateStats: (threadId) => use((live) => live.stateStats(threadId)),
    upsertStateMessageVectors: (request) => use((live) => live.upsertStateMessageVectors(request)),
    upsertStateObservationVectors: (request) =>
      use((live) => live.upsertStateObservationVectors(request)),
  };
  return { close, open: async () => void (await acquire()), port };
}
