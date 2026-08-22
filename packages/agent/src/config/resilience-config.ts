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
 * Tolerated gap BETWEEN stream parts, once the provider has started emitting.
 *
 * Scoped to inter-part gaps only since BST-1408. Time-to-first-part is a
 * different question and gets {@link DEFAULT_STREAM_FIRST_PART_MS}.
 */
export const DEFAULT_STREAM_INACTIVITY_MS = 120_000;
/**
 * Budget from stream start until the FIRST part arrives.
 *
 * DELIBERATELY decoupled from `DEFAULT_STREAM_INACTIVITY_MS` and much wider,
 * for the same reason `DEFAULT_TOOL_CALL_INPUT_MS` is (BST-839): the two
 * windows answer different questions. Inactivity asks "is the transport still
 * delivering parts?"; this one asks "has the provider started answering yet?".
 *
 * Sharing one number killed a healthy 18-minute turn (BST-1408): a cold
 * request carrying ~169k prompt tokens at `reasoning.effort: 'max'` can spend
 * minutes producing nothing observable, which is indistinguishable from a
 * wedged transport at the stream-part layer. The bound stays finite so a
 * provider that never answers still cannot hold a turn open forever.
 */
export const DEFAULT_STREAM_FIRST_PART_MS = 600_000;
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
 * Advisory age after which a rediscovered suspended approval is flagged `stale`
 * in the re-surfaced notice (24h). Deliberately generous and DECOUPLED from the
 * in-flight stream/tool timeouts above: a human approval may legitimately take
 * hours after a restart. Advisory only — never auto-declines (see docs/agents/assistant-runtime.md
 * PERMISSION ENGINE). Strict-parsed: a malformed override THROWS, no silent fallback.
 */
export const DEFAULT_APPROVAL_STALE_MS = 86_400_000;

export interface AssistantResilienceConfig {
  streamFirstPartMs: number;
  streamInactivityMs: number;
  toolCallInputMs: number;
  toolTimeoutMs: number;
}

function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) {
    return;
  }
  return process.env[name];
}

function resolvePositiveIntMs(envName: string, defaultValue: number, override?: number): number {
  if (typeof override === 'number') {
    if (!Number.isInteger(override) || override <= 0) {
      throw new Error(`${envName} override must be a positive integer (ms), received ${override}.`);
    }
    return override;
  }
  const raw = readEnv(envName);
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer (ms), received "${raw}".`);
  }
  return parsed;
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

export function resolveStreamFirstPartMs(override?: number): number {
  return resolvePositiveIntMs(
    'BRAINSTRIKE_STREAM_FIRST_PART_MS',
    DEFAULT_STREAM_FIRST_PART_MS,
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
  streamFirstPartMs?: number;
  streamInactivityMs?: number;
  toolCallInputMs?: number;
  toolTimeoutMs?: number;
}): AssistantResilienceConfig {
  const toolTimeoutMs = resolveToolTimeoutMs(options?.toolTimeoutMs);
  const streamInactivityMs = resolveStreamInactivityMs(options?.streamInactivityMs);
  const streamFirstPartMs = resolveStreamFirstPartWindow(streamInactivityMs, options);
  const resolvedToolCallInputMs = resolveToolCallInputMs(options?.toolCallInputMs);
  if (toolTimeoutMs >= streamInactivityMs) {
    throw new Error(
      `BRAINSTRIKE_TOOL_TIMEOUT_MS must be less than BRAINSTRIKE_STREAM_INACTIVITY_MS; received ${toolTimeoutMs}ms and ${streamInactivityMs}ms.`
    );
  }
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
      streamFirstPartMs,
      streamInactivityMs,
      toolCallInputMs: resolvedToolCallInputMs,
      toolTimeoutMs,
    };
  }
  return {
    streamFirstPartMs,
    streamInactivityMs,
    toolCallInputMs: Math.max(resolvedToolCallInputMs, streamInactivityMs),
    toolTimeoutMs,
  };
}

/**
 * The first-part window can never be TIGHTER than the inter-part one: waiting
 * for a provider to start is strictly harder than waiting for it to continue,
 * so a narrower first window would fire before the inactivity watchdog could
 * ever observe a real mid-stream stall.
 *
 * Resolution mirrors `BRAINSTRIKE_TOOL_CALL_INPUT_MS` exactly (BST-839): two
 * EXPLICIT values in that shape are contradictory and throw, while an unset
 * first-part window simply widens to satisfy the invariant rather than failing
 * on a variable the user never set. That is default resolution, not a silent
 * degradation — nothing configured is overridden.
 */
function resolveStreamFirstPartWindow(
  streamInactivityMs: number,
  options?: { streamFirstPartMs?: number }
): number {
  const resolved = resolveStreamFirstPartMs(options?.streamFirstPartMs);
  if (hasExplicitValue('BRAINSTRIKE_STREAM_FIRST_PART_MS', options?.streamFirstPartMs)) {
    if (resolved < streamInactivityMs) {
      throw new Error(
        `BRAINSTRIKE_STREAM_FIRST_PART_MS must be at least BRAINSTRIKE_STREAM_INACTIVITY_MS; received ${resolved}ms and ${streamInactivityMs}ms.`
      );
    }
    return resolved;
  }
  return Math.max(resolved, streamInactivityMs);
}
