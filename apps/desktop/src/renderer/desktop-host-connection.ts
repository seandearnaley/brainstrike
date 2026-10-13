import type { HostClient } from '@brainstrike/agent-host/browser';
import { createLogger } from '@brainstrike/logging';
import { isRetiredAgentAttachment, retiredAgentAttachment } from '../agent-host-attachment';
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

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

async function closeClient(client: HostClient): Promise<void> {
  const outcomes = await Promise.allSettled([(async () => client.close())(), client.closed]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : []
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Agent client physical close failed');
  }
}

/**
 * One owner for the frame's host client (BST-2004). When the client closes
 * without the frame asking, it requests a replacement through Main's
 * `agent:host-connect`. Main alone owns the restart allowance. A refused
 * replacement stays failed until explicit Reconnect; the frame owns no retry policy.
 */
export function createDesktopHostConnection(
  connect: (intent?: 'reconnect') => Promise<HostClient>
): DesktopHostConnection {
  let state: DesktopHostConnectionState = { kind: 'idle' };
  let generation = 0;
  let attempt: Promise<HostClient> | undefined;
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
        waiter.reject(retiredAgentAttachment());
      }
    }
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const start = (automatic: boolean, intent?: 'reconnect'): Promise<HostClient> => {
    const current = connect(intent).then(async (client) => {
      if (closing) {
        await closeClient(client);
        throw retiredAgentAttachment();
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
        if (isRetiredAgentAttachment(cause)) {
          publish({ kind: 'closed' });
          return;
        }
        logger.error('The agent host connection failed', { error: cause });
        if (!closing) {
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
    logger.warn('The agent host connection closed; asking Main for its admitted replacement');
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
        await closeClient(client);
      }
      if (settled?.status === 'rejected' && !isRetiredAgentAttachment(settled.reason)) {
        throw settled.reason;
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
          window.addEventListener(
            'beforeunload',
            () => {
              void close().catch((error: unknown) =>
                logger.error('The agent host view failed to close', { error })
              );
            },
            { once: true }
          );
          return start(false);
        case 'failed':
          return Promise.reject(new Error(state.error));
        default:
          return Promise.reject(retiredAgentAttachment());
      }
    },
    getSnapshot: () => state,
    reconnect: () => {
      if (closing || state.kind !== 'failed') {
        return;
      }
      start(false, 'reconnect').catch(() => undefined);
    },
    replacement: (lostClient) => {
      if (state.kind === 'connected' && state.client !== lostClient) {
        return Promise.resolve(state.client);
      }
      if (closing || state.kind === 'closed') {
        return Promise.reject(retiredAgentAttachment());
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
