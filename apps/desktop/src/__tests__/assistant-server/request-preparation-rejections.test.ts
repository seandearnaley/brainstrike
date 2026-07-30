/**
 * Request-preparation rejection tests (BST-1028 slice 3). NOT a verbatim move:
 * these tests drove the full HTTP POST in the pre-split monolith; here they
 * drive BST-972 A4's direct result API — `prepareAssistantPostRequest({ req,
 * resolveProviderApiKey })` — and assert on the returned rejection instead of
 * response bytes. What that changes, exactly:
 * - "streamResponse was never called" assertions become `result.ok === false`
 *   (with a direct call there is no stream to construct);
 * - the credential path injects a stub reader instead of mocking the secrets
 *   service — and the unreadable-key case throws the REAL SecretReadError
 *   through A3's structural matcher, not a mock-identity double;
 * - the 413 body-limit test is NOT here: its `Connection: close` header is a
 *   transport concern, so it moved verbatim to the stream-serving suite.
 * PURE lane: no HTTP, no PGlite. electron/electron-store are stubbed only
 * because request-preparation's module graph reaches ../secrets through
 * provider-credentials (the same pattern as secrets.test.ts).
 * The narrowed @brainstrike/agent mock carries only the two message
 * converters, preserving the monolith's trailing-message override contract.
 */
import { DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
  safeStorage: {
    getSelectedStorageBackend: vi.fn(() => 'keychain'),
    isEncryptionAvailable: vi.fn(() => true),
  },
}));
vi.mock('electron-store', () => ({ default: class {} }));

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  const convertAssistantUiMessages = vi.fn((messages) => messages);
  return {
    ...actual,
    convertAssistantUiMessages,
    convertAssistantUiMessagesWithFinalInput: vi.fn(
      (
        messages: Parameters<typeof actual.convertAssistantUiMessagesWithFinalInput>[0]
      ): ReturnType<typeof actual.convertAssistantUiMessagesWithFinalInput> => {
        const finalRawMessage = messages.at(-1);
        const { finalInputMessage } = actual.convertAssistantUiMessagesWithFinalInput(
          finalRawMessage ? [finalRawMessage] : []
        );
        return {
          finalInputMessage,
          messages: convertAssistantUiMessages(messages),
        };
      }
    ),
  };
});

import {
  type PrepareAssistantPostRequestResult,
  prepareAssistantPostRequest,
} from '../../assistant-server/request-preparation';
import { SecretReadError } from '../../secrets';
import { MockRequest } from './_harness';

const resolveProviderApiKey = vi.fn<(provider: string) => Promise<string | undefined>>();

beforeEach(() => {
  resolveProviderApiKey.mockReset().mockResolvedValue('test-api-key');
});

function postRequest(body: string): MockRequest {
  return new MockRequest({
    body,
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    url: '/assistant',
  });
}

async function prepare(body: string): Promise<PrepareAssistantPostRequestResult> {
  return await prepareAssistantPostRequest({
    req: postRequest(body) as unknown as Parameters<typeof prepareAssistantPostRequest>[0]['req'],
    resolveProviderApiKey,
  });
}

describe('prepareAssistantPostRequest rejections', () => {
  it('rejects an empty prompt with the message-less payload', async () => {
    const result = await prepare(
      JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: '   ', type: 'text' }], role: 'user' }],
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection).toEqual({ payload: { error: 'empty_prompt' }, status: 400 });
  });

  it('accepts an image-only user turn as a valid vision prompt', async () => {
    const result = await prepare(
      JSON.stringify({
        data: { provider: 'openai' },
        messages: [
          {
            id: 'image-only',
            parts: [
              {
                data: 'data:image/png;base64,aGVsbG8=',
                mediaType: 'image/png',
                type: 'file',
              },
            ],
            role: 'user',
          },
        ],
      })
    );

    expect(result.ok).toBe(true);
  });

  it.each([
    ['blank user', { id: 'blank-user', parts: [{ text: '   ', type: 'text' }], role: 'user' }],
    [
      'assistant tool result',
      {
        id: 'trailing-tool-result',
        parts: [{ output: { ok: true }, type: 'tool-result' }],
        role: 'assistant',
      },
    ],
    [
      'system context',
      { id: 'trailing-system', parts: [{ text: 'late context', type: 'text' }], role: 'system' },
    ],
  ])('rejects a trailing %s message instead of reusing an earlier user prompt', async (_case, trailingMessage) => {
    const { convertAssistantUiMessages } = await import('@brainstrike/agent');
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Earlier prompt', type: 'text' }], role: 'user' },
    ]);

    const result = await prepare(
      JSON.stringify({
        data: { provider: 'openai' },
        messages: [
          {
            id: 'earlier-user',
            parts: [{ text: 'Earlier prompt', type: 'text' }],
            role: 'user',
          },
          trailingMessage,
        ],
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection).toEqual({ payload: { error: 'empty_prompt' }, status: 400 });
  });

  it.each([
    [
      'a non-data URL',
      [{ data: 'not-a-data-url', mediaType: 'image/png', type: 'file' }],
      'not-a-data-url',
    ],
    [
      'invalid base64',
      [{ data: 'data:image/png;base64,%%%= ', mediaType: 'image/png', type: 'file' }],
      'invalid-base64',
    ],
    [
      'a media-type mismatch',
      [{ data: 'data:image/jpeg;base64,aGVsbG8=', mediaType: 'image/png', type: 'file' }],
      'media-type-mismatch',
    ],
    ['a malformed file part', [{ mediaType: 'image/png', type: 'file' }], 'invalid-file-part'],
    [
      'too many files',
      Array.from({ length: 5 }, () => ({
        data: 'data:image/png;base64,aGVsbG8=',
        mediaType: 'image/png',
        type: 'file',
      })),
      'too-many-attachments',
    ],
  ])('returns typed invalid_attachment for %s', async (_case, parts, reason) => {
    const result = await prepare(
      JSON.stringify({
        data: { provider: 'openai' },
        messages: [
          {
            id: 'invalid-image',
            parts,
            role: 'user',
          },
        ],
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection).toEqual({
      payload: {
        error: 'invalid_attachment',
        message: 'Assistant attachment payload is invalid.',
        reason,
      },
      status: 400,
    });
  });

  it('rejects a request without a provider', async () => {
    const result = await prepare(
      JSON.stringify({
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection.status).toBe(400);
    expect(result.rejection.payload.error).toBe('missing_provider');
  });

  it('rejects a request when the provider API key is missing', async () => {
    resolveProviderApiKey.mockResolvedValueOnce(undefined);

    const result = await prepare(
      JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection.status).toBe(400);
    expect(result.rejection.payload.error).toBe('missing_api_key');
    expect(result.rejection.payload.message).toContain('openai');
  });

  it('distinguishes an unreadable provider key from a missing key', async () => {
    // The REAL error class through A3's structural matcher — the production
    // path, not a mock-identity double.
    resolveProviderApiKey.mockRejectedValueOnce(
      new SecretReadError('encryption_unavailable', 'openrouter')
    );

    const result = await prepare(
      JSON.stringify({
        data: { provider: 'openrouter' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection).toEqual({
      payload: {
        code: 'encryption_unavailable',
        error: 'api_key_unreadable',
        message:
          'Secret for "openrouter" is unreadable: safeStorage encryption is unavailable or insecure on this system. Re-enter the key to repair it.',
        provider: 'openrouter',
      },
      status: 400,
    });
  });

  it('rejects an invalid JSON payload', async () => {
    const result = await prepare(
      '{"messages":[{"role":"user","parts":[{"type":"text","text":"Hello"}]}],'
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection.status).toBe(400);
    expect(result.rejection.payload).toEqual({
      error: 'invalid_json',
      message: 'Request body must be valid JSON.',
    });
  });

  it.each([
    [
      'an empty body',
      '',
      {
        error: 'invalid_json',
        message: 'Request body must be valid JSON.',
      },
    ],
    [
      'a missing messages field',
      '{}',
      {
        error: 'invalid_request_payload',
        message: 'Assistant request payload must include its own messages array.',
      },
    ],
    [
      'an unsupported top-level field',
      JSON.stringify({ messages: [], system: 'must stay server-owned' }),
      {
        error: 'invalid_request_payload',
        message: 'Assistant request payload contains an unsupported top-level field.',
      },
    ],
    [
      'a malformed messages field',
      JSON.stringify({ messages: {} }),
      {
        error: 'invalid_messages',
        message: 'Assistant messages must be an array.',
      },
    ],
  ])('returns a typed 400 rejection for %s', async (_name, body, expected) => {
    const result = await prepare(body);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection.status).toBe(400);
    expect(result.rejection.payload).toEqual(expected);
  });

  it('flags connection-close on the body-limit rejection', async () => {
    const result = await prepare('x'.repeat(DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES + 1));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection.status).toBe(413);
    expect(result.rejection.closeConnection).toBe(true);
    expect(result.rejection.payload.error).toBe('request_body_too_large');
  });
});
