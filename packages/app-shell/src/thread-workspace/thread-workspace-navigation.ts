/** Session-only navigation intent. The workspace coordinator remains the snapshot owner. */
export class ThreadWorkspaceNavigation {
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  readonly getSnapshot = (): number => this.revision;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  hasPending(resourceId: string, threadId: string | null): boolean {
    return this.pending?.resourceId === resourceId && this.pending.threadId === threadId;
  }
  private ready: { resourceId: string; threadId: string } | null = null;
  private pending: { resourceId: string; threadId: string; appId: string } | null = null;
  private readonly readyJoins = new Map<string, PromiseWithResolvers<void>>();
  /** The last attempt's failure, kept until the next attempt so a later join rejects with it. */
  private failure: { resourceId: string; threadId: string; error: unknown } | null = null;

  constructor(
    private readonly actions: {
      activateThread: (resourceId: string, threadId: string) => void;
      openApp: (appId: string) => void;
      reportError: (error: unknown) => void;
    }
  ) {}

  open(resourceId: string, threadId: string, appId: string): void {
    this.pending = { appId, resourceId, threadId };
    this.actions.activateThread(resourceId, threadId);
    if (this.ready?.resourceId === resourceId && this.ready.threadId === threadId) {
      this.complete(resourceId, threadId);
      return;
    }
    this.revision += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Joins the coordinator's report that this thread's stored workspace is applied to the live
   * stores: resolves on its `complete`, rejects with the error on its `failed` (BST-2288).
   */
  whenReady(resourceId: string, threadId: string): Promise<void> {
    if (this.ready?.resourceId === resourceId && this.ready.threadId === threadId) {
      return Promise.resolve();
    }
    if (this.failure?.resourceId === resourceId && this.failure.threadId === threadId) {
      return Promise.reject(this.failure.error);
    }
    const key = readyJoinKey(resourceId, threadId);
    let join = this.readyJoins.get(key);
    if (!join) {
      join = Promise.withResolvers<void>();
      this.readyJoins.set(key, join);
    }
    return join.promise;
  }

  loading(resourceId: string, threadId: string | null): void {
    this.ready = null;
    this.failure = null;
    if (this.pending?.resourceId !== resourceId || this.pending.threadId !== threadId) {
      this.pending = null;
    }
  }

  complete(resourceId: string, threadId: string): void {
    this.ready = { resourceId, threadId };
    this.failure = null;
    const pending = this.pending;
    this.pending = null;
    if (pending?.resourceId === resourceId && pending.threadId === threadId) {
      this.actions.openApp(pending.appId);
    }
    this.takeReadyJoin(resourceId, threadId)?.resolve();
  }

  failed(resourceId: string, threadId: string, error: unknown): void {
    // A save may reject after its coordinator unmounts and another owner is ready.
    if (this.ready?.resourceId === resourceId && this.ready.threadId === threadId) {
      this.ready = null;
    }
    if (this.pending?.resourceId === resourceId && this.pending.threadId === threadId) {
      this.pending = null;
      this.actions.reportError(error);
    }
    this.failure = { error, resourceId, threadId };
    this.takeReadyJoin(resourceId, threadId)?.reject(error);
  }

  private takeReadyJoin(resourceId: string, threadId: string) {
    const key = readyJoinKey(resourceId, threadId);
    const join = this.readyJoins.get(key);
    this.readyJoins.delete(key);
    return join;
  }
}

function readyJoinKey(resourceId: string, threadId: string): string {
  return `${resourceId}\0${threadId}`;
}
