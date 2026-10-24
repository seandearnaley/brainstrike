import { fileURLToPath } from 'node:url';
import {
  createMcpHandler,
  isLegacyRequest,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { createMcpLabLoopback } from './loopback-http.js';
import {
  createMcpOAuthReferenceEndpoint,
  createMcpOAuthReferenceHandler,
  type McpOAuthAuthorizationHold,
  type McpOAuthReferenceEndpoint,
  type McpOAuthReferenceHandler,
  type McpOAuthReferenceStateCounts,
} from './oauth-reference.js';
import { createReferenceServerFactory } from './reference-server.js';
import { getMcpLabScenario, type McpLabScenario, type McpLabScenarioId } from './scenario.js';
import {
  createMcpLabSessionCleanup,
  type McpLabCleanupReport,
  type McpLabCleanupResource,
} from './session-cleanup.js';
import { McpLabOwnedStdioTransport } from './stdio-transport.js';

export type { McpLabCleanupReport } from './session-cleanup.js';

export interface McpLabInProcessHttpEndpoint {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly kind: 'in-process-http';
  readonly url: URL;
}

export interface McpLabLoopbackHttpEndpoint {
  readonly kind: 'loopback-http';
  readonly url: URL;
}

export interface McpLabOAuthReferenceEndpoint extends McpOAuthReferenceEndpoint {
  stateCounts(): McpOAuthReferenceStateCounts;
}

export interface McpLabStdioEndpoint {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly kind: 'stdio';
  readonly transport: McpLabOwnedStdioTransport;
}

export type McpLabEndpoint =
  | McpLabInProcessHttpEndpoint
  | McpLabLoopbackHttpEndpoint
  | McpLabOAuthReferenceEndpoint
  | McpLabStdioEndpoint;

export {
  createMcpOAuthAuthorizationHold,
  createMcpOAuthAuthorizationResponseVerifier,
  type McpOAuthAuthorizationHold,
  type McpOAuthAuthorizationHoldState,
  type McpOAuthAuthorizationResponseVerifierOptions,
} from './oauth-reference.js';

export interface McpLabDiagnostic {
  readonly correlationId: string;
  readonly kind: 'child-stderr';
  readonly message: string;
}

export interface McpLabSession {
  close(): Promise<McpLabCleanupReport>;
  readonly closed: boolean;
  diagnostics(): readonly McpLabDiagnostic[];
  readonly endpoint: McpLabEndpoint;
  readonly scenario: McpLabScenario;
}

export interface StartMcpLabScenarioOptions {
  readonly execution: 'in-process' | 'loopback';
}

export interface StartMcpLabOAuthScenarioOptions {
  readonly authorizationHold?: McpOAuthAuthorizationHold;
  readonly execution: 'loopback';
}

type McpLabHttpScenarioId = Exclude<McpLabScenarioId, 'stdio-reference'>;
type McpLabNonOAuthHttpScenarioId = Exclude<McpLabHttpScenarioId, 'oauth-reference'>;
interface ParsedStartOptions {
  readonly authorizationHold?: McpOAuthAuthorizationHold;
  readonly execution?: 'in-process' | 'loopback';
  readonly executionProvided: boolean;
}

function parseStartOptions(options: unknown): ParsedStartOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('Invalid MCP lab start options: expected an object');
  }
  const record = options as Readonly<Record<string, unknown>>;
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => key !== 'execution' && key !== 'authorizationHold')) {
    throw new Error(
      'Invalid MCP lab start options: expected only optional "execution" and "authorizationHold"'
    );
  }
  let execution: unknown;
  let authorizationHold: unknown;
  try {
    execution = Object.hasOwn(record, 'execution') ? record['execution'] : undefined;
    authorizationHold = Object.hasOwn(record, 'authorizationHold')
      ? record['authorizationHold']
      : undefined;
  } catch {
    throw new Error('Invalid MCP lab start options: could not snapshot input');
  }
  if (execution !== undefined && execution !== 'in-process' && execution !== 'loopback') {
    throw new Error('Invalid MCP lab start options: execution must be "in-process" or "loopback"');
  }
  return Object.freeze({
    ...(authorizationHold === undefined
      ? {}
      : { authorizationHold: authorizationHold as McpOAuthAuthorizationHold }),
    ...(execution === undefined ? {} : { execution }),
    executionProvided: keys.includes('execution'),
  });
}

function createReferenceHandler(scenario: McpLabScenario): McpHttpHandler {
  const handler = createMcpHandler(createReferenceServerFactory(scenario.fixture), {
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
  resources: McpLabCleanupResource[],
  diagnostics: McpLabDiagnostic[] = [],
  oauthStateCounts?: () => McpOAuthReferenceStateCounts
): McpLabSession {
  const cleanup = createMcpLabSessionCleanup({ oauthStateCounts, resources });
  const guardedEndpoint =
    endpoint.kind === 'in-process-http'
      ? Object.freeze({
          ...endpoint,
          fetch: async (input: string | URL | Request, init?: RequestInit) => {
            if (cleanup.closed) {
              throw new Error('MCP lab session is closed');
            }
            return endpoint.fetch(input, init);
          },
        })
      : endpoint;
  return Object.freeze({
    close: cleanup.close,
    get closed() {
      return cleanup.closed;
    },
    diagnostics: () => Object.freeze(diagnostics.map((value) => Object.freeze({ ...value }))),
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

async function createLoopbackSession(
  scenario: McpLabScenario,
  authorizationHold: McpOAuthAuthorizationHold | undefined
): Promise<McpLabSession> {
  const downstream = createReferenceHandler(scenario);
  let loopback: Awaited<ReturnType<typeof createMcpLabLoopback>>;
  let oauthHandler: McpOAuthReferenceHandler | undefined;
  try {
    loopback = await createMcpLabLoopback(
      scenario.id === 'oauth-reference'
        ? (origin) => {
            oauthHandler = createMcpOAuthReferenceHandler(
              downstream,
              createMcpOAuthReferenceEndpoint(origin),
              authorizationHold ? { authorizationHold } : {}
            );
            return oauthHandler;
          }
        : downstream
    );
  } catch (startError) {
    try {
      await downstream.close();
    } catch (cleanupError) {
      throw new AggregateError([startError, cleanupError], 'MCP lab loopback startup failed');
    }
    throw startError;
  }
  const activeOAuthHandler = oauthHandler;
  const endpoint: McpLabEndpoint = activeOAuthHandler
    ? Object.freeze({
        ...activeOAuthHandler.endpoint,
        stateCounts: () => activeOAuthHandler.stateCounts(),
      })
    : Object.freeze({ kind: 'loopback-http' as const, url: loopback.url });
  return createSession(
    scenario,
    endpoint,
    [
      { close: loopback.close, closed: false, kind: 'http-listener' },
      { close: loopback.handler.close, closed: false, kind: 'handler' },
    ],
    [],
    activeOAuthHandler ? () => activeOAuthHandler.stateCounts() : undefined
  );
}

function createStdioSession(scenario: McpLabScenario): McpLabSession {
  const diagnostics: McpLabDiagnostic[] = [];
  let stderrByteCount = 0;
  const args = Object.freeze([
    fileURLToPath(new URL('../fixtures/stdio-reference-server.mjs', import.meta.url)),
  ]);
  const command = process.execPath;
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const env = Object.freeze({});
  const transport = new McpLabOwnedStdioTransport({ args, command, cwd, env }, (byteCount) => {
    stderrByteCount += byteCount;
    diagnostics[0] = Object.freeze({
      correlationId: 'stdio-reference:child:1',
      kind: 'child-stderr' as const,
      message: `captured ${stderrByteCount} stderr bytes`,
    });
  });
  return createSession(
    scenario,
    Object.freeze({ args, command, cwd, env, kind: 'stdio' as const, transport }),
    [
      {
        close: () => transport.close(),
        closed: false,
        counted: () => transport.wasSpawned,
        kind: 'stdio-transport',
      },
    ],
    diagnostics
  );
}

export function startMcpLabScenario(
  id: 'stdio-reference',
  options?: { readonly execution?: never }
): Promise<McpLabSession>;
export function startMcpLabScenario(
  id: 'oauth-reference',
  options: StartMcpLabOAuthScenarioOptions
): Promise<McpLabSession>;
export function startMcpLabScenario(
  id: McpLabNonOAuthHttpScenarioId,
  options: StartMcpLabScenarioOptions
): Promise<McpLabSession>;
export async function startMcpLabScenario(
  id: string,
  options: unknown = {}
): Promise<McpLabSession> {
  const startOptions = parseStartOptions(options);
  const scenario = getMcpLabScenario(id);
  if (startOptions.authorizationHold !== undefined && scenario.id !== 'oauth-reference') {
    throw new Error('MCP lab authorization hold is available only for the OAuth scenario');
  }
  if (scenario.id === 'stdio-reference') {
    if (startOptions.executionProvided) {
      throw new Error('MCP lab stdio scenario does not accept execution');
    }
    return createStdioSession(scenario);
  }
  if (scenario.availability !== 'executable' || scenario.transport !== 'streamable-http') {
    throw new Error(`MCP lab scenario "${scenario.id}" is not executable`);
  }
  if (startOptions.execution === undefined) {
    throw new Error('MCP lab HTTP scenario requires explicit execution');
  }
  if (scenario.id === 'oauth-reference' && startOptions.execution !== 'loopback') {
    throw new Error('MCP lab OAuth scenario requires a loopback listener');
  }
  return startOptions.execution === 'in-process'
    ? createInProcessSession(scenario)
    : await createLoopbackSession(scenario, startOptions.authorizationHold);
}
