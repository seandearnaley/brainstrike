import {
  createMcpHandler,
  isLegacyRequest,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { createMcpLabLoopback } from './loopback-http.js';
import { createReferenceServer } from './reference-server.js';
import { getMcpLabScenario, type McpLabScenario } from './scenario.js';

export interface McpLabCleanupReport {
  readonly httpListenersClosed: number;
  readonly stdioTransportsClosed: number;
  readonly untriggeredFaultIds: readonly string[];
}

export interface McpLabInProcessHttpEndpoint {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly kind: 'in-process-http';
  readonly url: URL;
}

export interface McpLabLoopbackHttpEndpoint {
  readonly kind: 'loopback-http';
  readonly url: URL;
}

export type McpLabEndpoint = McpLabInProcessHttpEndpoint | McpLabLoopbackHttpEndpoint;

export interface McpLabSession {
  close(): Promise<McpLabCleanupReport>;
  readonly closed: boolean;
  readonly endpoint: McpLabEndpoint;
  readonly scenario: McpLabScenario;
}

export interface StartMcpLabScenarioOptions {
  readonly execution: 'in-process' | 'loopback';
}

interface CloseResource {
  close(): Promise<void>;
  closed: boolean;
  readonly kind: 'handler' | 'http-listener';
}

function parseStartOptions(options: unknown): Readonly<StartMcpLabScenarioOptions> {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('Invalid MCP lab start options: expected an object');
  }
  const record = options as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'execution') {
    throw new Error('Invalid MCP lab start options: expected only "execution"');
  }
  let execution: unknown;
  try {
    execution = record['execution'];
  } catch {
    throw new Error('Invalid MCP lab start options: could not snapshot execution');
  }
  if (execution !== 'in-process' && execution !== 'loopback') {
    throw new Error('Invalid MCP lab start options: execution must be "in-process" or "loopback"');
  }
  return Object.freeze({ execution });
}

function createReferenceHandler(scenario: McpLabScenario): McpHttpHandler {
  const handler = createMcpHandler(createReferenceServer, {
    legacy: scenario.protocol.era === 'legacy' ? 'stateless' : 'reject',
  });
  if (scenario.protocol.era !== 'legacy') {
    return handler;
  }
  return {
    bus: handler.bus,
    close: handler.close,
    async fetch(request, options) {
      if (!(await isLegacyRequest(request))) {
        return Response.json({ error: 'mcp_lab_legacy_only' }, { status: 404 });
      }
      return handler.fetch(request, options);
    },
    notify: handler.notify,
  };
}

function createSession(
  scenario: McpLabScenario,
  endpoint: McpLabEndpoint,
  resources: CloseResource[]
): McpLabSession {
  let closed = false;
  let closePromise: Promise<McpLabCleanupReport> | undefined;
  const guardedEndpoint =
    endpoint.kind === 'in-process-http'
      ? Object.freeze({
          ...endpoint,
          fetch: async (input: string | URL | Request, init?: RequestInit) => {
            if (closed) {
              throw new Error('MCP lab session is closed');
            }
            return endpoint.fetch(input, init);
          },
        })
      : endpoint;
  return Object.freeze({
    close(): Promise<McpLabCleanupReport> {
      if (closePromise) {
        return closePromise;
      }
      closePromise = Promise.allSettled(
        resources
          .filter((resource) => !resource.closed)
          .map(async (resource) => {
            await resource.close();
            resource.closed = true;
          })
      ).then((results) => {
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (errors.length > 0) {
          closePromise = undefined;
          throw errors.length === 1
            ? errors[0]
            : new AggregateError(errors, 'MCP lab cleanup failed');
        }
        closed = resources.every((resource) => resource.closed);
        return Object.freeze({
          httpListenersClosed: resources.filter(
            (resource) => resource.kind === 'http-listener' && resource.closed
          ).length,
          stdioTransportsClosed: 0,
          untriggeredFaultIds: Object.freeze([]),
        });
      });
      return closePromise;
    },
    get closed() {
      return closed;
    },
    endpoint: guardedEndpoint,
    scenario,
  });
}

function createInProcessSession(scenario: McpLabScenario): McpLabSession {
  const handler = createReferenceHandler(scenario);
  const endpointUrl = new URL('http://mcp-lab.invalid/mcp');
  return createSession(
    scenario,
    Object.freeze({
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url !== endpointUrl.href) {
          throw new Error(
            `MCP lab request URL does not match the advertised endpoint: expected ${endpointUrl.href}, received ${request.url}`
          );
        }
        return handler.fetch(request);
      },
      kind: 'in-process-http' as const,
      url: endpointUrl,
    }),
    [{ close: handler.close, closed: false, kind: 'handler' }]
  );
}

async function createLoopbackSession(scenario: McpLabScenario): Promise<McpLabSession> {
  const handler = createReferenceHandler(scenario);
  let loopback: Awaited<ReturnType<typeof createMcpLabLoopback>>;
  try {
    loopback = await createMcpLabLoopback(handler);
  } catch (startError) {
    try {
      await handler.close();
    } catch (cleanupError) {
      throw new AggregateError([startError, cleanupError], 'MCP lab loopback startup failed');
    }
    throw startError;
  }
  return createSession(
    scenario,
    Object.freeze({ kind: 'loopback-http' as const, url: loopback.url }),
    [
      { close: loopback.close, closed: false, kind: 'http-listener' },
      { close: handler.close, closed: false, kind: 'handler' },
    ]
  );
}

export async function startMcpLabScenario(
  id: string,
  options: StartMcpLabScenarioOptions
): Promise<McpLabSession> {
  const startOptions = parseStartOptions(options);
  const scenario = getMcpLabScenario(id);
  if (scenario.availability !== 'executable' || scenario.transport !== 'streamable-http') {
    throw new Error(`MCP lab scenario "${scenario.id}" is not executable`);
  }
  return startOptions.execution === 'in-process'
    ? createInProcessSession(scenario)
    : createLoopbackSession(scenario);
}
