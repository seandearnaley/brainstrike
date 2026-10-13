import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthorityPort } from '@brainstrike/indexer/coverage-reader';
import { createLogger } from '@brainstrike/logging';
import {
  type ChildGenerationContext,
  type ChildSupervisor,
  createChildSupervisor,
} from './child-supervisor';
import { IndexerHostManager } from './indexer-host-manager';

type Port = IndexerPort & ScopedIndexerPort & CoverageAuthorityPort;
export interface IndexerLossHandover {
  failed(cause: unknown): Promise<void>;
  ready(): Promise<void>;
}
export interface IndexerRuntimeBorrowers {
  /** Fences native admission synchronously; the returned command captures its native generation. */
  lost(cause: unknown): Promise<IndexerLossHandover>;
  released(): void;
  /** Joins borrowed resources only. Must never call stop/close of this process owner. */
  retire(manager: IndexerHostManager): Promise<void>;
}
interface PhysicalIndexer {
  readonly context: ChildGenerationContext;
  readonly creation: Promise<IndexerHostManager>;
  manager?: IndexerHostManager;
  port?: Port;
}
interface IndexerOwner {
  closeReaders?: (() => Promise<void>) | undefined;
  readonly identity: string;
  physical?: PhysicalIndexer | undefined;
  stopKind?: 'close' | 'destroy' | undefined;
  readonly supervisor: Promise<ChildSupervisor<IndexerHostManager>>;
}
const logger = createLogger('IndexerRuntime');
let owner: IndexerOwner | undefined;

/** All inputs come from the canonical desktop profile/root owner; this module derives no paths/models. */
export async function acquireIndexerHost(
  input: unknown,
  deadlineInput: unknown,
  borrowers: IndexerRuntimeBorrowers
): Promise<IndexerHostManager> {
  const { validateIndexerOptions, validateIndexerDeadlines } = await import(
    '@brainstrike/indexer/transport'
  );
  const options = validateIndexerOptions(input);
  const deadlines = validateIndexerDeadlines(deadlineInput);
  const identity = JSON.stringify([
    options.dbPath,
    options.embedding,
    [...options.rootIds].sort(),
    [...(options.scopes ?? [])].map((scope) => JSON.stringify(scope)).sort(),
    deadlines.startupMs,
    deadlines.requestMs,
    deadlines.closeMs,
    deadlines.exitMs,
  ]);
  if (owner && owner.identity !== identity) {
    throw new Error(
      'Indexer owner must be explicitly closed before changing its profile, roots, path or deadlines.'
    );
  }
  if (!owner) {
    const current: IndexerOwner = {
      identity,
      supervisor: createChildSupervisor({
        create: (context) => {
          // This promise joins the physical loss callback; it is not another lifecycle queue.
          let loss: Promise<void> | undefined;
          const physical: PhysicalIndexer = {
            context,
            creation: IndexerHostManager.create(options, deadlines, undefined, (cause) => {
              if (current.physical !== physical || context.signal.aborted) {
                return;
              }
              const preparation = borrowers.lost(cause);
              loss = (async () => {
                const handover = await preparation;
                // Keep the actual startup failure when loss interrupts initial acquisition.
                const failure = await ready.then(
                  () => cause,
                  (error: unknown) => error
                );
                try {
                  await context.lost(failure);
                  const snapshot = await (await current.supervisor).snapshot();
                  if (snapshot.kind === 'ready') {
                    await handover.ready();
                  } else if (snapshot.kind === 'failed') {
                    await handover.failed(snapshot.cause);
                  }
                } catch (error) {
                  await handover.failed(error);
                  throw error;
                }
              })();
              void loss.catch((error: unknown) =>
                logger.error('Indexer loss handover failed', { error })
              );
            }),
          };
          current.physical = physical;
          const ready = physical.creation.then(async (manager) => {
            physical.manager = manager;
            physical.port = await manager.start();
            return manager;
          });
          return {
            close: async () => {
              const manager = await physical.creation;
              await current.closeReaders?.();
              await borrowers.retire(manager);
              if (current.stopKind === 'destroy') {
                await manager.destroy();
              } else {
                await manager.close();
              }
              borrowers.released();
              if (current.physical === physical) {
                current.physical = undefined;
              }
            },
            ready: ready.catch(async (error: unknown) => {
              // Let the sole supervisor record owned loss before a failed ready can replace it.
              await loss;
              throw error;
            }),
          };
        },
        restart: 'immediate',
      }),
    };
    owner = current;
  }
  return (await owner.supervisor).acquire();
}

export function getReadyIndexerHost(): IndexerHostManager {
  const physical = owner?.physical;
  if (
    !(physical?.manager && physical.port) ||
    physical.context.signal.aborted ||
    physical.manager.exited ||
    owner?.stopKind
  ) {
    throw new Error('Native indexer capability is unavailable or its owned host is not ready.');
  }
  return physical.manager;
}
export function getReadyIndexerPort(): IndexerPort {
  return getReadyScopedIndexerPort();
}
export function getReadyScopedIndexerPort(): Port {
  getReadyIndexerHost();
  const port = owner?.physical?.port;
  if (!port) {
    throw new Error('Native scoped indexer port is unavailable.');
  }
  return port;
}

async function stopIndexerRuntime(
  closeReaders: () => Promise<void>,
  destroy: boolean
): Promise<void> {
  const current = owner;
  if (!current) {
    return;
  }
  const kind = destroy ? 'destroy' : 'close';
  if (current.stopKind && current.stopKind !== kind) {
    throw new Error('Indexer retirement already has a different close/destroy operation.');
  }
  current.stopKind = kind;
  current.closeReaders ??= closeReaders;
  try {
    await (await current.supervisor).stop();
    if (owner === current) {
      owner = undefined;
    }
  } finally {
    current.stopKind = undefined;
    current.closeReaders = undefined;
  }
}
export function closeIndexerRuntime(closeReaders: () => Promise<void>): Promise<void> {
  return stopIndexerRuntime(closeReaders, false);
}
export function destroyIndexerRuntime(closeReaders: () => Promise<void>): Promise<void> {
  return stopIndexerRuntime(closeReaders, true);
}
