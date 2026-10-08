import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
// @boundaries-ignore packaged verification exercises the local Apps package before production registration exports it to Desktop.
import type {
  McpAppPreparedToolCall,
  McpAppToolCall,
} from '../../../../packages/mcp-app-host/src/index';

export interface LoopbackServerSnapshot {
  readonly abortedRequests: number;
  readonly activeRequests: number;
  readonly completedRequests: number;
  readonly listening: boolean;
  readonly openSockets: number;
  readonly pendingPreparedCalls: number;
  readonly totalRequests: number;
}

export interface LoopbackToolServer {
  readonly close: () => Promise<void>;
  readonly installAdmission: (
    prepare: (call: McpAppToolCall) => Promise<McpAppPreparedToolCall>
  ) => void;
  readonly origin: string;
  readonly prepareFailures: () => readonly Readonly<{ message: string; stack?: string }>[];
  readonly prepareRequests: () => number;
  readonly snapshot: () => LoopbackServerSnapshot;
}

type AdmissionPreparer = (call: McpAppToolCall) => Promise<McpAppPreparedToolCall>;
type PreparedCall = Readonly<{ generation: number; prepared: McpAppPreparedToolCall }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAdmissionCall(value: unknown): McpAppToolCall {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 6) {
    throw new TypeError('BST-1571 admission call must be an exact record');
  }
  const id = value['id'];
  if (
    value['audience'] !== 'app' ||
    value['serverId'] !== 'linear' ||
    value['toolName'] !== 'create_issue' ||
    !Number.isSafeInteger(value['generation']) ||
    !(typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) ||
    !isRecord(value['input'])
  ) {
    throw new TypeError('BST-1571 admission call fields are invalid');
  }
  return Object.freeze({
    audience: 'app',
    generation: value['generation'] as number,
    id,
    input: Object.freeze({ ...value['input'] }),
    serverId: 'linear',
    toolName: 'create_issue',
  });
}

function reply(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status);
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    body += chunk;
  }
  return JSON.parse(body);
}

/**
 * Loopback stand-in for the ordinary admission + tool execution path the
 * packaged MCP Apps verifier drives: `/prepare`, `/execute`, `/release`, and
 * the `/tool` endpoint whose completion/abort counters the spec asserts on.
 */
export async function createLoopbackToolServer(): Promise<LoopbackToolServer> {
  const sockets = new Set<Socket>();
  const preparedCalls = new Map<string, PreparedCall>();
  let admissionPreparer: AdmissionPreparer | undefined;
  let abortedRequests = 0;
  let activeRequests = 0;
  let completedRequests = 0;
  let totalRequests = 0;
  const prepareFailures: Readonly<{ message: string; stack?: string }>[] = [];
  let prepareRequests = 0;

  const handlePrepare = async (
    payload: Readonly<Record<string, unknown>>,
    response: ServerResponse
  ): Promise<void> => {
    prepareRequests += 1;
    try {
      if (!admissionPreparer) {
        throw new Error('BST-1571 ordinary admission is unavailable');
      }
      if (Reflect.ownKeys(payload).length !== 2) {
        throw new TypeError('BST-1571 preparation request must be an exact record');
      }
      const call = parseAdmissionCall(payload['call']);
      const preparationId = payload['preparationId'];
      // `mcp-app-preparation-<authority uuid>-<generation>-<sequence>`: ids are
      // unique per authority instance, and the generation must be the call's.
      if (
        typeof preparationId !== 'string' ||
        preparationId.length > 128 ||
        !new RegExp(
          String.raw`^mcp-app-preparation-[0-9a-f-]{36}-${call.generation}-\d+$`,
          'u'
        ).test(preparationId)
      ) {
        throw new TypeError('BST-1571 preparation id is invalid');
      }
      if (preparedCalls.has(preparationId)) {
        throw new TypeError('BST-1571 preparation id was reused');
      }
      const prepared = await admissionPreparer(call);
      preparedCalls.set(preparationId, Object.freeze({ generation: call.generation, prepared }));
      if (call.input['mode'] === 'hold-prepare-response') {
        return;
      }
      reply(response, 200, {
        decision: prepared.decision,
        riskCategory: prepared.riskCategory,
        token: preparationId,
      });
    } catch (error: unknown) {
      prepareFailures.push({
        message: String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      });
      reply(response, 400, { code: 'admission_rejected' });
    }
  };

  const handleExecute = async (
    payload: Readonly<Record<string, unknown>>,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const token = payload['token'];
    const entry = typeof token === 'string' ? preparedCalls.get(token) : undefined;
    if (!entry || Reflect.ownKeys(payload).length !== 1) {
      reply(response, 409, { code: 'prepared_call_unavailable' });
      return;
    }
    preparedCalls.delete(token as string);
    const controller = new AbortController();
    const abort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(new Error('BST-1571 admission client disconnected'));
      }
    };
    request.once('aborted', abort);
    response.once('close', () => {
      if (!response.writableEnded) {
        abort();
      }
    });
    try {
      const result = await entry.prepared.execute({ signal: controller.signal });
      if (!response.destroyed) {
        reply(response, 200, result);
      }
    } catch {
      if (!response.destroyed) {
        reply(response, 502, { code: 'ordinary_execution_failed' });
      }
    }
  };

  const handleRelease = (
    payload: Readonly<Record<string, unknown>>,
    response: ServerResponse
  ): void => {
    const preparationId = payload['preparationId'];
    if (typeof preparationId === 'string' && Reflect.ownKeys(payload).length === 1) {
      reply(response, 200, { released: preparedCalls.delete(preparationId) });
      return;
    }
    const generation = payload['generation'];
    if (!Number.isSafeInteger(generation) || Reflect.ownKeys(payload).length !== 1) {
      reply(response, 400, { code: 'invalid_release' });
      return;
    }
    let released = 0;
    for (const [token, entry] of preparedCalls) {
      if (entry.generation === generation) {
        preparedCalls.delete(token);
        released += 1;
      }
    }
    reply(response, 200, { released });
  };

  const handleTool = (
    payload: Readonly<Record<string, unknown>>,
    response: ServerResponse
  ): void => {
    totalRequests += 1;
    activeRequests += 1;
    let settled = false;
    const settle = (outcome: 'aborted' | 'completed'): void => {
      if (settled) {
        return;
      }
      settled = true;
      activeRequests -= 1;
      if (outcome === 'aborted') {
        abortedRequests += 1;
      } else {
        completedRequests += 1;
      }
    };
    response.once('finish', () => settle('completed'));
    response.once('close', () => {
      if (!response.writableEnded) {
        settle('aborted');
      }
    });
    if (payload['mode'] === 'hold') {
      return;
    }
    if (payload['mode'] === 'failure') {
      reply(response, 503, { code: 'fixture_failure' });
      return;
    }
    reply(response, 200, { content: [{ text: 'created', type: 'text' }] });
  };

  const server: Server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Connection', 'close');
    response.setHeader('Content-Type', 'application/json');
    let payload: unknown;
    try {
      payload = await readJsonBody(request);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        reply(response, 400, { code: 'invalid_json' });
        return;
      }
      response.destroy();
      return;
    }
    if (request.method !== 'POST' || !isRecord(payload)) {
      reply(response, 400, { code: 'invalid_request' });
      return;
    }
    switch (request.url) {
      case '/prepare':
        await handlePrepare(payload, response);
        return;
      case '/execute':
        await handleExecute(payload, request, response);
        return;
      case '/release':
        handleRelease(payload, response);
        return;
      case '/tool':
        handleTool(payload, response);
        return;
      default:
        reply(response, 404, { code: 'not_found' });
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('BST-1571 loopback tool server address is unavailable');
  }
  let closed = false;
  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      preparedCalls.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      );
    },
    installAdmission: (prepare) => {
      if (admissionPreparer) {
        throw new Error('BST-1571 ordinary admission is already installed');
      }
      admissionPreparer = prepare;
    },
    origin: `http://127.0.0.1:${address.port}`,
    prepareFailures: () => [...prepareFailures],
    prepareRequests: () => prepareRequests,
    snapshot: () => ({
      abortedRequests,
      activeRequests,
      completedRequests,
      listening: server.listening,
      openSockets: sockets.size,
      pendingPreparedCalls: preparedCalls.size,
      totalRequests,
    }),
  };
}
