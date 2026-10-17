// biome-ignore-all lint/style/useNamingConvention: canonical MCP conformance and OAuth fixtures use snake_case.
import { describe, expect, it, vi } from 'vitest';
import { createOfficialConformanceAuthorizationOpener } from '../../mcp/official-conformance-authorization.js';
import {
  createEphemeralOfficialConformanceOAuthRuntime,
  OFFICIAL_AUTH_SCENARIO_NAMES,
  parseOfficialAuthScenarioContext,
  parseOfficialConformanceOAuthContext,
} from '../../mcp/official-conformance-oauth.js';

const PRE_REGISTRATION_ISSUER = 'http://localhost:42002';
const PRE_REGISTRATION_CONTEXT = JSON.stringify({
  client_id: 'pre-registered-client',
  client_secret: 'pre-registered-secret',
  issuer: PRE_REGISTRATION_ISSUER,
  name: 'auth/pre-registration',
});

function authorizationRequest(): URL {
  const authorization = new URL('http://localhost:42000/authorize');
  authorization.searchParams.set('redirect_uri', 'http://127.0.0.1:42001/mcp/oauth/callback');
  authorization.searchParams.set('state', 'expected-state');
  return authorization;
}

function callbackLocation(): URL {
  const callback = new URL('http://127.0.0.1:42001/mcp/oauth/callback');
  callback.searchParams.set('code', 'authorization-code');
  callback.searchParams.set('state', 'expected-state');
  return callback;
}

describe('official conformance ephemeral OAuth adapter', () => {
  it('pins the exact canonical alpha.10 auth suite names in upstream order', () => {
    expect(OFFICIAL_AUTH_SCENARIO_NAMES).toEqual([
      'auth/metadata-default',
      'auth/metadata-var1',
      'auth/metadata-var2',
      'auth/metadata-var3',
      'auth/basic-cimd',
      'auth/scope-from-www-authenticate',
      'auth/scope-from-scopes-supported',
      'auth/scope-omitted-when-undefined',
      'auth/scope-step-up',
      'auth/scope-retry-limit',
      'auth/token-endpoint-auth-basic',
      'auth/token-endpoint-auth-post',
      'auth/token-endpoint-auth-none',
      'auth/pre-registration',
    ]);
  });

  it('accepts an absent context for dynamic-registration scenarios', () => {
    expect(parseOfficialConformanceOAuthContext(undefined)).toBeUndefined();
  });

  it.each(OFFICIAL_AUTH_SCENARIO_NAMES.filter((name) => name !== 'auth/pre-registration'))(
    'requires absent context for canonical scenario %s',
    (scenario) => {
      expect(parseOfficialAuthScenarioContext(scenario, undefined)).toBeUndefined();
      expect(() => parseOfficialAuthScenarioContext(scenario, PRE_REGISTRATION_CONTEXT)).toThrow(
        'Official MCP conformance auth scenario context is invalid'
      );
    }
  );

  it('requires the exact pre-registration context for its one canonical scenario', () => {
    expect(() => parseOfficialAuthScenarioContext('auth/pre-registration', undefined)).toThrow(
      'Official MCP conformance auth scenario context is invalid'
    );
    expect(
      parseOfficialAuthScenarioContext('auth/pre-registration', PRE_REGISTRATION_CONTEXT)
    ).toEqual(JSON.parse(PRE_REGISTRATION_CONTEXT));
  });

  it('follows one exact loopback authorization callback without automatic redirects', async () => {
    const callback = callbackLocation();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { headers: { location: callback.href }, status: 302 })
      )
      .mockResolvedValueOnce(new Response('Authorization received', { status: 200 }));
    const openAuthorization = createOfficialConformanceAuthorizationOpener(fetchFn);
    const authorization = authorizationRequest();

    await expect(openAuthorization(authorization.href)).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenNthCalledWith(1, authorization, { redirect: 'manual' });
    expect(fetchFn).toHaveBeenNthCalledWith(2, callback, { redirect: 'manual' });
  });

  it.each([301, 302, 303, 307, 308])(
    'accepts OAuth authorization redirect status %i after strict callback validation',
    async (status) => {
      const callback = callbackLocation();
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { headers: { location: callback.href }, status }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      await expect(
        createOfficialConformanceAuthorizationOpener(fetchFn)(authorizationRequest().href)
      ).resolves.toBeUndefined();
    }
  );

  it('accepts canonical loopback URLs on the default HTTP port', async () => {
    const authorization = new URL('http://localhost:80/authorize');
    authorization.searchParams.set('redirect_uri', 'http://127.0.0.1:80/mcp/oauth/callback');
    authorization.searchParams.set('state', 'expected-state');
    const callback = new URL('http://127.0.0.1:80/mcp/oauth/callback');
    callback.searchParams.set('code', 'authorization-code');
    callback.searchParams.set('state', 'expected-state');
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { headers: { location: callback.href }, status: 303 })
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await expect(
      createOfficialConformanceAuthorizationOpener(fetchFn)(authorization.href)
    ).resolves.toBeUndefined();
  });

  it.each([
    ['open redirect', 'https://attacker.example/callback?code=x&state=expected-state'],
    ['malformed Location', 'http://['],
    [
      'wrong callback host',
      'http://localhost:42001/mcp/oauth/callback?code=x&state=expected-state',
    ],
    ['wrong callback path', 'http://127.0.0.1:42001/other?code=x&state=expected-state'],
    ['missing state', 'http://127.0.0.1:42001/mcp/oauth/callback?code=x'],
    ['missing code', 'http://127.0.0.1:42001/mcp/oauth/callback?state=expected-state'],
    [
      'duplicate state',
      'http://127.0.0.1:42001/mcp/oauth/callback?code=x&state=expected-state&state=again',
    ],
    [
      'duplicate code',
      'http://127.0.0.1:42001/mcp/oauth/callback?code=x&code=y&state=expected-state',
    ],
  ])('rejects %s without following it', async (_case, location) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        headers: { location },
        status: 302,
      })
    );
    const openAuthorization = createOfficialConformanceAuthorizationOpener(fetchFn);

    await expect(openAuthorization(authorizationRequest().href)).rejects.toThrow(
      'Official MCP conformance authorization response is invalid'
    );
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('rejects non-loopback authorization and duplicate callback state before network access', async () => {
    const callback = callbackLocation();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { headers: { location: callback.href }, status: 302 })
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const openAuthorization = createOfficialConformanceAuthorizationOpener(fetchFn);
    const request = authorizationRequest();

    await openAuthorization(request.href);
    await expect(openAuthorization(request.href)).rejects.toThrow(
      'Official MCP conformance authorization request is invalid'
    );
    const arbitraryHost = authorizationRequest();
    arbitraryHost.hostname = 'attacker.example';
    await expect(openAuthorization(arbitraryHost.href)).rejects.toThrow(
      'Official MCP conformance authorization request is invalid'
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('replaces authorization transport failures with fixed secret-safe diagnostics', async () => {
    const secret = 'authorization-code-secret';
    const openAuthorization = createOfficialConformanceAuthorizationOpener(
      vi.fn(async () => {
        throw new Error(`request failed with ${secret}`);
      })
    );

    const result = openAuthorization(authorizationRequest().href);
    await expect(result).rejects.toThrow('Official MCP conformance authorization request failed');
    try {
      await result;
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each([
    {
      client_id: 'jwt-client',
      name: 'auth/client-credentials-jwt',
      private_key_pem: 'private-key',
      signing_algorithm: 'ES256',
    },
    {
      client_id: 'basic-client',
      client_secret: 'basic-secret',
      name: 'auth/client-credentials-basic',
    },
    {
      client_id: 'pre-registered-client',
      client_secret: 'pre-registered-secret',
      issuer: 'http://localhost:42002',
      name: 'auth/pre-registration',
    },
    {
      client_id: 'enterprise-client',
      client_secret: 'enterprise-secret',
      idp_client_id: 'idp-client',
      idp_id_token: 'idp-token',
      idp_issuer: 'https://issuer.example.test',
      idp_token_endpoint: 'https://issuer.example.test/token',
      name: 'auth/enterprise-managed-authorization',
    },
    {
      client_id: 'wif-client',
      expired_jwt: 'expired-jwt',
      name: 'auth/wif-jwt-bearer',
      valid_jwt: 'valid-jwt',
      wrong_audience_jwt: 'wrong-audience-jwt',
    },
  ])('parses the exact alpha.12 $name context', (context) => {
    expect(parseOfficialConformanceOAuthContext(JSON.stringify(context))).toEqual(context);
  });

  it.each([
    '{',
    '{}',
    JSON.stringify({ ...JSON.parse(PRE_REGISTRATION_CONTEXT), extra: true }),
    JSON.stringify({
      client_id: '',
      client_secret: 'secret-must-not-appear',
      issuer: PRE_REGISTRATION_ISSUER,
      name: 'auth/pre-registration',
    }),
    // The pre-alpha.12 shape names no issuing authorization server to bind.
    JSON.stringify({
      client_id: 'pre-registered-client',
      client_secret: 'secret-must-not-appear',
      name: 'auth/pre-registration',
    }),
    JSON.stringify({
      client_id: 'pre-registered-client',
      client_secret: 'secret-must-not-appear',
      issuer: 'not-an-absolute-url',
      name: 'auth/pre-registration',
    }),
  ])('rejects malformed context without echoing secret material', (raw) => {
    expect(() => parseOfficialConformanceOAuthContext(raw)).toThrow(
      'Official MCP conformance OAuth context is invalid'
    );
    try {
      parseOfficialConformanceOAuthContext(raw);
    } catch (error) {
      expect(String(error)).not.toContain('secret-must-not-appear');
    }
  });

  it('rejects oversized context before parsing it', () => {
    expect(() => parseOfficialConformanceOAuthContext('x'.repeat(64 * 1024 + 1))).toThrow(
      'Official MCP conformance OAuth context is invalid'
    );
  });

  it('uses the production provider with ephemeral storage and injected authorization opening', async () => {
    const openAuthorization = vi.fn(async (): Promise<void> => undefined);
    const runtime = createEphemeralOfficialConformanceOAuthRuntime({
      context: PRE_REGISTRATION_CONTEXT,
      openAuthorization,
      scenario: 'auth/pre-registration',
    });
    const provider = await runtime.createOAuthProvider({
      allowInteractiveAuthorization: true,
      openExternal: runtime.openExternal,
      serverId: 'official-conformance',
      serverUrl: 'http://127.0.0.1:38199/mcp',
      store: runtime.oauthStore,
    });
    try {
      // Pre-registered credentials are bound to the authorization server that
      // issued them, so another discovered issuer is never offered them.
      await expect(
        provider.clientInformation({ issuer: 'http://localhost:42003' })
      ).resolves.toBeUndefined();
      const client = await provider.clientInformation({ issuer: PRE_REGISTRATION_ISSUER });
      expect(client).toMatchObject({
        client_id: 'pre-registered-client',
        client_secret: 'pre-registered-secret',
        issuer: PRE_REGISTRATION_ISSUER,
        redirect_uris: [],
        token_endpoint_auth_method: 'client_secret_basic',
      });
      expect(provider.clientMetadata.redirect_uris).toEqual([provider.redirectUrl]);
      if (!(provider.state && provider.redirectToAuthorization)) {
        throw new Error('Production OAuth provider does not expose authorization flow methods');
      }
      const state = provider.state();
      const authorizationUrl = `https://authorize.example.test/start?state=${state}`;
      await provider.redirectToAuthorization(new URL(authorizationUrl));
      expect(openAuthorization).toHaveBeenCalledWith(authorizationUrl);
    } finally {
      await provider.close();
      await runtime.oauthStore.clearAll();
    }
  });

  it('supplies the canonical CIMD identity only to auth/basic-cimd', async () => {
    const createProvider = async (scenario: (typeof OFFICIAL_AUTH_SCENARIO_NAMES)[number]) => {
      const runtime = createEphemeralOfficialConformanceOAuthRuntime({
        openAuthorization: vi.fn(),
        scenario,
      });
      return await runtime.createOAuthProvider({
        openExternal: runtime.openExternal,
        serverId: 'official-conformance',
        serverUrl: 'http://127.0.0.1:38199/mcp',
        store: runtime.oauthStore,
      });
    };
    const cimd = await createProvider('auth/basic-cimd');
    const metadata = await createProvider('auth/metadata-default');
    try {
      expect(cimd.clientMetadataUrl).toBe('https://conformance-test.local/client-metadata.json');
      expect(metadata.clientMetadataUrl).toBeUndefined();
    } finally {
      await cimd.close();
      await metadata.close();
    }
  });

  it.each([
    {
      client_id: 'client',
      name: 'auth/client-credentials-jwt',
      private_key_pem: 'private-key',
    },
    {
      client_id: 'client',
      client_secret: 'secret-must-not-appear',
      name: 'auth/client-credentials-basic',
    },
    {
      client_id: 'client',
      client_secret: 'secret-must-not-appear',
      idp_client_id: 'idp-client',
      idp_id_token: 'idp-token',
      idp_issuer: 'https://issuer.example.test',
      idp_token_endpoint: 'https://issuer.example.test/token',
      name: 'auth/enterprise-managed-authorization',
    },
    {
      client_id: 'client',
      expired_jwt: 'expired',
      name: 'auth/wif-jwt-bearer',
      valid_jwt: 'valid',
      wrong_audience_jwt: 'wrong',
    },
  ])('rejects unsupported production mode $name without exposing context', (context) => {
    const raw = JSON.stringify(context);
    expect(() =>
      createEphemeralOfficialConformanceOAuthRuntime({
        context: raw,
        openAuthorization: vi.fn(),
        scenario: 'auth/metadata-default',
      })
    ).toThrow('Official MCP conformance auth scenario context is invalid');
    try {
      createEphemeralOfficialConformanceOAuthRuntime({
        context: raw,
        openAuthorization: vi.fn(),
        scenario: 'auth/metadata-default',
      });
    } catch (error) {
      expect(String(error)).not.toContain('secret-must-not-appear');
      expect(String(error)).not.toContain('private-key');
    }
  });
});
