import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { NativeIndexAuthority } from './native-index-runtime';

interface NativeCleanupOwner {
  readonly generation: number;
  readonly port: IndexerPort & ScopedIndexerPort;
  readAuthority(): NativeIndexAuthority;
}

/** The agent host's hold on one folder's data deletion, from its reservation to its end. */
export interface RootDataDeletionGrant {
  /**
   * `workspace/roots/delete-data`: retires the folder's command sessions and LSP servers,
   * deletes its records and closes it. The host releases the reservation however it ends.
   */
  delete(): Promise<void>;
  /** `workspace/roots/release-data-deletion`: the folder is back, untouched. */
  release(): Promise<void>;
}

interface Dependencies {
  acquire(): Promise<unknown>;
  captureOwner(): Promise<NativeCleanupOwner>;
  closeOwner(): Promise<void>;
  /**
   * `workspace/roots/reserve-data-deletion`: the host refuses a folder it cannot delete (a
   * read-only store, a folder it does not hold mounted, another change in flight) before
   * anything is removed, and fences the folder from every host read, watch, terminal and run
   * borrow until the grant ends.
   */
  reserveRootData(rootId: string): Promise<RootDataDeletionGrant>;
  resume(): Promise<void>;
  stopSources(): Promise<void>;
}

async function removeCapturedRoot(owner: NativeCleanupOwner, rootId: string): Promise<void> {
  // Read only AFTER joining admitted work: a pre-stop snapshot can miss a late ACK.
  const authority = owner.readAuthority();
  // A folder outside the partition (a worktree not opted in) has no bindings: nothing to remove.
  for (const binding of authority.fileBindings) {
    if (binding.rootId !== rootId) {
      continue;
    }
    await owner.port.removeScopedFile({
      fileId: binding.fileId,
      scope: { kind: 'workspace', rootId },
    });
  }
  // The captured port cannot select a replacement writer. Recheck its owner before
  // the host deletes the folder's records, without cloning the inventory per file.
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

/**
 * Main's native index stops its sources around the agent host's deletion of one folder's data
 * (ADR-0029 stage 4). The host reserves the folder first, so a deletion it would refuse removes
 * nothing; the index then drops the folder's bindings while stopped, the host deletes its records
 * and closes it, and the index resumes. The host owns the folder; this owns the index.
 */
export function createNativeRootDataDeletion(dependencies: Dependencies): NativeRootDataDeletion {
  let running: Promise<void> | undefined;
  let transitions: Promise<void> = Promise.resolve();
  let transitionCount = 0;

  const execute = async (rootId: string): Promise<void> => {
    await transitions;
    // Nothing is stopped or removed until the host has reserved the folder.
    const grant = await dependencies.reserveRootData(rootId);
    let granted = true;
    let sourcesStopped = false;
    try {
      const owner = await dependencies.captureOwner();
      sourcesStopped = true;
      await dependencies.stopSources();
      await removeCapturedRoot(owner, rootId);
      await dependencies.closeOwner();
      // The host consumes the reservation, and releases it however the deletion ends.
      granted = false;
      await grant.delete();
    } catch (error) {
      // A failed deletion leaves the folder as the host left it: a reservation not yet
      // consumed is released, and indexing resumes, so the user can retry.
      const recoveries: unknown[] = [];
      if (granted) {
        await grant.release().catch((cause: unknown) => recoveries.push(cause));
      }
      if (sourcesStopped) {
        try {
          await dependencies.resume();
          await dependencies.acquire();
        } catch (recovery) {
          recoveries.push(recovery);
        }
      }
      if (recoveries.length > 0) {
        throw new AggregateError(
          [error, ...recoveries],
          'Root data deletion failed and did not fully recover.'
        );
      }
      throw error;
    }
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
      // Claimed synchronously: native transitions see closed admission immediately.
      const deletion = execute(rootId).finally(() => {
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
