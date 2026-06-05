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
