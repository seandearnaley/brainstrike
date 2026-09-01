import { request } from 'node:http';
import { expect, it } from 'vitest';
import { startPackagedCoreFixture } from '../src/packaged-core-fixture.js';

function followAuthorization(url: URL): Promise<URL> {
  return new Promise((resolve, reject) => {
    const outbound = request(url, { method: 'GET' }, (response) => {
      const location = response.headers.location;
      response.resume();
      if (response.statusCode !== 302 || !location) {
        reject(new Error(`Expected OAuth authorization redirect, received ${response.statusCode}`));
        return;
      }
      resolve(new URL(location));
    });
    outbound.once('error', reject);
    outbound.end();
  });
}
it('owns bounded OAuth and legacy loopback fixtures for packaged Electron', async () => {
  await using cleanup = new AsyncDisposableStack();
  const oauth = await startPackagedCoreFixture('oauth-reference');
  cleanup.defer(async () => {
    expect(await oauth.close()).toMatchObject({
      clean: true,
      oauthState: { clients: 0, codes: 0, states: 0, tokens: 0 },
    });
  });
  const legacy = await startPackagedCoreFixture('legacy-reference');
  cleanup.defer(async () => expect(await legacy.close()).toMatchObject({ clean: true }));
  expect(oauth.manifest).toMatchObject({
    authentication: 'oauth',
    protocolVersion: '2026-07-28',
    transport: 'streamable-http',
  });
  expect(legacy.manifest).toMatchObject({
    authentication: 'none',
    protocolVersion: '2025-11-25',
    transport: 'streamable-http',
  });
  const authorize = new URL(oauth.manifest.authorizationUrl ?? '');
  authorize.search = new URLSearchParams({
    client_id: 'unregistered-client',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    redirect_uri: 'http://127.0.0.1:49876/mcp/oauth/callback',
    resource: oauth.manifest.url,
    response_type: 'code',
    scope: 'mcp',
    state: 'packaged-core-state',
  }).toString();
  await expect(followAuthorization(authorize)).rejects.toThrow(
    /Expected OAuth authorization redirect/u
  );
});
it('accepts one bounded OAuth authorization delay and rejects it elsewhere', async () => {
  await using cleanup = new AsyncDisposableStack();
  await expect(
    startPackagedCoreFixture('legacy-reference', { authorizationDelayMs: 100 })
  ).rejects.toThrow(/only for the OAuth fixture/u);
  await expect(
    startPackagedCoreFixture('oauth-reference', { authorizationDelayMs: 99 })
  ).rejects.toThrow(/100 to 10000/u);
  const oauth = await startPackagedCoreFixture('oauth-reference', {
    authorizationDelayMs: 100,
  });
  cleanup.defer(async () => expect((await oauth.close()).clean).toBe(false));
  expect(oauth.authorizationDelayObserved()).toBe(false);
});
