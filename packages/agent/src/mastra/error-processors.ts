import {
  type ErrorProcessor,
  PrefillErrorHandler,
  type Processor,
  ProviderHistoryCompat,
  StreamErrorRetryProcessor,
} from '@mastra/core/processors';

/**
 * Bounded retry budget for the error-processor layer.
 *
 * Configuring ANY `errorProcessors` flips Mastra's implicit
 * `maxProcessorRetries` from unset to 10 (verified in the compiled loop:
 * `maxProcessorRetries ?? (errorProcessors?.length ? 10 : void 0)`). Ten
 * transient retries — with the stream-retry backoff below stacking up to 30s
 * each — can inflate wall-clock latency well past a user's patience even though
 * no single silent gap ever trips the 120s stream inactivity watchdog. Pin a
 * small, observable ceiling so the layer stays inside the no-silent-fallbacks
 * posture: bounded retries, then a real terminal error the watchdog + renderer
 * boundary still surface.
 */
export const ASSISTANT_MAX_PROCESSOR_RETRIES = 3;

/** StreamErrorRetry's own per-processor cap (<= the agent-level ceiling). */
const STREAM_ERROR_MAX_RETRIES = 2;
/** Exponential-backoff ceiling for a transient network reset retry. */
const STREAM_ERROR_BACKOFF_CAP_MS = 30_000;
/**
 * Cap on provider-controlled `Retry-After` waits (core 1.51's default, pinned
 * explicitly so an upstream default change cannot silently stretch a run's
 * wall-clock stall past the value this layer was tuned against).
 */
export const STREAM_ERROR_MAX_RETRY_AFTER_MS = 30_000;

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

/** The built-in local provider proxies inference to the hidden llm-host, which
 * owns its own engine-fault recovery (LOCAL LLM ARCHITECTURE) and has none of
 * the hosted-provider wire quirks (Anthropic prefill, OpenAI stream errors,
 * cross-provider `mastra_messages` reuse) these processors recover from. */
function isLocalProvider(provider: string): boolean {
  return normalizeProvider(provider) === 'local';
}

/**
 * Matches ECONNRESET-class transient stream errors so StreamErrorRetry waits
 * (rather than immediately re-failing) before retrying. Kept narrow — genuine
 * socket resets only. Errors this matcher misses fall through to the bounded
 * `retryUnknownErrors` path (core 1.51), which excludes known authorization
 * failures (401/403) so a bad key still fails fast and visibly.
 */
export function isEconnResetStreamError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.toUpperCase() === 'ECONNRESET') {
    return true;
  }
  const message = error instanceof Error ? error.message : undefined;
  return typeof message === 'string' && /econnreset|socket hang up/i.test(message);
}

/**
 * The Agent-config `errorProcessors` stack (the un-clobbered seam — per-call
 * `inputProcessors` never touch it). Covers every `processAPIError` recovery.
 *
 * ORDER IS LOAD-BEARING: Mastra's runner returns on the FIRST processor that
 * claims `{retry: true}` (verified in the compiled `runProcessAPIError`), so
 * the SPECIFIC handlers must precede the generic catch-all — with
 * `retryUnknownErrors` enabled, a leading StreamErrorRetry would claim a
 * prefill rejection (status 400, not an auth failure) and blindly retry the
 * UNCHANGED prompt instead of letting PrefillErrorHandler inject its fix.
 *
 * 1. PrefillErrorHandler — reloaded-thread assistant-prefill rejections
 *    (injects the "continue" system-reminder, then retries).
 * 2. ProviderHistoryCompat — the REACTIVE cross-provider rules (e.g. Anthropic
 *    tool-id rewrite). Its PREEMPTIVE `processLLMRequest` rules do NOT fire from
 *    this array — those ride the per-call input array (see
 *    {@link buildProviderHistoryCompatInputProcessor}).
 * 3. StreamErrorRetryProcessor — transient mid-stream failures: ECONNRESET via
 *    the explicit matcher, everything else via the bounded unknown-error path.
 *
 * Returns `undefined` for the built-in local provider (excluded — see
 * {@link isLocalProvider}), so the bare-Agent path keeps zero error processors
 * there and the default `maxProcessorRetries` is never engaged.
 */
export function buildAssistantErrorProcessors(provider: string): ErrorProcessor[] | undefined {
  if (isLocalProvider(provider)) {
    return;
  }
  return [
    new PrefillErrorHandler(),
    new ProviderHistoryCompat(),
    new StreamErrorRetryProcessor({
      delayMs: ({ retryCount }) => Math.min(1000 * 2 ** retryCount, STREAM_ERROR_BACKOFF_CAP_MS),
      matchers: [isEconnResetStreamError],
      maxRetries: STREAM_ERROR_MAX_RETRIES,
      maxRetryAfterMs: STREAM_ERROR_MAX_RETRY_AFTER_MS,
      // Retry unmatched transient failures with the SAME bounded budget +
      // backoff; the processor surfaces known auth failures (401/403)
      // immediately. Still no silent fallback: budget exhaustion is a real
      // terminal error the watchdog + renderer boundary surface.
      retryUnknownErrors: true,
    }),
  ];
}

/**
 * ProviderHistoryCompat as a per-call INPUT processor so its PREEMPTIVE
 * `processLLMRequest` rules fire — stripping foreign/unsupported `reasoning`
 * parts from the outbound prompt before a provider that would reject them (the
 * only place cross-provider reasoning incompatibility is handled; there is no
 * reactive rule for it). Composed alongside the TokenLimiter in the per-call
 * `inputProcessors` array (buildToolLoopOptions) — NOT the Agent config, which
 * a per-call array would clobber. The two hooks are disjoint stages, so the
 * TokenLimiter's input trimming is unaffected.
 *
 * Returns `undefined` for the local provider (its built-in rules would no-op
 * anyway; excluded for parity with the error stack).
 */
export function buildProviderHistoryCompatInputProcessor(provider: string): Processor | undefined {
  if (isLocalProvider(provider)) {
    return;
  }
  return new ProviderHistoryCompat();
}
