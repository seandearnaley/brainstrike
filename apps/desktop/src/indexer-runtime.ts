import type { IndexerPort } from '@brainstrike/indexer';
import { IndexerHostManager } from './indexer-host-manager';

interface IndexerOwner {
  closing: boolean;
  readonly creation: Promise<IndexerHostManager>;
  readonly identity: string;
  manager?: IndexerHostManager;
  port?: IndexerPort;
  start?: Promise<IndexerHostManager>;
  startupFailure?: unknown;
  stop?: Promise<void>;
  stopKind?: 'close' | 'destroy';
}
let owner: IndexerOwner | undefined;

/** All inputs come from the canonical desktop profile/root owner; this module derives no paths/models. */
export async function acquireIndexerHost(
  input: unknown,
  deadlineInput: unknown
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
    deadlines.startupMs,
    deadlines.requestMs,
    deadlines.closeMs,
    deadlines.exitMs,
  ]);
  if (owner && (owner.closing || owner.identity !== identity)) {
    throw new Error(
      'Indexer owner must be explicitly closed before changing its profile, roots, path or deadlines.'
    );
  }
  owner ??= { closing: false, creation: IndexerHostManager.create(options, deadlines), identity };
  const current = owner;
  current.start ??= (async () => {
    try {
      current.manager = await current.creation;
      current.port = await current.manager.start();
      if (current.closing) {
        throw new Error('Indexer owner closed during startup.');
      }
      return current.manager;
    } catch (error) {
      current.startupFailure = error;
      throw error;
    }
  })();
  return current.start;
}

export function getReadyIndexerHost(): IndexerHostManager {
  if (!(owner?.manager && owner.port) || owner.closing || owner.manager.exited) {
    throw new Error(
      'Native indexer capability is unavailable or its owned host is not ready.',
      owner?.startupFailure === undefined ? undefined : { cause: owner.startupFailure }
    );
  }
  return owner.manager;
}
export function getReadyIndexerPort(): IndexerPort {
  getReadyIndexerHost();
  if (!owner?.port) {
    throw new Error('Native indexer port is unavailable.');
  }
  return owner.port;
}

async function stopIndexerRuntime(
  closeReaders: () => Promise<void>,
  destroy: boolean
): Promise<void> {
  const current = owner;
  if (!current) {
    return;
  }
  current.closing = true;
  const kind = destroy ? 'destroy' : 'close';
  if (current.stop && current.stopKind !== kind) {
    throw new Error('Indexer retirement already has a different close/destroy operation.');
  }
  current.stopKind = kind;
  current.stop ??= (async () => {
    // Reader admission closes/joins before the writer is closed or any index file is removed.
    // A rejection retains this exact writer owner for an explicit retry.
    await closeReaders();
    const manager = await current.creation;
    if (destroy) {
      await manager.destroy();
    } else {
      await manager.close();
    }
    const [startup] = await Promise.allSettled(current.start ? [current.start] : []);
    if (startup?.status === 'rejected') {
      current.startupFailure = startup.reason;
    }
    if (owner === current) {
      owner = undefined;
    }
  })();
  try {
    await current.stop;
  } finally {
    current.stop = undefined;
    current.stopKind = undefined;
  }
}

export function closeIndexerRuntime(closeReaders: () => Promise<void>): Promise<void> {
  return stopIndexerRuntime(closeReaders, false);
}
export function destroyIndexerRuntime(closeReaders: () => Promise<void>): Promise<void> {
  return stopIndexerRuntime(closeReaders, true);
}
