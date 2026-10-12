import { request } from 'node:http';
import { expect, it, vi } from 'vitest';
import { startPackagedCoreFixture } from '../src/packaged-core-fixture.js';

function followAuthorization(url: URL, signal?: AbortSignal): Promise<URL> {
  return new Promise((resolve, reject) => {
    const outbound = request(url, { method: 'GET', signal }, (response) => {
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
it.each(['release', 'abort', 'close'] as const)(
  'holds first OAuth authorization until %s and joins cleanup',
  async (completion) => {
    await using cleanup = new AsyncDisposableStack();
    await expect(
      startPackagedCoreFixture('legacy-reference', { authorizationDelayMs: 100 })
    ).rejects.toThrow(/only for the OAuth fixture/u);
    await expect(
      startPackagedCoreFixture('oauth-reference', { authorizationDelayMs: 99 })
    ).rejects.toThrow(/100 to 10000/u);
    const oauth = await startPackagedCoreFixture('oauth-reference', {
      authorizationDelayMs: 100,
      holdAuthorization: true,
    });
    cleanup.defer(async () => expect((await oauth.close()).clean).toBe(true));
    expect(oauth.authorizationDelayObserved()).toBe(false);
    expect(oauth.authorizationDelaySettled()).toBe(false);
    const redirectUri = 'http://127.0.0.1:49876/mcp/oauth/callback';
    const registration = await fetch(new URL('/register', oauth.manifest.authorizationUrl), {
      body: JSON.stringify({
        application_type: 'native',
        client_name: 'Packaged core fixture verifier',
        grant_types: ['authorization_code'],
        redirect_uris: [redirectUri],
        response_types: ['code'],
        scope: 'mcp',
        token_endpoint_auth_method: 'none',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(registration.status).toBe(201);
    const registeredClient: unknown = await registration.json();
    if (!(registeredClient && typeof registeredClient === 'object')) {
      throw new Error('Packaged core registration response was not an object');
    }
    const clientId = Reflect.get(registeredClient, 'client_id');
    if (typeof clientId !== 'string') {
      throw new Error('Packaged core registration response omitted client_id');
    }
    const delayedAuthorize = new URL(oauth.manifest.authorizationUrl ?? '');
    delayedAuthorize.search = new URLSearchParams({
      client_id: clientId,
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      redirect_uri: redirectUri,
      resource: oauth.manifest.url,
      response_type: 'code',
      scope: 'mcp',
      state: 'packaged-core-delayed-state',
    }).toString();
    const abort = new AbortController();
    const delayedResponse = followAuthorization(delayedAuthorize, abort.signal);
    // Observe rejection immediately so fixture-close and request-abort cannot leak it.
    void delayedResponse.catch(() => {});
    await vi.waitFor(() => expect(oauth.authorizationDelayObserved()).toBe(true));
    expect(oauth.authorizationDelaySettled()).toBe(false);
    // Simulate UI stabilization outlasting the old timer, while the authorization
    // must remain pending until the real cancellation action can complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(oauth.authorizationDelaySettled()).toBe(false);
    if (completion === 'release') {
      oauth.releaseAuthorization();
      await expect(delayedResponse).resolves.toEqual(expect.any(URL));
      delayedAuthorize.searchParams.set('state', 'packaged-core-reconnect-state');
      await expect(followAuthorization(delayedAuthorize)).resolves.toEqual(expect.any(URL));
    } else {
      if (completion === 'abort') {
        abort.abort();
      } else {
        await oauth.close();
      }
      await expect(delayedResponse).rejects.toThrow();
      await vi.waitFor(() => expect(oauth.authorizationDelaySettled()).toBe(true));
      oauth.releaseAuthorization();
    }
    expect(oauth.authorizationDelaySettled()).toBe(true);
  }
);
