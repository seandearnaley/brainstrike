import { Socket } from 'node:net';
import { runWithTimeout } from '@brainstrike/effect-kit';
import { decodeHostRecord, HOST_VERSION, type HostRecord } from '@brainstrike/host-lease';
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { authenticateHostClient, type HostClient } from './client-connection.js';
import { closeReceivedConnection } from './client-receive-lifetime.js';
import { AGENT_HOST_PROTOCOL_VERSION } from './protocol.js';

export { authenticateHostClient, type HostClient } from './client-connection.js';

/** Same bounded attachment primitive and timeout as the existing host lease. */
export async function attachAgentHost(input: HostRecord, timeoutMs = 1500): Promise<HostClient> {
  const record = decodeHostRecord(input);
  if (
    record.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION ||
    record.hostVersion !== HOST_VERSION
  ) {
    throw new Error('Host has an incompatible protocol or version');
  }
  const socket = new Socket();
  let reader: StreamMessageReader | undefined;
  let connection: MessageConnection | undefined;
  const receivedFailures = new Set<unknown>();
  const completion = Promise.withResolvers<void>();
  completion.promise.catch(() => undefined);
  socket.once('close', () => {
    // BST-1977: the final Stop frame was decoded but disposed before dispatch.
    void closeReceivedConnection(reader, connection, receivedFailures).then(
      completion.resolve,
      completion.reject
    );
  });
  socket.on('error', (error: Error) => receivedFailures.add(error));
  const close = async (): Promise<void> => {
    socket.destroy();
    await completion.promise;
  };
  try {
    return await runWithTimeout(
      async (signal) => {
        const aborted = (): void => {
          socket.destroy();
        };
        signal.addEventListener('abort', aborted, { once: true });
        try {
          await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
            socket.once('close', () => reject(new Error('Host socket closed before connect')));
            socket.connect(record.endpoint);
          });
          reader = new StreamMessageReader(socket);
          connection = createMessageConnection(reader, new StreamMessageWriter(socket));
          connection.onError(([cause]) => receivedFailures.add(cause));
          return await authenticateHostClient(connection, record, close, completion.promise);
        } finally {
          signal.removeEventListener('abort', aborted);
        }
      },
      {
        onTimeout: () => new Error(`Host pid ${record.pid} initialize/attach timed out`),
        timeoutMs,
      }
    );
  } catch (cause) {
    socket.destroy();
    await completion.promise.catch(() => undefined);
    throw cause;
  }
}
