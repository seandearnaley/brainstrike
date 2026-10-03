import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import type { McpLabSession } from '../../../../packages/mcp-test-lab/dist/index.js';

export interface PendingInputWireRecord {
  readonly method: string;
  readonly sequence: number;
  readonly taskId?: string;
  readonly toolName?: string;
}

export interface PendingInputFixtureSnapshot {
  readonly activeRequests: number;
  readonly cancellationAcknowledged: boolean;
  readonly heldTerminalPolls: number;
  readonly listening: boolean;
  readonly openSockets: number;
  readonly requests: readonly PendingInputWireRecord[];
}

export interface PendingInputFixture {
  close(): Promise<void>;
  releaseTerminalObservation(): void;
  snapshot(): PendingInputFixtureSnapshot;
  readonly url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65_536) {
      throw new Error('BST-1948 fixture request exceeds its 64 KiB bound');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function wireRecord(body: Buffer, sequence: number): PendingInputWireRecord | undefined {
  if (body.length === 0) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  if (!isRecord(parsed) || typeof parsed['method'] !== 'string') {
    throw new Error('BST-1948 fixture expects one JSON-RPC request');
  }
  const params = parsed['params'];
  return {
    method: parsed['method'],
    sequence,
    ...(isRecord(params) && typeof params['taskId'] === 'string'
      ? { taskId: params['taskId'] }
      : {}),
    ...(isRecord(params) && typeof params['name'] === 'string' ? { toolName: params['name'] } : {}),
  };
}

/**
 * Uses the unchanged public SDK-backed tasks-reference server. This loopback
 * relay records actual wire methods and holds post-cancel polls at the server
 * boundary, so an acknowledgement cannot masquerade as observed cancellation.
 * It never creates task state or responds on behalf of the reference server.
 */
export async function startPendingInputFixture(): Promise<PendingInputFixture> {
  const moduleUrl = pathToFileURL(
    path.resolve(process.cwd(), '../../packages/mcp-test-lab/dist/index.js')
  ).href;
  const lab: {
    startMcpLabScenario(
      id: 'tasks-reference',
      options: { readonly execution: 'loopback' }
    ): Promise<McpLabSession>;
  } = await import(moduleUrl);
  const session = await lab.startMcpLabScenario('tasks-reference', { execution: 'loopback' });
  if (session.endpoint.kind !== 'loopback-http') {
    await session.close();
    throw new Error('BST-1948 requires the real loopback Tasks reference transport');
  }
  const upstreamUrl = session.endpoint.url;
  const requests: PendingInputWireRecord[] = [];
  const sockets = new Set<Socket>();
  const failures: unknown[] = [];
  const terminalGate = Promise.withResolvers<void>();
  let released = false;
  let cancellationReceived = false;
  let cancellationAcknowledged = false;
  let activeRequests = 0;
  let heldTerminalPolls = 0;
  const server = createServer((incoming, outgoing) => {
    activeRequests += 1;
    const abort = new AbortController();
    const finish = (): void => {
      activeRequests -= 1;
      abort.abort();
    };
    outgoing.once('close', finish);
    void (async () => {
      const body = await readBody(incoming);
      const record = wireRecord(body, requests.length + 1);
      if (record) {
        requests.push(record);
      }
      if (record?.method === 'tasks/cancel') {
        cancellationReceived = true;
      }
      if (record?.method === 'tasks/get' && cancellationReceived && !released) {
        heldTerminalPolls += 1;
        await terminalGate.promise;
      }
      if (abort.signal.aborted) {
        return;
      }
      const upstream = httpRequest(new URL(incoming.url ?? '/mcp', upstreamUrl), {
        headers: { ...incoming.headers, host: upstreamUrl.host },
        method: incoming.method,
        signal: abort.signal,
      });
      const reply = await new Promise<IncomingMessage>((resolve, reject) => {
        upstream.once('response', resolve);
        upstream.once('error', reject);
        upstream.end(body);
      });
      if (record?.method === 'tasks/cancel' && reply.statusCode === 200) {
        cancellationAcknowledged = true;
      }
      outgoing.writeHead(reply.statusCode ?? 500, reply.headers);
      await pipeline(reply, outgoing);
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) {
        failures.push(error);
        outgoing.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await session.close();
    throw error;
  }
  const address = server.address();
  if (!(address && typeof address === 'object')) {
    throw new Error('BST-1948 fixture has no assigned loopback port');
  }
  return {
    async close(): Promise<void> {
      released = true;
      terminalGate.resolve();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      const report = await session.close();
      if (report.httpListenersClosed !== 1 || report.untriggeredFaultIds.length !== 0) {
        throw new Error('BST-1948 Tasks reference cleanup is incomplete');
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'BST-1948 wire relay failed');
      }
    },
    releaseTerminalObservation(): void {
      released = true;
      terminalGate.resolve();
    },
    snapshot: () => ({
      activeRequests,
      cancellationAcknowledged,
      heldTerminalPolls,
      listening: server.listening,
      openSockets: sockets.size,
      requests: requests.map((record) => ({ ...record })),
    }),
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}
