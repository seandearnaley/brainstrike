import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';

import {
  LOCAL_RUN_ERROR_FALLBACK_CODE,
  PROVIDER_RUN_ERROR_FALLBACK_CODE,
} from '../../provider-error-metadata';
import { OpenAIStoredItemExpiredError } from '../../providers/openai-expired-item';
import type { RuntimeData, StreamChunkTool } from '../../types';
import {
  asMastraStreamPart,
  buildProviderErrorDiagnosticCode,
  buildProviderErrorDiagnosticCorrelation,
  extractErrorMessage,
  getDeltaText,
  getToolCallIdFromToolEvent,
  INVALID_TRIPWIRE_REASON,
  isObservationalMemoryDataChunkType,
  isRunEventMetadata,
  MAX_VISIBLE_PROVIDER_ERROR_CHARS,
  makeStepMetadata,
  makeToolEventMetadata,
  PROVIDER_ERROR_TRUNCATION_MARKER,
  readFinishReason,
  readOmTokenCount,
  resolveProviderError,
  resolveTripwire,
  truncateStreamDetail,
} from '../mastra-chunk-decoding';

/**
 * BST-985. These are the PURE decoders lifted out of `agent-streaming.ts`:
 * untyped Mastra chunk in, validated Brainstrike value out. Nothing here may
 * read a clock, mint an id, log, or mutate its argument — the final `describe`
 * enforces exactly that, so a future edit that reintroduces a side effect
 * fails here rather than in a 4k-line full-stream spec.
 */

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

it('keeps the explicit replay decision for a classified expired OpenAI item', () => {
  const original = new Error('private provider payload with sk-synthetic-only');
  const error = new OpenAIStoredItemExpiredError(original);
  const resolved = resolveProviderError(error, undefined);
  expect(resolved.failure).toMatchObject({ category: 'configuration', kind: 'refusal' });
  expect(resolved.detail).toBe(error.message);
  expect(resolved.detail).not.toContain(original.message);
  expect(error.cause).toBe(original);
});

describe('asMastraStreamPart', () => {
  it('passes objects through untouched', () => {
    const part = { type: 'text-delta' };
    expect(asMastraStreamPart(part)).toBe(part);
  });

  it.each([[null], [undefined], ['text-delta'], [42]])(
    'maps the non-object %p to an unknown-typed part',
    (value) => {
      expect(asMastraStreamPart(value)).toEqual({ type: 'unknown' });
    }
  );
});

describe('readFinishReason', () => {
  it('reads the top-level finishReason', () => {
    expect(readFinishReason({ finishReason: 'stop', type: 'finish' })).toBe('stop');
  });

  it('falls back to the nested step result reason', () => {
    expect(
      readFinishReason({ payload: { stepResult: { reason: 'length' } }, type: 'finish' })
    ).toBe('length');
  });

  it('prefers the top-level reason over the nested one', () => {
    expect(
      readFinishReason({
        finishReason: 'stop',
        payload: { stepResult: { reason: 'length' } },
        type: 'finish',
      })
    ).toBe('stop');
  });

  it('normalizes the snake_case tool_calls alias', () => {
    expect(readFinishReason({ finishReason: 'tool_calls', type: 'finish' })).toBe('tool-calls');
  });

  it('reports an unmodelled reason as unrecognized rather than coercing it', () => {
    expect(readFinishReason({ finishReason: 'exploded', type: 'finish' })).toBe('unrecognized');
  });

  it('distinguishes an absent reason from an unrecognized one', () => {
    expect(readFinishReason({ type: 'finish' })).toBe('absent');
    expect(readFinishReason({ finishReason: '', type: 'finish' })).toBe('absent');
  });
});

describe('getDeltaText', () => {
  it('prefers top-level fields over payload fields', () => {
    expect(getDeltaText({ payload: { text: 'payload' }, text: 'top', type: 'text-delta' })).toBe(
      'top'
    );
  });

  it.each([
    [{ text: 'a' }, 'a'],
    [{ textDelta: 'b' }, 'b'],
    [{ delta: 'c' }, 'c'],
    [{ payload: { text: 'd' } }, 'd'],
    [{ payload: { textDelta: 'e' } }, 'e'],
    [{ payload: { delta: 'f' } }, 'f'],
  ])('reads %o as its delta text', (part, expected) => {
    expect(getDeltaText({ ...part, type: 'text-delta' })).toBe(expected);
  });

  it('returns an empty string when no delta field is present', () => {
    expect(getDeltaText({ type: 'text-delta' })).toBe('');
  });
});

describe('isRunEventMetadata', () => {
  it('accepts plain and null-prototype objects', () => {
    expect(isRunEventMetadata({})).toBe(true);
    expect(isRunEventMetadata(Object.create(null))).toBe(true);
  });

  it.each([[null], [undefined], [[]], ['x'], [new Error('boom')]])('rejects %p', (value) => {
    expect(isRunEventMetadata(value)).toBe(false);
  });
});

describe('makeStepMetadata', () => {
  it('reads usage nested under payload.output (the shape real parts carry)', () => {
    expect(
      makeStepMetadata({
        payload: { output: { usage: { completionTokens: 7, promptTokens: 11 } } },
        type: 'step-finish',
      })
    ).toEqual({ completionTokens: 7, promptTokens: 11 });
  });

  it('accepts the AI-SDK v2 input/output token names', () => {
    expect(
      makeStepMetadata({ type: 'step-finish', usage: { inputTokens: 3, outputTokens: 5 } })
    ).toEqual({ completionTokens: 5, promptTokens: 3 });
  });

  it('carries the message id when present', () => {
    expect(makeStepMetadata({ messageId: 'msg-1', type: 'start' })).toEqual({ messageId: 'msg-1' });
  });

  it('drops non-finite token counts instead of emitting NaN', () => {
    expect(
      makeStepMetadata({
        type: 'step-finish',
        usage: { completionTokens: Number.NaN, promptTokens: Number.POSITIVE_INFINITY },
      })
    ).toBeUndefined();
  });

  it('returns undefined when the part carries nothing worth recording', () => {
    expect(makeStepMetadata({ type: 'step-start' })).toBeUndefined();
  });
});

describe('resolveTripwire', () => {
  it('reads a legacy top-level tripwireReason', () => {
    expect(resolveTripwire({ tripwireReason: '  blocked  ', type: 'tripwire' })).toEqual({
      detail: 'blocked',
      diagnostic: { source: 'legacy-tripwire-reason' },
    });
  });

  it('reads a legacy tripwireReason nested in the payload', () => {
    expect(resolveTripwire({ payload: { tripwireReason: 'blocked' }, type: 'tripwire' })).toEqual({
      detail: 'blocked',
      diagnostic: { source: 'legacy-tripwire-reason' },
    });
  });

  it('surfaces a reason-less legacy tripwire as malformed instead of inventing text', () => {
    expect(resolveTripwire({ type: 'tripwire' })).toEqual({
      detail: INVALID_TRIPWIRE_REASON,
      diagnostic: { malformedFields: ['reason'], source: 'malformed' },
    });
  });

  it('reads the Mastra 1.51 payload shape', () => {
    expect(
      resolveTripwire({
        payload: { processorId: 'pii-filter', reason: 'policy', retry: true },
        type: 'tripwire',
      })
    ).toEqual({
      detail: 'policy',
      diagnostic: {
        processorId: 'pii-filter',
        retry: true,
        source: 'mastra-1.51',
      },
    });
  });

  it('falls back to the legacy reason when the current payload omits one', () => {
    const resolved = resolveTripwire({
      payload: { retry: false },
      tripwireReason: 'legacy',
      type: 'tripwire',
    });
    expect(resolved.detail).toBe('legacy');
    expect(resolved.diagnostic).toEqual({ retry: false, source: 'legacy-tripwire-reason' });
  });

  it('records each malformed optional field rather than dropping it silently', () => {
    const resolved = resolveTripwire({
      payload: { metadata: undefined, processorId: '   ', reason: 'policy', retry: 'yes' },
      type: 'tripwire',
    });
    expect(resolved.detail).toBe('policy');
    expect(resolved.diagnostic).toEqual({
      malformedFields: ['metadata', 'processorId', 'retry'],
      source: 'mastra-1.51',
    });
  });

  it('truncates an overlong reason with the shared marker', () => {
    const reason = 'x'.repeat(MAX_VISIBLE_PROVIDER_ERROR_CHARS + 50);
    const { detail } = resolveTripwire({ payload: { reason }, type: 'tripwire' });
    expect(detail).toHaveLength(MAX_VISIBLE_PROVIDER_ERROR_CHARS);
    expect(detail.endsWith(PROVIDER_ERROR_TRUNCATION_MARKER)).toBe(true);
  });

  it('never exceeds the cap, even when the cap is smaller than the marker', () => {
    // Regression (review #2169): `slice(0, maxChars - 13)` with a small cap
    // passes a NEGATIVE end index, which slice reads as an offset from the
    // end — the old formula returned 105 chars for a cap of 5, longer than
    // the input. A cap with no room for the marker drops the marker, never
    // the guarantee.
    for (const cap of [0, 1, 5, 13, 14, 40]) {
      const out = truncateStreamDetail('x'.repeat(100), cap);
      expect(out.length, `cap ${cap} produced ${out.length} chars`).toBeLessThanOrEqual(cap);
    }
    expect(truncateStreamDetail('x'.repeat(100), 40)).toMatch(/\[truncated\]$/u);
  });

  it('truncates an overlong processorId', () => {
    const { diagnostic } = resolveTripwire({
      payload: { processorId: 'p'.repeat(400), reason: 'policy' },
      type: 'tripwire',
    });
    expect((diagnostic as { processorId: string }).processorId).toHaveLength(256);
  });

  describe('metadata bounding', () => {
    function metadataOf(metadata: unknown): unknown {
      const { diagnostic } = resolveTripwire({
        payload: { metadata, reason: 'policy' },
        type: 'tripwire',
      });
      return (diagnostic as { metadata?: unknown }).metadata;
    }

    it('keeps allowlisted identifier-shaped strings verbatim', () => {
      expect(metadataOf({ category: 'pii', severity: 'high' })).toEqual({
        category: 'pii',
        severity: 'high',
      });
    });

    it('summarizes a non-allowlisted string instead of echoing it', () => {
      expect(metadataOf({ note: 'secret user content' })).toEqual({
        note: { __brainstrikeSummary: { characterCount: 19, kind: 'string' } },
      });
    });

    it('summarizes an allowlisted key whose value is not identifier-shaped', () => {
      expect(metadataOf({ category: 'has spaces' })).toEqual({
        category: { __brainstrikeSummary: { characterCount: 10, kind: 'string' } },
      });
    });

    it('keeps the redacted match sentinel but never a real match', () => {
      expect(metadataOf({ match: '[REDACTED_MATCH]' })).toEqual({ match: '[REDACTED_MATCH]' });
      expect(metadataOf({ match: 'ssn 123' })).toEqual({
        match: { __brainstrikeSummary: { characterCount: 7, kind: 'string' } },
      });
    });

    it('bounds an oversized array and reports the omission', () => {
      expect(metadataOf({ rule: Array.from({ length: 40 }, () => 1) })).toEqual({
        rule: {
          __brainstrikeSummary: { itemCount: 40, kind: 'array', omittedItemCount: 8 },
          items: Array.from({ length: 32 }, () => 1),
        },
      });
    });

    it('bounds an oversized object and reports the omission', () => {
      const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 1]));
      const bounded = metadataOf(wide) as Record<string, unknown>;
      expect(bounded['__brainstrikeSummary']).toEqual({
        entryCount: 40,
        kind: 'object',
        omittedEntryCount: 8,
      });
      expect(Object.keys(bounded)).toHaveLength(33);
    });

    it('strips a caller-supplied reserved summary key', () => {
      expect(metadataOf({ __brainstrikeSummary: 'spoofed' })).toEqual({
        __brainstrikeSummary: {
          entryCount: 1,
          kind: 'object',
          omittedEntryCount: 1,
          reservedKeyCount: 1,
        },
      });
    });

    it('drops an overlong key and reports it', () => {
      expect(metadataOf({ [`${'k'.repeat(200)}`]: 1 })).toEqual({
        __brainstrikeSummary: {
          entryCount: 1,
          kind: 'object',
          omittedEntryCount: 1,
          overlongKeyCount: 1,
        },
      });
    });

    it('rejects metadata nested deeper than the sanitizer can carry', () => {
      let deep: unknown = 1;
      for (let i = 0; i < 8; i += 1) {
        deep = { a: deep };
      }
      const { diagnostic } = resolveTripwire({
        payload: { metadata: deep, reason: 'policy' },
        type: 'tripwire',
      });
      expect(diagnostic).toEqual({ malformedFields: ['metadata'], source: 'mastra-1.51' });
    });

    it('accepts metadata at the deepest carryable nesting', () => {
      let deep: unknown = 1;
      for (let i = 0; i < 7; i += 1) {
        deep = { a: deep };
      }
      expect(metadataOf(deep)).toBeDefined();
    });

    it('rejects a class instance rather than coercing it to null', () => {
      const { diagnostic } = resolveTripwire({
        payload: { metadata: { at: new Date(0) }, reason: 'policy' },
        type: 'tripwire',
      });
      expect(diagnostic).toEqual({ malformedFields: ['metadata'], source: 'mastra-1.51' });
    });
  });
});

describe('extractErrorMessage', () => {
  it.each([
    [new Error('boom'), 'boom'],
    ['plain', 'plain'],
    [{ message: 'nested' }, 'nested'],
    [undefined, undefined],
    [null, undefined],
    ['', undefined],
  ])('reads %p as %p', (value, expected) => {
    expect(extractErrorMessage(value)).toBe(expected);
  });

  it('falls back to String() for a message-less object', () => {
    expect(extractErrorMessage({ status: 500 })).toBe('[object Object]');
  });
});

describe('resolveProviderError', () => {
  it('prefers the extracted message over the run error message', () => {
    expect(resolveProviderError(new Error('model unavailable'), undefined).detail).toBe(
      INTERNAL_FAULT.message
    );
  });

  it('does not surface the useless [object Object] stringification', () => {
    const { detail } = resolveProviderError({ error: { message: 'deep' } }, undefined);
    expect(detail).not.toBe('[object Object]');
  });

  it('prefixes the stable code only for OpenRouter, case- and space-insensitively', () => {
    // Only allowlisted codes are "stable" (see STABLE_PROVIDER_ERROR_CODES);
    // an arbitrary provider string deliberately collapses to the fallback.
    const value = { error: { code: 'context_length_exceeded', message: 'slow down' } };
    const openrouter = resolveProviderError(value, { provider: ' OpenRouter ' } as RuntimeData);
    const anthropic = resolveProviderError(value, { provider: 'anthropic' } as RuntimeData);
    expect(openrouter.runError.code).toBe('context_length_exceeded');
    expect(openrouter.failure.providerEvidence).toBe('[context_length_exceeded] slow down');
    expect(anthropic.failure.providerEvidence).toBe('slow down');
  });

  it('omits the prefix when OpenRouter yielded only a fallback classification', () => {
    // A bare Error carries no provider response evidence, so it classifies as
    // a local error — and the local code is a classification, not a stable
    // provider code, so it must never be prefixed onto the visible detail.
    const local = resolveProviderError(new Error('opaque'), {
      provider: 'openrouter',
    } as RuntimeData);
    expect(local.runError.code).toBe(LOCAL_RUN_ERROR_FALLBACK_CODE);
    expect(local.detail).toBe(INTERNAL_FAULT.message);

    const provider = resolveProviderError({ message: 'opaque', statusCode: 500 }, {
      provider: 'openrouter',
    } as RuntimeData);
    expect(provider.runError.code).toBe(PROVIDER_RUN_ERROR_FALLBACK_CODE);
    expect(provider.failure.providerEvidence).toBe('opaque');
  });

  // BST-1384: a provider 401 is the ONE wrong-credential status (the same rule
  // the Settings "Test connection" probe applies — provider-verification.ts).
  // OpenRouter's 401 body is literally "User not found." for ANY unrecognized
  // key, which read as an app regression for a full day. The visible detail
  // must name the provider, say the credential was rejected, and point at the
  // remedy FOR THAT PROVIDER'S AUTH TYPE (PR #2573 review: an api-key remedy
  // is wrong for a ChatGPT subscription session or a local-runtime token);
  // the runError envelope (code/httpStatus — the diagnostics fingerprint and
  // debug-bundle fields) must be byte-identical to before.
  describe('rejected credential (HTTP 401)', () => {
    const openRouterUserNotFound = {
      message: 'User not found.',
      statusCode: 401,
    };

    it('rewrites an OpenRouter 401 into actionable api-key copy, guidance first', () => {
      const resolved = resolveProviderError(openRouterUserNotFound, {
        provider: 'openrouter',
      } as RuntimeData);
      expect(resolved.detail).toBe(
        'OpenRouter rejected the API key (HTTP 401) — it is invalid or was revoked. Update the key in Settings → Providers, or verify it in the provider dashboard. Provider response: User not found.'
      );
    });

    it('leaves the runError envelope untouched (fingerprint + bundle fields)', () => {
      const resolved = resolveProviderError(openRouterUserNotFound, {
        provider: 'openrouter',
      } as RuntimeData);
      expect(resolved.runError).toEqual({
        code: PROVIDER_RUN_ERROR_FALLBACK_CODE,
        httpStatus: 401,
        message: 'User not found.',
      });
    });

    it('names every api-key provider by its registry displayName', () => {
      const resolved = resolveProviderError(
        { message: 'Incorrect API key provided.', statusCode: 401 },
        { provider: 'openai' } as RuntimeData
      );
      expect(resolved.detail).toBe(
        'OpenAI rejected the API key (HTTP 401) — it is invalid or was revoked. Update the key in Settings → Providers, or verify it in the provider dashboard. Provider response: Incorrect API key provided.'
      );
    });

    it('tells a subscription (oauth_subscription) provider to sign in again, never to edit a key', () => {
      // openai-codex stores the placeholder `oauth-subscription-no-api-key`;
      // an expired/revoked session or failed refresh is exactly a 401.
      const resolved = resolveProviderError({ message: 'Unauthorized', statusCode: 401 }, {
        provider: 'openai-codex',
      } as RuntimeData);
      expect(resolved.detail).toBe(
        'OpenAI (ChatGPT) rejected the sign-in session (HTTP 401) — it expired or was revoked. Sign in again in Settings → Providers. Provider response: Unauthorized'
      );
      expect(resolved.detail).not.toContain('API key');
    });

    it('points an aws provider at its Bedrock credential / AWS session', () => {
      const resolved = resolveProviderError(
        { message: 'The security token included in the request is invalid.', statusCode: 401 },
        { provider: 'bedrock' } as RuntimeData
      );
      expect(resolved.detail).toBe(
        'Amazon Bedrock rejected the AWS credentials (HTTP 401) — they are invalid or expired. Update the Bedrock credential in Settings → Providers, or refresh the AWS profile session (for example `aws sso login`). Provider response: The security token included in the request is invalid.'
      );
    });

    it('points a keyless local runtime (authType none) at its Local Runtimes token', () => {
      // ollama/lmstudio carry an OPTIONAL bearer via providerOptions.apiToken,
      // configured under Local Runtimes — there is no Settings key to update.
      const resolved = resolveProviderError({ message: 'Unauthorized', statusCode: 401 }, {
        provider: 'ollama',
      } as RuntimeData);
      expect(resolved.detail).toBe(
        'Ollama (Local Runtime) rejected the request as unauthorized (HTTP 401). Check the runtime’s API token under Settings → Local Runtimes. Provider response: Unauthorized'
      );
      expect(resolved.detail).not.toContain('API key');
    });

    it('falls back to a neutral credential subject when the provider is unknown', () => {
      const resolved = resolveProviderError(openRouterUserNotFound, undefined);
      expect(resolved.detail).toBe(
        'The provider rejected the credential (HTTP 401) — it is invalid or was revoked. Check the provider’s credential in Settings → Providers. Provider response: User not found.'
      );
    });

    it('keeps the guidance intact under the visible clamp (provider body is what truncates)', () => {
      const longBody = 'x'.repeat(MAX_VISIBLE_PROVIDER_ERROR_CHARS + 200);
      const resolved = resolveProviderError({ message: longBody, statusCode: 401 }, {
        provider: 'openrouter',
      } as RuntimeData);
      const visible = truncateStreamDetail(resolved.detail, MAX_VISIBLE_PROVIDER_ERROR_CHARS);
      expect(visible.length).toBe(MAX_VISIBLE_PROVIDER_ERROR_CHARS);
      expect(visible.startsWith('OpenRouter rejected the API key (HTTP 401)')).toBe(true);
      expect(visible).toContain('Settings → Providers');
      expect(visible.endsWith(PROVIDER_ERROR_TRUNCATION_MARKER)).toBe(true);
    });

    it('does NOT treat 403 as a wrong key (authenticated but limited — probe parity)', () => {
      const resolved = resolveProviderError(
        { message: 'Your account is not allowed to use this model.', statusCode: 403 },
        { provider: 'openrouter' } as RuntimeData
      );
      expect(resolved.failure.providerEvidence).toBe(
        'Your account is not allowed to use this model.'
      );
      expect(resolved.failure.code).toBe('provider.request-rejected');
    });

    it('never classifies a local (evidence-free) failure as a rejected key', () => {
      // No httpStatus ⇒ the error never crossed to a provider; the wording of
      // its message is irrelevant.
      const resolved = resolveProviderError(new Error('User not found.'), {
        provider: 'openrouter',
      } as RuntimeData);
      expect(resolved.runError.code).toBe(LOCAL_RUN_ERROR_FALLBACK_CODE);
      expect(resolved.detail).toBe(INTERNAL_FAULT.message);
    });
  });
});

describe('buildProviderErrorDiagnosticCode', () => {
  it('reports the fallback code with its http status', () => {
    expect(
      buildProviderErrorDiagnosticCode({ code: PROVIDER_RUN_ERROR_FALLBACK_CODE, httpStatus: 429 })
    ).toBe(`${PROVIDER_RUN_ERROR_FALLBACK_CODE}:429`);
  });

  it('reports the local classification code on its own, never nested under the provider prefix', () => {
    expect(buildProviderErrorDiagnosticCode({ code: LOCAL_RUN_ERROR_FALLBACK_CODE })).toBe(
      `${LOCAL_RUN_ERROR_FALLBACK_CODE}:no_status`
    );
  });

  it('marks a missing http status explicitly rather than emitting undefined', () => {
    expect(buildProviderErrorDiagnosticCode({ code: 'rate_limited' })).toBe(
      'mastra_agent_stream_provider_error:rate_limited:no_status'
    );
  });

  it('namespaces the local-model tool-arguments fault under the local classification', () => {
    // local_tool_call_arguments_invalid is raised before anything crosses to a
    // provider — it must not wear the provider prefix in the log fingerprint.
    expect(buildProviderErrorDiagnosticCode({ code: 'local_tool_call_arguments_invalid' })).toBe(
      `${LOCAL_RUN_ERROR_FALLBACK_CODE}:local_tool_call_arguments_invalid:no_status`
    );
  });
});

describe('buildProviderErrorDiagnosticCorrelation', () => {
  it('promotes every present correlation id', () => {
    expect(
      buildProviderErrorDiagnosticCorrelation({
        boundWorkspaceRootId: 'root-1',
        memory: { resourceId: 'res-1', runId: 'run-1', threadId: 'thread-1' },
      } as RuntimeData)
    ).toEqual({
      resourceId: 'res-1',
      rootId: 'root-1',
      runId: 'run-1',
      threadId: 'thread-1',
    });
  });

  it('omits absent ids instead of emitting undefined values', () => {
    expect(buildProviderErrorDiagnosticCorrelation(undefined)).toEqual({});
  });
});

describe('tool event metadata', () => {
  function toolEvent(payload: unknown): StreamChunkTool {
    return { name: 'read_file', payload, status: 'start', type: 'tool-event' };
  }

  it('prefers toolCallId over the legacy callId', () => {
    expect(getToolCallIdFromToolEvent(toolEvent({ callId: 'b', toolCallId: 'a' }))).toBe('a');
    expect(getToolCallIdFromToolEvent(toolEvent({ callId: 'b' }))).toBe('b');
    expect(getToolCallIdFromToolEvent(toolEvent({}))).toBeUndefined();
  });

  it('ignores a non-plain payload rather than reading through it', () => {
    expect(getToolCallIdFromToolEvent(toolEvent(['a']))).toBeUndefined();
  });

  it('carries only the boolean flags that are actually booleans', () => {
    expect(
      makeToolEventMetadata(toolEvent({ dynamic: 'yes', providerExecuted: true, toolCallId: 'a' }))
    ).toEqual({ providerExecuted: true, toolCallId: 'a', toolName: 'read_file' });
  });
});

describe('observational-memory readers', () => {
  it.each([
    ['data-om-observation-end', true],
    ['data-om-buffering-failed', true],
    ['data-other', false],
    [undefined, false],
  ])('classifies %p as an OM chunk type: %p', (type, expected) => {
    expect(isObservationalMemoryDataChunkType(type)).toBe(expected);
  });

  it.each([
    [{ tokensObserved: 12 }, 12],
    [{ tokensObserved: 0 }, 0],
    [{ tokensObserved: -1 }, undefined],
    [{ tokensObserved: Number.NaN }, undefined],
    [{ tokensObserved: '12' }, undefined],
    [undefined, undefined],
  ])('reads %p as %p', (payload, expected) => {
    expect(readOmTokenCount(payload, 'tokensObserved')).toBe(expected);
  });
});

describe('truncateStreamDetail', () => {
  it('leaves a value at the limit untouched', () => {
    expect(truncateStreamDetail('abcde', 5)).toBe('abcde');
  });

  it('clamps to exactly the limit including the marker', () => {
    const truncated = truncateStreamDetail('x'.repeat(100), 40);
    expect(truncated).toHaveLength(40);
    expect(truncated.endsWith(PROVIDER_ERROR_TRUNCATION_MARKER)).toBe(true);
  });
});

describe('purity', () => {
  const cases: ReadonlyArray<readonly [string, () => unknown]> = [
    ['asMastraStreamPart', () => asMastraStreamPart(deepFreeze({ type: 'finish' }))],
    ['readFinishReason', () => readFinishReason(deepFreeze({ finishReason: 'stop' }))],
    ['getDeltaText', () => getDeltaText(deepFreeze({ payload: { delta: 'hi' } }))],
    [
      'makeStepMetadata',
      () => makeStepMetadata(deepFreeze({ messageId: 'm', usage: { promptTokens: 1 } })),
    ],
    [
      'resolveTripwire',
      () =>
        resolveTripwire(
          deepFreeze({
            payload: { metadata: { category: 'pii', note: 'x' }, reason: 'policy', retry: true },
            type: 'tripwire',
          })
        ),
    ],
    [
      'resolveProviderError',
      () =>
        resolveProviderError(
          deepFreeze({ error: { code: 'rate_limited', message: 'slow' } }),
          deepFreeze({ provider: 'openrouter' }) as RuntimeData
        ),
    ],
    [
      'buildProviderErrorDiagnosticCorrelation',
      () =>
        buildProviderErrorDiagnosticCorrelation(
          deepFreeze({ memory: { threadId: 't' } }) as RuntimeData
        ),
    ],
    [
      'makeToolEventMetadata',
      () =>
        makeToolEventMetadata(
          deepFreeze({
            name: 'read_file',
            payload: { toolCallId: 'a' },
            status: 'start',
            type: 'tool-event',
          }) as StreamChunkTool
        ),
    ],
  ];

  it.each(cases)(
    '%s is referentially transparent and never mutates a frozen argument',
    (_name, run) => {
      // A deep-frozen argument makes any in-place write throw in ESM strict
      // mode, and two identical results rule out a clock/uuid/counter.
      expect(run()).toEqual(run());
    }
  );
});

describe('purity is structural, not just observed', () => {
  // The behavioural cases above only cover the decoders they name. This checks
  // the WHOLE module, so a side effect added to any future decoder fails here.
  const IMPURE_CALL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
    ['wall clock', /\bnew Date\s*\(|\bDate\.now\s*\(/u],
    ['id minting', /\bgenerateUUID\s*\(|\brandomUUID\s*\(/u],
    ['randomness', /\bMath\.random\s*\(/u],
    ['logging', /\blogger\s*\.|\bconsole\s*\./u],
  ];

  function sourceWithoutComments(relativePath: string): string {
    const filePath = resolve(import.meta.dirname, relativePath);
    return readFileSync(filePath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
  }

  it.each(IMPURE_CALL_PATTERNS)('the decoding module performs no %s', (_label, pattern) => {
    expect(sourceWithoutComments('../mastra-chunk-decoding.ts')).not.toMatch(pattern);
  });

  // Two controls, because a probe that cannot fire is not evidence. The first
  // proves every regex actually matches the form it claims to; the second
  // proves the comment-stripper does not blank out real code on a large file.
  it.each(IMPURE_CALL_PATTERNS)('control: the %s probe fires on a synthetic sample', (_l, p) => {
    const synthetic = [
      'const a = new Date().toISOString(); const b = Date.now();',
      'const c = generateUUID(); const d = crypto.randomUUID();',
      'const e = Math.random();',
      "logger.warn('x'); console.error('y');",
    ].join('\n');
    expect(synthetic).toMatch(p);
  });

  it('control: the clock, id-minting, and logging probes fire on agent-streaming.ts', () => {
    // agent-streaming.ts genuinely holds these three (and deliberately no
    // randomness) — that asymmetry is why the synthetic control exists too.
    const impure = sourceWithoutComments('../agent-streaming.ts');
    expect(impure).toMatch(/\bnew Date\s*\(|\bDate\.now\s*\(/u);
    expect(impure).toMatch(/\bgenerateUUID\s*\(|\brandomUUID\s*\(/u);
    expect(impure).toMatch(/\blogger\s*\.|\bconsole\s*\./u);
  });

  // The file-local probes above cannot see impurity that arrives through an
  // IMPORT — adding a `logger.warn` to `sanitizeAssistantRunEventMetadata`
  // would make every resolveTripwire call log while all these tests stayed
  // green (review #2169). Purity is a property of the reachable graph, so the
  // guard walks it.
  function reachableModules(entry: string): string[] {
    const importRe = /(?:import|export)[^'"]*from\s+['"](\.[^'"]+)['"]/gu;
    const seen = new Set<string>();
    const queue = [resolve(import.meta.dirname, entry)];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(importRe)) {
        const spec = (match[1] as string).replace(/\.js$/u, '');
        for (const candidate of [`${spec}.ts`, `${spec}/index.ts`]) {
          const resolved = resolve(dirname(file), candidate);
          if (existsSync(resolved)) {
            queue.push(resolved);
            break;
          }
        }
      }
    }
    return [...seen];
  }

  it.each(IMPURE_CALL_PATTERNS)('nothing reachable from the module performs %s', (_l, pattern) => {
    const modules = reachableModules('../mastra-chunk-decoding.ts');
    // Anti-vacuity: a resolver that silently found nothing would pass forever.
    expect(modules.length).toBeGreaterThan(3);
    for (const modulePath of modules) {
      const source = readFileSync(modulePath, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/^\s*\/\/.*$/gmu, '');
      expect(source, `${modulePath} breaks the decoder purity contract`).not.toMatch(pattern);
    }
  });
});
