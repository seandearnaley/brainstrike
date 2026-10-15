import { describe, expect, it } from 'vitest';
import {
  buildAssistantErrorProcessors,
  isSubscriptionRateLimitError,
} from '../mastra-processors/error-processors';

/**
 * Legal gate BST-1351, constraint 6:
 *
 * > Surface subscription rate-limit responses verbatim (bounded) so users
 * > understand quota, and NEVER auto-retry around them.
 *
 * The shared error-processor stack applies to every non-local provider, and
 * Mastra's `StreamErrorRetryProcessor` treats `rate_limit` as retryable by
 * default. Worse, its constructor is ADDITIVE
 * (`[...defaultEntries, ...options.matchers]`), so a custom matcher list
 * cannot remove that default. Subscription providers therefore need an
 * explicit terminal arm.
 *
 * Retrying a subscription 429 is not merely wasteful: it hammers the user's
 * personal quota on their behalf and hides the quota message the gate
 * requires them to see.
 */

/** The wire shape Mastra's OpenAI matcher actually parses (verified against
 * `getOpenAIErrorPayload` in @mastra/core 1.59.0). */
function rateLimitError(message = 'Rate limit reached for gpt-5.5'): unknown {
  return {
    error: { code: 'rate_limit', message, type: 'rate_limit_exceeded' },
    type: 'error',
  };
}

function econnresetError(): unknown {
  return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
}

function serverError(): unknown {
  return { error: { code: 'server_error', message: 'upstream blip' }, type: 'error' };
}

/**
 * Exercise the RETRY arm of the stack — the last processor, and the only one
 * that can request a retry for these error shapes. The two ahead of it
 * (PrefillErrorHandler, ProviderHistoryCompat) recover message-shape
 * rejections and need a full message context they never see here; invoking
 * them with a bare error would test the harness, not the constraint.
 */
async function runErrorProcessors(provider: string, error: unknown): Promise<boolean> {
  const processors = buildAssistantErrorProcessors(provider);
  if (!processors) {
    throw new Error(`expected error processors for ${provider}`);
  }
  const retryProcessor = processors.at(-1);
  if (!retryProcessor) {
    throw new Error(`expected a retry processor for ${provider}`);
  }
  const result = await retryProcessor.processAPIError?.({
    abortSignal: new AbortController().signal,
    error,
    retryCount: 0,
  } as never);
  return result?.retry === true;
}

describe('isSubscriptionRateLimitError', () => {
  it('matches the OpenAI rate-limit stream payload', () => {
    expect(isSubscriptionRateLimitError(rateLimitError())).toBe(true);
  });

  it('matches a plain 429 status anywhere in the cause chain', () => {
    expect(isSubscriptionRateLimitError({ statusCode: 429 })).toBe(true);
    expect(isSubscriptionRateLimitError({ status: 429 })).toBe(true);
    const wrapped = Object.assign(new Error('boom'), { cause: { statusCode: 429 } });
    expect(isSubscriptionRateLimitError(wrapped)).toBe(true);
  });

  it('matches quota exhaustion', () => {
    expect(
      isSubscriptionRateLimitError({ error: { code: 'insufficient_quota' }, type: 'error' })
    ).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isSubscriptionRateLimitError(econnresetError())).toBe(false);
    expect(isSubscriptionRateLimitError(serverError())).toBe(false);
    expect(isSubscriptionRateLimitError({ statusCode: 500 })).toBe(false);
    expect(isSubscriptionRateLimitError(undefined)).toBe(false);
    expect(isSubscriptionRateLimitError(null)).toBe(false);
  });

  it('terminates on a self-referential cause chain instead of looping', () => {
    const cyclic: Record<string, unknown> = { statusCode: 500 };
    cyclic['cause'] = cyclic;
    expect(isSubscriptionRateLimitError(cyclic)).toBe(false);
  });
});

describe('subscription rate limits are never auto-retried (gate constraint 6)', () => {
  it('does NOT retry a 429 for the ChatGPT-subscription provider', async () => {
    await expect(runErrorProcessors('openai-codex', rateLimitError())).resolves.toBe(false);
  });

  it('STILL retries a 429 for a metered api-key provider', async () => {
    // The constraint is specific to subscription quota; ordinary hosted
    // providers keep the transient-recovery behavior they have today.
    await expect(runErrorProcessors('openai', rateLimitError())).resolves.toBe(true);
  });

  it('still retries genuinely transient failures on the subscription provider', async () => {
    // Quota is terminal; a socket reset is not. Making everything terminal
    // would be a silent downgrade of reliability.
    await expect(runErrorProcessors('openai-codex', econnresetError())).resolves.toBe(true);
    await expect(runErrorProcessors('openai-codex', serverError())).resolves.toBe(true);
  });

  it('never sleeps before surfacing a subscription 429', async () => {
    // A retry that waits out `Retry-After` would stall the turn for up to 30s
    // before showing the user the quota message.
    const start = Date.now();
    await runErrorProcessors('openai-codex', {
      error: { code: 'rate_limit', message: 'slow down' },
      headers: { 'retry-after': '30' },
      type: 'error',
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
