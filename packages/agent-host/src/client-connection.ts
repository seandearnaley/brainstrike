import type { HostAttachment, HostRecord } from '@brainstrike/host-lease';
import type { MessageConnection } from 'vscode-jsonrpc';
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
  MCP_PRESENTATION_EVENT,
  MCP_SETTINGS_EVENT,
  type McpPresentationEvent,
  McpPresentationEventSchema,
  type McpSettingsEvent,
  McpSettingsEventSchema,
  parseHostParams,
} from './protocol.js';

export interface HostClient extends HostAttachment {
  /** BST-1932: told the thread whose children changed status; re-read `thread/children`. */
  onChildrenChanged(listener: (threadId: string) => void): () => void;
  onEvent(listener: (row: HostLogRow) => void): () => void;
  /** MCP task changes and server input, after this client's `mcp/presentation/subscribe`. */
  onMcpPresentation(listener: (event: McpPresentationEvent) => void): () => void;
  /** MCP settings changes, after this client's `mcp/settings/subscribe`. */
  onMcpSettings(listener: (event: McpSettingsEvent) => void): () => void;
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
  const settingsListeners = new Set<(event: McpSettingsEvent) => void>();
  const presentationListeners = new Set<(event: McpPresentationEvent) => void>();
  const childListeners = new Set<(threadId: string) => void>();
  const closeConnection = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      connection.dispose();
    } catch (cause) {
      failures.push(cause);
    }
    listeners.clear();
    settingsListeners.clear();
    presentationListeners.clear();
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
  connection.onNotification(MCP_SETTINGS_EVENT, (input: unknown) => {
    const event = McpSettingsEventSchema.parse(input);
    for (const listener of settingsListeners) {
      listener(event);
    }
  });
  connection.onNotification(MCP_PRESENTATION_EVENT, (input: unknown) => {
    const event = McpPresentationEventSchema.parse(input);
    for (const listener of presentationListeners) {
      listener(event);
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
    onMcpPresentation: (listener) => {
      presentationListeners.add(listener);
      return () => presentationListeners.delete(listener);
    },
    onMcpSettings: (listener) => {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    record,
    request: async <M extends HostMethod>(
      method: M,
      params: HostParams<M>
    ): Promise<HostResults[M]> =>
      HOST_RESULT_SCHEMAS[method].parse(
        await connection.sendRequest(method, parseHostParams(method, params))
      ) as HostResults[M],
  };
}
