import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  BoundaryFailureError,
  isBoundaryRefusal,
  refusal,
} from '@brainstrike/assistant-contract/boundary-failure';
import { createLogger } from '@brainstrike/logging';
import { connectDesktopAgentHost } from './agent-host-client';

const logger = createLogger('DesktopHostConnection');

/** This frame's agent host connection. Each connected client is one generation. */
export type DesktopHostConnectionState =
  | { readonly kind: 'idle' }
  | { readonly automatic: boolean; readonly kind: 'connecting' }
  | { readonly client: HostClient; readonly generation: number; readonly kind: 'connected' }
  | { readonly error: string; readonly kind: 'failed' }
  | { readonly kind: 'closed' };

export interface DesktopHostConnection {
  close(): Promise<void>;
  /** The connected client, connecting first when nothing has asked yet. Rejects while failed or closed. */
  current(): Promise<HostClient>;
  readonly getSnapshot: () => DesktopHostConnectionState;
  /** The user's Reconnect: one attempt, from `failed` only. */
  readonly reconnect: () => void;
  /**
   * The first client connected after `lost`, through every later attempt, the
   * user's included. Rejects only when the frame closes the connection.
   */
  replacement(lost: HostClient): Promise<HostClient>;
  readonly subscribe: (listener: () => void) => () => void;
}

/** The frame is unloading: its views stop asking, so this refusal is not a fault. */
const CLOSING = refusal({
  category: 'availability',
  code: 'host.view-closing',
  message: 'The desktop host view is closing',
});
const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * One owner for the frame's host client (BST-2004). When the client closes
 * without the frame asking, it makes one automatic attempt through Main's
 * `agent:host-connect`. A host lost again before the user reconnects stays
 * `failed` until they do. There is no timer and no retry loop.
 */
export function createDesktopHostConnection(
  connect: () => Promise<HostClient>
): DesktopHostConnection {
  let state: DesktopHostConnectionState = { kind: 'idle' };
  let generation = 0;
  let attempt: Promise<HostClient> | undefined;
  let automaticSpent = false;
  /** The typed cause behind `failed`, so later callers see the same refusal. */
  let failure: unknown;
  let closing: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const waiters = new Set<{
    readonly lost: HostClient;
    readonly reject: (cause: unknown) => void;
    readonly resolve: (client: HostClient) => void;
  }>();
  const publish = (next: DesktopHostConnectionState): void => {
    state = next;
    for (const waiter of [...waiters]) {
      if (next.kind === 'connected' && next.client !== waiter.lost) {
        waiters.delete(waiter);
        waiter.resolve(next.client);
      } else if (next.kind === 'closed') {
        waiters.delete(waiter);
        waiter.reject(new BoundaryFailureError(CLOSING));
      }
    }
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const start = (automatic: boolean): Promise<HostClient> => {
    const current = connect().then(async (client) => {
      if (closing) {
        await client.close();
        throw new BoundaryFailureError(CLOSING);
      }
      generation += 1;
      publish({ client, generation, kind: 'connected' });
      client.closed.then(lost(client), lost(client));
      return client;
    });
    attempt = current;
    publish({ automatic, kind: 'connecting' });
    current.then(
      () => {
        if (attempt === current) {
          attempt = undefined;
        }
      },
      (cause: unknown) => {
        if (attempt === current) {
          attempt = undefined;
        }
        if (!closing) {
          // Main refused (its profile is closed or preparing): unavailability, not a fault.
          if (isBoundaryRefusal(cause)) {
            logger.warn('The agent host connection was refused', { error: cause });
          } else {
            logger.error('The agent host connection failed', { error: cause });
          }
          failure = cause;
          publish({ error: messageOf(cause), kind: 'failed' });
        }
      }
    );
    return current;
  };
  const lost = (client: HostClient) => (): void => {
    if (closing || state.kind !== 'connected' || state.client !== client) {
      return;
    }
    if (automaticSpent) {
      logger.warn('The agent host connection closed again; waiting for the user to reconnect');
      failure = new Error('The agent host stopped again after reconnecting.');
      publish({ error: messageOf(failure), kind: 'failed' });
      return;
    }
    automaticSpent = true;
    logger.warn('The agent host connection closed; reconnecting once');
    start(true).catch(() => undefined);
  };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const pending = attempt;
      const connected = state.kind === 'connected' ? state.client : undefined;
      publish({ kind: 'closed' });
      // A connected client closes now; an attempt still in flight closes its own on arrival.
      const [settled] = await Promise.allSettled([pending]);
      const client = connected ?? (settled?.status === 'fulfilled' ? settled.value : undefined);
      if (client) {
        await client.close();
        await client.closed;
      }
    })();
    return closing;
  };
  return {
    close,
    current: () => {
      switch (state.kind) {
        case 'connected':
          return Promise.resolve(state.client);
        case 'connecting':
          return attempt ?? Promise.reject(new Error('The agent host connection has no attempt'));
        case 'idle':
          // The actual frame owns this client. Main joins its relay on navigation,
          // renderer loss and shutdown; React presentation replay owns no transport.
          window.addEventListener('beforeunload', () => void close(), { once: true });
          return start(false);
        case 'failed':
          return Promise.reject(failure ?? new Error(state.error));
        default:
          return Promise.reject(new BoundaryFailureError(CLOSING));
      }
    },
    getSnapshot: () => state,
    reconnect: () => {
      if (closing || state.kind !== 'failed') {
        return;
      }
      automaticSpent = false;
      start(false).catch(() => undefined);
    },
    replacement: (lostClient) => {
      if (state.kind === 'connected' && state.client !== lostClient) {
        return Promise.resolve(state.client);
      }
      if (closing) {
        return Promise.reject(new BoundaryFailureError(CLOSING));
      }
      const waiting = Promise.withResolvers<HostClient>();
      waiters.add({ lost: lostClient, reject: waiting.reject, resolve: waiting.resolve });
      return waiting.promise;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let windowConnection: DesktopHostConnection | undefined;

/** The one host connection of this renderer frame, shared by its thread views and MCP settings. */
export function windowHostConnection(): DesktopHostConnection {
  windowConnection ??= createDesktopHostConnection(connectDesktopAgentHost);
  return windowConnection;
}
