import type {
  CanonicalOperationContext,
  CanonicalScanReceipt,
  CanonicalVectorPublicationPort,
} from '@brainstrike/canonical-ingestion';
import type { NativeCanonicalCatalogRecord } from './native-canonical-catalog';

/** Promise ownership on the existing source lifetime, before collection inventory loading. */
export function createNativeScanAdmission(assertSource: () => void, signal: AbortSignal) {
  let collection:
    | {
        failure?: { readonly error: unknown };
        readonly ready: ReturnType<typeof Promise.withResolvers<void>>;
        readonly requestId: string;
        readonly settled: Promise<void>;
      }
    | undefined;
  let inventory: readonly NativeCanonicalCatalogRecord[] | undefined;
  const pendingBindings = new Set<Promise<void>>();
  const workspaces = new Map<
    string,
    { readonly rootId: string; readonly completion: ReturnType<typeof Promise.withResolvers<void>> }
  >();
  const wait = async (
    pending: Promise<void>,
    context?: CanonicalOperationContext
  ): Promise<void> => {
    const queued = Promise.withResolvers<void>();
    const signals = context ? [signal, context.signal] : [signal];
    const abort = (): void => {
      queued.reject(signals.find((current) => current.aborted)?.reason);
    };
    for (const current of signals) {
      current.addEventListener('abort', abort, { once: true });
      if (current.aborted) {
        abort();
      }
    }
    try {
      await Promise.race([pending, queued.promise]);
      assertSource();
      context?.signal.throwIfAborted();
    } finally {
      for (const current of signals) {
        current.removeEventListener('abort', abort);
      }
    }
  };
  const waitForCollection = async (context?: CanonicalOperationContext): Promise<void> => {
    assertSource();
    context?.signal.throwIfAborted();
    while (collection && collection.requestId !== context?.requestId) {
      // Previously admitted workspace work must finish before collection loading starts.
      if (context && workspaces.has(context.requestId)) {
        break;
      }
      await wait(collection.settled, context);
    }
  };
  const replaceBindings = async <T>(work: () => Promise<T>): Promise<T> => {
    const completion = Promise.withResolvers<void>();
    completion.promise.catch(() => undefined);
    pendingBindings.add(completion.promise);
    try {
      const result = await work();
      completion.resolve();
      pendingBindings.delete(completion.promise);
      return result;
    } catch (error) {
      completion.reject(error);
      throw error;
    }
  };
  return {
    acquireBindings: async <T>(
      context: CanonicalOperationContext,
      work: () => Promise<T>
    ): Promise<T> => {
      while (
        collection &&
        collection.requestId !== context.requestId &&
        !workspaces.has(context.requestId)
      ) {
        await waitForCollection(context);
      }
      assertSource();
      context.signal.throwIfAborted();
      if (collection?.failure) {
        throw collection.failure.error;
      }
      return replaceBindings(work);
    },
    acquireRead: async <T>(work: () => Promise<T>): Promise<T> => {
      while (collection && !inventory) {
        await wait(collection.ready.promise);
      }
      assertSource();
      if (collection?.failure) {
        throw collection.failure.error;
      }
      return replaceBindings(work);
    },
    completeWorkspace: (receipt: CanonicalScanReceipt): void => {
      const requestId = receipt.ticket.requestId;
      const workspace = workspaces.get(requestId);
      if (!receipt.scanComplete) {
        workspace?.completion.reject(new Error(`Native workspace scan was ${receipt.reason}.`));
        return;
      }
      workspace?.completion.resolve();
      workspaces.delete(requestId);
    },
    failWorkspace: (rootId: string, error: unknown): void => {
      for (const workspace of workspaces.values()) {
        if (workspace.rootId === rootId) {
          // Failed joins remain owned; later collection admission preserves the original failure.
          workspace.completion.reject(error);
        }
      }
    },
    getInventory: () => inventory,
    retainInventory: (records: readonly NativeCanonicalCatalogRecord[]): void => {
      if (!collection) {
        throw new Error('Collection inventory has no admitted source owner.');
      }
      inventory = records;
      collection.ready.resolve();
    },
    runCollection: async (requestId: string, work: () => Promise<void>): Promise<void> => {
      assertSource();
      if (collection) {
        throw new Error('Collection admission is already owned.');
      }
      const completion = Promise.withResolvers<void>();
      completion.promise.catch(() => undefined);
      const ready = Promise.withResolvers<void>();
      ready.promise.catch(() => undefined);
      collection = { ready, requestId, settled: completion.promise };
      try {
        await wait(
          Promise.all([
            ...pendingBindings,
            ...[...workspaces.values()].map((workspace) => workspace.completion.promise),
          ]).then(() => {})
        );
        await work();
        inventory = undefined;
        collection = undefined;
        completion.resolve();
      } catch (error) {
        // Preserve failed admission and its snapshot until the original sources physically retire.
        if (collection) {
          collection.failure = { error };
        }
        ready.reject(error);
        completion.reject(error);
        throw error;
      }
    },
    waitForCollection,
    workspacePublication: (
      publication: CanonicalVectorPublicationPort
    ): CanonicalVectorPublicationPort => ({
      ...publication,
      beginScan: async (request) => {
        while (collection) {
          await waitForCollection();
        }
        assertSource();
        if (request.scope.kind !== 'workspace') {
          throw new Error('Workspace admission requires its actual mounted scope.');
        }
        const rootId = request.scope.rootId;
        if ([...workspaces.values()].some((workspace) => workspace.rootId === rootId)) {
          throw new Error('Workspace publication admission remains owned.');
        }
        const completion = Promise.withResolvers<void>();
        completion.promise.catch(() => undefined);
        workspaces.set(request.requestId, { completion, rootId });
        try {
          return await publication.beginScan(request);
        } catch (error) {
          completion.reject(error);
          throw error;
        }
      },
    }),
  };
}
