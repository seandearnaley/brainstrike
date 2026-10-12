import type { ProviderAuthStatus } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  createOpenAiCodexDescriptor,
  OPENAI_CODEX_PROVIDER_ID,
} from '../../src/provider-auth/descriptors/openai-codex.js';
import { createProviderAuthEngine } from '../../src/provider-auth/provider-auth-engine.js';
import { makeFakeSecrets } from './fake-secrets.js';

/**
 * FULL Codex device-authorization flow driven through the REAL descriptor,
 * the REAL response adapter, the REAL engine poll loop, the REAL token
 * exchange and the REAL JWT account extraction (BST-1356 acceptance).
 *
 * The network is stubbed at `fetchFn` rather than by pointing the descriptor
 * at a local server, precisely so the descriptor's PRODUCTION absolute URLs
 * are the ones exercised — a descriptor typo would be invisible to a test
 * that rewrote the endpoints. That stubbing is also why this is a PLAIN unit
 * test, not `*.integration.test.ts`: it binds no ports, touches no native
 * binaries and depends on no wall-clock timing, so it belongs in (and gates)
 * the required Unit lane.
 *
 * This file is also the token-material sentinel for the surfaces BST-1356
 * adds (legal gate constraint 3). It asserts over statuses produced by a real
 * flow, not hand-built shapes.
 */

const ACCESS_SENTINEL = 'CODEX-ACCESS-SENTINEL-9a3f';
const REFRESH_SENTINEL = 'CODEX-REFRESH-SENTINEL-4c7d';
const ID_TOKEN_ACCOUNT = 'acct-codex-sentinel-1';

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

const ID_TOKEN_SENTINEL = makeJwt({
  chatgpt_account_id: ID_TOKEN_ACCOUNT,
  email: 'user@example.com',
});

interface RecordedRequest {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly url: string;
}

function buildRoutingFetch(options: { pendingPolls: number }): {
  fetchFn: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let pollsSeen = 0;

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) {
      headers[key] = value;
    }
    requests.push({ body: typeof init?.body === 'string' ? init.body : '', headers, url });

    if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
      return new Response(
        JSON.stringify({
          device_auth_id: 'device-auth-abc',
          interval: '5',
          user_code: 'WXYZ-7788',
        }),
        { status: 200 }
      );
    }

    if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
      pollsSeen += 1;
      if (pollsSeen <= options.pendingPolls) {
        // Codex's "not authorized yet" signal — status only, no error body.
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(
        JSON.stringify({
          authorization_code: 'device-auth-code-1',
          code_verifier: 'server-supplied-verifier-1',
        }),
        { status: 200 }
      );
    }

    if (url === 'https://auth.openai.com/oauth/token') {
      return new Response(
        JSON.stringify({
          access_token: ACCESS_SENTINEL,
          expires_in: 3600,
          id_token: ID_TOKEN_SENTINEL,
          refresh_token: REFRESH_SENTINEL,
          token_type: 'Bearer',
        }),
        { status: 200 }
      );
    }

    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;

  return { fetchFn, requests };
}

describe('OpenAI Codex device flow end to end', () => {
  it('polls through 403, exchanges the server-supplied verifier, and persists the account', async () => {
    const { fetchFn, requests } = buildRoutingFetch({ pendingPolls: 2 });
    const secrets = makeFakeSecrets();
    const descriptor = createOpenAiCodexDescriptor({ userAgent: 'brainstrike/9.9.9 (test)' });
    const observed: ProviderAuthStatus[] = [];

    const engine = createProviderAuthEngine({
      fetchFn,
      getDescriptor: () => descriptor,
      openExternal: async () => undefined,
      secrets,
      // Collapse the poll interval; the loop mechanics are the engine's own
      // tested behavior, this test is about the Codex shapes.
      sleep: async () => undefined,
    });

    observed.push(await engine.start(OPENAI_CODEX_PROVIDER_ID, 'device'));
    expect(observed[0]).toEqual({
      state: 'awaiting_device_code',
      userCode: 'WXYZ-7788',
      verificationUri: 'https://auth.openai.com/codex/device',
    });

    await vi.waitFor(async () => {
      const status = await engine.getStatus(OPENAI_CODEX_PROVIDER_ID);
      observed.push(status);
      expect(status).toEqual({ accountId: ID_TOKEN_ACCOUNT, state: 'connected' });
    });

    // The start request carried the Codex client id as JSON.
    const start = requests.find((request) => request.url.endsWith('/deviceauth/usercode'));
    expect(JSON.parse(start?.body ?? '{}')).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    });
    expect(start?.headers['user-agent']).toBe('brainstrike/9.9.9 (test)');

    // It kept polling through both 403s rather than failing.
    expect(requests.filter((request) => request.url.endsWith('/deviceauth/token'))).toHaveLength(3);

    // The exchange used the SERVER-supplied verifier and the device redirect.
    const exchange = requests.find(
      (request) => request.url === 'https://auth.openai.com/oauth/token'
    );
    const exchangeBody = new URLSearchParams(exchange?.body ?? '');
    expect(exchangeBody.get('grant_type')).toBe('authorization_code');
    expect(exchangeBody.get('code')).toBe('device-auth-code-1');
    expect(exchangeBody.get('code_verifier')).toBe('server-supplied-verifier-1');
    expect(exchangeBody.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
    expect(exchangeBody.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');

    // The credential landed, with the account id read from the id_token JWT.
    expect(secrets.store.get(OPENAI_CODEX_PROVIDER_ID)).toMatchObject({
      access: ACCESS_SENTINEL,
      accountId: ID_TOKEN_ACCOUNT,
      refresh: REFRESH_SENTINEL,
      type: 'oauth',
    });

    // SENTINEL (gate constraint 3): no token material in any observed status.
    const serialized = JSON.stringify(observed);
    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect(serialized).not.toContain(ACCESS_SENTINEL);
    expect(serialized).not.toContain(REFRESH_SENTINEL);
    expect(serialized).not.toContain(ID_TOKEN_SENTINEL);
    expect(serialized).not.toMatch(/access_token|refresh_token|id_token/i);
    // The account id IS allowed to cross (it is the display identity), but the
    // email claim riding the same JWT must not.
    expect(serialized).not.toContain('user@example.com');
  });

  it('disconnect wipes the credential so factory reset leaves nothing behind', async () => {
    const { fetchFn } = buildRoutingFetch({ pendingPolls: 0 });
    const secrets = makeFakeSecrets();
    const descriptor = createOpenAiCodexDescriptor({ userAgent: 'brainstrike/9.9.9 (test)' });
    const engine = createProviderAuthEngine({
      fetchFn,
      getDescriptor: () => descriptor,
      openExternal: async () => undefined,
      secrets,
      sleep: async () => undefined,
    });

    await engine.start(OPENAI_CODEX_PROVIDER_ID, 'device');
    await vi.waitFor(async () => {
      expect(await engine.getStatus(OPENAI_CODEX_PROVIDER_ID)).toMatchObject({
        state: 'connected',
      });
    });

    expect(await engine.disconnect(OPENAI_CODEX_PROVIDER_ID)).toEqual({ state: 'disconnected' });
    expect(secrets.store.get(OPENAI_CODEX_PROVIDER_ID)).toBeUndefined();
    expect(await secrets.listProviders()).toEqual([]);
  });

  it('a fresh access token is served without a redundant refresh round trip', async () => {
    const { fetchFn, requests } = buildRoutingFetch({ pendingPolls: 0 });
    const secrets = makeFakeSecrets();
    const descriptor = createOpenAiCodexDescriptor({ userAgent: 'brainstrike/9.9.9 (test)' });
    const engine = createProviderAuthEngine({
      fetchFn,
      getDescriptor: () => descriptor,
      openExternal: async () => undefined,
      secrets,
      sleep: async () => undefined,
    });

    await engine.start(OPENAI_CODEX_PROVIDER_ID, 'device');
    await vi.waitFor(async () => {
      expect(await engine.getStatus(OPENAI_CODEX_PROVIDER_ID)).toMatchObject({
        state: 'connected',
      });
    });
    const requestsAfterConnect = requests.length;

    const result = await engine.getFreshAccessToken(OPENAI_CODEX_PROVIDER_ID);
    expect(result).toEqual({ accessToken: ACCESS_SENTINEL, ok: true });
    // The token is well inside its lifetime, so no network call was made.
    expect(requests).toHaveLength(requestsAfterConnect);
  });
});
