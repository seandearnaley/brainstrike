import { afterEach, describe, expect, it } from 'vitest';
import { resolveAssistantAuthHeaders, resolveAssistantEndpoint } from '../assistant-endpoint';

type AssistantBridge = NonNullable<Window['assistant']>;

const setBridge = (bridge: AssistantBridge | undefined) => {
  if (bridge === undefined) {
    Reflect.deleteProperty(window, 'assistant');
    return;
  }
  (window as { assistant?: AssistantBridge }).assistant = bridge;
};

describe('resolveAssistantEndpoint', () => {
  afterEach(() => {
    setBridge(undefined);
  });

  it('prefers getAuth and returns api plus token auth headers', async () => {
    const token = 'c'.repeat(64);
    setBridge({
      getAuth: () => Promise.resolve({ token, url: 'http://127.0.0.1:5123' }),
      getUrl: () => Promise.resolve('http://127.0.0.1:5123'),
    });

    const endpoint = await resolveAssistantEndpoint();

    expect(endpoint).toEqual({
      api: 'http://127.0.0.1:5123/assistant',
      headers: { 'x-brainstrike-assistant-token': token },
    });
  });

  it('falls back to getUrl without headers when getAuth is absent (older bridge)', async () => {
    setBridge({ getUrl: () => Promise.resolve('http://127.0.0.1:5123') });

    const endpoint = await resolveAssistantEndpoint();

    expect(endpoint).toEqual({ api: 'http://127.0.0.1:5123/assistant' });
  });

  it('falls back to getUrl when getAuth reports the server unavailable', async () => {
    setBridge({
      getAuth: () => Promise.resolve(null),
      getUrl: () => Promise.resolve('http://127.0.0.1:5123'),
    });

    const endpoint = await resolveAssistantEndpoint();

    expect(endpoint).toEqual({ api: 'http://127.0.0.1:5123/assistant' });
  });

  it('returns undefined when no bridge exists (web build uses /api default)', async () => {
    setBridge(undefined);

    await expect(resolveAssistantEndpoint()).resolves.toBeUndefined();
  });
});

describe('resolveAssistantAuthHeaders', () => {
  afterEach(() => {
    setBridge(undefined);
  });

  it('returns the token header when the bridge provides auth', async () => {
    const token = 'd'.repeat(64);
    setBridge({ getAuth: () => Promise.resolve({ token, url: 'http://127.0.0.1:5123' }) });

    await expect(resolveAssistantAuthHeaders()).resolves.toEqual({
      'x-brainstrike-assistant-token': token,
    });
  });

  it('returns an empty object without a bridge or without auth', async () => {
    setBridge(undefined);
    await expect(resolveAssistantAuthHeaders()).resolves.toEqual({});

    setBridge({ getUrl: () => Promise.resolve('http://127.0.0.1:5123') });
    await expect(resolveAssistantAuthHeaders()).resolves.toEqual({});
  });

  it('returns an empty object when the bridge rejects, so the send proceeds and the server 401 surfaces', async () => {
    setBridge({ getAuth: () => Promise.reject(new Error('ipc dead')) });

    await expect(resolveAssistantAuthHeaders()).resolves.toEqual({});
  });
});
