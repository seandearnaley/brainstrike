import { createHash } from 'node:crypto';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  createMcpOAuthReferenceEndpoint,
  createMcpOAuthReferenceHandler,
} from '../src/oauth-reference';

const REDIRECT_URI = 'http://127.0.0.1:54321/callback';
const VERIFIER = 'brainstrike-mcp-lab-pkce-verifier-000000000000000000000000';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

describe('MCP OAuth reference core', () => {
  it('binds a bounded native authorization-code flow to state, PKCE, resource, and expiry', async () => {
    let now = 1_700_000_000_000;
    const downstream = {
      async close() {},
      async fetch() {
        return Response.json({ ok: true });
      },
    } as unknown as McpHttpHandler;
    const handler = createMcpOAuthReferenceHandler(
      downstream,
      createMcpOAuthReferenceEndpoint(new URL('http://127.0.0.1:43123/')),
      { now: () => now, randomBytes: (size) => new Uint8Array(size).fill(7) }
    );
    const registration = await handler.fetch(
      new Request(handler.endpoint.registrationUrl, {
        body: JSON.stringify({
          application_type: 'native',
          client_name: 'Brainstrike MCP Lab',
          extension_value: 'ignored',
          grant_types: ['authorization_code'],
          redirect_uris: [REDIRECT_URI],
          response_types: ['code'],
          scope: 'mcp',
          token_endpoint_auth_method: 'none',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    );
    expect(registration.status).toBe(201);
    const registered = (await registration.json()) as Record<string, unknown>;
    expect(registered).not.toHaveProperty('extension_value');
    const clientId = String(registered['client_id']);
    const authorize = async (state: string, resource = handler.endpoint.url.href) => {
      const url = new URL(handler.endpoint.authorizationUrl);
      url.search = new URLSearchParams({
        client_id: clientId,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        redirect_uri: REDIRECT_URI,
        resource,
        response_type: 'code',
        scope: 'mcp',
        state,
      }).toString();
      return handler.fetch(new Request(url));
    };
    const invalidResource = await authorize('bad-resource', 'https://attacker.invalid/mcp');
    expect(invalidResource.status).toBe(302);
    expect(
      new URL(invalidResource.headers.get('location') ?? 'missing:').searchParams.get('error')
    ).toBe('invalid_target');
    const authorization = await authorize('state-1');
    const callback = new URL(authorization.headers.get('location') ?? 'missing:');
    expect(callback.searchParams.get('iss')).toBe(handler.endpoint.issuer.href);
    const code = callback.searchParams.get('code') ?? '';
    const tokenBody = new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: VERIFIER,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      resource: handler.endpoint.url.href,
    });
    const tokenResponse = await handler.fetch(
      new Request(handler.endpoint.tokenUrl, {
        body: tokenBody,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      })
    );
    expect(tokenResponse.status).toBe(200);
    const token = String(((await tokenResponse.json()) as Record<string, unknown>)['access_token']);
    const protectedRequest = () =>
      handler.fetch(
        new Request(handler.endpoint.url, {
          body: '{}',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          method: 'POST',
        })
      );
    expect((await protectedRequest()).status).toBe(200);
    now += 301_000;
    expect((await protectedRequest()).status).toBe(401);
    await handler.close();
    expect(handler.stateCounts()).toEqual({ clients: 0, codes: 0, states: 0, tokens: 0 });
  });
});
