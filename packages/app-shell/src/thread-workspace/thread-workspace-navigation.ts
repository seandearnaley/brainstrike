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

  loading(resourceId: string, threadId: string | null): void {
    this.ready = null;
    if (this.pending?.resourceId !== resourceId || this.pending.threadId !== threadId) {
      this.pending = null;
    }
  }

  complete(resourceId: string, threadId: string): void {
    this.ready = { resourceId, threadId };
    const pending = this.pending;
    this.pending = null;
    if (pending?.resourceId === resourceId && pending.threadId === threadId) {
      this.actions.openApp(pending.appId);
    }
  }

  failed(resourceId: string, threadId: string, error: unknown): void {
    this.ready = null;
    if (this.pending?.resourceId === resourceId && this.pending.threadId === threadId) {
      this.pending = null;
      this.actions.reportError(error);
    }
  }
}
