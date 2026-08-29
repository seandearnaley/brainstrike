import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
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

async function authorize(lab: McpLabSession): Promise<string> {
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
  const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
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

class ReferencePhaseOwner implements McpLabRunnerPhaseOwner {
  private client: Client | undefined;
  private closePromise: Promise<{ readonly details: string; readonly verified: true }> | undefined;
  private lab: McpLabSession | undefined;

  constructor(
    private readonly runnerCase: McpLabRunnerCase,
    private readonly phase: McpLabRunnerPhase
  ) {}

  close(): Promise<{ readonly details: string; readonly verified: true }> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = (async () => {
      const failures: Error[] = [];
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
    if (this.lab) {
      throw new Error('MCP reference runner phase already ran');
    }
    const abort = () => void this.close().catch(() => undefined);
    signal.addEventListener('abort', abort, { once: true });
    try {
      this.lab = await startCase(this.runnerCase);
      const version = this.lab.scenario.protocol.version;
      this.client = new Client(
        { name: 'brainstrike-mcp-verifier-runner', version: '1.0.0' },
        {
          versionNegotiation:
            this.lab.scenario.protocol.era === 'legacy'
              ? { mode: 'legacy' }
              : { mode: { pin: '2026-07-28' } },
        }
      );
      const endpoint = this.lab.endpoint;
      if (endpoint.kind === 'stdio') {
        await this.client.connect(endpoint.transport);
      } else {
        const accessToken =
          endpoint.kind === 'oauth-loopback-http' ? await authorize(this.lab) : undefined;
        await this.client.connect(
          new StreamableHTTPClientTransport(endpoint.url, {
            ...(endpoint.kind === 'in-process-http' ? { fetch: endpoint.fetch } : {}),
            ...(accessToken
              ? { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }
              : {}),
          })
        );
      }
      const tools = await this.client.listTools();
      const value = `${this.runnerCase.id}-${this.phase}`;
      const actual = echoText(
        await this.client.callTool({ arguments: { text: value }, name: 'echo' })
      );
      const expected = this.phase === 'red' ? `${value}-mutation-canary` : value;
      const passed = actual === expected;
      const negotiated = this.client.getNegotiatedProtocolVersion();
      if (negotiated !== version) {
        throw new Error(
          `MCP reference runner negotiated ${String(negotiated)} instead of ${version}`
        );
      }
      return Object.freeze({
        capabilities: Object.freeze(tools.tools.map(({ name }) => name)),
        correlationIds: Object.freeze([`${this.runnerCase.id}-${this.phase}`]),
        exitStatus: passed ? 0 : 1,
        negotiation:
          this.lab.scenario.protocol.era === 'legacy'
            ? ({ era: 'legacy', revision: '2025-11-25' } as const)
            : ({ era: 'modern', revision: '2026-07-28' } as const),
        tests: Object.freeze({
          failed: passed ? 0 : 1,
          passed: passed ? 1 : 0,
          skipped: 0,
          total: 1,
        }),
      });
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}

export function createMcpLabReferenceRunnerDependencies(): McpLabRunnerDependencies {
  return Object.freeze({
    createPhaseOwner(runnerCase: McpLabRunnerCase, phase: McpLabRunnerPhase) {
      return new ReferencePhaseOwner(runnerCase, phase);
    },
    now: () => performance.now(),
  });
}
