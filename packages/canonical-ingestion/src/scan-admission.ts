import type {
  CanonicalOperationContext,
  CanonicalScanReceipt,
  CanonicalVectorPublicationPort,
} from './ports.ts';

/** Promise ownership of each workspace scan on the existing source lifetime. */
export function createNativeScanAdmission(assertSource: () => void, signal: AbortSignal) {
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
  return {
    acquireBindings: async <T>(
      context: CanonicalOperationContext,
      work: () => Promise<T>
    ): Promise<T> => {
      assertSource();
      context.signal.throwIfAborted();
      return await work();
    },
    acquireRead: async <T>(work: () => Promise<T>): Promise<T> => {
      assertSource();
      return await work();
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
          // Failed joins remain owned until the original sources physically retire.
          workspace.completion.reject(error);
        }
      }
    },
    getWorkspaceCompletions: (): readonly Promise<void>[] =>
      [...workspaces.values()].map((workspace) => workspace.completion.promise),
    joinPublication: wait,
    releaseInvalidatedWorkspace: (receipt: CanonicalScanReceipt): void => {
      if (receipt.scanComplete || receipt.reason !== 'manifest-mismatch') {
        throw new Error('Workspace recovery requires its settled invalidated source receipt.');
      }
      const workspace = workspaces.get(receipt.ticket.requestId);
      if (!workspace || workspace.rootId !== receipt.ticket.scope.rootId) {
        throw new Error('Invalidated workspace receipt has no matching admission owner.');
      }
      workspace.completion.resolve();
      workspaces.delete(receipt.ticket.requestId);
    },
    workspacePublication: (
      publication: CanonicalVectorPublicationPort
    ): CanonicalVectorPublicationPort => ({
      ...publication,
      beginScan: async (request) => {
        assertSource();
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
