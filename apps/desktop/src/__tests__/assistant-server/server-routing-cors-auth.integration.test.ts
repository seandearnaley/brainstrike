/**
 * Server lifecycle, routing, CORS/origin enforcement, and the auth token gate
 * (moved verbatim from the pre-split assistant-server.integration.test.ts,
 * BST-1028). Nothing here reaches stream serving or the agent runtime, so the
 * pre-split file's mock set shrinks to two: the secrets service (the 200-path
 * status responses resolve providers through it) and the agent-client-loader
 * env-key probe. Notably NO mock of `@brainstrike/agent` — verified: the
 * routes exercised here never invoke the eagerly imported stream sessions.
 */
import type http from 'node:http';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAssistantRequest, startAssistantServer } from '../../assistant-server';
import { DESKTOP_DEV_RENDERER_URL } from '../../desktop-renderer-url';
import { createRunRequest, MockRequest, MockResponse } from './_harness';

const desktopRendererOrigin = new URL(DESKTOP_DEV_RENDERER_URL).origin;

const mockSecretsService = vi.hoisted(() => ({
  deleteKey: vi.fn(),
  // BST-1352: the assistant POST path reads the TYPED credential.
  getCredential: vi.fn(),
  getKey: vi.fn(),
  listProviders: vi.fn(),
  saveKey: vi.fn(),
}));

vi.mock('../../secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../secrets')>();
  return {
    ...actual,
    getSecretsService: () => mockSecretsService,
  };
});

vi.mock('../../agent-client-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-client-loader')>();
  return {
    ...actual,
    getAgentProviderEnvKeys: vi.fn(() => []),
  };
});

const runRequest = createRunRequest(handleAssistantRequest);

let server: { url: string; stop: () => Promise<void>; authToken?: string } | undefined;

// Defaults install BEFORE each test (review finding on this PR): the pre-split
// suite installed them only in afterEach, so a test selected in isolation via
// `-t` ran against bare vi.fn()s — listProviders() yielded undefined and the
// expected 200 became a 500. beforeEach makes every test independently
// runnable.
beforeEach(() => {
  mockSecretsService.getCredential
    .mockReset()
    .mockResolvedValue({ key: 'test-api-key', type: 'api_key' });
  mockSecretsService.getKey.mockReset().mockResolvedValue('test-api-key');
  mockSecretsService.listProviders.mockReset().mockResolvedValue(['openai']);
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: false });
});

afterEach(async () => {
  if (server) {
    try {
      // Add timeout to prevent hanging
      await Promise.race([
        server.stop(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Server stop timeout')), 5000)
        ),
      ]).catch(() => {
        // Ignore stop errors in cleanup
      });
    } catch {
      // Ignore stop errors in cleanup
    }
    server = undefined;
  }
  vi.clearAllMocks();
}, 15_000);

describe('startAssistantServer', () => {
  it('should start server on dynamic port by default', async () => {
    server = await startAssistantServer(undefined, { listen: false });

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.stop).toBeInstanceOf(Function);
  });

  it('should start server on specified port hint', async () => {
    server = await startAssistantServer(0, { listen: false }); // Use 0 for dynamic port

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('should respect BS_ASSISTANT_PORT environment variable', async () => {
    const originalEnv = process.env['BS_ASSISTANT_PORT'];
    process.env['BS_ASSISTANT_PORT'] = '0'; // Use 0 for dynamic port

    try {
      server = await startAssistantServer(undefined, { listen: false });

      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      if (originalEnv === undefined) {
        // Pre-split version assigned `undefined`, which stringifies to the
        // literal "undefined" in process.env — deletion is the real restore.
        Reflect.deleteProperty(process.env, 'BS_ASSISTANT_PORT');
      } else {
        process.env['BS_ASSISTANT_PORT'] = originalEnv;
      }
    }
  });

  it('should allow stopping the server', async () => {
    server = await startAssistantServer(undefined, { listen: false });
    await expect(server.stop()).resolves.not.toThrow();
    server = undefined; // Mark as stopped
  });
});

describe('CORS preflight', () => {
  it('should handle CORS preflight for assistant routes', async () => {
    const response = await runRequest({
      headers: {
        'access-control-request-method': 'POST',
        origin: desktopRendererOrigin,
      },
      method: 'OPTIONS',
      url: '/assistant/status?source=test',
    });

    expect(response.status).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['access-control-allow-origin']).toBe(desktopRendererOrigin);
    expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('should return 204 for OPTIONS on unknown routes', async () => {
    const response = await runRequest({
      headers: {
        'access-control-request-method': 'POST',
        origin: desktopRendererOrigin,
      },
      method: 'OPTIONS',
      url: '/unknown?source=test',
    });

    expect(response.status).toBe(204);
    expect(response.body).toBe('');
  });

  it('should return null CORS origin for preflight requests from disallowed origins', async () => {
    const response = await runRequest({
      headers: {
        'access-control-request-method': 'POST',
        origin: 'https://evil.example',
      },
      method: 'OPTIONS',
      url: '/assistant/status?source=test',
    });

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBe('null');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    const data = JSON.parse(response.body) as { error: string };
    expect(data.error).toBe('forbidden_origin');
  });

  it('should not treat non-preflight OPTIONS requests as CORS preflight', async () => {
    const response = await runRequest({
      headers: { origin: desktopRendererOrigin },
      method: 'OPTIONS',
      url: '/assistant/status',
    });

    expect(response.status).toBe(404);
    expect(response.body).toBe('not found');
  });

  it('should allow null origin for packaged Electron renderer requests', async () => {
    const response = await runRequest({
      headers: { origin: 'null' },
      method: 'GET',
      url: '/assistant/status',
    });

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('null');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('auth token gate', () => {
  const AUTH_TOKEN = 'a'.repeat(64);
  const withToken = { auth: { token: AUTH_TOKEN } } as const;

  it('rejects requests without a token with 401', async () => {
    const response = await runRequest(
      { headers: { origin: desktopRendererOrigin }, method: 'GET', url: '/assistant/status' },
      withToken
    );

    expect(response.status).toBe(401);
    const data = JSON.parse(response.body) as { error: string };
    expect(data.error).toBe('unauthorized');
  });

  it('rejects requests with a wrong token with 401', async () => {
    const response = await runRequest(
      {
        headers: {
          origin: desktopRendererOrigin,
          'x-brainstrike-assistant-token': 'b'.repeat(64),
        },
        method: 'GET',
        url: '/assistant/status',
      },
      withToken
    );

    expect(response.status).toBe(401);
  });

  it('serves requests carrying the expected token', async () => {
    const response = await runRequest(
      {
        headers: {
          origin: desktopRendererOrigin,
          'x-brainstrike-assistant-token': AUTH_TOKEN,
        },
        method: 'GET',
        url: '/assistant/status',
      },
      withToken
    );

    expect(response.status).toBe(200);
  });

  it('rejects null-origin (packaged-shape) requests without a token', async () => {
    const response = await runRequest(
      { headers: { origin: 'null' }, method: 'GET', url: '/assistant/status' },
      withToken
    );

    expect(response.status).toBe(401);
  });

  it('allows CORS preflight without a token (preflights cannot carry custom headers)', async () => {
    const response = await runRequest(
      {
        headers: {
          'access-control-request-method': 'POST',
          origin: desktopRendererOrigin,
        },
        method: 'OPTIONS',
        url: '/assistant/status',
      },
      withToken
    );

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-headers']).toContain(
      'X-Brainstrike-Assistant-Token'
    );
  });

  it('still rejects disallowed origins even with a valid token', async () => {
    const response = await runRequest(
      {
        headers: {
          origin: 'https://evil.example',
          'x-brainstrike-assistant-token': AUTH_TOKEN,
        },
        method: 'GET',
        url: '/assistant/status',
      },
      withToken
    );

    expect(response.status).toBe(403);
    const data = JSON.parse(response.body) as { error: string };
    expect(data.error).toBe('forbidden_origin');
  });

  it('throws loudly when auth is not configured at all', async () => {
    const req = new MockRequest({
      headers: { origin: desktopRendererOrigin },
      method: 'GET',
      url: '/assistant/status',
    });
    const res = new MockResponse();

    await expect(
      handleAssistantRequest(
        req as unknown as http.IncomingMessage,
        res as unknown as http.ServerResponse,
        {}
      )
    ).rejects.toThrow(/auth/i);
  });

  it('startAssistantServer mints and returns a per-boot token by default', async () => {
    server = await startAssistantServer(undefined, { listen: false });
    expect(server.authToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('startAssistantServer returns no token when auth is explicitly disabled', async () => {
    server = await startAssistantServer(undefined, { auth: 'disabled', listen: false });
    expect(server.authToken).toBeUndefined();
  });
});

describe('origin enforcement', () => {
  it('should reject assistant POST requests from disallowed origins', async () => {
    const response = await runRequest({
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      method: 'POST',
      url: '/assistant',
    });

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBe('null');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    const data = JSON.parse(response.body) as { error: string };
    expect(data.error).toBe('forbidden_origin');
  });

  it('should default missing Origin header to null CORS origin', async () => {
    const response = await runRequest({
      method: 'GET',
      url: '/assistant/status',
    });

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('null');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('should reject requests from disallowed origins', async () => {
    const response = await runRequest({
      headers: { origin: 'https://evil.example' },
      method: 'GET',
      url: '/assistant/status',
    });

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBe('null');
    const data = JSON.parse(response.body) as { error: string };
    expect(data.error).toBe('forbidden_origin');
  });

  it('should reject malformed origin headers', async () => {
    const response = await runRequest({
      headers: { origin: 'not-a-url' },
      method: 'GET',
      url: '/assistant/status',
    });

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBe('null');
    const data = JSON.parse(response.body) as { error: string };
    expect(data.error).toBe('forbidden_origin');
  });

  it('should reject comma-separated multi-origin header values', async () => {
    const response = await runRequest({
      headers: { origin: `${desktopRendererOrigin}, https://evil.example` },
      method: 'GET',
      url: '/assistant/status',
    });

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBe('null');
    const data = JSON.parse(response.body) as { error: string };
    expect(data.error).toBe('forbidden_origin');
  });

  it('should reject arbitrary localhost origins on other ports', async () => {
    const response = await runRequest({
      headers: { origin: 'http://localhost:3000' },
      method: 'GET',
      url: '/assistant/status',
    });

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBe('null');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    const data = JSON.parse(response.body) as { error: string };
    expect(data.error).toBe('forbidden_origin');
  });

  it('should reject the dev renderer origin in packaged builds', async () => {
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true });

    const response = await runRequest({
      headers: { origin: desktopRendererOrigin },
      method: 'GET',
      url: '/assistant/status',
    });

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBe('null');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    const data = JSON.parse(response.body) as { error: string };
    expect(data.error).toBe('forbidden_origin');
  });

  it('should reject localhost origins over https', async () => {
    const response = await runRequest({
      headers: { origin: `https://localhost:${new URL(DESKTOP_DEV_RENDERER_URL).port}` },
      method: 'GET',
      url: '/assistant/status',
    });

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBe('null');
  });
});

describe('routing', () => {
  it('should return 404 for unknown routes', async () => {
    const response = await runRequest({ method: 'GET', url: '/unknown' });

    expect(response.status).toBe(404);
    expect(response.body).toBe('not found');
  }, 10_000);
});
