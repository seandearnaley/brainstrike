import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  isLegacyRequest,
  type McpHttpHandler,
  OAuthError,
  OAuthErrorCode,
  type OAuthMetadata,
  oauthMetadataResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import type {
  McpLabFault,
  McpLabFaultPlan,
  McpLabProtocolMethod,
  McpLabProtocolPhase,
} from './faults.js';
import { protocolPhaseForMethod } from './faults.js';
import {
  closeLoopbackServer,
  listenLoopback,
  toCorrelatedNodeRequest,
  writeNodeResponse,
} from './node-loopback.js';
import { createReferenceServer } from './reference-server.js';
import { getMcpLabScenario, type McpLabScenario } from './scenario.js';
import { assertStartOptions, type StartMcpLabScenarioOptions } from './start-options.js';
import {
  requestIdKey,
  requestMethodFromMessage,
  responseIdKey,
  stdioChunkByteLength,
} from './stdio-utils.js';

export type { StartMcpLabScenarioOptions } from './start-options.js';

export interface McpLabCleanupReport {
  readonly httpListenersClosed: number;
  readonly stdioTransportsClosed: number;
  readonly untriggeredFaultIds: readonly string[];
}

export interface McpLabDiagnostic {
  readonly correlationId: string;
  readonly kind: 'child-stderr' | 'cleanup-error' | 'handler-error';
  readonly message: string;
}

export type McpLabEndpoint =
  | {
      readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
      readonly kind: 'in-process-http';
      readonly url: URL;
    }
  | { readonly kind: 'loopback-http'; readonly url: URL }
  | {
      readonly authorizationServerMetadataUrl: URL;
      readonly authorizationUrl: URL;
      readonly issuer: URL;
      readonly kind: 'oauth-loopback-http';
      readonly protectedResourceMetadataUrl: URL;
      readonly registrationUrl: URL;
      readonly tokenUrl: URL;
      readonly url: URL;
    }
  | {
      readonly args: readonly string[];
      readonly command: string;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly kind: 'stdio';
      readonly transport: McpLabOwnedStdioTransport;
    };

export interface McpLabOwnedStdioTransport extends Transport {
  readonly pid: number | null;
}

export interface McpLabSession {
  close: () => Promise<McpLabCleanupReport>;
  readonly closed: boolean;
  diagnostics: () => readonly McpLabDiagnostic[];
  endpoint: McpLabEndpoint;
  scenario: McpLabScenario;
}

interface AppliedFault {
  readonly fault: McpLabFault;
  readonly id: string;
}

const HTTP_PROTOCOL_COORDINATE_PHASES = [
  'initialization',
  'operation',
  'subscription',
] as const satisfies readonly McpLabProtocolPhase[];

interface CloseResource {
  close: () => Promise<void>;
  closed: boolean;
  readonly kind: 'handler' | 'http-listener' | 'stdio-transport';
}

interface RegisteredClient {
  readonly redirectUris: readonly string[];
}

interface AuthorizationCode {
  readonly challenge: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly scope: string;
}

interface AccessToken {
  readonly clientId: string;
  readonly expiresAt: number;
  readonly resource: string;
  readonly scope: string;
}

interface OAuthRuntime {
  readonly clients: Map<string, RegisteredClient>;
  readonly codes: Map<string, AuthorizationCode>;
  nextAccessToken(): string;
  nextAuthorizationCode(): string;
  nextClientId(): string;
  readonly tokens: Map<string, AccessToken>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class McpLabDroppedResponseError extends Error {
  constructor(faultId: string) {
    super(`MCP lab fault "${faultId}" dropped the response`);
    this.name = 'McpLabDroppedResponseError';
  }
}

function recordDiagnostic(list: McpLabDiagnostic[], value: McpLabDiagnostic): void {
  list.push(Object.freeze({ ...value }));
}

function createFaultRuntime(plan: McpLabFaultPlan | undefined, scenarioId: string) {
  const occurrences = new Map<string, number>();
  let correlationSequence = 0;
  return {
    consume(
      phase: McpLabProtocolPhase,
      method: McpLabProtocolMethod,
      correlationId: string
    ): AppliedFault | undefined {
      if (!plan) {
        return;
      }
      const key = `${phase}\u0000${method}`;
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      const fault = plan.consumeIfConfigured({ correlationId, method, occurrence, phase });
      if (!fault) {
        return;
      }
      const observation = plan.observations().at(-1);
      if (!observation || observation.correlationId !== correlationId) {
        throw new Error(`MCP lab fault observation missing for ${phase}/${method}`);
      }
      return { fault, id: observation.faultId };
    },
    nextCorrelation(label = 'exchange'): string {
      correlationSequence += 1;
      return `${scenarioId}:${label}:${correlationSequence}`;
    },
    requiresProtocolBodyCoordinate(): boolean {
      return (
        plan !== undefined &&
        HTTP_PROTOCOL_COORDINATE_PHASES.some((phase) => plan.hasRemainingPhase(phase))
      );
    },
    untriggeredIds(): readonly string[] {
      return plan?.untriggeredIds() ?? Object.freeze([]);
    },
  };
}

type FaultRuntime = ReturnType<typeof createFaultRuntime>;

function oauthFaultMethod(pathname: string): McpLabProtocolMethod | undefined {
  switch (pathname) {
    case '/.well-known/oauth-protected-resource/mcp':
      return 'oauth/protected-resource';
    case '/.well-known/oauth-authorization-server':
      return 'oauth/authorization-server';
    case '/authorize':
      return 'oauth/authorize';
    case '/callback':
      return 'oauth/callback';
    case '/register':
      return 'oauth/register';
    case '/revoke':
      return 'oauth/revoke';
    case '/token':
      return 'oauth/token';
    default:
      return;
  }
}

async function protocolCoordinate(
  request: Request
): Promise<
  { readonly method: McpLabProtocolMethod; readonly phase: McpLabProtocolPhase } | undefined
> {
  const oauth = oauthFaultMethod(new URL(request.url).pathname);
  if (oauth) {
    return { method: oauth, phase: 'authorization' };
  }
  let method = request.headers.get('mcp-method') ?? undefined;
  if (!method && request.method === 'POST') {
    try {
      const body: unknown = await request.clone().json();
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        const candidate = (body as Record<string, unknown>)['method'];
        method = typeof candidate === 'string' ? candidate : undefined;
      }
    } catch {
      return;
    }
  }
  if (!method) {
    return;
  }
  const phase = protocolPhaseForMethod(method);
  return phase &&
    (HTTP_PROTOCOL_COORDINATE_PHASES as readonly McpLabProtocolPhase[]).includes(phase)
    ? { method: method as McpLabProtocolMethod, phase }
    : undefined;
}

async function applyHttpFault(applied: AppliedFault): Promise<Response | undefined> {
  switch (applied.fault.kind) {
    case 'delay': {
      const { delayMs } = applied.fault;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return;
    }
    case 'drop_response':
      throw new McpLabDroppedResponseError(applied.id);
    case 'http_status':
      return Response.json(
        { error: 'mcp_lab_fault', faultId: applied.id },
        { status: applied.fault.status }
      );
    case 'malformed_json':
      return new Response(applied.fault.payload, {
        headers: { 'content-type': 'application/json' },
      });
    case 'cleanup_error':
    case 'child_exit':
    case 'child_stderr':
      throw new Error(`MCP lab fault "${applied.id}" cannot target an HTTP exchange`);
  }
}

async function consumeHttpFault(
  runtime: FaultRuntime,
  phase: McpLabProtocolPhase,
  method: McpLabProtocolMethod,
  correlationId: string
): Promise<Response | undefined> {
  const applied = runtime.consume(phase, method, correlationId);
  return applied ? applyHttpFault(applied) : undefined;
}

async function consumeProtocolHttpFault(
  runtime: FaultRuntime,
  request: Request,
  correlationId: string
): Promise<Response | undefined> {
  const oauthMethod = oauthFaultMethod(new URL(request.url).pathname);
  if (oauthMethod) {
    return consumeHttpFault(runtime, 'authorization', oauthMethod, correlationId);
  }
  if (!runtime.requiresProtocolBodyCoordinate()) {
    return;
  }
  const coordinate = await protocolCoordinate(request);
  if (!coordinate) {
    return;
  }
  return consumeHttpFault(runtime, coordinate.phase, coordinate.method, correlationId);
}

function withFaults(
  handler: McpHttpHandler,
  runtime: FaultRuntime,
  diagnostics: McpLabDiagnostic[]
): McpHttpHandler {
  return {
    bus: handler.bus,
    close: handler.close,
    async fetch(request, options) {
      const correlationId =
        request.headers.get('x-mcp-lab-correlation-id') ?? runtime.nextCorrelation();
      try {
        const requestFaultResponse = await consumeHttpFault(
          runtime,
          'transport',
          'http/request',
          correlationId
        );
        if (requestFaultResponse) {
          return requestFaultResponse;
        }
        const protocolFaultResponse = await consumeProtocolHttpFault(
          runtime,
          request,
          correlationId
        );
        if (protocolFaultResponse) {
          return protocolFaultResponse;
        }
        const response = await handler.fetch(request, options);
        return (
          (await consumeHttpFault(runtime, 'transport', 'http/response', correlationId)) ?? response
        );
      } catch (error) {
        recordDiagnostic(diagnostics, {
          correlationId,
          kind: 'handler-error',
          message: messageOf(error),
        });
        throw error;
      }
    },
    notify: handler.notify,
  };
}

function referenceHandler(scenario: McpLabScenario): McpHttpHandler {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oauthError(error: string, description: string): Response {
  return Response.json(
    { error, ['error_description']: description },
    { headers: { 'cache-control': 'no-store' }, status: 400 }
  );
}

function createOAuthRuntime(): OAuthRuntime {
  let clientSequence = 0;
  let codeSequence = 0;
  let tokenSequence = 0;
  return {
    clients: new Map(),
    codes: new Map(),
    nextAccessToken() {
      tokenSequence += 1;
      return `brainstrike-lab-access-${tokenSequence}`;
    },
    nextAuthorizationCode() {
      codeSequence += 1;
      return `brainstrike-lab-code-${codeSequence}`;
    },
    nextClientId() {
      clientSequence += 1;
      return `brainstrike-lab-client-${clientSequence}`;
    },
    tokens: new Map(),
  };
}

function createOAuthMetadata(
  endpoint: Extract<McpLabEndpoint, { readonly kind: 'oauth-loopback-http' }>
): OAuthMetadata {
  return {
    ['authorization_endpoint']: endpoint.authorizationUrl.href,
    ['authorization_response_iss_parameter_supported']: true,
    ['code_challenge_methods_supported']: ['S256'],
    ['grant_types_supported']: ['authorization_code'],
    issuer: endpoint.issuer.href,
    ['registration_endpoint']: endpoint.registrationUrl.href,
    ['response_types_supported']: ['code'],
    ['scopes_supported']: ['mcp'],
    ['token_endpoint']: endpoint.tokenUrl.href,
    ['token_endpoint_auth_methods_supported']: ['none'],
  };
}

async function registerOAuthClient(request: Request, runtime: OAuthRuntime): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { headers: { allow: 'POST' }, status: 405 });
  }
  const body: unknown = await request.json().catch(() => undefined);
  const bodyRecord = isRecord(body) ? body : undefined;
  const redirectUris = bodyRecord?.['redirect_uris'];
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every(
      (value): value is string => typeof value === 'string' && isLoopbackRedirect(value)
    )
  ) {
    return oauthError('invalid_client_metadata', 'Loopback redirect_uris are required');
  }
  const clientId = runtime.nextClientId();
  runtime.clients.set(clientId, { redirectUris: Object.freeze([...redirectUris]) });
  return Response.json(
    {
      ...bodyRecord,
      ['client_id']: clientId,
      ['client_id_issued_at']: 1_700_000_000,
      ['token_endpoint_auth_method']: 'none',
    },
    { status: 201 }
  );
}

function authorizeOAuthClient(
  request: Request,
  endpoint: Extract<McpLabEndpoint, { readonly kind: 'oauth-loopback-http' }>,
  runtime: OAuthRuntime
): Response {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const challenge = url.searchParams.get('code_challenge');
  const state = url.searchParams.get('state');
  const resource = url.searchParams.get('resource');
  if (
    request.method !== 'GET' ||
    url.searchParams.get('response_type') !== 'code' ||
    url.searchParams.get('code_challenge_method') !== 'S256' ||
    !clientId ||
    !redirectUri ||
    !challenge ||
    !state ||
    resource !== endpoint.url.href ||
    !runtime.clients.get(clientId)?.redirectUris.includes(redirectUri)
  ) {
    return oauthError('invalid_request', 'Authorization request is invalid');
  }
  const code = runtime.nextAuthorizationCode();
  runtime.codes.set(code, {
    challenge,
    clientId,
    redirectUri,
    resource,
    scope: url.searchParams.get('scope') ?? 'mcp',
  });
  const callback = new URL(redirectUri);
  callback.searchParams.set('code', code);
  callback.searchParams.set('iss', endpoint.issuer.href);
  callback.searchParams.set('state', state);
  return new Response(null, { headers: { location: callback.href }, status: 302 });
}

async function exchangeOAuthCode(request: Request, runtime: OAuthRuntime): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { headers: { allow: 'POST' }, status: 405 });
  }
  const form = new URLSearchParams(await request.text());
  const code = form.get('code');
  const record = code ? runtime.codes.get(code) : undefined;
  const verifier = form.get('code_verifier');
  const challenge = verifier
    ? createHash('sha256').update(verifier).digest('base64url')
    : undefined;
  if (
    form.get('grant_type') !== 'authorization_code' ||
    !code ||
    !record ||
    challenge !== record.challenge ||
    form.get('client_id') !== record.clientId ||
    form.get('redirect_uri') !== record.redirectUri ||
    form.get('resource') !== record.resource
  ) {
    return oauthError('invalid_grant', 'Authorization code or PKCE binding is invalid');
  }
  runtime.codes.delete(code);
  const accessToken = runtime.nextAccessToken();
  runtime.tokens.set(accessToken, {
    clientId: record.clientId,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    resource: record.resource,
    scope: record.scope,
  });
  return Response.json(
    {
      ['access_token']: accessToken,
      ['expires_in']: 300,
      scope: record.scope,
      ['token_type']: 'Bearer',
    },
    { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } }
  );
}

function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function oauthHandler(
  mcpHandler: McpHttpHandler,
  endpoint: Extract<McpLabEndpoint, { readonly kind: 'oauth-loopback-http' }>
): McpHttpHandler {
  const runtime = createOAuthRuntime();
  const metadata = createOAuthMetadata(endpoint);
  const gate = requireBearerAuth({
    requiredScopes: ['mcp'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(endpoint.url),
    verifier: {
      async verifyAccessToken(token) {
        const record = runtime.tokens.get(token);
        if (!record) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown access token');
        }
        return {
          clientId: record.clientId,
          expiresAt: record.expiresAt,
          resource: new URL(record.resource),
          scopes: record.scope.split(' '),
          token,
        };
      },
    },
  });
  return {
    bus: mcpHandler.bus,
    close: mcpHandler.close,
    async fetch(request, options) {
      const discovery = oauthMetadataResponse(request, {
        dangerouslyAllowInsecureIssuerUrl: true,
        oauthMetadata: metadata,
        resourceName: 'Brainstrike MCP Lab',
        resourceServerUrl: endpoint.url,
        scopesSupported: ['mcp'],
      });
      if (discovery) {
        return discovery;
      }
      const url = new URL(request.url);
      if (url.pathname === '/register') {
        return registerOAuthClient(request, runtime);
      }
      if (url.pathname === '/authorize') {
        return authorizeOAuthClient(request, endpoint, runtime);
      }
      if (url.pathname === '/token') {
        return exchangeOAuthCode(request, runtime);
      }
      if (url.pathname !== '/mcp') {
        return new Response('Not found', { status: 404 });
      }
      const auth = await gate(request);
      return auth instanceof Response
        ? auth
        : mcpHandler.fetch(request, { ...options, authInfo: auth });
    },
    notify: mcpHandler.notify,
  };
}

async function applyCleanupFault(fault: AppliedFault): Promise<void> {
  if (fault.fault.kind === 'delay') {
    const { delayMs } = fault.fault;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  if (fault.fault.kind === 'cleanup_error') {
    throw new Error(`MCP lab fault "${fault.id}" interrupted cleanup`);
  }
  throw new Error(
    `MCP lab fault "${fault.id}" of kind "${fault.fault.kind}" reached an incompatible cleanup coordinate`
  );
}

function session(
  endpoint: McpLabEndpoint,
  scenario: McpLabScenario,
  resources: CloseResource[],
  diagnostics: McpLabDiagnostic[],
  runtime: FaultRuntime
): McpLabSession {
  let closePromise: Promise<McpLabCleanupReport> | undefined;
  let didClose = false;
  return {
    close() {
      if (closePromise) {
        return closePromise;
      }
      closePromise = (async () => {
        await Promise.resolve();
        const correlationId = runtime.nextCorrelation('cleanup');
        try {
          const fault = runtime.consume('shutdown', 'transport/close', correlationId);
          if (fault) {
            await applyCleanupFault(fault);
          }
          const results = await Promise.allSettled(
            resources
              .filter((resource) => !resource.closed)
              .map(async (resource) => {
                await resource.close();
                resource.closed = true;
              })
          );
          const errors = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []
          );
          if (errors.length > 0) {
            throw errors.length === 1
              ? errors[0]
              : new AggregateError(errors, 'MCP lab cleanup failed');
          }
          didClose = resources.every((resource) => resource.closed);
          return Object.freeze({
            httpListenersClosed: resources.filter(
              (resource) => resource.kind === 'http-listener' && resource.closed
            ).length,
            stdioTransportsClosed: resources.filter(
              (resource) => resource.kind === 'stdio-transport' && resource.closed
            ).length,
            untriggeredFaultIds: runtime.untriggeredIds(),
          });
        } catch (error) {
          recordDiagnostic(diagnostics, {
            correlationId,
            kind: 'cleanup-error',
            message: messageOf(error),
          });
          throw error;
        } finally {
          if (!didClose) {
            closePromise = undefined;
          }
        }
      })();
      return closePromise;
    },
    get closed() {
      return didClose && resources.every((resource) => resource.closed);
    },
    diagnostics: () => Object.freeze(diagnostics.map((value) => Object.freeze({ ...value }))),
    endpoint,
    scenario,
  };
}

function inProcessSession(
  scenario: McpLabScenario,
  faultPlan: McpLabFaultPlan | undefined
): McpLabSession {
  const diagnostics: McpLabDiagnostic[] = [];
  const runtime = createFaultRuntime(faultPlan, scenario.id);
  const handler = referenceHandler(scenario);
  const guarded = withFaults(handler, runtime, diagnostics);
  return session(
    Object.freeze({
      fetch: (input: string | URL | Request, init?: RequestInit) =>
        guarded.fetch(new Request(input, init)),
      kind: 'in-process-http' as const,
      url: new URL('http://127.0.0.1/mcp'),
    }),
    scenario,
    [{ close: handler.close, closed: false, kind: 'handler' }],
    diagnostics,
    runtime
  );
}

function stdioSession(
  scenario: McpLabScenario,
  faultPlan: McpLabFaultPlan | undefined
): McpLabSession {
  const diagnostics: McpLabDiagnostic[] = [];
  const runtime = createFaultRuntime(faultPlan, scenario.id);
  const env: Record<string, string> = {};
  const args = Object.freeze([
    fileURLToPath(new URL('../fixtures/stdio-reference-server.mjs', import.meta.url)),
  ]);
  const command = process.execPath;
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const transport = new LabOwnedStdioTransport({ args, command, cwd, env }, runtime, diagnostics);
  return session(
    Object.freeze({
      args,
      command,
      cwd,
      env: Object.freeze(env),
      kind: 'stdio' as const,
      transport,
    }),
    scenario,
    [{ close: () => transport.close(), closed: false, kind: 'stdio-transport' }],
    diagnostics,
    runtime
  );
}

class LabOwnedStdioTransport implements McpLabOwnedStdioTransport {
  private closed = false;
  private delegate: StdioClientTransport | undefined;
  private readonly droppedResponseIds = new Set<string>();
  onclose: (() => void) | undefined;
  onerror: ((error: Error) => void) | undefined;
  onmessage: ((message: JSONRPCMessage) => void) | undefined;

  constructor(
    private readonly parameters: {
      readonly args: readonly string[];
      readonly command: string;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    },
    private readonly runtime: FaultRuntime,
    private readonly diagnostics: McpLabDiagnostic[]
  ) {}

  get pid(): number | null {
    return this.delegate?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error('MCP lab stdio transport is closed');
    }
    if (this.delegate) {
      throw new Error('MCP lab stdio transport is already started');
    }

    const env = { ...this.parameters.env };
    const correlationId = this.runtime.nextCorrelation('child');
    for (const method of ['child/spawn', 'child/stderr', 'child/exit'] as const) {
      const applied = this.runtime.consume('child-process', method, correlationId);
      if (applied) {
        applyStdioFault(env, applied);
      }
    }

    const delegate = new StdioClientTransport({
      args: [...this.parameters.args],
      command: this.parameters.command,
      cwd: this.parameters.cwd,
      env,
      stderr: 'pipe',
    });
    delegate.onclose = () => this.onclose?.();
    delegate.onerror = (error) => this.onerror?.(error);
    delegate.onmessage = (message) => {
      const responseId = responseIdKey(message);
      if (responseId && this.droppedResponseIds.delete(responseId)) {
        return;
      }
      this.onmessage?.(message);
    };
    delegate.stderr?.on('data', (chunk: unknown) => {
      recordDiagnostic(this.diagnostics, {
        correlationId,
        kind: 'child-stderr',
        message: `captured ${stdioChunkByteLength(chunk)} stderr bytes`,
      });
    });
    this.delegate = delegate;
    await delegate.start();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.delegate?.close();
    this.closed = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.delegate) {
      throw new Error('MCP lab stdio transport is not started');
    }
    const method = requestMethodFromMessage(message);
    if (method) {
      const phase = protocolPhaseForMethod(method);
      if (phase) {
        const applied = this.runtime.consume(
          phase,
          method as McpLabProtocolMethod,
          this.runtime.nextCorrelation('stdio')
        );
        if (applied) {
          await this.applyProtocolFault(message, applied);
        }
      }
    }
    await this.delegate.send(message);
  }

  private async applyProtocolFault(message: JSONRPCMessage, applied: AppliedFault): Promise<void> {
    if (applied.fault.kind === 'delay') {
      const { delayMs } = applied.fault;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return;
    }
    if (applied.fault.kind === 'drop_response') {
      const requestId = requestIdKey(message);
      if (!requestId) {
        throw new Error(`MCP lab fault "${applied.id}" requires a request id to drop its response`);
      }
      this.droppedResponseIds.add(requestId);
      return;
    }
    throw new Error(
      `MCP lab fault "${applied.id}" of kind "${applied.fault.kind}" cannot target a stdio protocol request`
    );
  }
}

function applyStdioFault(env: Record<string, string>, applied: AppliedFault): void {
  if (applied.fault.kind === 'delay') {
    env['MCP_LAB_START_DELAY_MS'] = String(applied.fault.delayMs);
    return;
  }
  if (applied.fault.kind === 'child_stderr') {
    env['MCP_LAB_STDERR_TEXT'] = applied.fault.text;
    return;
  }
  if (applied.fault.kind === 'child_exit') {
    env[applied.fault.code === null ? 'MCP_LAB_EXIT_SIGNAL' : 'MCP_LAB_EXIT_CODE'] =
      applied.fault.code === null ? applied.fault.signal : String(applied.fault.code);
    return;
  }
  if (applied.fault.kind === 'malformed_json') {
    env['MCP_LAB_MALFORMED_JSON'] = applied.fault.payload;
    return;
  }
  if (applied.fault.kind === 'drop_response') {
    throw new Error(`MCP lab fault "${applied.id}" must target a stdio protocol request`);
  }
  throw new Error(`MCP lab fault "${applied.id}" cannot target stdio`);
}

async function loopbackSession(
  scenario: McpLabScenario,
  faultPlan: McpLabFaultPlan | undefined
): Promise<McpLabSession> {
  const diagnostics: McpLabDiagnostic[] = [];
  const runtime = createFaultRuntime(faultPlan, scenario.id);
  let dispatch: McpHttpHandler | undefined;
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer((request, response) => {
    if (!(validateHost(request, response) && validateOrigin(request, response))) {
      return;
    }
    const correlationId = runtime.nextCorrelation();
    const activeDispatch = dispatch;
    if (!activeDispatch) {
      response.writeHead(503).end();
      return;
    }
    const runDispatch = async () => {
      const dispatchFault = runtime.consume('transport', 'node/dispatch', correlationId);
      if (dispatchFault) {
        const faultResponse = await applyHttpFault(dispatchFault);
        if (faultResponse) {
          await writeNodeResponse(response, faultResponse);
          return;
        }
      }
      await toNodeHandler(activeDispatch, {
        onerror(error) {
          if (error instanceof McpLabDroppedResponseError) {
            response.destroy(error);
          }
        },
      })(toCorrelatedNodeRequest(request, correlationId), response);
    };
    void runDispatch().catch((error: unknown) => {
      recordDiagnostic(diagnostics, {
        correlationId,
        kind: 'handler-error',
        message: messageOf(error),
      });
      if (error instanceof McpLabDroppedResponseError) {
        response.destroy(error);
        return;
      }
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
      } else {
        response.writeHead(500, {
          'content-type': 'application/json',
          'x-mcp-lab-correlation-id': correlationId,
        });
        response.end(JSON.stringify({ correlationId, error: 'mcp_lab_handler_error' }));
      }
    });
  });
  const port = await listenLoopback(server);
  const origin = new URL(`http://127.0.0.1:${port}/`);
  const url = new URL('/mcp', origin);
  let endpoint: Extract<McpLabEndpoint, { readonly kind: 'loopback-http' | 'oauth-loopback-http' }>;
  let handler = referenceHandler(scenario);
  if (scenario.id === 'oauth-reference') {
    endpoint = Object.freeze({
      authorizationServerMetadataUrl: new URL('/.well-known/oauth-authorization-server', origin),
      authorizationUrl: new URL('/authorize', origin),
      issuer: origin,
      kind: 'oauth-loopback-http',
      protectedResourceMetadataUrl: new URL(getOAuthProtectedResourceMetadataUrl(url)),
      registrationUrl: new URL('/register', origin),
      tokenUrl: new URL('/token', origin),
      url,
    });
    handler = oauthHandler(handler, endpoint);
  } else {
    endpoint = Object.freeze({ kind: 'loopback-http', url });
  }
  dispatch = withFaults(handler, runtime, diagnostics);
  return session(
    endpoint,
    scenario,
    [
      { close: () => closeLoopbackServer(server), closed: false, kind: 'http-listener' },
      { close: handler.close, closed: false, kind: 'handler' },
    ],
    diagnostics,
    runtime
  );
}

export async function startMcpLabScenario(
  id: string,
  options: StartMcpLabScenarioOptions = {}
): Promise<McpLabSession> {
  assertStartOptions(options);
  const scenario = getMcpLabScenario(id);
  options.faultPlan?.assertCompatibleWithTransport(
    scenario.id === 'stdio-reference'
      ? 'stdio'
      : options.execution === 'in-process'
        ? 'http-in-process'
        : 'http-loopback'
  );
  if (scenario.id === 'stdio-reference') {
    if (options.execution) {
      throw new Error(`MCP lab stdio scenario does not accept execution=${options.execution}`);
    }
    return stdioSession(scenario, options.faultPlan);
  }
  if (options.execution === 'in-process') {
    if (scenario.id === 'oauth-reference') {
      throw new Error('MCP lab OAuth scenario requires a loopback listener');
    }
    return inProcessSession(scenario, options.faultPlan);
  }
  return loopbackSession(scenario, options.faultPlan);
}
