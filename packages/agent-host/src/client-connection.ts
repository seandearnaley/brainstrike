import { BoundaryFailureError, INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import type { HostAttachment, HostRecord } from '@brainstrike/host-lease';
import { createLogger } from '@brainstrike/logging';
import { CancellationTokenSource, type MessageConnection } from 'vscode-jsonrpc';
import type { ZodType } from 'zod';
import { fromBoundaryResponseError } from './boundary-wire.js';
import { createHostCatalogClient, type HostCatalog } from './catalog/transport.js';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_CHILDREN_CHANGED,
  HOST_RESULT_SCHEMAS,
  HOST_RUN_TELEMETRY,
  HostChildrenChangedSchema,
  type HostLogRow,
  HostLogRowSchema,
  type HostMethod,
  type HostParams,
  type HostResults,
  type HostRunTelemetry,
  HostRunTelemetrySchema,
  MCP_PRESENTATION_EVENT,
  MCP_SETTINGS_EVENT,
  type McpPresentationEvent,
  McpPresentationEventSchema,
  type McpSettingsEvent,
  McpSettingsEventSchema,
  parseHostParams,
} from './protocol.js';

export interface HostClient extends HostAttachment {
  readonly catalog: HostCatalog;
  /** BST-1932: told the thread whose children changed status; re-read `thread/children`. */
  onChildrenChanged(listener: (threadId: string) => void): () => void;
  onEvent(listener: (row: HostLogRow) => void): () => void;
  /** MCP task changes and server input, after this client's `mcp/presentation/subscribe`. */
  onMcpPresentation(listener: (event: McpPresentationEvent) => void): () => void;
  /** MCP settings changes, after this client's `mcp/settings/subscribe`. */
  onMcpSettings(listener: (event: McpSettingsEvent) => void): () => void;
  /** A subscribed thread's live tool telemetry; never committed, so a reload shows none. */
  onTelemetry(listener: (telemetry: HostRunTelemetry) => void): () => void;
  /** An abort sends the request's JSON-RPC cancellation; the host settles it. */
  request<M extends HostMethod>(
    method: M,
    params: HostParams<M>,
    signal?: AbortSignal
  ): Promise<HostResults[M]>;
}
const logger = createLogger('AgentHostClient');

/** A failed response becomes the host's typed failure (or the internal fault), never raw text. */
async function sendTyped(method: string, send: () => Promise<unknown>): Promise<unknown> {
  try {
    return await send();
  } catch (cause) {
    throw fromBoundaryResponseError(cause, (message, fields) =>
      logger.error(message, { ...fields, method })
    );
  }
}

/** A result this client cannot read is logged, and its user sees the internal fault. */
function readResult<M extends HostMethod>(method: M, result: unknown): HostResults[M] {
  // Widened once: indexing the result map by a generic method is too deep for tsc.
  const schema: ZodType<unknown> = HOST_RESULT_SCHEMAS[method];
  const parsed = schema.safeParse(result);
  if (parsed.success) {
    return parsed.data as HostResults[M];
  }
  const correlationId = crypto.randomUUID();
  logger.error('The agent host sent a result this client cannot read', {
    correlationId,
    issues: parsed.error.issues,
    method,
  });
  throw new BoundaryFailureError({ ...INTERNAL_FAULT, correlationId }, { cause: parsed.error });
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
  const telemetryListeners = new Set<(telemetry: HostRunTelemetry) => void>();
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
    telemetryListeners.clear();
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
  connection.onNotification(HOST_RUN_TELEMETRY, (input: unknown) => {
    const telemetry = HostRunTelemetrySchema.parse(input);
    for (const listener of telemetryListeners) {
      listener(telemetry);
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
    catalog: createHostCatalogClient(connection),
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
    onTelemetry: (listener) => {
      telemetryListeners.add(listener);
      return () => telemetryListeners.delete(listener);
    },
    record,
    request: async <M extends HostMethod>(
      method: M,
      params: HostParams<M>,
      signal?: AbortSignal
    ): Promise<HostResults[M]> => {
      const parsed = parseHostParams(method, params);
      if (!signal) {
        return readResult(
          method,
          await sendTyped(method, () => connection.sendRequest(method, parsed))
        );
      }
      signal.throwIfAborted();
      const cancellation = new CancellationTokenSource();
      const cancel = (): void => cancellation.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        return readResult(
          method,
          await sendTyped(method, () => connection.sendRequest(method, parsed, cancellation.token))
        );
      } finally {
        signal.removeEventListener('abort', cancel);
        cancellation.dispose();
      }
    },
  };
}
