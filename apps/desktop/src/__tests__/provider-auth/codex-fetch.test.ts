import { describe, expect, it, vi } from 'vitest';
import { createCodexFetch } from '../../provider-auth/codex-fetch';

/**
 * Codex request rewriting (BST-1356).
 *
 * The AI SDK builds an OpenAI Responses request against api.openai.com and
 * signs it with whatever `apiKey` the factory was given — a DUMMY here. This
 * layer must therefore (a) strip that SDK authorization header in every shape
 * the SDK can produce, (b) attach the real subscription bearer from the
 * provider-auth engine, and (c) redirect the request onto the Codex backend.
 * Gate constraint 2: the rewrite target is OpenAI's own host — there is no
 * Brainstrike server in this path.
 */

const ACCESS_TOKEN = 'CODEX-ACCESS-TOKEN-a1b2';
const SESSION_ID = 'session-abc-123';
const USER_AGENT = 'brainstrike/9.9.9 (testos 1.0; x64)';
const RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

interface Captured {
  readonly body: string | undefined;
  readonly headers: Headers;
  readonly url: string;
}

function setup(options: { accessToken?: string; accountId?: string } = {}): {
  captured: Captured[];
  codexFetch: typeof fetch;
} {
  const captured: Captured[] = [];
  const baseFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: new Headers(init?.headers),
      url: input instanceof URL ? input.toString() : String(input),
    });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  const codexFetch = createCodexFetch({
    ...(options.accountId === undefined ? {} : { getAccountId: () => options.accountId }),
    baseFetch,
    getAccessToken: async () => options.accessToken ?? ACCESS_TOKEN,
    sessionId: SESSION_ID,
    userAgent: USER_AGENT,
  });
  return { captured, codexFetch };
}

const BODY = JSON.stringify({ input: [], model: 'gpt-5.5' });

describe('codexFetch authorization header stripping', () => {
  it('replaces a Headers-instance authorization with the subscription bearer', async () => {
    const { captured, codexFetch } = setup();
    const headers = new Headers({ authorization: 'Bearer SDK-DUMMY-KEY', 'x-keep': 'yes' });
    await codexFetch('https://api.openai.com/v1/responses', {
      body: BODY,
      headers,
      method: 'POST',
    });
    const sent = captured[0]?.headers;
    expect(sent?.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(sent?.get('authorization')).not.toContain('SDK-DUMMY-KEY');
    expect(sent?.get('x-keep')).toBe('yes');
  });

  it('replaces a tuple-array authorization (including odd casing)', async () => {
    const { captured, codexFetch } = setup();
    await codexFetch('https://api.openai.com/v1/responses', {
      body: BODY,
      headers: [
        ['Authorization', 'Bearer SDK-DUMMY-KEY'],
        ['x-keep', 'yes'],
      ],
      method: 'POST',
    });
    const sent = captured[0]?.headers;
    expect(sent?.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(captured[0]?.headers.get('x-keep')).toBe('yes');
  });

  it('replaces a plain-object authorization in either casing', async () => {
    const { captured, codexFetch } = setup();
    await codexFetch('https://api.openai.com/v1/responses', {
      body: BODY,
      headers: { Authorization: 'Bearer SDK-DUMMY-KEY', 'x-keep': 'yes' },
      method: 'POST',
    });
    expect(captured[0]?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);

    const second = setup();
    await second.codexFetch('https://api.openai.com/v1/responses', {
      body: BODY,
      headers: { authorization: 'Bearer SDK-DUMMY-KEY' },
      method: 'POST',
    });
    expect(second.captured[0]?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('attaches the bearer when the SDK sent no authorization at all', async () => {
    const { captured, codexFetch } = setup();
    await codexFetch('https://api.openai.com/v1/responses', { body: BODY, method: 'POST' });
    expect(captured[0]?.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
  });
});

describe('codexFetch endpoint rewriting', () => {
  it('rewrites /v1/responses onto the Codex backend', async () => {
    const { captured, codexFetch } = setup();
    await codexFetch('https://api.openai.com/v1/responses', { body: BODY, method: 'POST' });
    expect(captured[0]?.url).toBe(RESPONSES_ENDPOINT);
  });

  it('rewrites /chat/completions onto the Codex backend', async () => {
    const { captured, codexFetch } = setup();
    await codexFetch('https://api.openai.com/v1/chat/completions', { body: BODY, method: 'POST' });
    expect(captured[0]?.url).toBe(RESPONSES_ENDPOINT);
  });

  it('accepts a URL instance', async () => {
    const { captured, codexFetch } = setup();
    await codexFetch(new URL('https://api.openai.com/v1/responses'), {
      body: BODY,
      method: 'POST',
    });
    expect(captured[0]?.url).toBe(RESPONSES_ENDPOINT);
  });

  it('REJECTS a Request input rather than silently sending a bodiless GET', async () => {
    // A Request carries its own method/headers/body, which this layer rebuilds
    // from `init` alone — accepting one would drop the payload silently.
    const { captured, codexFetch } = setup();
    const request = new Request('https://api.openai.com/v1/responses', {
      body: BODY,
      method: 'POST',
    });
    await expect(codexFetch(request)).rejects.toThrow(/Request object/i);
    expect(captured).toHaveLength(0);
  });

  it('leaves unrelated paths untouched', async () => {
    const { captured, codexFetch } = setup();
    await codexFetch('https://api.openai.com/v1/models', { method: 'GET' });
    expect(captured[0]?.url).toBe('https://api.openai.com/v1/models');
  });
});

describe('codexFetch identity headers', () => {
  it('sends the account id, honest originator, session id and user agent', async () => {
    const { captured, codexFetch } = setup({ accountId: 'acct-9' });
    await codexFetch('https://api.openai.com/v1/responses', { body: BODY, method: 'POST' });
    const sent = captured[0]?.headers;
    expect(sent?.get('chatgpt-account-id')).toBe('acct-9');
    expect(sent?.get('originator')).toBe('brainstrike');
    expect(sent?.get('session-id')).toBe(SESSION_ID);
    expect(sent?.get('user-agent')).toBe(USER_AGENT);
  });

  it('omits the account header when no account id is known', async () => {
    const { captured, codexFetch } = setup();
    await codexFetch('https://api.openai.com/v1/responses', { body: BODY, method: 'POST' });
    expect(captured[0]?.headers.has('chatgpt-account-id')).toBe(false);
  });

  it('never identifies as another tool', async () => {
    const { captured, codexFetch } = setup({ accountId: 'acct-9' });
    await codexFetch('https://api.openai.com/v1/responses', { body: BODY, method: 'POST' });
    const serialized = JSON.stringify([...(captured[0]?.headers.entries() ?? [])]);
    expect(serialized).not.toContain('opencode');
  });
});

describe('codexFetch data residency (upstream #42432)', () => {
  it('sets the residency header from the access token when rewriting', async () => {
    const { captured, codexFetch } = setup({
      accessToken: makeJwt({ 'https://api.openai.com/auth': { chatgpt_compute_residency: 'eu' } }),
    });
    await codexFetch('https://api.openai.com/v1/responses', { body: BODY, method: 'POST' });
    expect(captured[0]?.headers.get('x-openai-internal-codex-residency')).toBe('eu');
  });

  it('omits the residency header when the token carries no constraint', async () => {
    const { captured, codexFetch } = setup({
      accessToken: makeJwt({ chatgpt_compute_residency: 'no_constraint' }),
    });
    await codexFetch('https://api.openai.com/v1/responses', { body: BODY, method: 'POST' });
    expect(captured[0]?.headers.has('x-openai-internal-codex-residency')).toBe(false);
  });

  it('does not set the residency header on non-rewritten requests', async () => {
    const { captured, codexFetch } = setup({
      accessToken: makeJwt({ chatgpt_compute_residency: 'eu' }),
    });
    await codexFetch('https://api.openai.com/v1/models', { method: 'GET' });
    expect(captured[0]?.headers.has('x-openai-internal-codex-residency')).toBe(false);
  });
});

describe('codexFetch request body', () => {
  it('forces store:false on a rewritten request', async () => {
    const { captured, codexFetch } = setup();
    await codexFetch('https://api.openai.com/v1/responses', { body: BODY, method: 'POST' });
    expect(JSON.parse(captured[0]?.body ?? '{}')).toMatchObject({ model: 'gpt-5.5', store: false });
  });

  it('overrides an SDK-supplied store:true', async () => {
    const { captured, codexFetch } = setup();
    await codexFetch('https://api.openai.com/v1/responses', {
      body: JSON.stringify({ model: 'gpt-5.5', store: true }),
      method: 'POST',
    });
    expect(JSON.parse(captured[0]?.body ?? '{}').store).toBe(false);
  });

  it('preserves the rest of the payload verbatim', async () => {
    const { captured, codexFetch } = setup();
    const payload = { input: [{ role: 'user' }], model: 'gpt-5.4', stream: true };
    await codexFetch('https://api.openai.com/v1/responses', {
      body: JSON.stringify(payload),
      method: 'POST',
    });
    expect(JSON.parse(captured[0]?.body ?? '{}')).toEqual({ ...payload, store: false });
  });

  it('leaves non-rewritten request bodies untouched', async () => {
    const { captured, codexFetch } = setup();
    await codexFetch('https://api.openai.com/v1/models', { body: 'raw-body', method: 'POST' });
    expect(captured[0]?.body).toBe('raw-body');
  });

  it('fails visibly when a rewritten request carries an unparseable body', async () => {
    const { codexFetch } = setup();
    await expect(
      codexFetch('https://api.openai.com/v1/responses', { body: 'not-json', method: 'POST' })
    ).rejects.toThrow(/Codex/i);
  });
});

describe('codexFetch token acquisition', () => {
  it('requests a fresh token for every call (engine owns single-flight refresh)', async () => {
    const getAccessToken = vi.fn(async () => ACCESS_TOKEN);
    const baseFetch = vi.fn(
      async () => new Response('{}', { status: 200 })
    ) as unknown as typeof fetch;
    const codexFetch = createCodexFetch({
      baseFetch,
      getAccessToken,
      sessionId: SESSION_ID,
      userAgent: USER_AGENT,
    });
    await codexFetch('https://api.openai.com/v1/responses', { body: BODY, method: 'POST' });
    await codexFetch('https://api.openai.com/v1/responses', { body: BODY, method: 'POST' });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('propagates a token failure instead of sending an unauthenticated request', async () => {
    const baseFetch = vi.fn(
      async () => new Response('{}', { status: 200 })
    ) as unknown as typeof fetch;
    const codexFetch = createCodexFetch({
      baseFetch,
      getAccessToken: async () => {
        throw new Error('reconnect required');
      },
      sessionId: SESSION_ID,
      userAgent: USER_AGENT,
    });
    await expect(
      codexFetch('https://api.openai.com/v1/responses', { body: BODY, method: 'POST' })
    ).rejects.toThrow(/reconnect required/);
    expect(baseFetch).not.toHaveBeenCalled();
  });
});
