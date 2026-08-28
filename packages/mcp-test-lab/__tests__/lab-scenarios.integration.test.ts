import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { startMcpLabScenario } from '../src/lab';

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

describe('MCP lab advertised scenarios', () => {
  it('accepts bracketed IPv6 loopback OAuth redirects for native clients', async () => {
    const lab = await startMcpLabScenario('oauth-reference');
    if (lab.endpoint.kind !== 'oauth-loopback-http') {
      throw new Error(`Expected OAuth loopback endpoint, received ${lab.endpoint.kind}`);
    }

    try {
      const response = await fetch(lab.endpoint.registrationUrl, {
        body: JSON.stringify({
          application_type: 'native',
          client_name: 'Brainstrike IPv6 Loopback Test',
          redirect_uris: ['http://[::1]:54321/callback'],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(201);
    } finally {
      await lab.close();
    }
  });

  it('serves the legacy reference over a real loopback exchange', async () => {
    const lab = await startMcpLabScenario('legacy-reference');
    if (lab.endpoint.kind !== 'loopback-http') {
      throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
    }
    const client = new Client(
      { name: 'brainstrike-mcp-lab-legacy-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'legacy' } }
    );

    try {
      await client.connect(new StreamableHTTPClientTransport(lab.endpoint.url));
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
    } finally {
      await client.close();
      await lab.close();
    }

    expect(lab.closed).toBe(true);
  });

  it('exposes a real spawned stdio endpoint backed by the lab fixture', async () => {
    const lab = await startMcpLabScenario('stdio-reference');
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const { transport } = lab.endpoint;
    const client = new Client(
      { name: 'brainstrike-mcp-lab-stdio-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );

    try {
      await client.connect(transport);
      expect(transport.pid).toEqual(expect.any(Number));
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
    } finally {
      await client.close();
      await expect(lab.close()).resolves.toEqual({
        httpListenersClosed: 0,
        stdioTransportsClosed: 1,
        untriggeredFaultIds: [],
      });
    }

    expect(transport.pid).toBeNull();
    expect(lab.closed).toBe(true);
  });

  it('provides deterministic RFC metadata, DCR, PKCE authorization, token exchange, and a protected MCP endpoint', async () => {
    const lab = await startMcpLabScenario('oauth-reference');
    if (lab.endpoint.kind !== 'oauth-loopback-http') {
      throw new Error(`Expected OAuth loopback endpoint, received ${lab.endpoint.kind}`);
    }
    expect(lab.scenario.usesAmbientCredentials).toBe(false);

    try {
      const unauthorized = await fetch(lab.endpoint.url, { method: 'POST' });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('www-authenticate')).toContain(
        `resource_metadata="${lab.endpoint.protectedResourceMetadataUrl.href}"`
      );

      const protectedResource = expectRecord(
        await (await fetch(lab.endpoint.protectedResourceMetadataUrl)).json(),
        'protected resource metadata'
      );
      expect(protectedResource).toMatchObject({
        authorization_servers: [lab.endpoint.issuer.href],
        resource: lab.endpoint.url.href,
        scopes_supported: ['mcp'],
      });

      const authorizationServer = expectRecord(
        await (await fetch(lab.endpoint.authorizationServerMetadataUrl)).json(),
        'authorization server metadata'
      );
      expect(authorizationServer).toMatchObject({
        authorization_endpoint: lab.endpoint.authorizationUrl.href,
        authorization_response_iss_parameter_supported: true,
        code_challenge_methods_supported: ['S256'],
        issuer: lab.endpoint.issuer.href,
        registration_endpoint: lab.endpoint.registrationUrl.href,
        token_endpoint: lab.endpoint.tokenUrl.href,
      });

      const redirectUri = 'http://127.0.0.1:54321/callback';
      const registrationResponse = await fetch(lab.endpoint.registrationUrl, {
        body: JSON.stringify({
          application_type: 'native',
          client_name: 'Brainstrike MCP Lab Test',
          redirect_uris: [redirectUri],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(registrationResponse.status).toBe(201);
      const registration = expectRecord(await registrationResponse.json(), 'registration');
      const clientId = expectString(registration['client_id'], 'client_id');

      const verifier = 'brainstrike-mcp-lab-pkce-verifier-000000000000000000000000';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const authorizeUrl = new URL(lab.endpoint.authorizationUrl);
      authorizeUrl.search = new URLSearchParams({
        client_id: clientId,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        redirect_uri: redirectUri,
        resource: lab.endpoint.url.href,
        response_type: 'code',
        scope: 'mcp',
        state: 'deterministic-state',
      }).toString();
      const authorizationResponse = await fetch(authorizeUrl, { redirect: 'manual' });
      expect(authorizationResponse.status).toBe(302);
      const callback = new URL(
        expectString(authorizationResponse.headers.get('location'), 'location')
      );
      expect(callback.origin + callback.pathname).toBe(redirectUri);
      expect(callback.searchParams.get('state')).toBe('deterministic-state');
      expect(callback.searchParams.get('iss')).toBe(lab.endpoint.issuer.href);

      const tokenResponse = await fetch(lab.endpoint.tokenUrl, {
        body: new URLSearchParams({
          client_id: clientId,
          code: expectString(callback.searchParams.get('code'), 'authorization code'),
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          resource: lab.endpoint.url.href,
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      });
      expect(tokenResponse.status).toBe(200);
      const tokens = expectRecord(await tokenResponse.json(), 'tokens');
      const accessToken = expectString(tokens['access_token'], 'access_token');
      expect(tokens).toMatchObject({ scope: 'mcp', token_type: 'Bearer' });

      const client = new Client(
        { name: 'brainstrike-mcp-lab-oauth-test', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      );
      try {
        await client.connect(
          new StreamableHTTPClientTransport(lab.endpoint.url, {
            requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
          })
        );
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
      } finally {
        await client.close();
      }
    } finally {
      await lab.close();
    }

    expect(lab.closed).toBe(true);
  });
});
