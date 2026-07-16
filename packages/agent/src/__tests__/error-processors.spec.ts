/**
 * Unit coverage for the error-processor stack builders.
 *
 * These pin the PLACEMENT decision the study flagged as the sharp edge: the two
 * pure-`processAPIError` processors + ProviderHistoryCompat's REACTIVE rules go
 * on the Agent-config `errorProcessors` seam, while ProviderHistoryCompat's
 * PREEMPTIVE `processLLMRequest` rules must ride the per-call `inputProcessors`
 * array (verified against the compiled loop: `listResolvedLLMRequestProcessors`
 * resolves ONLY input processors — `errorProcessors` never dispatch
 * `processLLMRequest`). The live-loop behavior is proved in
 * mastra-error-processors.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_MAX_PROCESSOR_RETRIES,
  buildAssistantErrorProcessors,
  buildProviderHistoryCompatInputProcessor,
  isEconnResetStreamError,
  STREAM_ERROR_MAX_RETRY_AFTER_MS,
} from '../mastra/error-processors';

describe('error-processor builders', () => {
  it('pins the retry budget to a small explicit value (not Mastra default 10)', () => {
    // Adding any errorProcessors flips Mastra's implicit maxProcessorRetries to
    // 10; we pin a bounded, observable ceiling.
    expect(ASSISTANT_MAX_PROCESSOR_RETRIES).toBe(3);
    expect(ASSISTANT_MAX_PROCESSOR_RETRIES).toBeLessThan(10);
  });

  it('pins the provider Retry-After cap explicitly (never trust a moving default)', () => {
    // 1.51's maxRetryAfterMs defaults to 30s; we pass it explicitly so a future
    // default change upstream cannot silently stretch a run's wall-clock stall.
    expect(STREAM_ERROR_MAX_RETRY_AFTER_MS).toBe(30_000);
  });

  it('builds the three-processor error stack SPECIFIC-BEFORE-GENERIC', () => {
    // Mastra's runner returns on the FIRST processor claiming {retry:true}, so
    // the targeted handlers must precede the retryUnknownErrors catch-all — a
    // leading StreamErrorRetry would swallow prefill errors unfixed.
    const processors = buildAssistantErrorProcessors('anthropic');
    expect(processors).toBeDefined();
    expect(processors?.map((processor) => processor.id)).toEqual([
      'prefill-error-handler',
      'provider-history-compat',
      'stream-error-retry-processor',
    ]);
  });

  it('excludes the error stack for the built-in local provider', () => {
    expect(buildAssistantErrorProcessors('local')).toBeUndefined();
  });

  it('normalizes the provider before the local check', () => {
    expect(buildAssistantErrorProcessors('  LOCAL  ')).toBeUndefined();
  });

  it('exposes a ProviderHistoryCompat preemptive instance for hosted providers', () => {
    const processor = buildProviderHistoryCompatInputProcessor('openai');
    expect(processor?.id).toBe('provider-history-compat');
    // The preemptive rules run in processLLMRequest; the instance must implement it.
    expect(typeof processor?.processLLMRequest).toBe('function');
  });

  it('excludes the preemptive ProviderHistoryCompat for the local provider', () => {
    expect(buildProviderHistoryCompatInputProcessor('local')).toBeUndefined();
    expect(buildProviderHistoryCompatInputProcessor('Local')).toBeUndefined();
  });

  it('matches ECONNRESET-class transient stream errors, and only those', () => {
    expect(isEconnResetStreamError({ code: 'ECONNRESET' })).toBe(true);
    expect(isEconnResetStreamError({ code: 'econnreset' })).toBe(true);
    expect(isEconnResetStreamError(new Error('read ECONNRESET'))).toBe(true);
    expect(isEconnResetStreamError(new Error('socket hang up'))).toBe(true);
    expect(isEconnResetStreamError(new Error('rate limit exceeded'))).toBe(false);
    expect(isEconnResetStreamError(undefined)).toBe(false);
    expect(isEconnResetStreamError('ECONNRESET')).toBe(false);
  });
});
