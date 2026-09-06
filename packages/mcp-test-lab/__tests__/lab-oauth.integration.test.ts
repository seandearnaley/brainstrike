import { createHash } from 'node:crypto';
import {
  Client,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createMcpLabFaultPlan } from '../src/faults';
import {
  createMcpOAuthAuthorizationResponseVerifier,
  type McpLabSession,
  startMcpLabScenario,
} from '../src/lab';

const REDIRECT_URI = 'http://127.0.0.1:54321/callback';
const VERIFIER = 'brainstrike-mcp-lab-pkce-verifier-000000000000000000000000';

class TestOAuthProvider implements OAuthClientProvider {
  private authorizationUrlValue: URL | undefined;
  private clientInformationValue: StoredOAuthClientInformation | undefined;
  readonly clientMetadata: OAuthClientMetadata = {
    client_name: 'Brainstrike SDK OAuth Integration',
    grant_types: ['authorization_code'],
    redirect_uris: [REDIRECT_URI],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  private discoveryStateValue: OAuthDiscoveryState | undefined;
  readonly redirectUrl = REDIRECT_URI;
  private tokenValue: StoredOAuthTokens | undefined;
  private verifierValue = '';

  authorizationUrl(): URL {
    if (!this.authorizationUrlValue) {
      throw new Error('SDK OAuth authorization URL was not captured');
    }
    return this.authorizationUrlValue;
  }

  clientInformation(
    _context?: OAuthClientInformationContext
  ): StoredOAuthClientInformation | undefined {
    return this.clientInformationValue;
  }

  codeVerifier(): string {
    if (!this.verifierValue) {
      throw new Error('SDK OAuth code verifier was not saved');
    }
    return this.verifierValue;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discoveryStateValue;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrlValue = new URL(url);
  }

  saveClientInformation(value: StoredOAuthClientInformation): void {
    this.clientInformationValue = value;
  }

  saveCodeVerifier(value: string): void {
    this.verifierValue = value;
  }

  saveDiscoveryState(value: OAuthDiscoveryState): void {
    this.discoveryStateValue = value;
  }

  saveTokens(value: StoredOAuthTokens): void {
    this.tokenValue = value;
  }

  state(): string {
    return 'sdk-integration-state';
  }

  tokens(_context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return this.tokenValue;
  }
}

function expectRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

const startUnchecked = startMcpLabScenario as unknown as (
  id: string,
  options: unknown
) => Promise<McpLabSession>;

describe('MCP OAuth loopback reference', () => {
  it('executes accepted Node-dispatch faults before OAuth authentication', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'oauth-node-dispatch',
        match: { method: 'node/dispatch', occurrence: 1, phase: 'transport' },
      },
    ]);
    const lab = await startMcpLabScenario('oauth-reference', {
      execution: 'loopback',
      faultPlan: plan,
    });
    if (lab.endpoint.kind !== 'oauth-loopback-http') {
      throw new Error(`Expected OAuth loopback endpoint, received ${lab.endpoint.kind}`);
    }

    try {
      const response = await fetch(lab.endpoint.url, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': { name: 'oauth-fault-test', version: '1' },
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            },
          },
        }),
        headers: {
          'content-type': 'application/json',
          'mcp-method': 'tools/list',
          'mcp-protocol-version': '2026-07-28',
        },
        method: 'POST',
      });
      expect(response.status).toBe(418);
      expect(plan.untriggeredIds()).toEqual([]);
    } finally {
      await lab.close();
    }
  });

  it('runs discovery, DCR, PKCE, issuer/resource verification, and a protected SDK exchange', async () => {
    const lab = await startMcpLabScenario('oauth-reference', { execution: 'loopback' });
    if (lab.endpoint.kind !== 'oauth-loopback-http') {
      throw new Error(`Expected OAuth loopback endpoint, received ${lab.endpoint.kind}`);
    }
    const endpoint = lab.endpoint;
    expect(endpoint.url.hostname).toBe('127.0.0.1');
    expect(lab.scenario.usesAmbientCredentials).toBe(false);

    let client: Client | undefined;
    let firstReport: Awaited<ReturnType<typeof lab.close>> | undefined;
    try {
      const unauthorized = await fetch(endpoint.url, { method: 'POST' });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('www-authenticate')).toContain(
        `resource_metadata="${endpoint.protectedResourceMetadataUrl.href}"`
      );
      await expect(
        (await fetch(endpoint.protectedResourceMetadataUrl)).json()
      ).resolves.toMatchObject({
        authorization_servers: [endpoint.issuer.href],
        resource: endpoint.url.href,
      });

      const registrationResponse = await fetch(endpoint.registrationUrl, {
        body: JSON.stringify({
          application_type: 'native',
          client_name: 'Brainstrike OAuth Integration',
          grant_types: ['authorization_code'],
          redirect_uris: [REDIRECT_URI],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(registrationResponse.status).toBe(201);
      const registration = expectRecord(await registrationResponse.json(), 'registration');
      const clientId = expectString(registration['client_id'], 'client_id');

      const authorizationUrl = new URL(endpoint.authorizationUrl);
      authorizationUrl.search = new URLSearchParams({
        client_id: clientId,
        code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'),
        code_challenge_method: 'S256',
        redirect_uri: REDIRECT_URI,
        resource: endpoint.url.href,
        response_type: 'code',
        scope: 'mcp',
        state: 'integration-state',
      }).toString();
      const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
      expect(authorization.status).toBe(302);
      const callback = new URL(expectString(authorization.headers.get('location'), 'location'));
      const code = createMcpOAuthAuthorizationResponseVerifier({
        endpoint,
        expectedRedirectUri: REDIRECT_URI,
        expectedState: 'integration-state',
      })(callback);

      const tokenBody = new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: VERIFIER,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        resource: endpoint.url.href,
      });
      const tokenResponse = await fetch(endpoint.tokenUrl, {
        body: tokenBody,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      });
      expect(tokenResponse.status).toBe(200);
      const tokens = expectRecord(await tokenResponse.json(), 'tokens');
      const accessToken = expectString(tokens['access_token'], 'access_token');
      expect(
        (
          await fetch(endpoint.tokenUrl, {
            body: tokenBody,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            method: 'POST',
          })
        ).status
      ).toBe(400);

      const authenticatedHeaders = {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      };
      expect(
        (
          await fetch(new URL('?unexpected=1', endpoint.url), {
            body: '{}',
            headers: authenticatedHeaders,
            method: 'POST',
          })
        ).status
      ).toBe(400);
      for (const method of ['GET', 'DELETE', 'PUT']) {
        const wrongMethod = await fetch(endpoint.url, { headers: authenticatedHeaders, method });
        expect(wrongMethod.status).toBe(405);
        expect(wrongMethod.headers.get('allow')).toBe('POST');
      }

      client = new Client(
        { name: 'brainstrike-mcp-lab-oauth-test', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      );
      await client.connect(
        new StreamableHTTPClientTransport(endpoint.url, {
          requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
        })
      );
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'echo',
        'elicit_confirm',
      ]);
      await expect(
        client.callTool({ arguments: { text: 'oauth-reference' }, name: 'echo' })
      ).resolves.toMatchObject({ structuredContent: { text: 'oauth-reference' } });
      expect(endpoint.stateCounts()).toEqual({ clients: 1, codes: 0, states: 1, tokens: 1 });
    } finally {
      try {
        await client?.close();
      } finally {
        firstReport = await lab.close();
      }
    }

    if (!firstReport) {
      throw new Error('MCP OAuth lab cleanup report was not captured');
    }
    expect(await lab.close()).toBe(firstReport);
    expect(firstReport).toEqual({
      httpListenersClosed: 1,
      oauthRecordsRemaining: { clients: 0, codes: 0, states: 0, tokens: 0 },
      stdioTransportsClosed: 0,
      untriggeredFaultIds: [],
    });
    expect(lab.closed).toBe(true);
  });

  it('drives the pinned SDK OAuth provider through discovery, DCR, callback, and reconnect', async () => {
    const lab = await startMcpLabScenario('oauth-reference', { execution: 'loopback' });
    if (lab.endpoint.kind !== 'oauth-loopback-http') {
      throw new Error(`Expected OAuth loopback endpoint, received ${lab.endpoint.kind}`);
    }
    const provider = new TestOAuthProvider();
    const transport = new StreamableHTTPClientTransport(lab.endpoint.url, {
      authProvider: provider,
    });
    let client = new Client(
      { name: 'brainstrike-sdk-oauth-provider-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    try {
      await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
      const authorizationUrl = provider.authorizationUrl();
      expect(authorizationUrl.searchParams.get('resource')).toBe(lab.endpoint.url.href);
      expect(provider.clientInformation()).toBeDefined();
      expect(provider.discoveryState()).toBeDefined();
      const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
      const callback = new URL(expectString(authorization.headers.get('location'), 'location'));
      const verifyCallback = createMcpOAuthAuthorizationResponseVerifier({
        endpoint: lab.endpoint,
        expectedRedirectUri: provider.redirectUrl,
        expectedState: provider.state(),
      });
      const tamperedCallback = new URL(callback);
      tamperedCallback.searchParams.set('state', 'tampered-state');
      expect(() => verifyCallback(tamperedCallback)).toThrow(/state mismatch/);
      expect(verifyCallback(callback)).toMatch(/^brainstrike-lab-code-/u);
      expect(() => verifyCallback(callback)).toThrow(/already consumed/);
      await transport.finishAuth(callback.searchParams);
      await client.close();
      client = new Client(
        { name: 'brainstrike-sdk-oauth-provider-test', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      );
      await client.connect(
        new StreamableHTTPClientTransport(lab.endpoint.url, { authProvider: provider })
      );
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'echo',
        'elicit_confirm',
      ]);
    } finally {
      await client.close();
      await lab.close();
    }
  });

  it('requires loopback execution and rejects malformed registration over the real listener', async () => {
    await expect(startUnchecked('oauth-reference', { execution: 'in-process' })).rejects.toThrow(
      /requires a loopback listener/
    );
    const lab = await startMcpLabScenario('oauth-reference', { execution: 'loopback' });
    if (lab.endpoint.kind !== 'oauth-loopback-http') {
      throw new Error(`Expected OAuth loopback endpoint, received ${lab.endpoint.kind}`);
    }
    try {
      const malformed = await fetch(lab.endpoint.registrationUrl, {
        body: JSON.stringify({ redirect_uris: ['https://attacker.invalid/callback'] }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toMatchObject({ error: 'invalid_redirect_uri' });
    } finally {
      await lab.close();
    }
  });
});
