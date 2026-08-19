import type { DeviceFlowHttpResponse, OAuthTokenGrant } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  buildCodexUserAgent,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_VERIFICATION_URI,
  CODEX_RESPONSES_ENDPOINT,
  createOpenAiCodexDescriptor,
  extractCodexAccountId,
  extractCodexResidency,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_PROVIDER_ID,
  parseJwtClaims,
} from '../../provider-auth/descriptors/openai-codex';
import { buildAuthorizeUrl } from '../../provider-auth/oauth-flow';

const TEST_USER_AGENT = 'brainstrike/9.9.9 (testos 1.0; x64)';
const openAiCodexDescriptor = createOpenAiCodexDescriptor({ userAgent: TEST_USER_AGENT });

/**
 * OpenAI Codex OAuth descriptor (BST-1356).
 *
 * Every constant here is pinned against opencode's
 * `packages/opencode/src/plugin/openai/codex.ts` (re-verified at implementation
 * time per legal gate constraint 8). A drift in any of these values changes
 * which OAuth client we present ourselves as, so they are asserted literally
 * rather than read back from the module under test.
 */

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

function grantWith(tokens: { access?: string; id?: string }): OAuthTokenGrant {
  return {
    accessToken: tokens.access ?? 'access-token',
    raw: { ...(tokens.id === undefined ? {} : { id_token: tokens.id }) },
    refreshToken: 'refresh-token',
  };
}

function jsonResponse(status: number, body: unknown): DeviceFlowHttpResponse {
  return { body, status };
}

describe('openai-codex descriptor constants', () => {
  it('pins the Codex CLI OAuth client registration', () => {
    expect(OPENAI_CODEX_PROVIDER_ID).toBe('openai-codex');
    expect(OPENAI_CODEX_CLIENT_ID).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(openAiCodexDescriptor.providerId).toBe('openai-codex');
    expect(openAiCodexDescriptor.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(openAiCodexDescriptor.authorizeUrl).toBe('https://auth.openai.com/oauth/authorize');
    expect(openAiCodexDescriptor.tokenUrl).toBe('https://auth.openai.com/oauth/token');
    expect(openAiCodexDescriptor.redirectPort).toBe(1455);
    expect(openAiCodexDescriptor.redirectPath).toBe('/auth/callback');
    expect(openAiCodexDescriptor.scopes).toEqual(['openid', 'profile', 'email', 'offline_access']);
  });

  it('identifies Brainstrike honestly in the authorize params (gate constraint 5)', () => {
    expect(openAiCodexDescriptor.extraAuthorizeParams).toEqual({
      codex_cli_simplified_flow: 'true',
      id_token_add_organizations: 'true',
      originator: 'brainstrike',
    });
  });

  it('carries the honest originator through the engine-built authorize URL', () => {
    const url = new URL(
      buildAuthorizeUrl(openAiCodexDescriptor, {
        codeChallenge: 'challenge-value',
        redirectUri: 'http://127.0.0.1:1455/auth/callback',
        state: 'state-value',
      })
    );
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(url.searchParams.get('originator')).toBe('brainstrike');
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    // Never another tool's identity.
    expect(url.search).not.toContain('opencode');
  });

  it('points the device flow at the non-standard Codex endpoints', () => {
    const deviceFlow = openAiCodexDescriptor.deviceFlow;
    if (!deviceFlow) {
      throw new Error('expected a device flow descriptor');
    }
    expect(deviceFlow.startUrl).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(deviceFlow.pollUrl).toBe('https://auth.openai.com/api/accounts/deviceauth/token');
    expect(deviceFlow.verificationUri).toBe('https://auth.openai.com/codex/device');
    expect(CODEX_DEVICE_VERIFICATION_URI).toBe('https://auth.openai.com/codex/device');
    expect(CODEX_DEVICE_REDIRECT_URI).toBe('https://auth.openai.com/deviceauth/callback');
    expect(deviceFlow.responseAdapter).toBeDefined();
  });
});

describe('openai-codex device-flow response adapter', () => {
  const adapter = openAiCodexDescriptor.deviceFlow?.responseAdapter;
  if (!adapter) {
    throw new Error('expected a Codex device-flow response adapter');
  }

  it('starts with a JSON client_id body, not RFC 8628 form encoding', () => {
    const request = adapter.buildStartRequest(openAiCodexDescriptor);
    expect(request.url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(request.headers['User-Agent']).toBe(TEST_USER_AGENT);
    expect(JSON.parse(request.body)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
  });

  it('parses the usercode response, carrying device_auth_id as the poll handle', () => {
    const start = adapter.parseStartResponse(
      jsonResponse(200, {
        device_auth_id: 'device-auth-123',
        interval: '5',
        user_code: 'WXYZ-7788',
      })
    );
    expect(start.deviceCode).toBe('device-auth-123');
    expect(start.userCode).toBe('WXYZ-7788');
    // The verification URI is descriptor-supplied; the usercode response has none.
    expect(start.verificationUri).toBe('https://auth.openai.com/codex/device');
    expect(start.intervalMs).toBe(5000);
  });

  it('floors a too-small or unusable interval instead of busy-looping', () => {
    const start = adapter.parseStartResponse(
      jsonResponse(200, { device_auth_id: 'd', interval: '0', user_code: 'C-1' })
    );
    expect(start.intervalMs).toBeGreaterThanOrEqual(1000);
    const nanStart = adapter.parseStartResponse(
      jsonResponse(200, { device_auth_id: 'd', interval: 'not-a-number', user_code: 'C-1' })
    );
    expect(nanStart.intervalMs).toBeGreaterThanOrEqual(1000);
  });

  it('throws on an unusable start response rather than inventing a device code', () => {
    expect(() => adapter.parseStartResponse(jsonResponse(500, { error: 'boom' }))).toThrow();
    expect(() => adapter.parseStartResponse(jsonResponse(200, { user_code: 'C-1' }))).toThrow();
    expect(() => adapter.parseStartResponse(jsonResponse(200, undefined))).toThrow();
  });

  it('polls with the device_auth_id and user_code as JSON', () => {
    const start = adapter.parseStartResponse(
      jsonResponse(200, {
        device_auth_id: 'device-auth-123',
        interval: '5',
        user_code: 'WXYZ-7788',
      })
    );
    const request = adapter.buildPollRequest(openAiCodexDescriptor, start);
    expect(request.url).toBe('https://auth.openai.com/api/accounts/deviceauth/token');
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(request.body)).toEqual({
      device_auth_id: 'device-auth-123',
      user_code: 'WXYZ-7788',
    });
  });

  it('treats 403 and 404 as keep-polling (the Codex pending signal)', () => {
    expect(adapter.classifyPollResponse(jsonResponse(403, {}))).toEqual({ kind: 'pending' });
    expect(adapter.classifyPollResponse(jsonResponse(404, {}))).toEqual({ kind: 'pending' });
    // Non-JSON bodies on those statuses are still pending: Codex classifies on
    // status alone.
    expect(adapter.classifyPollResponse(jsonResponse(403, undefined))).toEqual({ kind: 'pending' });
  });

  it('returns an authorization code plus the server-supplied verifier on success', () => {
    const outcome = adapter.classifyPollResponse(
      jsonResponse(200, { authorization_code: 'auth-code-9', code_verifier: 'server-verifier-9' })
    );
    expect(outcome).toEqual({
      code: 'auth-code-9',
      codeVerifier: 'server-verifier-9',
      kind: 'authorization_code',
      redirectUri: 'https://auth.openai.com/deviceauth/callback',
    });
  });

  it('fails visibly on a 200 that lacks the code pair (no silent fallback)', () => {
    const outcome = adapter.classifyPollResponse(jsonResponse(200, { authorization_code: 'only' }));
    expect(outcome.kind).toBe('failure');
  });

  it('fails on any other non-ok status instead of polling forever', () => {
    expect(adapter.classifyPollResponse(jsonResponse(400, {})).kind).toBe('failure');
    expect(adapter.classifyPollResponse(jsonResponse(500, {})).kind).toBe('failure');
  });
});

describe('codex account id extraction', () => {
  it('reads the top-level chatgpt_account_id claim first', () => {
    const grant = grantWith({
      id: makeJwt({
        chatgpt_account_id: 'acct-top',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-namespaced' },
        organizations: [{ id: 'org-1' }],
      }),
    });
    expect(extractCodexAccountId(grant)).toBe('acct-top');
  });

  it('falls back to the namespaced auth claim', () => {
    const grant = grantWith({
      id: makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-namespaced' },
        organizations: [{ id: 'org-1' }],
      }),
    });
    expect(extractCodexAccountId(grant)).toBe('acct-namespaced');
  });

  it('falls back to the first organization id', () => {
    const grant = grantWith({ id: makeJwt({ organizations: [{ id: 'org-1' }, { id: 'org-2' }] }) });
    expect(extractCodexAccountId(grant)).toBe('org-1');
  });

  it('prefers the id_token over the access token', () => {
    const grant = grantWith({
      access: makeJwt({ chatgpt_account_id: 'acct-from-access' }),
      id: makeJwt({ chatgpt_account_id: 'acct-from-id' }),
    });
    expect(extractCodexAccountId(grant)).toBe('acct-from-id');
  });

  it('falls through to the access token when the id_token carries no account id', () => {
    const grant = grantWith({
      access: makeJwt({ chatgpt_account_id: 'acct-from-access' }),
      id: makeJwt({ email: 'user@example.com' }),
    });
    expect(extractCodexAccountId(grant)).toBe('acct-from-access');
  });

  it('returns undefined rather than guessing when no claim carries an account', () => {
    expect(extractCodexAccountId(grantWith({ access: makeJwt({ email: 'u@example.com' }) }))).toBe(
      undefined
    );
    expect(extractCodexAccountId(grantWith({ access: 'not-a-jwt' }))).toBe(undefined);
    expect(extractCodexAccountId(grantWith({ access: 'a.b.c' }))).toBe(undefined);
  });

  it('is the descriptor-registered extractor', () => {
    const grant = grantWith({ id: makeJwt({ chatgpt_account_id: 'acct-wired' }) });
    expect(openAiCodexDescriptor.extractAccountId?.(grant)).toBe('acct-wired');
  });
});

describe('parseJwtClaims', () => {
  it('decodes a base64url payload', () => {
    expect(parseJwtClaims(makeJwt({ email: 'user@example.com' }))).toEqual({
      email: 'user@example.com',
    });
  });

  it('returns undefined for malformed tokens instead of throwing', () => {
    expect(parseJwtClaims('nope')).toBe(undefined);
    expect(parseJwtClaims('a.b')).toBe(undefined);
    expect(parseJwtClaims('a.!!!not-base64!!!.c')).toBe(undefined);
  });
});

describe('codex data residency (opencode dev HEAD 0033bb3559, upstream #42432)', () => {
  it('prefers the namespaced residency claim over the top-level one', () => {
    // Deliberately the OPPOSITE precedence from the account id — mirrors
    // upstream rather than "correcting" it.
    const token = makeJwt({
      chatgpt_compute_residency: 'top-level-region',
      'https://api.openai.com/auth': { chatgpt_compute_residency: 'namespaced-region' },
    });
    expect(extractCodexResidency(token)).toBe('namespaced-region');
  });

  it('falls back to the top-level residency claim', () => {
    expect(extractCodexResidency(makeJwt({ chatgpt_compute_residency: 'eu' }))).toBe('eu');
  });

  it('treats no_constraint as no residency header', () => {
    expect(extractCodexResidency(makeJwt({ chatgpt_compute_residency: 'no_constraint' }))).toBe(
      undefined
    );
  });

  it('returns undefined for absent claims or unparseable tokens', () => {
    expect(extractCodexResidency(makeJwt({ email: 'u@example.com' }))).toBe(undefined);
    expect(extractCodexResidency('not-a-jwt')).toBe(undefined);
  });
});

describe('codex user agent and endpoint constants', () => {
  it('identifies Brainstrike and its version honestly', () => {
    const userAgent = buildCodexUserAgent('1.2.3');
    expect(userAgent.startsWith('brainstrike/1.2.3 (')).toBe(true);
    expect(userAgent).not.toContain('opencode');
    expect(userAgent).not.toContain('codex_cli');
  });

  it('pins the Codex responses backend', () => {
    expect(CODEX_RESPONSES_ENDPOINT).toBe('https://chatgpt.com/backend-api/codex/responses');
  });
});
