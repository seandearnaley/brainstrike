import type { HostAttachment, HostRecord } from '@brainstrike/host-lease';
import { CancellationTokenSource, type MessageConnection } from 'vscode-jsonrpc';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_CHILDREN_CHANGED,
  HOST_RESULT_SCHEMAS,
  HostChildrenChangedSchema,
  type HostLogRow,
  HostLogRowSchema,
  type HostMethod,
  type HostParams,
  type HostResults,
  parseHostParams,
} from './protocol.js';

export interface HostClient extends HostAttachment {
  /** BST-1932: told the thread whose children changed status; re-read `thread/children`. */
  onChildrenChanged(listener: (threadId: string) => void): () => void;
  onEvent(listener: (row: HostLogRow) => void): () => void;
  /** An abort sends the request's JSON-RPC cancellation; the host settles it. */
  request<M extends HostMethod>(
    method: M,
    params: HostParams<M>,
    signal?: AbortSignal
  ): Promise<HostResults[M]>;
}
/** Browser-safe connection; the private lease record comes from the owning launcher. */
export async function authenticateHostClient(
  connection: MessageConnection,
  record: HostRecord,
  closeTransport: () => Promise<void>,
  transportClosed: Promise<void>
): Promise<HostClient> {
  const listeners = new Set<(row: HostLogRow) => void>();
  const childListeners = new Set<(threadId: string) => void>();
  const closeConnection = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      connection.dispose();
    } catch (cause) {
      failures.push(cause);
    }
    listeners.clear();
    childListeners.clear();
    try {
      await closeTransport();
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Host client disposal and transport close failed');
    }
  };
  connection.onNotification('log/event', (input: unknown) => {
    const row = HostLogRowSchema.parse(input);
    for (const listener of listeners) {
      listener(row);
    }
  });
  connection.onNotification(HOST_CHILDREN_CHANGED, (input: unknown) => {
    const { threadId } = HostChildrenChangedSchema.parse(input);
    for (const listener of childListeners) {
      listener(threadId);
    }
  });
  connection.listen();
  try {
    const reply = HOST_RESULT_SCHEMAS.initialize.parse(
      await connection.sendRequest('initialize', {
        hostVersion: record.hostVersion,
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        token: record.token,
      })
    );
    if (
      reply.pid !== record.pid ||
      reply.start !== record.start ||
      reply.hostVersion !== record.hostVersion ||
      reply.protocolVersion !== record.protocolVersion
    ) {
      throw new Error('Host initialize reply does not match its lease record');
    }
  } catch (cause) {
    try {
      await closeConnection();
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], 'Host initialize and cleanup failed');
    }
    throw cause;
  }
  return {
    close: closeConnection,
    closed: transportClosed,
    onChildrenChanged: (listener) => {
      childListeners.add(listener);
      return () => childListeners.delete(listener);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record,
    request: async <M extends HostMethod>(
      method: M,
      params: HostParams<M>,
      signal?: AbortSignal
    ): Promise<HostResults[M]> => {
      const parsed = parseHostParams(method, params);
      if (!signal) {
        return HOST_RESULT_SCHEMAS[method].parse(
          await connection.sendRequest(method, parsed)
        ) as HostResults[M];
      }
      signal.throwIfAborted();
      const cancellation = new CancellationTokenSource();
      const cancel = (): void => cancellation.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        return HOST_RESULT_SCHEMAS[method].parse(
          await connection.sendRequest(method, parsed, cancellation.token)
        ) as HostResults[M];
      } finally {
        signal.removeEventListener('abort', cancel);
        cancellation.dispose();
      }
    },
  };
}
