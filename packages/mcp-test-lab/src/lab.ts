import {
  createMcpHandler,
  isLegacyRequest,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
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

export interface McpLabSession {
  close(): Promise<McpLabCleanupReport>;
  readonly closed: boolean;
  readonly endpoint: McpLabInProcessHttpEndpoint;
  readonly scenario: McpLabScenario;
}

export interface StartMcpLabScenarioOptions {
  readonly execution: 'in-process';
}

function parseStartOptions(options: unknown): void {
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
  if (execution !== 'in-process') {
    throw new Error('Invalid MCP lab start options: execution must be "in-process"');
  }
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

function createSession(scenario: McpLabScenario, handler: McpHttpHandler): McpLabSession {
  let closed = false;
  let closePromise: Promise<McpLabCleanupReport> | undefined;
  const endpointUrl = new URL('http://mcp-lab.invalid/mcp');
  const report = Object.freeze({
    httpListenersClosed: 0,
    stdioTransportsClosed: 0,
    untriggeredFaultIds: Object.freeze([]),
  });
  return Object.freeze({
    close(): Promise<McpLabCleanupReport> {
      if (closePromise) {
        return closePromise;
      }
      closePromise = handler.close().then(
        () => {
          closed = true;
          return report;
        },
        (error: unknown) => {
          closePromise = undefined;
          throw error;
        }
      );
      return closePromise;
    },
    get closed() {
      return closed;
    },
    endpoint: Object.freeze({
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        if (closed) {
          throw new Error('MCP lab session is closed');
        }
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
    scenario,
  });
}

export async function startMcpLabScenario(
  id: string,
  options: StartMcpLabScenarioOptions
): Promise<McpLabSession> {
  parseStartOptions(options);
  const scenario = getMcpLabScenario(id);
  if (scenario.availability !== 'executable' || scenario.transport !== 'streamable-http') {
    throw new Error(`MCP lab scenario "${scenario.id}" is not executable over in-process HTTP`);
  }
  return createSession(scenario, createReferenceHandler(scenario));
}
