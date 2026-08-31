import { createHash } from 'node:crypto';
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  createMcpOAuthAuthorizationResponseVerifier,
  type McpLabCleanupReport,
  type McpLabSession,
  startMcpLabScenario,
} from './lab.js';
import type {
  McpLabRunnerCaseObservation,
  McpLabRunnerDependencies,
  McpLabRunnerPhase,
  McpLabRunnerPhaseOwner,
} from './runner.js';
import type { McpLabRunnerCase } from './runner-manifest.js';

const REDIRECT_URI = 'http://127.0.0.1:54321/callback';
const PKCE_VERIFIER = 'brainstrike-runner-pkce-verifier-000000000000000000000000';

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`MCP reference runner ${label} is not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`MCP reference runner ${label} is not a string`);
  }
  return value;
}

async function authorize(lab: McpLabSession, signal: AbortSignal): Promise<string> {
  if (lab.endpoint.kind !== 'oauth-loopback-http') {
    throw new Error(`Expected OAuth endpoint, received ${lab.endpoint.kind}`);
  }
  const endpoint = lab.endpoint;
  const registrationResponse = await fetch(endpoint.registrationUrl, {
    body: JSON.stringify({
      ['application_type']: 'native',
      ['client_name']: 'Brainstrike MCP verifier runner',
      ['grant_types']: ['authorization_code'],
      ['redirect_uris']: [REDIRECT_URI],
      ['response_types']: ['code'],
      ['token_endpoint_auth_method']: 'none',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal,
  });
  if (registrationResponse.status !== 201) {
    throw new Error('MCP reference runner OAuth registration failed');
  }
  const registration = record(await registrationResponse.json(), 'registration');
  const clientId = stringValue(registration['client_id'], 'client id');
  const state = 'runner-state';
  const authorizationUrl = new URL(endpoint.authorizationUrl);
  authorizationUrl.search = new URLSearchParams({
    ['client_id']: clientId,
    ['code_challenge']: createHash('sha256').update(PKCE_VERIFIER).digest('base64url'),
    ['code_challenge_method']: 'S256',
    ['redirect_uri']: REDIRECT_URI,
    resource: endpoint.url.href,
    ['response_type']: 'code',
    scope: 'mcp',
    state,
  }).toString();
  const authorization = await fetch(authorizationUrl, { redirect: 'manual', signal });
  if (authorization.status !== 302) {
    throw new Error('MCP reference runner OAuth authorization failed');
  }
  const callback = new URL(stringValue(authorization.headers.get('location'), 'callback'));
  const code = createMcpOAuthAuthorizationResponseVerifier({
    endpoint,
    expectedRedirectUri: REDIRECT_URI,
    expectedState: state,
  })(callback);
  const tokenResponse = await fetch(endpoint.tokenUrl, {
    body: new URLSearchParams({
      ['client_id']: clientId,
      code,
      ['code_verifier']: PKCE_VERIFIER,
      ['grant_type']: 'authorization_code',
      ['redirect_uri']: REDIRECT_URI,
      resource: endpoint.url.href,
    }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
    signal,
  });
  if (tokenResponse.status !== 200) {
    throw new Error('MCP reference runner OAuth token exchange failed');
  }
  return stringValue(
    record(await tokenResponse.json(), 'token response')['access_token'],
    'access token'
  );
}

function startCase(runnerCase: McpLabRunnerCase): Promise<McpLabSession> {
  if (runnerCase.scenarioId === 'stdio-reference') {
    return startMcpLabScenario('stdio-reference', {});
  }
  if (runnerCase.scenarioId === 'oauth-reference') {
    return startMcpLabScenario('oauth-reference', { execution: 'loopback' });
  }
  if (!runnerCase.execution) {
    throw new Error(`MCP reference runner case "${runnerCase.id}" has no HTTP execution`);
  }
  return startMcpLabScenario(runnerCase.scenarioId, { execution: runnerCase.execution });
}

export function isMissingToolProtocolError(error: unknown, toolName: string): boolean {
  return (
    error instanceof ProtocolError &&
    error.code === ProtocolErrorCode.InvalidParams &&
    error.message.includes(toolName)
  );
}

function assertCleanup(runnerCase: McpLabRunnerCase, report: McpLabCleanupReport): string {
  if (report.untriggeredFaultIds.length !== 0) {
    throw new Error(`MCP reference runner case "${runnerCase.id}" left faults untriggered`);
  }
  const expectedListeners = runnerCase.execution === 'loopback' ? 1 : 0;
  const expectedStdio = runnerCase.scenarioId === 'stdio-reference' ? 1 : 0;
  if (
    report.httpListenersClosed !== expectedListeners ||
    report.stdioTransportsClosed !== expectedStdio
  ) {
    throw new Error(`MCP reference runner case "${runnerCase.id}" cleanup counts are invalid`);
  }
  if (
    'oauthRecordsRemaining' in report &&
    Object.values(report.oauthRecordsRemaining).some((count) => count !== 0)
  ) {
    throw new Error(`MCP reference runner case "${runnerCase.id}" retained OAuth records`);
  }
  return `closed listeners=${expectedListeners} stdio=${expectedStdio}`;
}

function echoText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('structuredContent' in value)) {
    return;
  }
  const structured = value.structuredContent;
  if (typeof structured !== 'object' || structured === null || !('text' in structured)) {
    return;
  }
  return typeof structured.text === 'string' ? structured.text : undefined;
}

async function runReferenceTest(
  client: Client,
  runnerCase: McpLabRunnerCase,
  phase: McpLabRunnerPhase,
  value: string,
  signal: AbortSignal
): Promise<boolean> {
  if (phase !== 'red' && runnerCase.scenarioId === 'modern-reference') {
    const result = await client.callTool({ name: 'test_simple_text' }, { signal });
    return (
      typeof result === 'object' &&
      result !== null &&
      'content' in result &&
      Array.isArray(result.content) &&
      result.content.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'text' in entry &&
          entry.text === 'This is a simple text response for testing.'
      )
    );
  }
  if (phase !== 'red') {
    return (
      echoText(await client.callTool({ arguments: { text: value }, name: 'echo' }, { signal })) ===
      value
    );
  }
  try {
    await client.callTool({ arguments: { text: value }, name: 'missing-red-mutation' }, { signal });
  } catch (error) {
    if (isMissingToolProtocolError(error, 'missing-red-mutation')) {
      return false;
    }
    throw error;
  }
  throw new Error('MCP reference runner RED mutation did not produce a server rejection');
}

class ReferencePhaseOwner implements McpLabRunnerPhaseOwner {
  private client: Client | undefined;
  private closePromise: Promise<{ readonly details: string; readonly verified: true }> | undefined;
  private lab: McpLabSession | undefined;
  private startPromise: Promise<McpLabSession> | undefined;

  constructor(
    private readonly runnerCase: McpLabRunnerCase,
    private readonly phase: McpLabRunnerPhase,
    private readonly start: (runnerCase: McpLabRunnerCase) => Promise<McpLabSession>
  ) {}

  close(_signal: AbortSignal): Promise<{ readonly details: string; readonly verified: true }> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = (async () => {
      const failures: Error[] = [];
      if (this.startPromise) {
        try {
          this.lab ??= await this.startPromise;
        } catch {
          // The primary run path owns and reports startup failure. No lab was allocated.
        }
      }
      try {
        await this.client?.close();
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error('MCP client cleanup failed'));
      }
      let report: McpLabCleanupReport | undefined;
      try {
        report = await this.lab?.close();
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error('MCP lab cleanup failed'));
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `MCP reference runner cleanup failed for ${this.runnerCase.id}`
        );
      }
      const details = report ? assertCleanup(this.runnerCase, report) : 'closed before allocation';
      return Object.freeze({ details, verified: true as const });
    })();
    return this.closePromise;
  }

  async run(signal: AbortSignal): Promise<McpLabRunnerCaseObservation> {
    if (this.startPromise || this.closePromise) {
      throw new Error('MCP reference runner phase already ran');
    }
    this.startPromise = this.start(this.runnerCase);
    this.lab = await this.startPromise;
    signal.throwIfAborted();
    const protocol = this.lab.scenario.protocol;
    this.client = new Client(
      { name: 'brainstrike-mcp-verifier-runner', version: '1.0.0' },
      {
        versionNegotiation:
          protocol.era === 'legacy' ? { mode: 'legacy' } : { mode: { pin: protocol.version } },
      }
    );
    const endpoint = this.lab.endpoint;
    if (endpoint.kind === 'stdio') {
      await this.client.connect(endpoint.transport, { signal });
    } else {
      const accessToken =
        endpoint.kind === 'oauth-loopback-http' ? await authorize(this.lab, signal) : undefined;
      signal.throwIfAborted();
      await this.client.connect(
        new StreamableHTTPClientTransport(endpoint.url, {
          ...(endpoint.kind === 'in-process-http' ? { fetch: endpoint.fetch } : {}),
          ...(accessToken
            ? { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }
            : {}),
        }),
        { signal }
      );
    }
    signal.throwIfAborted();
    const tools = await this.client.listTools(undefined, { signal });
    signal.throwIfAborted();
    const expectedTool =
      this.runnerCase.scenarioId === 'modern-reference' ? 'test_simple_text' : 'echo';
    if (!tools.tools.some(({ name }) => name === expectedTool)) {
      throw new Error(`MCP reference runner server does not expose the ${expectedTool} tool`);
    }
    const value = `${this.runnerCase.id}-${this.phase}`;
    const passed = await runReferenceTest(this.client, this.runnerCase, this.phase, value, signal);
    signal.throwIfAborted();
    const negotiated = this.client.getNegotiatedProtocolVersion();
    if (negotiated !== protocol.version) {
      throw new Error(
        `MCP reference runner negotiated ${String(negotiated)} instead of ${protocol.version}`
      );
    }
    const serverCapabilities = this.client.getServerCapabilities();
    if (!serverCapabilities) {
      throw new Error('MCP reference runner has no negotiated server capabilities');
    }
    return Object.freeze({
      capabilities: Object.freeze(Object.keys(serverCapabilities).sort()),
      correlationIds: Object.freeze([
        `${this.runnerCase.id}-${this.phase}${this.phase === 'red' ? '-tool-rejection' : ''}`,
      ]),
      exitStatus: passed ? 0 : 1,
      negotiation:
        protocol.era === 'legacy'
          ? { era: protocol.era, revision: protocol.version }
          : { era: protocol.era, revision: protocol.version },
      tests: Object.freeze({
        failed: passed ? 0 : 1,
        passed: passed ? 1 : 0,
        skipped: 0,
        total: 1,
      }),
    });
  }
}

export function createMcpLabReferenceRunnerDependencies(
  options: { readonly startCase?: (runnerCase: McpLabRunnerCase) => Promise<McpLabSession> } = {}
): McpLabRunnerDependencies {
  const start = options.startCase ?? startCase;
  return Object.freeze({
    createPhaseOwner(runnerCase: McpLabRunnerCase, phase: McpLabRunnerPhase) {
      return new ReferencePhaseOwner(runnerCase, phase, start);
    },
    now: () => performance.now(),
  });
}
