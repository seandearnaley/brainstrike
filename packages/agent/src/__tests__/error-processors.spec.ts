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
  buildAssistantErrorProcessors,
  buildProviderHistoryCompatInputProcessor,
  isEconnResetStreamError,
} from '../mastra-processors/error-processors';

describe('error-processor builders', () => {
  it('builds the three-processor error stack for hosted providers in order', () => {
    const processors = buildAssistantErrorProcessors();
    expect(processors).toBeDefined();
    // ORDER IS LOAD-BEARING: the runner returns at the FIRST processor that
    // requests a retry, so the fixup processors must precede the
    // unknown-error retry (see mastra-error-processors.spec.ts for the
    // live-loop prompt-sensitive regression pin).
    expect(processors?.map((processor) => processor.id)).toEqual([
      'prefill-error-handler',
      'provider-history-compat',
      'stream-error-retry-processor',
    ]);
  });

  it('exposes a ProviderHistoryCompat preemptive instance for hosted providers', () => {
    const processor = buildProviderHistoryCompatInputProcessor('openai');
    expect(processor?.id).toBe('provider-history-compat');
    // The preemptive rules run in processLLMRequest; the instance must implement it.
    expect(typeof processor?.processLLMRequest).toBe('function');
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
