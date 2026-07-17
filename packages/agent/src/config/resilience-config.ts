// packages/agent/src/config/resilience-config.ts
/**
 * Strict, no-silent-fallback configuration for assistant resilience timeouts.
 *
 * A *present but malformed* env value throws (typos must not silently coerce);
 * an *absent* value uses the documented default. An explicit override argument
 * always wins, mirroring how `mcpTimeoutMs` is threaded through the runtime.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const DEFAULT_STREAM_INACTIVITY_MS = 120_000;
/**
 * Advisory age after which a rediscovered suspended approval is flagged `stale`
 * in the re-surfaced notice (24h). Deliberately generous and DECOUPLED from the
 * in-flight stream/tool timeouts above: a human approval may legitimately take
 * hours after a restart. Advisory only — never auto-declines (see docs/agents/assistant-runtime.md
 * PERMISSION ENGINE). Strict-parsed: a malformed override THROWS, no silent fallback.
 */
export const DEFAULT_APPROVAL_STALE_MS = 86_400_000;

export interface AssistantResilienceConfig {
  streamInactivityMs: number;
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

export function resolveApprovalStaleMs(override?: number): number {
  return resolvePositiveIntMs('BRAINSTRIKE_APPROVAL_STALE_MS', DEFAULT_APPROVAL_STALE_MS, override);
}

export function resolveAssistantResilienceConfig(options?: {
  streamInactivityMs?: number;
  toolTimeoutMs?: number;
}): AssistantResilienceConfig {
  const toolTimeoutMs = resolveToolTimeoutMs(options?.toolTimeoutMs);
  const streamInactivityMs = resolveStreamInactivityMs(options?.streamInactivityMs);
  if (toolTimeoutMs >= streamInactivityMs) {
    throw new Error(
      `BRAINSTRIKE_TOOL_TIMEOUT_MS must be less than BRAINSTRIKE_STREAM_INACTIVITY_MS; received ${toolTimeoutMs}ms and ${streamInactivityMs}ms.`
    );
  }
  return { streamInactivityMs, toolTimeoutMs };
}
