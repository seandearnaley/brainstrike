import type {
  MountedWorkspaceRoot,
  RootDataDeletionReservation,
} from '@brainstrike/assistant-service/node-workspace-services';
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { NativeIndexAuthority } from './native-index-runtime';

interface NativeCleanupOwner {
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

async function removeCapturedRoot(
  owner: NativeCleanupOwner,
  reservation: RootDataDeletionReservation
): Promise<void> {
  // Read only AFTER joining admitted work: a pre-stop snapshot can miss a late ACK.
  const authority = owner.readAuthority();
  const rootId = reservation.mounted.rootId;
  // A folder outside the partition (a worktree not opted in) has no bindings: nothing to remove.
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
  prepareTransition<P, T>(
    prepare: () => Promise<P>,
    complete: (prepared: P) => Promise<T>
  ): Promise<T>;
  transition<T>(operation: () => Promise<T>): Promise<T>;
}

/** Main owns the entire destructive transition; callers supply only a mounted root ID. */
export function createNativeRootDataDeletion(dependencies: Dependencies): NativeRootDataDeletion {
  let running: Promise<void> | undefined;
  let transitions: Promise<void> = Promise.resolve();
  let transitionCount = 0;

  const execute = async (reservation: RootDataDeletionReservation): Promise<void> => {
    await transitions;
    let sourcesStopped = false;
    try {
      await reservation.run(async () => {
        const owner = await dependencies.captureOwner();
        reservation.assertCurrent();
        sourcesStopped = true;
        await dependencies.stopSources();
        await reservation.retireSources();
        reservation.assertCurrent();
        await removeCapturedRoot(owner, reservation);
        await dependencies.closeOwner();
        reservation.assertCurrent();
        await dependencies.deleteCanonicalRoot(reservation.mounted);
        await reservation.disconnect();
      });
    } catch (error) {
      // A failed deletion never keeps admission: the folder stays connected, its
      // indexing resumes, and the user can retry.
      reservation.release();
      if (sourcesStopped) {
        try {
          await dependencies.resume();
          await dependencies.acquire();
        } catch (recovery) {
          throw new AggregateError(
            [error, recovery],
            'Root data deletion failed and native indexing did not resume.'
          );
        }
      }
      throw error;
    }
    reservation.release();
    await dependencies.resume();
    await dependencies.acquire();
  };
  const deleteRootData = (rootId: string): Promise<void> => {
    try {
      if (running) {
        throw new Error('A root data deletion is already running; retry after it settles.');
      }
      if (transitionCount > 0) {
        throw new Error(
          'A native transition already owns admission; retry root deletion after it settles.'
        );
      }
      // Reserve synchronously: filesystem and native transitions see closed admission immediately.
      const deletion = execute(dependencies.reserveRoot(rootId)).finally(() => {
        running = undefined;
      });
      running = deletion;
      return deletion;
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const prepareTransition = <P, T>(
    prepare: () => Promise<P>,
    complete: (prepared: P) => Promise<T>
  ): Promise<T> => {
    if (running) {
      return Promise.reject(
        new Error('Native root deletion owns admission; retry after it settles.')
      );
    }
    transitionCount += 1;
    const prepared = (async () => await prepare())();
    prepared.catch(() => undefined);
    const operation = async (): Promise<T> => complete(await prepared);
    const result = transitions.then(operation, operation).finally(() => {
      transitionCount -= 1;
    });
    transitions = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  const transition = <T>(operation: () => Promise<T>): Promise<T> =>
    prepareTransition(async () => undefined, operation);
  return { deleteRootData, prepareTransition, transition };
}
