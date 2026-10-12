import type {
  DeviceFlowHttpResponse,
  DeviceFlowResponseAdapter,
  OAuthProviderDescriptor,
} from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_FLOW_DEFAULT_INTERVAL_MS,
  DEVICE_FLOW_POLL_SAFETY_MARGIN_MS,
  DEVICE_FLOW_SLOW_DOWN_INCREMENT_MS,
  pollDeviceFlow,
  RFC8628_DEVICE_FLOW_ADAPTER,
  startDeviceFlow,
} from '../../src/provider-auth/device-flow.js';
import { isProviderAuthFlowCancelled } from '../../src/provider-auth/errors.js';

function makeDescriptor(overrides: Partial<OAuthProviderDescriptor> = {}): OAuthProviderDescriptor {
  return {
    authorizeUrl: 'https://provider.test/authorize',
    clientId: 'client-123',
    deviceFlow: {
      pollUrl: 'https://provider.test/device/token',
      startUrl: 'https://provider.test/device/code',
      verificationUri: 'https://provider.test/activate',
    },
    providerId: 'fake-provider',
    redirectPath: '/callback',
    redirectPort: 5,
    scopes: ['openid', 'offline_access'],
    tokenUrl: 'https://provider.test/token',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

function sequencedFetch(responses: Response[]): typeof fetch {
  let index = 0;
  return vi.fn(async () => {
    const response = responses[index];
    index += 1;
    if (!response) {
      throw new Error('sequencedFetch exhausted');
    }
    return response;
  }) as unknown as typeof fetch;
}

const START_BODY = {
  device_code: 'device-code-1',
  expires_in: 600,
  interval: 5,
  user_code: 'ABCD-1234',
  verification_uri: 'https://provider.test/activate',
};

const TOKENS_BODY = {
  access_token: 'access-1',
  expires_in: 3600,
  refresh_token: 'refresh-1',
  token_type: 'Bearer',
};

describe('startDeviceFlow (RFC 8628 adapter)', () => {
  it('parses the start response and normalizes seconds to milliseconds', async () => {
    const fetchFn = sequencedFetch([jsonResponse(200, START_BODY)]);

    const start = await startDeviceFlow(makeDescriptor(), { fetchFn });

    expect(start).toMatchObject({
      deviceCode: 'device-code-1',
      expiresInMs: 600_000,
      intervalMs: 5000,
      userCode: 'ABCD-1234',
      verificationUri: 'https://provider.test/activate',
    });
  });

  it('defends the interval against garbage server values', () => {
    const start = RFC8628_DEVICE_FLOW_ADAPTER.parseStartResponse({
      body: { ...START_BODY, expires_in: -3, interval: 'NaN' },
      status: 200,
    });
    expect(start.intervalMs).toBe(DEVICE_FLOW_DEFAULT_INTERVAL_MS);
    expect(start.expiresInMs).toBeGreaterThan(0);
  });

  it('throws on a start response missing required fields', async () => {
    const fetchFn = sequencedFetch([jsonResponse(200, { interval: 5 })]);
    await expect(startDeviceFlow(makeDescriptor(), { fetchFn })).rejects.toMatchObject({
      code: 'device_flow_failed',
    });
  });

  it('throws device_flow_unsupported when the descriptor has no device flow', async () => {
    const fetchFn = sequencedFetch([]);
    const { deviceFlow: _deviceFlow, ...withoutDeviceFlow } = makeDescriptor();
    await expect(startDeviceFlow(withoutDeviceFlow, { fetchFn })).rejects.toMatchObject({
      code: 'device_flow_unsupported',
    });
  });
});

describe('pollDeviceFlow (RFC 8628 adapter)', () => {
  const start = {
    deviceCode: 'device-code-1',
    expiresInMs: 600_000,
    intervalMs: 5000,
    userCode: 'ABCD-1234',
    verificationUri: 'https://provider.test/activate',
  };

  it('keeps polling through authorization_pending and returns tokens', async () => {
    const sleeps: number[] = [];
    const fetchFn = sequencedFetch([
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, TOKENS_BODY),
    ]);

    const outcome = await pollDeviceFlow(makeDescriptor(), start, {
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(outcome).toMatchObject({
      kind: 'tokens',
      tokens: { accessToken: 'access-1', expiresInSeconds: 3600, refreshToken: 'refresh-1' },
    });
    expect(sleeps).toEqual([5000 + DEVICE_FLOW_POLL_SAFETY_MARGIN_MS]);
  });

  it('backs off on slow_down by the spec increment and keeps the raised interval', async () => {
    const sleeps: number[] = [];
    const fetchFn = sequencedFetch([
      jsonResponse(400, { error: 'slow_down' }),
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, TOKENS_BODY),
    ]);

    await pollDeviceFlow(makeDescriptor(), start, {
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const raised = 5000 + DEVICE_FLOW_SLOW_DOWN_INCREMENT_MS;
    expect(sleeps).toEqual([
      raised + DEVICE_FLOW_POLL_SAFETY_MARGIN_MS,
      raised + DEVICE_FLOW_POLL_SAFETY_MARGIN_MS,
    ]);
  });

  it('treats expired_token as terminal', async () => {
    const fetchFn = sequencedFetch([jsonResponse(400, { error: 'expired_token' })]);
    const sleep = vi.fn(async () => {
      /* never expected */
    });

    await expect(pollDeviceFlow(makeDescriptor(), start, { fetchFn, sleep })).rejects.toMatchObject(
      { code: 'device_flow_expired' }
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats access_denied as terminal', async () => {
    const fetchFn = sequencedFetch([jsonResponse(400, { error: 'access_denied' })]);

    await expect(pollDeviceFlow(makeDescriptor(), start, { fetchFn })).rejects.toMatchObject({
      code: 'device_flow_denied',
    });
  });

  it('enforces the hard deadline from expires_in', async () => {
    let clock = 0;
    const fetchFn = sequencedFetch([
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(400, { error: 'authorization_pending' }),
    ]);

    await expect(
      pollDeviceFlow(
        makeDescriptor(),
        { ...start, expiresInMs: 9000 },
        {
          fetchFn,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        }
      )
    ).rejects.toMatchObject({ code: 'device_flow_expired' });
  });

  it('rejects with a cancellation error when aborted mid-wait', async () => {
    const controller = new AbortController();
    const fetchFn = sequencedFetch([jsonResponse(400, { error: 'authorization_pending' })]);

    const outcome = pollDeviceFlow(makeDescriptor(), start, {
      cancelSignal: controller.signal,
      fetchFn,
      sleep: () => new Promise<void>(() => undefined),
    }).then(
      () => {
        throw new Error('expected cancellation');
      },
      (error: unknown) => error
    );

    controller.abort();

    await expect(outcome).resolves.toSatisfy(isProviderAuthFlowCancelled);
  });

  it('cancels a stalled response body and ignores a late token grant', async () => {
    const controller = new AbortController();
    let resolveBody: ((body: string) => void) | undefined;
    let bodyStarted: (() => void) | undefined;
    const reachedBody = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => {
            bodyStarted?.();
            return await new Promise<string>((resolve) => {
              resolveBody = resolve;
            });
          },
        }) as Response
    );
    const pending = pollDeviceFlow(makeDescriptor(), start, {
      cancelSignal: controller.signal,
      fetchFn,
      fetchTimeoutMs: 10_000,
    });
    await reachedBody;
    controller.abort();
    await expect(pending).rejects.toSatisfy(isProviderAuthFlowCancelled);
    resolveBody?.(JSON.stringify(TOKENS_BODY));
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('missing refresh_token in a token response is a visible failure', async () => {
    const fetchFn = sequencedFetch([
      jsonResponse(200, { access_token: 'access-1', token_type: 'Bearer' }),
    ]);

    await expect(pollDeviceFlow(makeDescriptor(), start, { fetchFn })).rejects.toMatchObject({
      code: 'device_flow_failed',
    });
  });
});

/**
 * Codex-shaped test double (BST-1355 acceptance): proves opencode's
 * NON-standard Codex device flow — JSON start/poll bodies, 403/404 = keep
 * polling, poll success yields an authorization code plus a SERVER-supplied
 * code_verifier that still needs a standard token exchange — is expressible
 * purely as a descriptor adapter, with zero engine changes. The real adapter
 * ships in BST-1356.
 */
const codexShapedAdapter: DeviceFlowResponseAdapter = {
  buildPollRequest: (_descriptor, flowStart) => ({
    body: JSON.stringify({
      device_auth_id: flowStart.deviceCode,
      user_code: flowStart.userCode,
    }),
    headers: { 'Content-Type': 'application/json' },
    url: 'https://issuer.test/api/accounts/deviceauth/token',
  }),
  buildStartRequest: (descriptor) => ({
    body: JSON.stringify({ client_id: descriptor.clientId }),
    headers: { 'Content-Type': 'application/json' },
    url: 'https://issuer.test/api/accounts/deviceauth/usercode',
  }),
  classifyPollResponse: (response: DeviceFlowHttpResponse) => {
    if (response.status === 403 || response.status === 404) {
      return { kind: 'pending' };
    }
    if (response.status === 200) {
      const body = response.body as { authorization_code: string; code_verifier: string };
      return {
        code: body.authorization_code,
        codeVerifier: body.code_verifier,
        kind: 'authorization_code',
        redirectUri: 'https://issuer.test/deviceauth/callback',
      };
    }
    return { kind: 'failure', message: `unexpected status ${response.status}` };
  },
  parseStartResponse: (response) => {
    const body = response.body as { device_auth_id: string; interval: string; user_code: string };
    const intervalSeconds = Number.parseInt(body.interval, 10);
    return {
      deviceCode: body.device_auth_id,
      expiresInMs: 600_000,
      intervalMs: Math.max(Number.isFinite(intervalSeconds) ? intervalSeconds : 5, 1) * 1000,
      userCode: body.user_code,
      verificationUri: 'https://issuer.test/codex/device',
    };
  },
};

describe('descriptor-custom adapter (Codex-shaped test double)', () => {
  it('runs the non-standard start/poll shapes without engine changes', async () => {
    const descriptor = makeDescriptor({
      deviceFlow: {
        pollUrl: 'https://issuer.test/api/accounts/deviceauth/token',
        responseAdapter: codexShapedAdapter,
        startUrl: 'https://issuer.test/api/accounts/deviceauth/usercode',
        verificationUri: 'https://issuer.test/codex/device',
      },
    });
    const sleeps: number[] = [];
    const fetchFn = sequencedFetch([
      jsonResponse(200, { device_auth_id: 'auth-id-9', interval: '5', user_code: 'WXYZ-7890' }),
      jsonResponse(403, {}),
      jsonResponse(404, {}),
      jsonResponse(200, {
        authorization_code: 'codex-auth-code',
        code_verifier: 'server-supplied-verifier',
      }),
    ]);

    const flowStart = await startDeviceFlow(descriptor, { fetchFn });
    expect(flowStart).toMatchObject({ deviceCode: 'auth-id-9', userCode: 'WXYZ-7890' });

    const outcome = await pollDeviceFlow(descriptor, flowStart, {
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(outcome).toEqual({
      code: 'codex-auth-code',
      codeVerifier: 'server-supplied-verifier',
      kind: 'authorization_code',
      redirectUri: 'https://issuer.test/deviceauth/callback',
    });
    expect(sleeps).toHaveLength(2);
  });
});
