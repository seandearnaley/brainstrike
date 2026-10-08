import type { HostClient } from '@brainstrike/agent-host/browser';

export type WindowHostConnectionState =
  | { readonly status: 'idle' }
  | { readonly client: HostClient; readonly status: 'connected' }
  /** The connection closed (the host exited); one reattach is in flight. */
  | { readonly status: 'restarting' }
  /** The reattach failed; only an explicit retry tries again. */
  | { readonly error: string; readonly status: 'failed' };

/**
 * The window's one host client. When its connection closes, it reattaches once
 * through Main, which attaches to the replacement host or starts one. A failed
 * reattach waits for an explicit retry. Every transition follows an event;
 * nothing is polled.
 */
export class WindowHostConnection {
  private state: WindowHostConnectionState = { status: 'idle' };
  private connecting: Promise<HostClient> | undefined;
  private closing: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly connect: () => Promise<HostClient>,
    /** Every newly attached client, including each replacement. */
    private readonly attached: (client: HostClient) => void
  ) {}

  readonly getSnapshot = (): WindowHostConnectionState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  client(): Promise<HostClient> {
    if (this.closing) {
      return Promise.reject(new Error('The desktop host view is closing'));
    }
    this.connecting ??= this.open();
    return this.connecting;
  }

  /** An explicit retry after a failed reattach; a live connection is kept. */
  retry(): void {
    this.client().catch(() => undefined);
  }

  close(): Promise<void> {
    const admitted = this.connecting;
    this.closing ??= (async () => {
      if (admitted) {
        const [result] = await Promise.allSettled([admitted]);
        if (result?.status === 'fulfilled') {
          await result.value.close();
          await result.value.closed;
        }
      }
    })();
    return this.closing;
  }

  private set(state: WindowHostConnectionState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private open(): Promise<HostClient> {
    const attempt: Promise<HostClient> = this.connect().then(
      (client) => {
        if (this.closing) {
          void client.close();
          throw new Error('The desktop host view is closing');
        }
        this.set({ client, status: 'connected' });
        this.attached(client);
        const lost = (): void => {
          if (this.connecting !== attempt || this.closing) {
            return;
          }
          this.connecting = undefined;
          this.set({ status: 'restarting' });
          this.client().catch(() => undefined);
        };
        client.closed.then(lost, lost);
        return client;
      },
      (cause: unknown) => {
        if (this.connecting === attempt) {
          this.connecting = undefined;
        }
        if (!this.closing) {
          this.set({
            error: cause instanceof Error ? cause.message : String(cause),
            status: 'failed',
          });
        }
        throw cause;
      }
    );
    return attempt;
  }
}
