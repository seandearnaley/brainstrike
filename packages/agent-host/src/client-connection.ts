import type { HostAttachment, HostRecord } from '@brainstrike/host-lease';
import type { MessageConnection } from 'vscode-jsonrpc';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_METHOD_SCHEMAS,
  HOST_RESULT_SCHEMAS,
  type HostLogRow,
  HostLogRowSchema,
  type HostMethod,
  type HostParams,
  type HostResults,
} from './protocol.js';

export interface HostClient extends HostAttachment {
  onEvent(listener: (row: HostLogRow) => void): () => void;
  request<M extends HostMethod>(method: M, params: HostParams<M>): Promise<HostResults[M]>;
}
/** Browser-safe connection; the private lease record comes from the owning launcher. */
export async function authenticateHostClient(
  connection: MessageConnection,
  record: HostRecord,
  closeTransport: () => Promise<void>,
  transportClosed: Promise<void>
): Promise<HostClient> {
  const listeners = new Set<(row: HostLogRow) => void>();
  connection.onNotification('log/event', (input: unknown) => {
    const row = HostLogRowSchema.parse(input);
    for (const listener of listeners) {
      listener(row);
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
    connection.dispose();
    await closeTransport();
    throw cause;
  }
  return {
    close: async () => {
      connection.dispose();
      listeners.clear();
      await closeTransport();
    },
    closed: transportClosed,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record,
    request: async <M extends HostMethod>(
      method: M,
      params: HostParams<M>
    ): Promise<HostResults[M]> =>
      HOST_RESULT_SCHEMAS[method].parse(
        await connection.sendRequest(method, HOST_METHOD_SCHEMAS[method].parse(params))
      ) as HostResults[M],
  };
}
