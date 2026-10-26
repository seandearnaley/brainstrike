import { createLogger } from '@brainstrike/logging';
import {
  type Client,
  type SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { ExplicitHttpMcpFetch } from './explicit-http-client-types.ts';

const logger = createLogger('McpHttpConnectionCleanup');

interface OwnedHttpConnection {
  readonly capabilityLease: { close: () => Promise<unknown> };
  readonly client: Client;
  readonly disconnected: boolean;
  readonly transport: SSEClientTransport | StreamableHTTPClientTransport;
}

/**
 * The session DELETE is the server's farewell, not local cleanup: close sends
 * it and never joins it (ADR-0031). The SDK sends it on the transport's abort
 * signal, which the local close aborts at once, so the DELETE alone leaves that
 * signal behind and outlives the connection it ends.
 */
export function sessionTerminationOutlivesClose(fetch: ExplicitHttpMcpFetch): ExplicitHttpMcpFetch {
  return (url, init) => {
    if (init?.method !== 'DELETE') {
      return fetch(url, init);
    }
    const { signal: _closedWithConnection, ...farewell } = init;
    return fetch(url, farewell);
  };
}

export async function closeOwnedHttpConnection(connection: OwnedHttpConnection): Promise<void> {
  if (
    !connection.disconnected &&
    connection.transport instanceof StreamableHTTPClientTransport &&
    connection.transport.sessionId
  ) {
    void connection.transport.terminateSession().catch((error: unknown) => {
      logger.warn('MCP session termination failed', { error });
    });
  }
  const errors: unknown[] = [];
  try {
    await connection.capabilityLease.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await connection.client.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'MCP owned local cleanup failed');
  }
}
