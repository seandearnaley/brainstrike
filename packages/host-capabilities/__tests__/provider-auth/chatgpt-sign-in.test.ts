import {
  BoundaryFailureError,
  type ChatGptSignInCredential,
} from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createHostAuthority, createHostCredentials } from '../../src/index.js';
import { createChatGptSignIn } from '../../src/provider-auth/chatgpt-sign-in.js';
import { type FakeChatGptIssuer, startFakeChatGptIssuer } from '../fixtures/fake-chatgpt-issuer.js';
import { memoryCredentialBackend } from '../fixtures/memory-credential-backend.js';

let openai: FakeChatGptIssuer;
beforeEach(async () => {
  openai = await startFakeChatGptIssuer();
});
afterEach(async () => {
  await openai.close();
});

function host(
  options: { readonly browser?: boolean; readonly stored?: Record<string, string> } = {}
) {
  const memory = memoryCredentialBackend(options.stored);
  const credentials = createHostCredentials({
    createNativeBackend: () => memory.backend,
    selection: { kind: 'keyring', service: 'brainstrike-test-disposable' },
  });
  const auth = createHostAuthority({
    chatGptIssuer: openai.issuer,
    credentials,
    env: {},
    ...(options.browser === false ? {} : { openExternal: (url: string) => openai.browser(url) }),
  });
  const stored = () => JSON.parse(memory.entries.get('chatgpt') ?? 'null');
  return { auth, credentials, memory, stored };
}

async function refusal(work: Promise<unknown>): Promise<string> {
  const failure = await work.then(
    () => undefined,
    (cause: unknown) => cause
  );
  expect(failure).toBeInstanceOf(BoundaryFailureError);
  return (failure as BoundaryFailureError).failure.code;
}

test('a first sign-in registers this installation and answers requests with its token', async () => {
  const { auth, credentials, stored } = host();
  try {
    await expect(auth.chatGptStatus(false)).resolves.toEqual({ state: 'signed_out' });
    await expect(auth.chatGptSignIn(false)).resolves.toEqual({
      email: 'ada@example.com',
      firstSignIn: true,
      state: 'signed_in',
    });

    const [authorization] = openai.authorizations;
    expect(Object.fromEntries(authorization ?? [])).toMatchObject({
      agent_name_hint: 'Brainstrike',
      client_id: 'dynamic_agent_client',
      code_challenge_method: 'S256',
      resource: 'https://api.openai.com/v1',
      response_type: 'code',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    });
    expect(authorization?.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/u
    );
    const record = stored();
    expect(record).toMatchObject({ email: 'ada@example.com', subject: 'user-ada' });
    expect(record.clientId).toMatch(/^oaiapp_/u);
    expect(authorization?.get('ext_agent_host_id')).toBe(record.hostId);
    // The code is exchanged as the client OpenAI issued, never as the registration entry.
    expect(openai.tokenRequests[0]?.get('client_id')).toBe(record.clientId);
    expect(openai.tokenRequests[0]?.get('resource')).toBe('https://api.openai.com/v1');

    const input = await auth.resolveProviderAuth('chatgpt');
    expect(input?.kind).toBe('access_token');
    await expect(input?.kind === 'access_token' && input.accessToken()).resolves.toBe(
      record.session.accessToken
    );
    await expect(auth.chatGptStatus(false)).resolves.toEqual({
      email: 'ada@example.com',
      state: 'signed_in',
    });
  } finally {
    await credentials.close();
  }
});

test('a token about to expire is renewed once, and the renewed session is the one kept', async () => {
  const memory = memoryCredentialBackend();
  let clock = Date.now();
  const credentials = createHostCredentials({
    createNativeBackend: () => memory.backend,
    selection: { kind: 'keyring', service: 'brainstrike-test-disposable' },
  });
  const chatGpt = createChatGptSignIn({
    issuer: openai.issuer,
    now: () => clock,
    openExternal: (url) => openai.browser(url),
    secrets: () => credentials.secrets(),
  });
  const stored = () => JSON.parse(memory.entries.get('chatgpt') ?? 'null');
  try {
    await chatGpt.signIn();
    const first = stored().session;
    await expect(chatGpt.accessToken()).resolves.toBe(first.accessToken);

    // 58 minutes on, the one-hour token has two minutes left.
    clock += 58 * 60 * 1000;
    const renewed = await Promise.all([chatGpt.accessToken(), chatGpt.accessToken()]);
    expect(renewed[0]).not.toBe(first.accessToken);
    expect(renewed[1]).toBe(renewed[0]);
    const refreshes = openai.tokenRequests.filter(
      (form) => form.get('grant_type') === 'refresh_token'
    );
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.get('client_id')).toBe(stored().clientId);
    expect(refreshes[0]?.get('resource')).toBe('https://api.openai.com/v1');
    // The rotated refresh token replaced the spent one together with the access token.
    expect(stored().session).toMatchObject({ accessToken: renewed[0] });
    expect(stored().session.refreshToken).not.toBe(first.refreshToken);
  } finally {
    await credentials.close();
  }
});

test('sign-out ends the session at OpenAI and keeps the registration for the next sign-in', async () => {
  const { auth, credentials, stored } = host();
  try {
    await auth.chatGptSignIn(false);
    const signedIn = stored();
    await expect(auth.chatGptSignOut()).resolves.toEqual({ revoked: true });
    expect(openai.revoked).toEqual([signedIn.session.refreshToken]);
    expect(stored()).toEqual({
      clientId: signedIn.clientId,
      email: 'ada@example.com',
      hostId: signedIn.hostId,
      subject: 'user-ada',
      type: 'chatgpt_sign_in',
    });
    await expect(auth.chatGptStatus(false)).resolves.toEqual({
      email: 'ada@example.com',
      state: 'signed_out',
    });
    // Signed out, the provider has no credential: a run refuses instead of sending a dead token.
    await expect(auth.resolveProviderAuth('chatgpt')).rejects.toThrow(
      'The selected provider has no configured credential'
    );

    // Signing in again as the registered account is not a first sign-in.
    await expect(auth.chatGptSignIn(false)).resolves.toEqual({
      email: 'ada@example.com',
      state: 'signed_in',
    });
    const again = openai.authorizations[1];
    expect(again?.get('client_id')).toBe(signedIn.clientId);
    expect(again?.get('login_hint')).toBe('ada@example.com');
    expect(again?.get('ext_agent_host_id')).toBe(signedIn.hostId);
    expect(again?.has('agent_name_hint')).toBe(false);
    expect(stored().clientId).toBe(signedIn.clientId);
  } finally {
    await credentials.close();
  }
});

test('another account signs in only as a new registration', async () => {
  const { auth, credentials, stored } = host();
  try {
    await auth.chatGptSignIn(false);
    const first = stored();
    await auth.chatGptSignOut();

    openai.user = { email: 'grace@example.com', sub: 'user-grace' };
    expect(await refusal(auth.chatGptSignIn(false))).toBe('auth.chatgpt-account-mismatch');
    expect(stored().session).toBeUndefined();

    await expect(auth.chatGptSignIn(true)).resolves.toEqual({
      email: 'grace@example.com',
      firstSignIn: true,
      state: 'signed_in',
    });
    expect(openai.authorizations.at(-1)?.get('client_id')).toBe('dynamic_agent_client');
    expect(stored()).toMatchObject({ hostId: first.hostId, subject: 'user-grace' });
    expect(stored().clientId).not.toBe(first.clientId);
  } finally {
    await credentials.close();
  }
});

test('a sign-in that grants no plan use, or is declined, stores no session', async () => {
  const { auth, credentials, stored } = host();
  try {
    openai.next = { withoutPlanScope: true };
    expect(await refusal(auth.chatGptSignIn(false))).toBe('auth.chatgpt-plan-not-granted');
    expect(stored().session).toBeUndefined();
    // The client OpenAI registered is kept, so the retry does not register a second one.
    const registered = stored().clientId;
    expect(registered).toMatch(/^oaiapp_/u);

    openai.next = { error: 'access_denied' };
    expect(await refusal(auth.chatGptSignIn(false))).toBe('auth.chatgpt-access-denied');
    expect(openai.authorizations.at(-1)?.get('client_id')).toBe(registered);
    await expect(auth.chatGptStatus(false)).resolves.toEqual({ state: 'signed_out' });
  } finally {
    await credentials.close();
  }
});

test('a refresh token OpenAI no longer accepts ends the sign-in and keeps the registration', async () => {
  const memory = memoryCredentialBackend();
  let clock = Date.now();
  const credentials = createHostCredentials({
    createNativeBackend: () => memory.backend,
    selection: { kind: 'keyring', service: 'brainstrike-test-disposable' },
  });
  const chatGpt = createChatGptSignIn({
    issuer: openai.issuer,
    now: () => clock,
    openExternal: (url) => openai.browser(url),
    secrets: () => credentials.secrets(),
  });
  try {
    await chatGpt.signIn();
    const record = JSON.parse(memory.entries.get('chatgpt') ?? 'null');
    // The person disconnected the app in ChatGPT settings.
    await fetch(`${openai.issuer}/api/accounts/oauth/revoke`, {
      body: new URLSearchParams({ token: record.session.refreshToken }),
      method: 'POST',
    });
    clock += 59 * 60 * 1000;
    expect(await refusal(chatGpt.accessToken())).toBe('auth.chatgpt-session-ended');
    await expect(chatGpt.status()).resolves.toEqual({
      email: 'ada@example.com',
      state: 'signed_out',
    });
    expect(JSON.parse(memory.entries.get('chatgpt') ?? 'null').clientId).toBe(record.clientId);
  } finally {
    await credentials.close();
  }
});

test('a host with no browser, and every key path, refuses to write a ChatGPT sign-in', async () => {
  const { auth, credentials, memory } = host({ browser: false });
  const session: ChatGptSignInCredential = {
    clientId: 'oaiapp_forged',
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    session: {
      accessToken: 'forged',
      expiresAt: Date.now() + 3_600_000,
      refreshToken: 'forged',
      scopes: ['chatgpt.tokens.use.direct'],
    },
    subject: 'user-forged',
    type: 'chatgpt_sign_in',
  };
  try {
    expect(await refusal(auth.chatGptSignIn(false))).toBe('auth.chatgpt-sign-in-unavailable');
    expect(await refusal(auth.storeProviderCredential('chatgpt', session))).toBe(
      'auth.chatgpt-sign-in-only'
    );
    expect(await refusal(auth.setCredential('chatgpt', session))).toBe('auth.chatgpt-sign-in-only');
    expect(await refusal(auth.setCredential('openai', session))).toBe('auth.chatgpt-sign-in-only');
    expect(
      await refusal(auth.setCredential('chatgpt', { key: 'sk-fixture', type: 'api_key' }))
    ).toBe('auth.chatgpt-sign-in-only');
    expect(await refusal(auth.deleteCredential('chatgpt'))).toBe('auth.chatgpt-sign-in-only');
    expect(memory.entries.size).toBe(0);
  } finally {
    await credentials.close();
  }
});
