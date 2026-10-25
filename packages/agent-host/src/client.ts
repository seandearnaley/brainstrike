import { Socket } from 'node:net';
import { runWithTimeout } from '@brainstrike/effect-kit';
import {
  decodeHostRecord,
  HOST_LEASE_CONNECTION_CLOSED,
  HOST_STARTUP_TIMEOUT_MS,
  HOST_VERSION,
  HostLeaseRefusalError,
  type HostRecord,
} from '@brainstrike/host-lease';
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { authenticateHostClient, type HostClient } from './client-connection.ts';
import { closeReceivedConnection } from './client-receive-lifetime.ts';
import { AGENT_HOST_PROTOCOL_VERSION } from './protocol.ts';

export { authenticateHostClient, type HostClient } from './client-connection.ts';

function compatibleRecord(input: HostRecord): HostRecord {
  const record = decodeHostRecord(input);
  if (
    record.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION ||
    record.hostVersion !== HOST_VERSION
  ) {
    throw new Error('Host has an incompatible protocol or version');
  }
  return record;
}

/** Connect and initialize on the record's socket; `signal` destroys the socket and rejects. */
async function connectAgentHost(record: HostRecord, signal: AbortSignal): Promise<HostClient> {
  signal.throwIfAborted();
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
  const aborted = (): void => {
    socket.destroy();
  };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.once('close', () =>
        reject(
          new HostLeaseRefusalError(
            HOST_LEASE_CONNECTION_CLOSED,
            'Host socket closed before connect'
          )
        )
      );
      socket.connect(record.endpoint);
    });
    reader = new StreamMessageReader(socket);
    connection = createMessageConnection(reader, new StreamMessageWriter(socket));
    connection.onError(([cause]) => receivedFailures.add(cause));
    return await authenticateHostClient(connection, record, close, completion.promise);
  } catch (cause) {
    socket.destroy();
    await completion.promise.catch(() => undefined);
    throw signal.aborted ? signal.reason : cause;
  } finally {
    signal.removeEventListener('abort', aborted);
  }
}

/**
 * Attaches to an agent host this process did not start (a CLI `host start`).
 * R5(a), the R2 exception: bounded, because a live but unreachable owner that
 * is not ours is refused at `timeoutMs`, never waited on, killed or replaced.
 * `cancel` (the caller's cancellation, such as quit) ends it sooner, with its
 * own reason (BST-2279).
 */
export async function attachAgentHost(
  input: HostRecord,
  timeoutMs = HOST_STARTUP_TIMEOUT_MS,
  cancel?: AbortSignal
): Promise<HostClient> {
  const record = compatibleRecord(input);
  let attaching: Promise<HostClient> | undefined;
  try {
    return await runWithTimeout(
      (signal) => {
        attaching = connectAgentHost(record, signal);
        return attaching;
      },
      {
        onTimeout: () => new Error(`Host pid ${record.pid} initialize/attach timed out`),
        signal: cancel,
        timeoutMs,
      }
    );
  } catch (cause) {
    // The abandoned attempt's socket is closed and joined before the refusal.
    const late = await attaching?.catch(() => undefined);
    await late?.close().catch(() => undefined);
    throw cause;
  }
}

/**
 * Attaches to the agent host this process started, from the record its ready
 * report carried (lifecycle R2/R3): no deadline. It fails only when that
 * host's socket errors or closes, or when `signal` aborts because the host
 * exited or its owner is closing.
 */
export async function attachStartedAgentHost(
  input: HostRecord,
  signal: AbortSignal
): Promise<HostClient> {
  return await connectAgentHost(compatibleRecord(input), signal);
}
