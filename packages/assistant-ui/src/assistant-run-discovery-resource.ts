export type AssistantRunDiscoverySnapshot<T> =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error'; readonly error: Error };

export type AssistantRunDiscoveryOutcome<T> =
  | { readonly type: 'ready'; readonly value: T }
  | { readonly type: 'retry' };

/** One scoped discovery attempt. React subscribes; this resource owns its I/O lifetime. */
export class AssistantRunDiscoveryResource<T> {
  private snapshot: AssistantRunDiscoverySnapshot<T>;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private abortController: AbortController | undefined;

  constructor(initialStatus: 'pending' | 'ready', initialValue: T) {
    this.snapshot =
      initialStatus === 'pending'
        ? { status: 'pending' }
        : { status: 'ready', value: initialValue };
  }

  readonly getSnapshot = (): AssistantRunDiscoverySnapshot<T> => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(snapshot: AssistantRunDiscoverySnapshot<T>): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }

  start(args: {
    readonly execute: (signal: AbortSignal) => Promise<AssistantRunDiscoveryOutcome<T>>;
    readonly onError?: (error: Error) => void;
    readonly onRetry: () => void;
    readonly timeoutMs: number;
  }): () => void {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const generation = ++this.generation;
    this.publish({ status: 'pending' });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Assistant run discovery timed out.'));
      }, args.timeoutMs);
    });
    const isCurrent = (): boolean =>
      generation === this.generation && this.abortController === controller;
    void Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return args.execute(controller.signal);
      }),
      timedOut,
    ])
      .then((outcome) => {
        if (!isCurrent()) {
          return;
        }
        if (outcome.type === 'retry') {
          args.onRetry();
          return;
        }
        this.publish({ status: 'ready', value: outcome.value });
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          const recoveryError = error instanceof Error ? error : new Error(String(error));
          args.onError?.(recoveryError);
          this.publish({
            error: recoveryError,
            status: 'error',
          });
        }
      })
      .finally(() => {
        if (timeout) {
          clearTimeout(timeout);
        }
      });
    return () => {
      if (isCurrent()) {
        this.generation += 1;
        controller.abort();
        this.abortController = undefined;
      }
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }
}
