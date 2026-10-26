import { BoundaryFailureError, INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import { wireDecoder, wireResultDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { createLogger } from '@brainstrike/logging';
import { Schema, SchemaIssue } from 'effect';
import { CancellationTokenSource, type MessageConnection } from 'vscode-jsonrpc';
import { watchPeerReset } from './boundary-wire.ts';
import { createHostCatalogClient, type HostCatalog } from './catalog/transport.ts';
import { markHostClosing, markHostDrained, sendHostRequest } from './client-request.ts';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  GIT_WORKSPACE_EVENT,
  type GitWorkspaceEvent,
  GitWorkspaceEventSchema,
  HOST_CHILDREN_CHANGED,
  HOST_CLOSING_EVENT,
  HOST_DRAINED_EVENT,
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
  TERMINAL_EVENT,
  type TerminalEvent,
  TerminalEventSchema,
} from './protocol.ts';
/**
 * What a client expects the host's initialize to answer. A socket client knows the
 * host's record and presents its token; a client on a transport its launcher handed
 * over knows only the versions it speaks.
 */
export interface HostClientExpectation {
  readonly hostVersion: string;
  readonly pid?: number;
  readonly protocolVersion: number;
  readonly start?: string;
  readonly token?: string;
}
export interface HostClient {
  readonly catalog: HostCatalog;
  close(): Promise<void>;
  readonly closed: Promise<void>;
  /** The host this client initialized with: its process and versions. */
  readonly host: HostResults['initialize'];
  /** BST-1932: told the thread whose children changed status; re-read `thread/children`. */
  onChildrenChanged(listener: (threadId: string) => void): () => void;
  onEvent(listener: (row: HostLogRow) => void): () => void;
  /** Repository and pull-request changes, after this client's `workspace/git/subscribe`. */
  onGitWorkspace(listener: (event: GitWorkspaceEvent) => void): () => void;
  /** MCP task changes and server input, after this client's `mcp/presentation/subscribe`. */
  onMcpPresentation(listener: (event: McpPresentationEvent) => void): () => void;
  /** MCP settings changes, after this client's `mcp/settings/subscribe`. */
  onMcpSettings(listener: (event: McpSettingsEvent) => void): () => void;
  /** A subscribed thread's live tool telemetry; never committed, so a reload shows none. */
  onTelemetry(listener: (telemetry: HostRunTelemetry) => void): () => void;
  /** Output and exits of the terminals this client created. */
  onTerminal(listener: (event: TerminalEvent) => void): () => void;
  /** An abort sends the request's JSON-RPC cancellation; the host settles it. */
  request<M extends HostMethod>(
    method: M,
    params: HostParams<M>,
    signal?: AbortSignal
  ): Promise<HostResults[M]>;
}
const logger = createLogger('AgentHostClient');
/** A failed response becomes the host's typed failure (or the internal fault), never raw text. */
async function sendTyped(
  connection: MessageConnection,
  method: string,
  send: () => Promise<unknown>
): Promise<unknown> {
  return await sendHostRequest(connection, send, (message, fields) =>
    logger.error(message, { ...fields, method })
  );
}
/** A result this client cannot read is logged, and its user sees the internal fault. */
function readResult<M extends HostMethod>(method: M, result: unknown): HostResults[M] {
  // Widened once: indexing the result map by a generic method is too deep for tsc.
  const schema: Schema.ConstraintDecoder<unknown> = HOST_RESULT_SCHEMAS[method];
  const parsed = wireResultDecoder(schema, { errors: 'all', onExcessProperty: 'error' })(result);
  if (parsed._tag === 'Success') {
    return parsed.success as HostResults[M];
  }
  const correlationId = crypto.randomUUID();
  logger.error('The agent host sent a result this client cannot read', {
    correlationId,
    issues: SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue).issues,
    method,
  });
  throw new BoundaryFailureError({ ...INTERNAL_FAULT, correlationId }, { cause: parsed.failure });
}
/** Browser-safe connection; what it expects of the host comes from the owning launcher. */
export async function authenticateHostClient<E extends HostClientExpectation>(
  connection: MessageConnection,
  record: E,
  closeTransport: () => Promise<void>,
  transportClosed: Promise<void>
): Promise<HostClient & { readonly record: E }> {
  const listeners = new Set<(row: HostLogRow) => void>();
  const settingsListeners = new Set<(event: McpSettingsEvent) => void>();
  const gitWorkspaceListeners = new Set<(event: GitWorkspaceEvent) => void>();
  const presentationListeners = new Set<(event: McpPresentationEvent) => void>();
  const terminalListeners = new Set<(event: TerminalEvent) => void>();
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
    gitWorkspaceListeners.clear();
    presentationListeners.clear();
    terminalListeners.clear();
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
  // Before any request: a host that closes its end can fail the next write.
  watchPeerReset(connection);
  connection.onNotification(HOST_CLOSING_EVENT, () => markHostClosing(connection));
  connection.onNotification(HOST_DRAINED_EVENT, () => markHostDrained(connection));
  // A transport that closes, the host killed included, rejects every request still pending.
  // The JSON-RPC connection rejects them only when disposed, never when its reader ends.
  transportClosed.then(
    () => connection.dispose(),
    () => connection.dispose()
  );
  connection.onNotification('log/event', (input: unknown) => {
    const row = Schema.decodeUnknownSync(HostLogRowSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(input);
    for (const listener of listeners) {
      listener(row);
    }
  });
  connection.onNotification(HOST_CHILDREN_CHANGED, (input: unknown) => {
    const { threadId } = Schema.decodeUnknownSync(HostChildrenChangedSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(input);
    for (const listener of childListeners) {
      listener(threadId);
    }
  });
  connection.onNotification(MCP_SETTINGS_EVENT, (input: unknown) => {
    const event = wireDecoder(McpSettingsEventSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(input);
    for (const listener of settingsListeners) {
      listener(event);
    }
  });
  connection.onNotification(GIT_WORKSPACE_EVENT, (input: unknown) => {
    const event = wireDecoder(GitWorkspaceEventSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(input);
    for (const listener of gitWorkspaceListeners) {
      listener(event);
    }
  });
  connection.onNotification(TERMINAL_EVENT, (input: unknown) => {
    const event = wireDecoder(TerminalEventSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(input);
    for (const listener of terminalListeners) {
      listener(event);
    }
  });
  connection.onNotification(MCP_PRESENTATION_EVENT, (input: unknown) => {
    const event = wireDecoder(McpPresentationEventSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(input);
    for (const listener of presentationListeners) {
      listener(event);
    }
  });
  connection.onNotification(HOST_RUN_TELEMETRY, (input: unknown) => {
    const telemetry = Schema.decodeUnknownSync(HostRunTelemetrySchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(input);
    for (const listener of telemetryListeners) {
      listener(telemetry);
    }
  });
  connection.listen();
  let reply: HostResults['initialize'];
  try {
    reply = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS.initialize, {
      errors: 'all',
      onExcessProperty: 'error',
    })(
      await connection.sendRequest('initialize', {
        hostVersion: record.hostVersion,
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        ...(record.token === undefined ? {} : { token: record.token }),
      })
    );
    if (
      (record.pid !== undefined && reply.pid !== record.pid) ||
      (record.start !== undefined && reply.start !== record.start) ||
      reply.hostVersion !== record.hostVersion ||
      reply.protocolVersion !== record.protocolVersion
    ) {
      throw new Error('Host initialize reply does not match what this client expects');
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
    host: reply,
    onChildrenChanged: (listener) => {
      childListeners.add(listener);
      return () => childListeners.delete(listener);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onGitWorkspace: (listener) => {
      gitWorkspaceListeners.add(listener);
      return () => gitWorkspaceListeners.delete(listener);
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
    onTerminal: (listener) => {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
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
          await sendTyped(connection, method, () => connection.sendRequest(method, parsed))
        );
      }
      signal.throwIfAborted();
      const cancellation = new CancellationTokenSource();
      const cancel = (): void => cancellation.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        return readResult(
          method,
          await sendTyped(connection, method, () =>
            connection.sendRequest(method, parsed, cancellation.token)
          )
        );
      } finally {
        signal.removeEventListener('abort', cancel);
        cancellation.dispose();
      }
    },
  };
}
