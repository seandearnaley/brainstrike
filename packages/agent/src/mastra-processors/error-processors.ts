import {
  type ErrorProcessor,
  PrefillErrorHandler,
  type Processor,
  ProviderHistoryCompat,
  StreamErrorRetryProcessor,
} from '@mastra/core/processors';
import {
  CanonicalProviderHistoryCompat,
  type ProviderCallProvenance,
} from '../providers/foreign-provider-history.ts';

/** Retry cap for the retained vendor-processor regression harness. */
const STREAM_ERROR_MAX_RETRIES = 2;
/**
 * Exponential-backoff ceiling for a transient retry. Doubles as the explicit
 * `maxRetryAfterMs` clamp on provider `Retry-After` headers (1.51): the two
 * caps are deliberately the SAME value so no retry wait — ours or the
 * provider's — can exceed it. 1.51's default happens to match today; pinning
 * it here guards against upstream drift in the processor regression harness.
 */
const STREAM_ERROR_BACKOFF_CAP_MS = 30_000;

/**
 * Matches ECONNRESET-class transient stream errors so StreamErrorRetry waits
 * (rather than immediately re-failing) before retrying. Deliberately narrow —
 * only genuine socket resets, never a generic error — so a real terminal
 * failure is not retried into a hidden stall.
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
  return typeof message === 'string' && /econnreset|socket hang up/iu.test(message);
}

/**
 * The Agent-config `errorProcessors` stack (the un-clobbered seam — per-call
 * `inputProcessors` never touch it). Covers every `processAPIError` recovery.
 *
 * ORDER IS LOAD-BEARING: Mastra's ProcessorRunner returns at the FIRST
 * processor that requests a retry, so the FIXUP processors must run before
 * the unknown-error retry — otherwise a deterministic prefill / history-compat
 * rejection is blindly retried with the UNCHANGED request until the budget
 * burns, and the mutation that would fix it never happens (verified against
 * the compiled 1.51 runner; pinned by the prompt-sensitive prefill test):
 *
 * 1. PrefillErrorHandler — reloaded-thread assistant-prefill rejections,
 *    recovered by MUTATING history (must see `retryCount === 0`).
 * 2. ProviderHistoryCompat — the REACTIVE cross-provider rules (e.g. Anthropic
 *    tool-id rewrite). Its PREEMPTIVE `processLLMRequest` rules do NOT fire from
 *    this array — those ride the per-call input array (see
 *    {@link buildProviderHistoryCompatInputProcessor}).
 * 3. StreamErrorRetryProcessor — transient mid-stream / ECONNRESET failures,
 *    plus (1.51) UNKNOWN errors as the LAST RESORT, bounded by the same
 *    maxRetries + backoff. Known-terminal authorization failures (401/403 /
 *    invalid_api_key-class codes, matched through the cause chain) surface
 *    immediately — a bad key must fail loudly. Deliberate trade-off: OTHER
 *    deterministic non-auth errors (e.g. a 400 context-length rejection) eat
 *    the bounded ~3s retry budget before surfacing — accepted for the
 *    transient-error recovery the option buys.
 */
/** @internal Test seam: error-processors.spec.ts exercises vendor processor ordering. */
export function buildAssistantErrorProcessors(): ErrorProcessor[] | undefined {
  const retryProcessor = new StreamErrorRetryProcessor({
    delayMs: ({ retryCount }) => Math.min(1000 * 2 ** retryCount, STREAM_ERROR_BACKOFF_CAP_MS),
    matchers: [isEconnResetStreamError],
    maxRetries: STREAM_ERROR_MAX_RETRIES,
    // Cap provider `Retry-After` waits (walked through the error/cause
    // chain) so a hostile/buggy header can never stall a retry past the
    // same ceiling as our own backoff.
    maxRetryAfterMs: STREAM_ERROR_BACKOFF_CAP_MS,
    retryUnknownErrors: true,
  });
  return [new PrefillErrorHandler(), new ProviderHistoryCompat(), retryProcessor];
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
 */
export function buildProviderHistoryCompatInputProcessor(
  provider: string,
  provenance?: ProviderCallProvenance
): Processor | undefined {
  return new CanonicalProviderHistoryCompat(provider, provenance);
}
