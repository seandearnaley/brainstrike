/**
 * Request-preparation rejection tests (migrated into the package, BST-972 B2;
 * previously apps/desktop's request-preparation-rejections.test.ts from the
 * BST-1028 split). Drives the direct result API with an injected readBody
 * thunk — no HTTP, no electron stubs (the module graph no longer reaches
 * ../secrets), no request double. The unreadable-key case throws a STRUCTURAL
 * SecretReadError fake through the contract matcher (a package test cannot
 * import the desktop class upward); the real-class conformance money test
 * stays in apps/desktop's secrets.test.ts.
 */
import { AssistantRequestBodyTooLargeError } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

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

import { AssistantInvalidJsonError } from '@brainstrike/agent/hosted-web';
import { listProviders } from '@brainstrike/assistant-contract/provider-metadata';
import type { ScopedLogger } from '@brainstrike/logging';
import type { ProviderCredentialReader } from '../ports';
import {
  createProviderApiKeyReader,
  UnsupportedCredentialTypeError,
} from '../provider-credential-projection';
import {
  AssistantFilterPayloadError,
  hydrateRuntimeDataWithLocalRuntimeToken,
  type PrepareAssistantPostRequestResult,
  prepareAssistantPostRequest,
} from '../request';

const resolveProviderCredential = vi.fn<ProviderCredentialReader>();

beforeEach(() => {
  resolveProviderCredential
    .mockReset()
    .mockResolvedValue({ key: 'test-api-key', source: 'env', type: 'api_key' });
  logger.debug.mockReset();
  logger.fatal.mockReset();
  logger.trace.mockReset();
  logger.error.mockReset();
  logger.info.mockReset();
  logger.warn.mockReset();
});

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
} satisfies ScopedLogger;

async function prepare(body: string): Promise<PrepareAssistantPostRequestResult> {
  return await prepareAssistantPostRequest({
    logger,
    readBody: async () => body,
    resolveProviderCredential,
  });
}

it('retains the exact accepted user input and parent edge for live replay discovery', async () => {
  const result = await prepare(
    JSON.stringify({
      data: { provider: 'openai' },
      inputParentMessageId: 'prior-assistant',
      messages: [{ content: [{ text: 'Continue', type: 'text' }], id: 'new-user', role: 'user' }],
    })
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.request.inputParentMessageId).toBe('prior-assistant');
    expect(result.request.finalInputMessage).toMatchObject({
      id: 'new-user',
      parts: [{ text: 'Continue', type: 'text' }],
      role: 'user',
    });
  }
});

describe('prepareAssistantPostRequest filterPayload hook (BST-1030)', () => {
  it('publishes parsed scope before slow credential resolution begins', async () => {
    const credential =
      Promise.withResolvers<Awaited<ReturnType<typeof resolveProviderCredential>>>();
    let scopeRegistered = false;
    resolveProviderCredential.mockImplementationOnce(async () => {
      expect(scopeRegistered).toBe(true);
      return credential.promise;
    });
    const pending = prepareAssistantPostRequest({
      filterPayload: (payload) => {
        expect(payload.data?.memory).toMatchObject({
          resourceId: 'workspace',
          threadId: 'thread-1',
        });
        scopeRegistered = true;
        return payload;
      },
      logger,
      readBody: async () =>
        JSON.stringify({
          data: { memory: { resourceId: 'workspace', threadId: 'thread-1' }, provider: 'openai' },
          messages: [{ parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
        }),
      resolveProviderCredential,
    });
    await vi.waitFor(() => expect(resolveProviderCredential).toHaveBeenCalled());
    expect(scopeRegistered).toBe(true);
    credential.resolve({ key: 'test-api-key', source: 'env', type: 'api_key' });
    await pending;
  });
  it('runs AFTER envelope parsing: the hook receives the parsed payload', async () => {
    const seen: unknown[] = [];
    await prepareAssistantPostRequest({
      filterPayload: (payload) => {
        seen.push(payload);
        return payload;
      },
      logger,
      readBody: async () =>
        JSON.stringify({
          data: { provider: 'openai' },
          messages: [{ parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
        }),
      resolveProviderCredential,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ data: { provider: 'openai' } });
  });

  it('does NOT run when parsing rejects (nothing trusted reaches the hook)', async () => {
    const filterPayload = vi.fn(
      (
        payload: Parameters<
          NonNullable<Parameters<typeof prepareAssistantPostRequest>[0]['filterPayload']>
        >[0]
      ) => payload
    );
    const result = await prepareAssistantPostRequest({
      filterPayload,
      logger,
      readBody: async () => '{"messages":[',
      resolveProviderCredential,
    });
    expect(result.ok).toBe(false);
    expect(filterPayload).not.toHaveBeenCalled();
  });

  it('runs BEFORE native-tool-id validation: injected bad ids are rejected', async () => {
    // Proves the ordering contract in the failing direction: values the hook
    // ADDS are validated, so values it STRIPS can never reach validation.
    const result = await prepareAssistantPostRequest({
      filterPayload: (payload) => ({
        ...payload,
        data: { ...(payload.data ?? {}), enabledNativeToolIds: ['not-a-real-tool'] },
      }),
      logger,
      readBody: async () =>
        JSON.stringify({
          data: { provider: 'openai' },
          messages: [{ parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
        }),
      resolveProviderCredential,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection.payload).toMatchObject({
      error: 'invalid_enabled_native_tool_ids',
    });
  });

  it('runs BEFORE tool-continuation extraction: a stripped runConfig yields no action', async () => {
    const result = await prepareAssistantPostRequest({
      filterPayload: (payload) => ({ ...payload, runConfig: undefined }),
      logger,
      readBody: async () =>
        JSON.stringify({
          data: { provider: 'openai' },
          messages: [{ parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
          runConfig: { custom: { 'not-a-valid-shape': { bogus: true } } },
        }),
      resolveProviderCredential,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.request.toolApprovalAction).toBeUndefined();
    expect(result.request.toolResumeAction).toBeUndefined();
  });

  it('rethrows EVERY hook throw wrapped, never mapped — even preparation-owned classes', async () => {
    // The inverse direction of the propagation contract (review finding):
    // a hook throwing a class preparation maps for its own parse phase must
    // NOT be silently absorbed into preparation's rejection mapping.
    const parseShapedError = new AssistantInvalidJsonError();
    const promise = prepareAssistantPostRequest({
      filterPayload: () => {
        throw parseShapedError;
      },
      logger,
      readBody: async () =>
        JSON.stringify({
          data: { provider: 'openai' },
          messages: [{ parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
        }),
      resolveProviderCredential,
    });
    await expect(promise).rejects.toBeInstanceOf(AssistantFilterPayloadError);
    await promise.catch((error: unknown) => {
      expect((error as AssistantFilterPayloadError).cause).toBe(parseShapedError);
    });
  });
});

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
  ])(
    'rejects a trailing %s message instead of reusing an earlier user prompt',
    async (_case, trailingMessage) => {
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
    }
  );

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
    resolveProviderCredential.mockResolvedValueOnce(undefined);

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
    // Structural fake matching assistant-contract's matchSecretReadError shape
    // (name + code + provider + message) — the production path is structural
    // classification, not instanceof; the REAL-class conformance money test
    // lives in apps/desktop's secrets.test.ts.
    const secretReadError = Object.assign(
      new Error(
        'Secret for "openrouter" is unreadable: safeStorage encryption is unavailable or insecure on this system. Re-enter the key to repair it.'
      ),
      { code: 'encryption_unavailable', provider: 'openrouter' }
    );
    secretReadError.name = 'SecretReadError';
    resolveProviderCredential.mockRejectedValueOnce(secretReadError);

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
    // The byte LIMIT lives in the transport's readBody thunk since B2; the
    // core's contract is mapping the typed error the thunk throws. (The
    // limit-enforcement itself is covered end-to-end by the 413 HTTP test in
    // desktop's stream-serving suite.)
    const result = await prepareAssistantPostRequest({
      logger,
      readBody: async () => {
        throw new AssistantRequestBodyTooLargeError();
      },
      resolveProviderCredential,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection.status).toBe(413);
    expect(result.rejection.closeConnection).toBe(true);
    expect(result.rejection.payload.error).toBe('request_body_too_large');
  });

  it('redacts unsafe enabled-native-tool ids in the warn log and keeps safe ones raw', async () => {
    // The sha256 truncation is a deliberate log-redaction guard for
    // attacker-controlled identifiers (review finding: previously asserted
    // nowhere) — the spy logger makes this suite the contract's owner.
    const result = await prepare(
      JSON.stringify({
        data: {
          enabledNativeToolIds: ['unknown.tool', 'evil id with spaces \u0000'],
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection.payload.error).toBe('invalid_enabled_native_tool_ids');
    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected unknown enabled native tool ids',
      expect.objectContaining({
        correlationId: expect.any(String),
        // A SAFE-pattern id that is merely unknown renders raw; the unsafe
        // string is sha256-truncated. (A VALID id never reaches this list.)
        toolIdentifiers: ['unknown.tool', expect.stringMatching(/^sha256:[0-9a-f]{12}$/)],
      })
    );
  });
});

describe('registry-derived keyless auth (BST-1349)', () => {
  const providers = listProviders();

  it('the registry derives exactly local, ollama, and lmstudio as keyless', () => {
    const keyless = providers
      .filter((provider) => provider.authType === 'none')
      .map((provider) => provider.id)
      .sort();
    expect(keyless).toEqual(['lmstudio', 'local', 'ollama']);
  });

  it('accepts a keyless-provider request without any api key', async () => {
    for (const provider of providers) {
      if (provider.authType !== 'none') {
        continue;
      }
      resolveProviderCredential.mockResolvedValueOnce(undefined);
      const result = await prepare(
        JSON.stringify({
          data: { provider: provider.id },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        })
      );
      expect(result.ok, `${provider.id} must not require a key`).toBe(true);
    }
  });

  it('rejects every api_key-provider request without a key', async () => {
    for (const provider of providers) {
      if (provider.authType !== 'api_key') {
        continue;
      }
      resolveProviderCredential.mockResolvedValueOnce(undefined);
      const result = await prepare(
        JSON.stringify({
          data: { provider: provider.id },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        })
      );
      expect(result.ok, `${provider.id} must require a key`).toBe(false);
      if (result.ok) {
        throw new Error('expected rejection');
      }
      expect(result.rejection.payload.error).toBe('missing_api_key');
    }
  });

  it.each(['ollama', 'lmstudio'] as const)(
    'proceeds keyless when the OPTIONAL %s token read fails with a SecretReadError',
    async (provider) => {
      // PR #2513 review, finding 3: a keyless provider's stored token is
      // optional — an unreadable keychain entry must not 400 the run.
      const secretReadError = Object.assign(new Error(`Secret for "${provider}" is unreadable.`), {
        code: 'encryption_unavailable',
        provider,
      });
      secretReadError.name = 'SecretReadError';
      resolveProviderCredential.mockRejectedValueOnce(secretReadError);

      const result = await prepare(
        JSON.stringify({
          data: { provider },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        })
      );

      expect(result.ok, `${provider} must proceed keyless`).toBe(true);
      if (!result.ok) {
        throw new Error('expected success');
      }
      expect(result.request.apiKey).toBe('');
      // Never silent: the failed optional read is warn-logged.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('token'),
        expect.objectContaining({ provider })
      );
    }
  );

  it('still fetches and injects a READABLE optional token for local-runtime servers', async () => {
    resolveProviderCredential.mockResolvedValueOnce({
      key: 'stored-ollama-token',
      source: 'stored',
      type: 'api_key',
    });
    const result = await prepare(
      JSON.stringify({
        data: { provider: 'ollama' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.request.runtimeData.providerOptions?.['ollama']).toEqual({
      apiToken: 'stored-ollama-token',
    });
  });

  it('injects the optional bearer token only for local-runtime servers', () => {
    for (const provider of providers) {
      const hydrated = hydrateRuntimeDataWithLocalRuntimeToken(
        { provider: provider.id },
        provider.id,
        'runtime-token'
      );
      if (provider.runtime === 'local') {
        expect(hydrated.providerOptions?.[provider.id], provider.id).toEqual({
          apiToken: 'runtime-token',
        });
      } else {
        expect(hydrated.providerOptions, provider.id).toBeUndefined();
      }
    }
  });
});

describe('typed credential seam (BST-1352)', () => {
  it('resolves an api_key credential to the same prepared apiKey and exposes the credential', async () => {
    resolveProviderCredential.mockResolvedValueOnce({
      key: 'typed-key',
      source: 'stored',
      type: 'api_key',
    });
    const result = await prepare(
      JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.request.apiKey).toBe('typed-key');
    expect(result.request.credential).toEqual({
      key: 'typed-key',
      source: 'stored',
      type: 'api_key',
    });
  });

  it('rejects a stored non-api_key credential as api_key_unreadable — NEVER missing_api_key', async () => {
    // Regression pin: pre-BST-1352 the desktop getKey threw
    // SecretReadError('credential_type_unsupported') for a stored oauth
    // credential; the typed reader now RETURNS it and preparation must map it
    // onto the exact same wire failure.
    resolveProviderCredential.mockResolvedValueOnce({
      access: 'a',
      expires: 1,
      refresh: 'r',
      source: 'stored',
      type: 'oauth',
    });
    const result = await prepare(
      JSON.stringify({
        data: { provider: 'anthropic' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection.status).toBe(400);
    expect(result.rejection.payload).toMatchObject({
      code: 'credential_type_unsupported',
      error: 'api_key_unreadable',
      provider: 'anthropic',
    });
    expect(result.rejection.payload.error).not.toBe('missing_api_key');
  });

  it('accepts a stored aws bearer credential for bedrock (BST-1350)', async () => {
    resolveProviderCredential.mockResolvedValueOnce({
      bearerKey: 'stored-bedrock-bearer',
      mode: 'bearer',
      region: 'us-east-1',
      source: 'stored',
      type: 'aws',
    });
    const result = await prepare(
      JSON.stringify({
        data: { provider: 'bedrock' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    // The bearer key satisfies the missing_api_key gate; the region rides the
    // exposed credential into the aws auth-input projection downstream.
    expect(result.request.apiKey).toBe('stored-bedrock-bearer');
    expect(result.request.credential).toEqual({
      bearerKey: 'stored-bedrock-bearer',
      mode: 'bearer',
      region: 'us-east-1',
      source: 'stored',
      type: 'aws',
    });
  });

  // BST-1353: preparation classifies a profile_chain credential the SAME way
  // the host that will consume it does. Without a chain capability (Hosted
  // Web) it is a hard rejection; with one (desktop) it prepares keyless.
  it('rejects a stored aws profile_chain credential when NO chain capability is supplied', async () => {
    resolveProviderCredential.mockResolvedValueOnce({
      mode: 'profile_chain',
      region: 'us-east-1',
      source: 'stored',
      type: 'aws',
    });
    const result = await prepare(
      JSON.stringify({
        data: { provider: 'bedrock' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected rejection');
    }
    expect(result.rejection.status).toBe(400);
    expect(result.rejection.payload).toMatchObject({
      code: 'credential_type_unsupported',
      error: 'api_key_unreadable',
      provider: 'bedrock',
    });
    expect(result.rejection.payload.message).toContain('desktop');
  });

  it('PREPARES a stored aws profile_chain credential when the chain capability IS supplied', async () => {
    resolveProviderCredential.mockResolvedValueOnce({
      mode: 'profile_chain',
      profile: 'work',
      region: 'us-east-1',
      source: 'stored',
      type: 'aws',
    });
    const result = await prepareAssistantPostRequest({
      awsCredentialChain: () => async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'sec' }),
      logger,
      readBody: async () =>
        JSON.stringify({
          data: { provider: 'bedrock' },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
      resolveProviderCredential,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected preparation to succeed');
    }
    // A chain has no bearer string: preparation proceeds KEYLESS and hands the
    // typed credential on for the host to project into a credentialProvider.
    expect(result.request.apiKey).toBeFalsy();
    expect(result.request.credential).toMatchObject({ mode: 'profile_chain', type: 'aws' });
  });

  it('proceeds keyless (with a warn) when a keyless provider stores a non-api_key credential', async () => {
    resolveProviderCredential.mockResolvedValueOnce({
      access: 'a',
      expires: 1,
      refresh: 'r',
      source: 'stored',
      type: 'oauth',
    });
    const result = await prepare(
      JSON.stringify({
        data: { provider: 'ollama' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expect(result.request.apiKey).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('token'),
      expect.objectContaining({ provider: 'ollama' })
    );
  });
});

describe('createProviderApiKeyReader adapter (BST-1352 migration shim)', () => {
  it('projects api_key credentials to their key string', async () => {
    const reader = createProviderApiKeyReader(async () => ({
      key: 'adapted-key',
      source: 'env',
      type: 'api_key',
    }));
    await expect(reader('openai')).resolves.toBe('adapted-key');
  });

  it('passes through not-configured as undefined', async () => {
    const reader = createProviderApiKeyReader(async () => undefined);
    await expect(reader('openai')).resolves.toBeUndefined();
  });

  it('throws a SecretReadError-shaped typed error on an oauth credential (never stringifies)', async () => {
    const reader = createProviderApiKeyReader(async () => ({
      access: 'secret-access-token',
      expires: 1,
      refresh: 'secret-refresh-token',
      source: 'stored',
      type: 'oauth',
    }));
    let thrown: unknown;
    try {
      await reader('anthropic');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedCredentialTypeError);
    const shaped = thrown as UnsupportedCredentialTypeError;
    expect(shaped.name).toBe('SecretReadError');
    expect(shaped.code).toBe('credential_type_unsupported');
    expect(shaped.provider).toBe('anthropic');
    // The credential value must never leak through the error message.
    expect(shaped.message).not.toContain('secret-access-token');
    expect(shaped.message).not.toContain('secret-refresh-token');
  });
});

describe('managed idle-child continuation admission', () => {
  const childFollowup = {
    id: 'child-request',
    text: 'Continue the existing work',
    threadId: 'owned-child',
  };
  it('prepares a typed child followup without manufacturing another root user prompt', async () => {
    const result = await prepare(
      JSON.stringify({
        data: { memory: { resourceId: 'owner', threadId: 'root' }, provider: 'openai' },
        messages: [],
        runConfig: { custom: { brainstrikeChildFollowup: childFollowup } },
      })
    );
    expect(result).toMatchObject({ ok: true, request: { childFollowupAction: childFollowup } });
  });

  it('admits image-only child input without adding images to the parent prompt', async () => {
    const action = {
      ...childFollowup,
      attachments: [{ data: 'data:image/png;base64,AQID', mediaType: 'image/png', type: 'file' }],
      text: '',
    };
    const result = await prepare(
      JSON.stringify({
        data: { model: 'z-ai/glm-5.3', provider: 'openrouter' },
        messages: [{ content: [{ text: '', type: 'text' }], role: 'user' }],
        runConfig: { custom: { brainstrikeChildFollowup: action } },
      })
    );
    expect(result).toMatchObject({ ok: true, request: { childFollowupAction: action } });
    if (!result.ok) {
      throw new Error('Image-only child action was rejected');
    }
    expect(JSON.stringify(result.request.messages)).not.toContain('data:image');
  });

  it.each([
    { ...childFollowup, threadId: '' },
    { ...childFollowup, resourceId: 'borrowed-owner' },
    { ...childFollowup, text: '' },
  ])(
    'rejects invalid child continuation identity or caller-supplied authority %#',
    async (action) => {
      const result = await prepare(
        JSON.stringify({
          data: { provider: 'openai' },
          messages: [],
          runConfig: { custom: { brainstrikeChildFollowup: action } },
        })
      );
      expect(result).toMatchObject({
        ok: false,
        rejection: { payload: { error: 'invalid_child_followup_action' }, status: 400 },
      });
    }
  );

  it('rejects mixed child input and pending decision actions', async () => {
    const result = await prepare(
      JSON.stringify({
        data: { provider: 'openai' },
        messages: [],
        runConfig: {
          custom: {
            brainstrikeChildFollowup: childFollowup,
            brainstrikeToolApproval: { action: 'approve', runId: 'run', toolCallId: 'call' },
          },
        },
      })
    );
    expect(result).toMatchObject({
      ok: false,
      rejection: { payload: { error: 'conflicting_tool_continuation_actions' }, status: 400 },
    });
  });
});
