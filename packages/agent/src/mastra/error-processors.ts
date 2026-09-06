import { findProviderDefinition } from '@brainstrike/assistant-contract/provider-registry';
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
/**
 * Exponential-backoff ceiling for a transient retry. Doubles as the explicit
 * `maxRetryAfterMs` clamp on provider `Retry-After` headers (1.51): the two
 * caps are deliberately the SAME value so no retry wait — ours or the
 * provider's — can exceed it. 1.51's default happens to match today; pinning
 * it here guards against upstream drift (same posture as
 * {@link ASSISTANT_MAX_PROCESSOR_RETRIES}).
 */
const STREAM_ERROR_BACKOFF_CAP_MS = 30_000;

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
  return typeof message === 'string' && /econnreset|socket hang up/i.test(message);
}

/** Codes that mean "you are out of subscription quota", not "try again". */
const SUBSCRIPTION_RATE_LIMIT_CODES = ['rate_limit', 'insufficient_quota', 'quota_exceeded'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Rate-limit / quota-exhaustion detection for subscription providers
 * (BST-1356, legal gate constraint 6).
 *
 * Walks the error, its `cause` chain, and the OpenAI stream-error envelope
 * (`{ type: 'error', error: {...} }`) that Mastra's own matcher parses, so the
 * two agree on what a 429 looks like. `WeakSet`-guarded against the
 * self-referential cause chains real SDK errors sometimes carry.
 */
export function isSubscriptionRateLimitError(error: unknown): boolean {
  const visited = new WeakSet<object>();

  function visit(candidate: unknown): boolean {
    if (!isRecord(candidate) || visited.has(candidate)) {
      return false;
    }
    visited.add(candidate);

    const status = candidate['statusCode'] ?? candidate['status'];
    if (status === 429) {
      return true;
    }
    const code = readString(candidate, 'code') ?? readString(candidate, 'type');
    if (
      code !== undefined &&
      SUBSCRIPTION_RATE_LIMIT_CODES.some((needle) => code.toLowerCase().includes(needle))
    ) {
      return true;
    }
    // The OpenAI stream envelope nests the real payload, and SDK errors nest
    // the transport failure under `cause`.
    return visit(candidate['error']) || visit(candidate['cause']);
  }

  return visit(error);
}

/**
 * Wraps the shared retry processor so subscription quota is TERMINAL
 * (BST-1356, gate constraint 6).
 *
 * Ordering cannot express this: Mastra's ProcessorRunner only stops at a
 * processor that REQUESTS a retry, so an earlier "don't retry" processor
 * would simply be skipped over. And the retry processor's own matcher list is
 * ADDITIVE — `[...defaultEntries, ...options.matchers]` — so the built-in
 * `rate_limit` entry cannot be removed through configuration. Wrapping is the
 * only seam that actually holds the constraint.
 *
 * Everything that is NOT quota (socket resets, 5xx, unknown errors) keeps the
 * ordinary bounded retry behavior — making all failures terminal here would be
 * a silent reliability downgrade, not a legal safeguard.
 */
class SubscriptionQuotaTerminalRetryProcessor implements ErrorProcessor {
  readonly id = 'subscription-quota-terminal-retry-processor';
  readonly name = 'Subscription Quota Terminal Retry Processor';
  readonly #inner: StreamErrorRetryProcessor;

  constructor(inner: StreamErrorRetryProcessor) {
    this.#inner = inner;
  }

  processAPIError(
    ...args: Parameters<NonNullable<ErrorProcessor['processAPIError']>>
  ): ReturnType<NonNullable<ErrorProcessor['processAPIError']>> {
    const [options] = args;
    if (isSubscriptionRateLimitError(options.error)) {
      // Return WITHOUT retrying and without sleeping: the provider's own
      // quota message reaches the user immediately and verbatim (bounded by
      // the shared run-error envelope).
      return;
    }
    return this.#inner.processAPIError(...args);
  }
}

function isSubscriptionAuthProvider(provider: string): boolean {
  return findProviderDefinition(normalizeProvider(provider))?.authType === 'oauth_subscription';
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
 *
 * Returns `undefined` for the built-in local provider (excluded — see
 * {@link isLocalProvider}), so the bare-Agent path keeps zero error processors
 * there and the default `maxProcessorRetries` is never engaged.
 */
export function buildAssistantErrorProcessors(provider: string): ErrorProcessor[] | undefined {
  if (isLocalProvider(provider)) {
    return;
  }
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
  return [
    new PrefillErrorHandler(),
    new ProviderHistoryCompat(),
    // Subscription providers get the quota-terminal wrapper (gate constraint
    // 6): retrying a 429 would spend the user's personal quota on their behalf
    // and bury the message the gate requires them to see.
    isSubscriptionAuthProvider(provider)
      ? new SubscriptionQuotaTerminalRetryProcessor(retryProcessor)
      : retryProcessor,
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
