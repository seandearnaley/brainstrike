import { describe, expect, it } from 'vitest';
import {
  extractProviderRunError,
  isLocalRunErrorClassification,
  LOCAL_RUN_ERROR_FALLBACK_CODE,
  MAX_PROVIDER_RUN_ERROR_CAUSES,
  MAX_PROVIDER_RUN_ERROR_HEADER_VALUE_CHARS,
  MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS,
  MAX_PROVIDER_RUN_ERROR_REQUEST_ID_CHARS,
  PROVIDER_RUN_ERROR_FALLBACK_CODE,
  readProviderRunError,
} from '../provider-error-metadata';

describe('provider error metadata', () => {
  it('walks APICallError causes and retains only allow-listed response diagnostics', () => {
    const cause = new Error('socket closed by upstream');
    cause.name = 'NetworkError';
    const error = {
      cause,
      message: 'The provider rejected the request.',
      name: 'AI_APICallError',
      requestBodyValues: { apiKey: 'request-secret' },
      requestId: 'req_direct_123',
      responseBody: '{"authorization":"Bearer response-secret"}',
      responseHeaders: {
        Authorization: 'Bearer header-secret',
        'Content-Type': 'application/json',
        'Retry-After': '12',
        'X-RateLimit-Limit-Requests': '500',
        'X-RateLimit-Remaining-Requests': '0',
        'X-Request-Id': 'req_header_ignored_for_direct_value',
      },
      statusCode: 429,
    };

    expect(extractProviderRunError(error)).toEqual({
      causeChain: ['NetworkError: socket closed by upstream'],
      code: PROVIDER_RUN_ERROR_FALLBACK_CODE,
      httpStatus: 429,
      message: 'The provider rejected the request.',
      providerRequestId: 'req_direct_123',
      responseHeaders: {
        'retry-after': '12',
        'x-ratelimit-limit-requests': '500',
        'x-ratelimit-remaining-requests': '0',
        'x-request-id': 'req_header_ignored_for_direct_value',
      },
    });
  });

  it('never treats request headers as provider response evidence', () => {
    expect(
      extractProviderRunError({
        headers: {
          'retry-after': 'request-value',
          'x-client-request-id': 'caller-controlled-id',
        },
        message: 'The provider rejected the request.',
        statusCode: 429,
      })
    ).toEqual({
      code: PROVIDER_RUN_ERROR_FALLBACK_CODE,
      httpStatus: 429,
      message: 'The provider rejected the request.',
    });
  });

  it('reads allow-listed response evidence from a native Headers instance', () => {
    expect(
      extractProviderRunError({
        message: 'The provider rejected the request.',
        response: {
          headers: new Headers({
            Authorization: 'Bearer response-secret',
            'Retry-After': '9',
            'X-Request-Id': 'req-native-headers',
          }),
          status: 429,
        },
      })
    ).toEqual({
      code: PROVIDER_RUN_ERROR_FALLBACK_CODE,
      httpStatus: 429,
      message: 'The provider rejected the request.',
      providerRequestId: 'req-native-headers',
      responseHeaders: {
        'retry-after': '9',
        'x-request-id': 'req-native-headers',
      },
    });
  });

  it('promotes only explicitly stable provider codes from AI SDK data envelopes', () => {
    expect(
      extractProviderRunError({
        data: {
          error: {
            code: 400,
            metadata: {
              error_type: 'context_length_exceeded',
              provider_code: 'unstable-upstream-detail',
            },
          },
        },
        message: 'The request exceeds the context window.',
        name: 'AI_APICallError',
        statusCode: 400,
      })
    ).toMatchObject({
      code: 'context_length_exceeded',
      httpStatus: 400,
      message: 'The request exceeds the context window.',
    });

    expect(
      extractProviderRunError({
        code: 'vendor_internal_9812',
        message: 'Provider failure.',
        statusCode: 502,
      }).code
    ).toBe(PROVIDER_RUN_ERROR_FALLBACK_CODE);
  });

  it('classifies errors without provider evidence as local, not provider', () => {
    // The 2026-08-03 grepSearch-projection incident: a renderer-side TypeError
    // was labeled a provider error for hours. No httpStatus, no request id, no
    // response headers => the failure did not come from a provider response.
    expect(extractProviderRunError(new TypeError('x is not a function'))).toEqual({
      code: LOCAL_RUN_ERROR_FALLBACK_CODE,
    });
    expect(
      extractProviderRunError({
        code: 'vendor_internal_9812',
        message: 'Opaque failure with an unstable code and no response evidence.',
      }).code
    ).toBe(LOCAL_RUN_ERROR_FALLBACK_CODE);
  });

  it('keeps local failure codes without exposing private message or cause prose in event metadata', () => {
    // Real child-continuation stream error shape, including the nested native failure.
    const error = new Error('Provider refused continuation: /Users/fixture/private/workspace.ts', {
      cause: new Error('ENOENT /Users/fixture/private/credentials.json'),
    });
    expect(extractProviderRunError(error)).toEqual({ code: LOCAL_RUN_ERROR_FALLBACK_CODE });
    Object.assign(error, { code: 'local_tool_call_arguments_invalid' });
    expect(extractProviderRunError(error)).toEqual({ code: 'local_tool_call_arguments_invalid' });
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('keeps the provider fallback code when any single piece of response evidence exists', () => {
    expect(extractProviderRunError({ message: 'boom', statusCode: 500 }).code).toBe(
      PROVIDER_RUN_ERROR_FALLBACK_CODE
    );
    expect(extractProviderRunError({ message: 'boom', requestId: 'req_evidence_1' }).code).toBe(
      PROVIDER_RUN_ERROR_FALLBACK_CODE
    );
    expect(
      extractProviderRunError({
        message: 'boom',
        responseHeaders: { 'retry-after': '5' },
      }).code
    ).toBe(PROVIDER_RUN_ERROR_FALLBACK_CODE);
  });

  it('treats an AI SDK api-call error marker as provider evidence without response metadata', () => {
    // The live Anthropic 404 path can surface as an AI_APICallError carrying
    // neither status nor headers nor a request id — the marker alone proves
    // the call crossed to a provider, so it must never classify as local.
    expect(extractProviderRunError({ message: 'Not Found', name: 'AI_APICallError' }).code).toBe(
      PROVIDER_RUN_ERROR_FALLBACK_CODE
    );
    expect(
      extractProviderRunError({ error: { message: 'Not Found', name: 'AI_APICallError' } }).code
    ).toBe(PROVIDER_RUN_ERROR_FALLBACK_CODE);
    expect(
      extractProviderRunError(
        new Error('wrapped', {
          cause: { message: 'retries exhausted', name: 'AI_RetryError' },
        })
      ).code
    ).toBe(PROVIDER_RUN_ERROR_FALLBACK_CODE);
    // APICallError always carries url + requestBodyValues, even when the name
    // was lost to serialization; a renderer TypeError never carries either.
    expect(
      extractProviderRunError({
        message: 'fetch failed',
        requestBodyValues: { model: 'claude-sonnet-5' },
        url: 'https://api.anthropic.com/v1/messages',
      }).code
    ).toBe(PROVIDER_RUN_ERROR_FALLBACK_CODE);
  });

  it('classifies exactly the local fallback and local-model tool fault as local', () => {
    expect(isLocalRunErrorClassification(LOCAL_RUN_ERROR_FALLBACK_CODE)).toBe(true);
    expect(isLocalRunErrorClassification('local_tool_call_arguments_invalid')).toBe(true);
    expect(isLocalRunErrorClassification(PROVIDER_RUN_ERROR_FALLBACK_CODE)).toBe(false);
    expect(isLocalRunErrorClassification('context_length_exceeded')).toBe(false);
  });

  it('still promotes stable typed codes even without response evidence', () => {
    expect(
      extractProviderRunError({
        code: 'context_length_exceeded',
        message: 'Too many tokens.',
      }).code
    ).toBe('context_length_exceeded');
  });

  it('bounds every persisted string and marks truncation explicitly', () => {
    let cause: Error | undefined;
    for (let index = 0; index < MAX_PROVIDER_RUN_ERROR_CAUSES + 3; index += 1) {
      cause = new Error(`${index}:${'c'.repeat(1000)}`, { cause });
    }
    const result = extractProviderRunError({
      cause,
      message: `root:${'m'.repeat(2000)}`,
      requestId: `req_${'r'.repeat(1000)}`,
      responseHeaders: {
        'retry-after': `after_${'h'.repeat(2000)}`,
      },
    });

    expect(result.message).toHaveLength(MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS);
    expect(result.message?.endsWith('… [truncated]')).toBe(true);
    expect(result.providerRequestId).toHaveLength(MAX_PROVIDER_RUN_ERROR_REQUEST_ID_CHARS);
    expect(result.providerRequestId?.endsWith('… [truncated]')).toBe(true);
    expect(result.responseHeaders?.['retry-after']).toHaveLength(
      MAX_PROVIDER_RUN_ERROR_HEADER_VALUE_CHARS
    );
    expect(result.responseHeaders?.['retry-after']?.endsWith('… [truncated]')).toBe(true);
    expect(result.causeChain).toHaveLength(MAX_PROVIDER_RUN_ERROR_CAUSES);
    expect(result.causeChain?.every((entry) => entry.endsWith('… [truncated]'))).toBe(true);
  });

  it('stops cyclic cause chains without repeating or throwing', () => {
    const cyclic: { cause?: unknown; message: string; name: string } = {
      message: 'cycle',
      name: 'CycleError',
    };
    cyclic.cause = cyclic;

    expect(extractProviderRunError(cyclic)).toEqual({
      code: LOCAL_RUN_ERROR_FALLBACK_CODE,
    });
  });

  it('strictly reads the namespaced runError envelope and rejects arbitrary metadata', () => {
    const valid = {
      runError: {
        causeChain: ['NetworkError: disconnected'],
        code: PROVIDER_RUN_ERROR_FALLBACK_CODE,
        httpStatus: 503,
        message: 'Unavailable',
        providerRequestId: 'req_123',
        responseHeaders: {
          'retry-after': '3',
          'x-request-id': 'req_123',
        },
      },
    };

    expect(readProviderRunError(valid)).toEqual(valid.runError);
    expect(
      readProviderRunError({
        runError: { code: LOCAL_RUN_ERROR_FALLBACK_CODE, message: 'renderer-side TypeError' },
      })
    ).toEqual({ code: LOCAL_RUN_ERROR_FALLBACK_CODE, message: 'renderer-side TypeError' });
    expect(
      readProviderRunError({
        runError: { ...valid.runError, responseBody: 'must not persist' },
      })
    ).toBeUndefined();
    expect(
      readProviderRunError({
        runError: {
          ...valid.runError,
          responseHeaders: { authorization: 'Bearer secret' },
        },
      })
    ).toBeUndefined();
    expect(
      readProviderRunError({
        runError: {
          ...valid.runError,
          message: 'x'.repeat(MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS + 1),
        },
      })
    ).toBeUndefined();
  });
});
