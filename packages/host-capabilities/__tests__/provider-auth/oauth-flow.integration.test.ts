import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { OAuthProviderDescriptor, ProviderAuthStatus } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderAuthEngine } from '../../src/provider-auth/provider-auth-engine.js';
import { makeFakeSecrets } from './fake-secrets.js';

/**
 * Full loopback happy path against a FAKE local OAuth provider (BST-1355
 * acceptance): real HTTP servers on ephemeral test ports for both the
 * provider's token endpoint and the engine's loopback callback server. The
 * fixture descriptor uses port 0 and reads the bound port — the fixed-port
 * rule applies to real descriptors only.
 *
 * The simulated browser is a plain fetch: it receives the authorize URL the
 * engine hands to openExternal, "authenticates", and follows the redirect
 * back to the loopback server. The fake token endpoint verifies the PKCE
 * S256 challenge END TO END (challenge captured from the authorize URL must
 * match the hash of the code_verifier presented at exchange).
 */

const ACCESS_SENTINEL = 'INTEGRATION-ACCESS-TOKEN-77f2';
const REFRESH_SENTINEL = 'INTEGRATION-REFRESH-TOKEN-b41c';
const PROVIDER = 'fake-provider';

interface FakeProvider {
  challengeFromAuthorizeUrl?: string;
  readonly issuedCodes: Set<string>;
  // Assigned after listen() resolves the ephemeral port.
  server: Server;
  tokenRequests: URLSearchParams[];
  tokenUrl: string;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

async function startFakeProvider(): Promise<FakeProvider> {
  const provider: FakeProvider = {
    issuedCodes: new Set<string>(),
    server: undefined as unknown as Server,
    tokenRequests: [],
    tokenUrl: '',
  };
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/token') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        provider.tokenRequests.push(params);
        const code = params.get('code') ?? '';
        const verifier = params.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
        if (
          params.get('grant_type') !== 'authorization_code' ||
          !provider.issuedCodes.delete(code) ||
          challenge !== provider.challengeFromAuthorizeUrl
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: ACCESS_SENTINEL,
            account_id: 'acct-integration-1',
            expires_in: 3600,
            refresh_token: REFRESH_SENTINEL,
            token_type: 'Bearer',
          })
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake provider has no bound port');
  }
  provider.server = server;
  provider.tokenUrl = `http://127.0.0.1:${address.port}/token`;
  return provider;
}

describe('loopback OAuth happy path against a fake local provider', () => {
  it('connects, verifies PKCE end to end, persists the credential, and serves the branded page', async () => {
    const fakeProvider = await startFakeProvider();
    const secrets = makeFakeSecrets();
    const now = Date.now();

    const descriptor: OAuthProviderDescriptor = {
      authorizeUrl: 'https://fake-provider.test/authorize',
      clientId: 'integration-client',
      extractAccountId: (grant) => {
        const accountId = grant.raw['account_id'];
        return typeof accountId === 'string' ? accountId : undefined;
      },
      providerId: PROVIDER,
      redirectPath: '/callback',
      // Port 0: fixture-only ephemeral binding (fixed-port rule is for real
      // descriptors); the engine reads the bound port for the redirect_uri.
      redirectPort: 0,
      scopes: ['openid', 'offline_access'],
      tokenUrl: fakeProvider.tokenUrl,
    };

    let browserHtml = '';
    const openExternal = vi.fn(async (authorizeUrlString: string) => {
      // Simulated browser: user authenticates at the provider, which issues a
      // code and redirects back to the loopback redirect_uri.
      const authorizeUrl = new URL(authorizeUrlString);
      expect(authorizeUrl.origin).toBe('https://fake-provider.test');
      expect(authorizeUrl.searchParams.get('client_id')).toBe('integration-client');
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorizeUrl.searchParams.get('scope')).toBe('openid offline_access');
      const challenge = authorizeUrl.searchParams.get('code_challenge');
      const state = authorizeUrl.searchParams.get('state');
      const redirectUri = authorizeUrl.searchParams.get('redirect_uri');
      if (!(challenge && state && redirectUri)) {
        throw new Error('authorize URL is missing PKCE/state/redirect parameters');
      }
      fakeProvider.challengeFromAuthorizeUrl = challenge;
      const code = 'integration-code-1';
      fakeProvider.issuedCodes.add(code);
      const redirect = new URL(redirectUri);
      expect(redirect.hostname).toBe('127.0.0.1');
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', state);
      const response = await fetch(redirect);
      browserHtml = await response.text();
      expect(response.status).toBe(200);
    });

    const engine = createProviderAuthEngine({
      getDescriptor: () => descriptor,
      openExternal,
      secrets,
    });

    const statuses: ProviderAuthStatus[] = [];
    statuses.push(await engine.start(PROVIDER));
    expect(statuses[0]).toEqual({ state: 'awaiting_browser' });

    await vi.waitFor(async () => {
      const status = await engine.getStatus(PROVIDER);
      statuses.push(status);
      expect(status).toEqual({ accountId: 'acct-integration-1', state: 'connected' });
    });

    // Branded callback page reached the (simulated) browser.
    expect(browserHtml).toContain('Brainstrike');
    expect(browserHtml).toContain('Authorization successful');

    // The engine persisted the typed oauth credential.
    const stored = secrets.store.get(PROVIDER);
    expect(stored).toMatchObject({
      access: ACCESS_SENTINEL,
      accountId: 'acct-integration-1',
      refresh: REFRESH_SENTINEL,
      type: 'oauth',
    });
    if (stored?.type !== 'oauth') {
      throw new Error('expected oauth credential');
    }
    expect(stored.expires).toBeGreaterThanOrEqual(now + 3600 * 1000);
    expect(stored.expires).toBeLessThan(now + 3600 * 1000 + 60_000);

    // PKCE verified end to end: exactly one exchange, carrying the verifier
    // whose S256 hash matched the authorize-time challenge.
    expect(fakeProvider.tokenRequests).toHaveLength(1);

    // Gate constraint 3: nothing the renderer would see carries tokens.
    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain(ACCESS_SENTINEL);
    expect(serialized).not.toContain(REFRESH_SENTINEL);
  });
});
