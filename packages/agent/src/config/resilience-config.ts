// packages/agent/src/config/resilience-config.ts
/**
 * Strict, no-silent-fallback configuration for assistant resilience timeouts.
 *
 * A *present but malformed* env value throws (typos must not silently coerce);
 * an *absent* value uses the documented default. An explicit override argument
 * always wins, mirroring how `mcpTimeoutMs` is threaded through the runtime.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
/**
 * Tolerated gap between stream parts, once the provider is demonstrably
 * producing OUTPUT.
 *
 * Scoped to that phase only since BST-1408. The wait for a provider to produce
 * its first output — which recurs in every step — is a different question and
 * gets {@link DEFAULT_STREAM_FIRST_OUTPUT_MS}.
 */
export const DEFAULT_STREAM_INACTIVITY_MS = 120_000;
/**
 * Budget for the provider to produce its first OUTPUT — per step, not per
 * stream.
 *
 * DELIBERATELY decoupled from `DEFAULT_STREAM_INACTIVITY_MS` and much wider,
 * for the same reason `DEFAULT_TOOL_CALL_INPUT_MS` is (BST-839): the two
 * windows answer different questions. Inactivity asks "is the provider still
 * delivering?"; this one asks "has it started answering yet?".
 *
 * Sharing one number killed a healthy 18-minute turn (BST-1408): a request
 * carrying ~169k prompt tokens at `reasoning.effort: 'max'` can spend minutes
 * producing nothing observable, which is indistinguishable from a wedged
 * transport at the stream-part layer.
 *
 * PER STEP is load-bearing, not a detail. Mastra opens every step with an
 * instant framework prologue (`start`, `step-start`) and only then calls the
 * provider, so time-to-first-output recurs throughout a turn — the captured
 * incident's fatal gap was a MID-TURN step's, not the opening one. The bound
 * stays finite so a provider that never answers cannot hold a turn open
 * forever.
 */
export const DEFAULT_STREAM_FIRST_OUTPUT_MS = 600_000;
/**
 * Budget for a gap BETWEEN reasoning deltas — the model is thinking, not
 * answering.
 *
 * Scaled to {@link DEFAULT_STREAM_FIRST_OUTPUT_MS} rather than to
 * {@link DEFAULT_STREAM_INACTIVITY_MS} because it answers the same question
 * that one does: has the provider begun ANSWERING yet? A reasoning delta is
 * evidence of work, not of an answer, so the pauses around it belong to the
 * wide budget.
 *
 * Measuring them against the tight window is what killed
 * `google/gemini-3.7-flash` at `reasoning.effort: 'high'` — both attempts of
 * one turn died on `lastPartType: 'reasoning-delta'` with the stream in
 * `phase: 'streaming'`, because the first reasoning token had already been
 * counted as "the provider started answering". It had not; it had started
 * thinking, which is exactly the state the wide window exists for.
 *
 * Finite, so a provider that reasons forever still cannot hold a turn open.
 */
export const DEFAULT_STREAM_REASONING_GAP_MS = 600_000;
/**
 * Absolute wall-clock budget for assembling ONE streamed tool-call input.
 *
 * DELIBERATELY decoupled from `DEFAULT_STREAM_INACTIVITY_MS` and much wider.
 * The two windows answer different questions: inactivity asks "is the transport
 * still delivering parts?", this one asks "will this call ever become
 * executable?". Reusing the inactivity window here killed legitimate large
 * argument payloads — a model writing tens of KB of file content streams
 * argument deltas continuously for minutes on a slow upstream route, which is
 * healthy progress, not a stalled call. The bound stays finite so a provider
 * still cannot dribble incomplete JSON forever.
 */
export const DEFAULT_TOOL_CALL_INPUT_MS = 600_000;
/**
 * How many provider ATTEMPTS one turn may spend before a stall becomes
 * terminal (BST-1409). `1` disables recovery — the pre-BST-1409 behavior.
 *
 * Deliberately small. A resume re-sends the whole prompt (~169k tokens in the
 * captured incident), so an unbounded budget would let a reliably-stalling
 * route bill the same turn repeatedly. Two attempts covers the transient gap a
 * healthy provider produces; a third would mostly buy cost.
 */
export const DEFAULT_STREAM_STALL_ATTEMPTS = 2;
/**
 * Advisory age after which a rediscovered suspended approval is flagged `stale`
 * in the re-surfaced notice (24h). Deliberately generous and DECOUPLED from the
 * in-flight stream/tool timeouts above: a human approval may legitimately take
 * hours after a restart. Advisory only — never auto-declines (see docs/agents/assistant-runtime.md
 * PERMISSION ENGINE). Strict-parsed: a malformed override THROWS, no silent fallback.
 */
export const DEFAULT_APPROVAL_STALE_MS = 86_400_000;

export interface AssistantResilienceConfig {
  streamFirstOutputMs: number;
  streamInactivityMs: number;
  /** Budget for a gap between reasoning deltas (the model is thinking). */
  streamReasoningGapMs: number;
  /** Provider attempts per turn; 1 means a stall is immediately terminal. */
  streamStallAttempts: number;
  toolCallInputMs: number;
  toolTimeoutMs: number;
}

function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) {
    return;
  }
  return process.env[name];
}

/**
 * Strict positive-integer parse with an explicit UNIT in the error text.
 *
 * The unit is a parameter rather than a hardcoded `(ms)` because
 * `BRAINSTRIKE_STREAM_STALL_ATTEMPTS` is a COUNT — reporting a bad attempt
 * budget as "must be a positive integer (ms)" is a strict-parse error that
 * lies about what it wants, on the one knob an operator is most likely to set
 * by hand (review of #2590).
 */
function resolvePositiveInt(
  envName: string,
  unit: string,
  defaultValue: number,
  override?: number
): number {
  if (typeof override === 'number') {
    if (!Number.isInteger(override) || override <= 0) {
      throw new Error(
        `${envName} override must be a positive integer (${unit}), received ${override}.`
      );
    }
    return override;
  }
  const raw = readEnv(envName);
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer (${unit}), received "${raw}".`);
  }
  return parsed;
}

function resolvePositiveIntMs(envName: string, defaultValue: number, override?: number): number {
  return resolvePositiveInt(envName, 'ms', defaultValue, override);
}

export function resolveToolTimeoutMs(override?: number): number {
  return resolvePositiveIntMs('BRAINSTRIKE_TOOL_TIMEOUT_MS', DEFAULT_TOOL_TIMEOUT_MS, override);
}

export function resolveStreamInactivityMs(override?: number): number {
  return resolvePositiveIntMs(
    'BRAINSTRIKE_STREAM_INACTIVITY_MS',
    DEFAULT_STREAM_INACTIVITY_MS,
    override
  );
}

export function resolveStreamFirstOutputMs(override?: number): number {
  return resolvePositiveIntMs(
    'BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS',
    DEFAULT_STREAM_FIRST_OUTPUT_MS,
    override
  );
}

export function resolveStreamReasoningGapMs(override?: number): number {
  return resolvePositiveIntMs(
    'BRAINSTRIKE_STREAM_REASONING_GAP_MS',
    DEFAULT_STREAM_REASONING_GAP_MS,
    override
  );
}

export function resolveStreamStallAttempts(override?: number): number {
  return resolvePositiveInt(
    'BRAINSTRIKE_STREAM_STALL_ATTEMPTS',
    'attempts',
    DEFAULT_STREAM_STALL_ATTEMPTS,
    override
  );
}

export function resolveToolCallInputMs(override?: number): number {
  return resolvePositiveIntMs(
    'BRAINSTRIKE_TOOL_CALL_INPUT_MS',
    DEFAULT_TOOL_CALL_INPUT_MS,
    override
  );
}

/** Whether a value was actually supplied, rather than falling back to a default. */
function hasExplicitValue(envName: string, override?: number): boolean {
  if (typeof override === 'number') {
    return true;
  }
  const raw = readEnv(envName);
  return raw !== undefined && raw.trim() !== '';
}

export function resolveApprovalStaleMs(override?: number): number {
  return resolvePositiveIntMs('BRAINSTRIKE_APPROVAL_STALE_MS', DEFAULT_APPROVAL_STALE_MS, override);
}

export function resolveAssistantResilienceConfig(options?: {
  streamFirstOutputMs?: number;
  streamInactivityMs?: number;
  streamReasoningGapMs?: number;
  streamStallAttempts?: number;
  toolCallInputMs?: number;
  toolTimeoutMs?: number;
}): AssistantResilienceConfig {
  const toolTimeoutMs = resolveToolTimeoutMs(options?.toolTimeoutMs);
  const streamInactivityMs = resolveStreamInactivityMs(options?.streamInactivityMs);
  // The FOUNDATIONAL ordering is checked before any derived window, so a config
  // that violates several invariants at once names the first thing to fix
  // rather than a consequence of it (review of #2586).
  if (toolTimeoutMs >= streamInactivityMs) {
    throw new Error(
      `BRAINSTRIKE_TOOL_TIMEOUT_MS must be less than BRAINSTRIKE_STREAM_INACTIVITY_MS; received ${toolTimeoutMs}ms and ${streamInactivityMs}ms.`
    );
  }
  const streamFirstOutputMs = resolveStreamFirstOutputWindow(streamInactivityMs, options);
  const streamReasoningGapMs = resolveStreamReasoningGapWindow(streamInactivityMs, options);
  const streamStallAttempts = resolveStreamStallAttempts(options?.streamStallAttempts);
  const resolvedToolCallInputMs = resolveToolCallInputMs(options?.toolCallInputMs);
  // A tighter input budget than the inactivity window would fire before the
  // inactivity watchdog could ever observe a genuine stall, turning healthy
  // in-progress argument streaming into a false timeout.
  //
  // Two EXPLICIT values in that shape are contradictory, so they throw. But an
  // unset input budget must not turn a long, deliberate inactivity window
  // (a slow local route) into a hard failure naming a variable the user never
  // set — the default simply resolves wide enough to satisfy the invariant.
  // That is default resolution, not a silent degradation: the widened value
  // still honours the documented rule, and nothing configured is overridden.
  if (hasExplicitValue('BRAINSTRIKE_TOOL_CALL_INPUT_MS', options?.toolCallInputMs)) {
    if (resolvedToolCallInputMs < streamInactivityMs) {
      throw new Error(
        `BRAINSTRIKE_TOOL_CALL_INPUT_MS must be at least BRAINSTRIKE_STREAM_INACTIVITY_MS; received ${resolvedToolCallInputMs}ms and ${streamInactivityMs}ms.`
      );
    }
    return {
      streamFirstOutputMs,
      streamInactivityMs,
      streamReasoningGapMs,
      streamStallAttempts,
      toolCallInputMs: resolvedToolCallInputMs,
      toolTimeoutMs,
    };
  }
  return {
    streamFirstOutputMs,
    streamInactivityMs,
    streamReasoningGapMs,
    streamStallAttempts,
    toolCallInputMs: Math.max(resolvedToolCallInputMs, streamInactivityMs),
    toolTimeoutMs,
  };
}

/**
 * The reasoning-gap window can never be TIGHTER than the inter-output one, for
 * the same reason the first-output window cannot: a pause while the model is
 * thinking is strictly less suspicious than a pause while it is answering, so
 * a narrower reasoning budget would fire on healthy thought and never let the
 * inactivity watchdog observe a real mid-answer stall.
 *
 * Resolution mirrors `BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS` exactly: two EXPLICIT
 * values in that shape are contradictory and throw, while an unset reasoning
 * window simply widens to satisfy the invariant rather than failing on a
 * variable the user never set.
 */
function resolveStreamReasoningGapWindow(
  streamInactivityMs: number,
  options?: { streamReasoningGapMs?: number }
): number {
  const resolved = resolveStreamReasoningGapMs(options?.streamReasoningGapMs);
  if (hasExplicitValue('BRAINSTRIKE_STREAM_REASONING_GAP_MS', options?.streamReasoningGapMs)) {
    if (resolved < streamInactivityMs) {
      throw new Error(
        `BRAINSTRIKE_STREAM_REASONING_GAP_MS must be at least BRAINSTRIKE_STREAM_INACTIVITY_MS; received ${resolved}ms and ${streamInactivityMs}ms.`
      );
    }
    return resolved;
  }
  return Math.max(resolved, streamInactivityMs);
}

/**
 * The first-output window can never be TIGHTER than the inter-output one:
 * waiting for a provider to start is strictly harder than waiting for it to
 * continue, so a narrower first window would fire before the inactivity
 * watchdog could ever observe a real mid-output stall.
 *
 * Resolution mirrors `BRAINSTRIKE_TOOL_CALL_INPUT_MS` exactly (BST-839): two
 * EXPLICIT values in that shape are contradictory and throw, while an unset
 * first-output window simply widens to satisfy the invariant rather than
 * failing on a variable the user never set. That is default resolution, not a
 * silent degradation — nothing configured is overridden.
 */
function resolveStreamFirstOutputWindow(
  streamInactivityMs: number,
  options?: { streamFirstOutputMs?: number }
): number {
  const resolved = resolveStreamFirstOutputMs(options?.streamFirstOutputMs);
  if (hasExplicitValue('BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS', options?.streamFirstOutputMs)) {
    if (resolved < streamInactivityMs) {
      throw new Error(
        `BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS must be at least BRAINSTRIKE_STREAM_INACTIVITY_MS; received ${resolved}ms and ${streamInactivityMs}ms.`
      );
    }
    return resolved;
  }
  return Math.max(resolved, streamInactivityMs);
}
