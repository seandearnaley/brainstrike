import {
  type Client,
  type SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const SESSION_TERMINATION_TIMEOUT_MS = 250;

interface OwnedHttpConnection {
  readonly capabilityLease: { close: () => Promise<unknown> };
  readonly client: Client;
  readonly disconnected: boolean;
  readonly transport: SSEClientTransport | StreamableHTTPClientTransport;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function closeOwnedHttpConnection(connection: OwnedHttpConnection): Promise<void> {
  const errors: unknown[] = [];
  if (
    !connection.disconnected &&
    connection.transport instanceof StreamableHTTPClientTransport &&
    connection.transport.sessionId
  ) {
    try {
      await withTimeout(
        connection.transport.terminateSession(),
        SESSION_TERMINATION_TIMEOUT_MS,
        `MCP session termination timed out after ${SESSION_TERMINATION_TIMEOUT_MS}ms`
      );
    } catch (error) {
      errors.push(error);
    }
  }
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
    throw new AggregateError(errors, 'MCP session termination or owned local cleanup failed');
  }
}
