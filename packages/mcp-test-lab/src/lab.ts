import { fileURLToPath } from 'node:url';
import {
  createMcpHandler,
  isLegacyRequest,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import {
  type McpLabClaimedFaultPlan,
  startWithClaimedMcpLabFaultPlan,
} from './fault-plan-claim.js';
import {
  createMcpLabFaultRuntime,
  McpLabDroppedResponseError,
  type McpLabFaultRuntime,
} from './fault-runtime.js';
import {
  assertScenarioFaultCompatibility,
  isMcpLabFaultPlan,
  type McpLabFaultPlan,
  type McpLabProtocolPhase,
} from './faults.js';
import {
  IN_PROCESS_HTTP_FAULT_SCOPES,
  LOOPBACK_HTTP_FAULT_SCOPES,
  McpLabHttpFaultExecutor,
  OAUTH_OUTER_FAULT_SCOPES,
  withMcpLabHttpFaults,
} from './http-fault-handler.js';
import { createMcpLabLoopback } from './loopback-http.js';
import {
  createMcpOAuthReferenceEndpoint,
  createMcpOAuthReferenceHandler,
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
  createMcpOAuthAuthorizationResponseVerifier,
  type McpOAuthAuthorizationResponseVerifierOptions,
} from './oauth-reference.js';

export interface McpLabDiagnostic {
  readonly correlationId: string;
  readonly kind: 'child-stderr' | 'handler-error';
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
  readonly faultPlan?: McpLabFaultPlan;
}

type McpLabHttpScenarioId = Exclude<McpLabScenarioId, 'stdio-reference'>;
type McpLabNonOAuthHttpScenarioId = Exclude<McpLabHttpScenarioId, 'oauth-reference'>;
interface ParsedStartOptions extends Readonly<Partial<StartMcpLabScenarioOptions>> {
  readonly executionProvided: boolean;
}

const STDIO_FAULT_PHASE_POLICY = {
  authorization: 'defer',
  'child-process': 'execute',
  initialization: 'execute',
  operation: 'execute',
  shutdown: 'execute',
  subscription: 'execute',
  transport: 'defer',
} as const satisfies Readonly<Record<McpLabProtocolPhase, 'defer' | 'execute'>>;

function parseStartOptions(options: unknown): ParsedStartOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('Invalid MCP lab start options: expected an object');
  }
  const record = options as Readonly<Record<string, unknown>>;
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => key !== 'execution' && key !== 'faultPlan')) {
    throw new Error(
      'Invalid MCP lab start options: expected only optional "execution" and "faultPlan"'
    );
  }
  let execution: unknown;
  let faultPlan: unknown;
  try {
    execution = Object.hasOwn(record, 'execution') ? record['execution'] : undefined;
    faultPlan = Object.hasOwn(record, 'faultPlan') ? record['faultPlan'] : undefined;
  } catch {
    throw new Error('Invalid MCP lab start options: could not snapshot input');
  }
  if (execution !== undefined && execution !== 'in-process' && execution !== 'loopback') {
    throw new Error('Invalid MCP lab start options: execution must be "in-process" or "loopback"');
  }
  if (faultPlan !== undefined && !isMcpLabFaultPlan(faultPlan)) {
    throw new Error('Invalid MCP lab fault plan');
  }
  return Object.freeze({
    ...(execution === undefined ? {} : { execution }),
    executionProvided: keys.includes('execution'),
    ...(faultPlan === undefined ? {} : { faultPlan }),
  });
}

function recordHandlerError(
  diagnostics: McpLabDiagnostic[],
  correlationId: string,
  error: unknown
): void {
  if (diagnostics.length >= 64) {
    return;
  }
  diagnostics.push(
    Object.freeze({
      correlationId,
      kind: 'handler-error' as const,
      message:
        error instanceof McpLabDroppedResponseError
          ? `MCP lab fault "${error.faultId}" dropped the response`
          : 'MCP lab HTTP handler failed',
    })
  );
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
  oauthStateCounts?: () => McpOAuthReferenceStateCounts,
  faultRuntime?: McpLabFaultRuntime
): McpLabSession {
  const cleanup = createMcpLabSessionCleanup({
    faultRuntime,
    oauthStateCounts,
    resources,
  });
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

function createInProcessSession(
  scenario: McpLabScenario,
  faultPlan: McpLabClaimedFaultPlan | undefined
): McpLabSession {
  const diagnostics: McpLabDiagnostic[] = [];
  const faultRuntime = createMcpLabFaultRuntime(faultPlan, scenario.id);
  const handler = createReferenceHandler(scenario);
  const guarded = withMcpLabHttpFaults(
    handler,
    faultRuntime,
    (correlationId, error) => recordHandlerError(diagnostics, correlationId, error),
    scenario.protocol.era,
    IN_PROCESS_HTTP_FAULT_SCOPES
  );
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
        return guarded.fetch(request);
      },
      kind: 'in-process-http' as const,
      url: endpointUrl,
    }),
    [{ close: guarded.close, closed: false, kind: 'handler' }],
    diagnostics,
    undefined,
    faultRuntime
  );
}

async function createLoopbackSession(
  scenario: McpLabScenario,
  faultPlan: McpLabClaimedFaultPlan | undefined
): Promise<McpLabSession> {
  const diagnostics: McpLabDiagnostic[] = [];
  const faultRuntime = createMcpLabFaultRuntime(faultPlan, scenario.id);
  const recordError = (correlationId: string, error: unknown) =>
    recordHandlerError(diagnostics, correlationId, error);
  const faultExecutor = new McpLabHttpFaultExecutor(
    faultRuntime,
    scenario.protocol.era,
    recordError
  );
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
              {
                beforeAuthorizationMutation: (request, method) =>
                  faultExecutor.injectAuthorizationFault(request, method),
                async beforeMcpDispatch(request) {
                  await faultExecutor.injectAuthenticatedProtocolFault(request);
                  return faultExecutor.parsedBodyFor(request);
                },
              }
            );
            return oauthHandler;
          }
        : downstream,
      {
        faultExecutor,
        faultScopes:
          scenario.id === 'oauth-reference' ? OAUTH_OUTER_FAULT_SCOPES : LOOPBACK_HTTP_FAULT_SCOPES,
      }
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
    diagnostics,
    activeOAuthHandler ? () => activeOAuthHandler.stateCounts() : undefined,
    faultRuntime
  );
}

function createStdioSession(
  scenario: McpLabScenario,
  faultPlan: McpLabClaimedFaultPlan | undefined
): McpLabSession {
  const diagnostics: McpLabDiagnostic[] = [];
  const faultRuntime = createMcpLabFaultRuntime(faultPlan, scenario.id);
  let stderrByteCount = 0;
  const args = Object.freeze([
    fileURLToPath(new URL('../fixtures/stdio-reference-server.mjs', import.meta.url)),
  ]);
  const command = process.execPath;
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const env = Object.freeze({});
  const transport = new McpLabOwnedStdioTransport(
    { args, command, cwd, env, era: scenario.protocol.era },
    (byteCount) => {
      stderrByteCount += byteCount;
      diagnostics[0] = Object.freeze({
        correlationId: 'stdio-reference:child:1',
        kind: 'child-stderr' as const,
        message: `captured ${stderrByteCount} stderr bytes`,
      });
    },
    faultRuntime
  );
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
    diagnostics,
    undefined,
    faultRuntime
  );
}

export function startMcpLabScenario(
  id: 'stdio-reference',
  options?: { readonly execution?: never; readonly faultPlan?: McpLabFaultPlan }
): Promise<McpLabSession>;
export function startMcpLabScenario(
  id: 'oauth-reference',
  options: { readonly execution: 'loopback'; readonly faultPlan?: McpLabFaultPlan }
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
  if (scenario.id === 'stdio-reference') {
    if (startOptions.executionProvided) {
      throw new Error('MCP lab stdio scenario does not accept execution');
    }
    assertScenarioFaultCompatibility(startOptions.faultPlan, scenario, undefined);
    if (
      startOptions.faultPlan &&
      Object.entries(STDIO_FAULT_PHASE_POLICY).some(
        ([phase, policy]) =>
          policy === 'defer' &&
          startOptions.faultPlan?.hasRemainingPhase(phase as McpLabProtocolPhase)
      )
    ) {
      throw new Error('MCP lab stdio protocol fault execution is not available in this layer');
    }
    return startWithClaimedMcpLabFaultPlan(startOptions.faultPlan, (claimedFaultPlan) =>
      createStdioSession(scenario, claimedFaultPlan)
    );
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
  assertScenarioFaultCompatibility(startOptions.faultPlan, scenario, startOptions.execution);
  return startWithClaimedMcpLabFaultPlan(startOptions.faultPlan, (claimedFaultPlan) =>
    startOptions.execution === 'in-process'
      ? createInProcessSession(scenario, claimedFaultPlan)
      : createLoopbackSession(scenario, claimedFaultPlan)
  );
}
