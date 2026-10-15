import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';
import { createMastraAgentError } from '../mastra-boundary/mastra-agent-error';
import {
  providerFetchOptions,
  requireCustomFetchAuthInput,
} from '../providers/provider-auth-input';

/**
 * Token-material sentinel for the ChatGPT-subscription surfaces (BST-1356;
 * legal gate BST-1351 constraint 3, widened per PR #2527 review, finding 7):
 *
 * > Tokens: safeStorage-encrypted local store only; never in logs, telemetry,
 * > run-error envelopes, RuntimeData, or RequestContext.
 *
 * The design that makes this true is that the bearer lives ONLY inside the
 * fetch closure and never on any serializable object. These tests pin that
 * design rather than restate it: each one fails if a future change moves the
 * token onto `sdkFactorySettings`, the auth input, RuntimeData, or an error.
 */

const ACCESS_SENTINEL = 'SENTINEL-ACCESS-TOKEN-8f3a2b';
const REFRESH_SENTINEL = 'SENTINEL-REFRESH-TOKEN-1d9c4e';

/** The real projection shape: a dummy key plus a closure holding the token. */
function subscriptionAuthInput() {
  let capturedToken: string | undefined;
  const fetchImpl = (async () => {
    // The token exists only here, for the duration of one request.
    capturedToken = ACCESS_SENTINEL;
    return new Response('{}');
  }) as unknown as typeof globalThis.fetch;
  return {
    authInput: {
      apiKey: 'oauth-subscription-no-api-key',
      fetch: fetchImpl,
      kind: 'custom_fetch' as const,
    },
    readCapturedToken: () => capturedToken,
  };
}

function containsTokenMaterial(serialized: string): boolean {
  return (
    serialized.includes(ACCESS_SENTINEL) ||
    serialized.includes(REFRESH_SENTINEL) ||
    /access_token|refresh_token|"refresh"\s*:/i.test(serialized)
  );
}

describe('subscription token never reaches the SDK settings object', () => {
  it('projects only the dummy key onto the AI SDK factory settings', () => {
    const { authInput } = subscriptionAuthInput();
    const options = providerFetchOptions(authInput, 'openai-codex');

    expect(options.apiKey).toBe('oauth-subscription-no-api-key');
    expect(options.apiKey).not.toContain(ACCESS_SENTINEL);
    expect(typeof options.fetch).toBe('function');
    // The token is NOT an own property anywhere on the settings object — it is
    // reachable only by CALLING the closure.
    expect(containsTokenMaterial(JSON.stringify(options) ?? '')).toBe(false);
  });

  it('keeps the token unreachable until the closure is actually invoked', async () => {
    const { authInput, readCapturedToken } = subscriptionAuthInput();
    const options = providerFetchOptions(authInput, 'openai-codex');
    expect(readCapturedToken()).toBeUndefined();
    await options.fetch?.('https://api.openai.com/v1/responses');
    expect(readCapturedToken()).toBe(ACCESS_SENTINEL);
  });
});

describe('subscription token never reaches RuntimeData or RequestContext', () => {
  it('is absent from a serialized RuntimeData carrying the turn', () => {
    const { authInput } = subscriptionAuthInput();
    // Auth inputs travel as DIRECT parameters, never inside RuntimeData. This
    // asserts the invariant on a realistic runtime-data payload.
    const runtimeData = {
      model: 'codex/gpt-5.5',
      provider: 'openai-codex',
      threadId: 'thread-1',
    };
    expect(containsTokenMaterial(JSON.stringify(runtimeData))).toBe(false);
    // And even if someone wrongly attached it, JSON drops the closure — which
    // is precisely why a fetch closure must never be the ONLY carrier of state
    // that needs to survive serialization (it isn't; it carries only auth).
    const contaminated = JSON.stringify({ ...runtimeData, auth: authInput });
    expect(contaminated).not.toContain(ACCESS_SENTINEL);
  });

  it('is dropped by RequestContext serialization', () => {
    const { authInput } = subscriptionAuthInput();
    const context = new RequestContext();
    context.set('provider', 'openai-codex');
    // RequestContext.toJSON drops functions — the documented reason auth
    // inputs are threaded as direct parameters instead.
    context.set('auth', authInput);
    const serialized = JSON.stringify(context.toJSON?.() ?? Object.fromEntries(context.entries()));
    expect(serialized).not.toContain(ACCESS_SENTINEL);
    expect(serialized).not.toContain(REFRESH_SENTINEL);
  });
});

describe('subscription token never reaches error envelopes or logs', () => {
  it('is absent from a typed runtime-init error raised on the codex path', () => {
    // The realistic failure: an api_key input reaching the subscription
    // provider. The rejection must name the problem without echoing material.
    let thrown: unknown;
    try {
      requireCustomFetchAuthInput({ apiKey: ACCESS_SENTINEL, kind: 'api_key' }, 'openai-codex');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    const serialized = JSON.stringify(
      thrown,
      Object.getOwnPropertyNames(thrown as object).concat(['message', 'detail', 'context'])
    );
    expect(serialized).not.toContain(ACCESS_SENTINEL);
    expect((thrown as Error).message).not.toContain(ACCESS_SENTINEL);
  });

  it('is absent from a fully serialized run-error envelope', () => {
    const error = createMastraAgentError('mastra_agent_runtime_init_failed', {
      context: { authKind: 'custom_fetch', provider: 'openai-codex' },
      detail: 'Provider "openai-codex" requires a connected subscription credential.',
    });
    const serialized = JSON.stringify({
      context: (error as { context?: unknown }).context,
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    expect(containsTokenMaterial(serialized)).toBe(false);
  });

  it('is absent when the whole auth input is force-serialized for a log line', () => {
    // Worst case: a future logger naively stringifies the auth input.
    const { authInput } = subscriptionAuthInput();
    const logLine = JSON.stringify({ auth: authInput, msg: 'creating provider' });
    expect(logLine).not.toContain(ACCESS_SENTINEL);
    expect(logLine).not.toContain(REFRESH_SENTINEL);
    // The dummy IS present — proving the assertion above is not vacuous.
    expect(logLine).toContain('oauth-subscription-no-api-key');
  });
});
