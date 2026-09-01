// biome-ignore-all lint/style/useNamingConvention: canonical MCP conformance and OAuth fixtures use snake_case.
import { describe, expect, it, vi } from 'vitest';
import {
  createEphemeralOfficialConformanceOAuthRuntime,
  parseOfficialConformanceOAuthContext,
} from '../../mcp/official-conformance-oauth.js';

const PRE_REGISTRATION_CONTEXT = JSON.stringify({
  client_id: 'pre-registered-client',
  client_secret: 'pre-registered-secret',
  name: 'auth/pre-registration',
});

describe('official conformance ephemeral OAuth adapter', () => {
  it('accepts an absent context for dynamic-registration scenarios', () => {
    expect(parseOfficialConformanceOAuthContext(undefined)).toBeUndefined();
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
  ])('parses the exact alpha.10 $name context', (context) => {
    expect(parseOfficialConformanceOAuthContext(JSON.stringify(context))).toEqual(context);
  });

  it.each([
    '{',
    '{}',
    JSON.stringify({ ...JSON.parse(PRE_REGISTRATION_CONTEXT), extra: true }),
    JSON.stringify({
      client_id: '',
      client_secret: 'secret-must-not-appear',
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
    });
    const provider = await runtime.createOAuthProvider({
      openExternal: runtime.openExternal,
      serverId: 'official-conformance',
      serverUrl: 'http://127.0.0.1:38199/mcp',
      store: runtime.oauthStore,
    });
    try {
      const client = await provider.clientInformation({
        issuer: 'http://127.0.0.1:38198',
      });
      expect(client).toMatchObject({
        client_id: 'pre-registered-client',
        client_secret: 'pre-registered-secret',
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
      createEphemeralOfficialConformanceOAuthRuntime({ context: raw, openAuthorization: vi.fn() })
    ).toThrow(`Official MCP conformance OAuth context "${context.name}" is not supported`);
    try {
      createEphemeralOfficialConformanceOAuthRuntime({
        context: raw,
        openAuthorization: vi.fn(),
      });
    } catch (error) {
      expect(String(error)).not.toContain('secret-must-not-appear');
      expect(String(error)).not.toContain('private-key');
    }
  });
});
