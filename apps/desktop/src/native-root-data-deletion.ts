import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { MountedWorkspaceRoot } from './ipc-domains/workspace-root-types';
import type { NativeIndexAuthority } from './native-index-runtime';

export interface RootDataDeletionReservation {
  assertCurrent(): void;
  disconnect(): Promise<void>;
  readonly mounted: MountedWorkspaceRoot;
  release(): void;
  retireSources(): Promise<void>;
  run(operation: () => Promise<void>): Promise<void>;
}

export interface NativeCleanupOwner {
  readonly generation: number;
  readonly port: IndexerPort & ScopedIndexerPort;
  readAuthority(): NativeIndexAuthority;
}

interface Dependencies {
  acquire(): Promise<unknown>;
  captureOwner(): Promise<NativeCleanupOwner>;
  closeOwner(): Promise<void>;
  deleteCanonicalRoot(mounted: MountedWorkspaceRoot): Promise<void>;
  reserveRoot(rootId: string): RootDataDeletionReservation;
  resume(): Promise<void>;
  stopSources(): Promise<void>;
}

type Phase =
  | 'capture'
  | 'stop'
  | 'remove'
  | 'close'
  | 'cascade'
  | 'disconnect'
  | 'resume'
  | 'acquire'
  | 'done';
interface Deletion {
  owner?: NativeCleanupOwner;
  phase: Phase;
  readonly reservation: RootDataDeletionReservation;
  running?: Promise<void> | undefined;
}

async function removeCapturedRoot(deletion: Deletion): Promise<void> {
  const owner = deletion.owner;
  if (!owner) {
    throw new Error('Root deletion has no captured native owner.');
  }
  const reservation = deletion.reservation;
  // Read only AFTER joining admitted work: a pre-stop snapshot can miss a late ACK.
  const authority = owner.readAuthority();
  const rootId = reservation.mounted.rootId;
  if (
    !(
      authority.rootIds.includes(rootId) &&
      authority.scopes.some((scope) => scope.kind === 'workspace' && scope.rootId === rootId)
    )
  ) {
    throw new Error('The original native owner has no authorized scope for this root.');
  }
  for (const binding of authority.fileBindings) {
    if (binding.rootId !== rootId) {
      continue;
    }
    reservation.assertCurrent();
    await owner.port.removeScopedFile({
      fileId: binding.fileId,
      scope: { kind: 'workspace', rootId },
    });
    reservation.assertCurrent();
  }
  // The captured port cannot select a replacement writer. Recheck its owner before
  // downstream retirement/PG, without cloning the complete inventory per file.
  owner.readAuthority();
}

export interface NativeRootDataDeletion {
  deleteRootData(rootId: string): Promise<void>;
  transition<T>(operation: () => Promise<T>): Promise<T>;
}

/** Main owns the entire destructive transition; callers supply only a mounted root ID. */
export function createNativeRootDataDeletion(dependencies: Dependencies): NativeRootDataDeletion {
  let pending: Deletion | undefined;
  let transitions: Promise<void> = Promise.resolve();
  let transitionCount = 0;

  const advance = async (deletion: Deletion): Promise<void> => {
    const reservation = deletion.reservation;
    reservation.assertCurrent();
    switch (deletion.phase) {
      case 'capture':
        deletion.owner = await dependencies.captureOwner();
        reservation.assertCurrent();
        deletion.phase = 'stop';
        return;
      case 'stop':
        await dependencies.stopSources();
        await reservation.retireSources();
        reservation.assertCurrent();
        deletion.phase = 'remove';
        return;
      case 'remove':
        await removeCapturedRoot(deletion);
        deletion.phase = 'close';
        return;
      case 'close':
        await dependencies.closeOwner();
        reservation.assertCurrent();
        deletion.phase = 'cascade';
        return;
      case 'cascade':
        await dependencies.deleteCanonicalRoot(reservation.mounted);
        deletion.phase = 'disconnect';
        return;
      case 'disconnect':
        await reservation.disconnect();
        deletion.phase = 'resume';
        return;
      default:
        throw new Error('Root deletion entered an invalid reserved phase.');
    }
  };
  const execute = async (deletion: Deletion): Promise<void> => {
    await transitions;
    if (deletion.phase !== 'resume' && deletion.phase !== 'acquire') {
      await deletion.reservation.run(async () => {
        while (deletion.phase !== 'resume') {
          await advance(deletion);
        }
      });
      deletion.reservation.release();
    }
    if (deletion.phase === 'resume') {
      await dependencies.resume();
      deletion.phase = 'acquire';
    }
    await dependencies.acquire();
    deletion.phase = 'done';
    if (pending === deletion) {
      pending = undefined;
    }
  };
  const deleteRootData = (rootId: string): Promise<void> => {
    try {
      if (!pending && transitionCount > 0) {
        throw new Error(
          'A native transition already owns admission; retry root deletion after it settles.'
        );
      }
      if (pending && pending.reservation.mounted.rootId !== rootId) {
        throw new Error('Root deletion cleanup must be retried for its original root.');
      }
      // Reserve synchronously: filesystem and native transitions see closed admission immediately.
      pending ??= { phase: 'capture', reservation: dependencies.reserveRoot(rootId) };
      const deletion = pending;
      deletion.running ??= execute(deletion)
        .catch((error: unknown) => {
          if (deletion.phase === 'capture') {
            deletion.reservation.release();
            if (pending === deletion) {
              pending = undefined;
            }
          }
          throw error;
        })
        .finally(() => {
          deletion.running = undefined;
        });
      return deletion.running;
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const transition = <T>(operation: () => Promise<T>): Promise<T> => {
    if (pending) {
      return Promise.reject(
        new Error('Native root deletion owns admission; retry its cleanup first.')
      );
    }
    transitionCount += 1;
    const result = transitions.then(operation, operation).finally(() => {
      transitionCount -= 1;
    });
    transitions = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  return { deleteRootData, transition };
}
