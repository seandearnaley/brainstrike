import { SHELL_OUTPUT_DATA_NAME } from '@brainstrike/assistant-contract';

/** Accumulated live output for one running shell command. */
export interface ShellOutputAccumulation {
  /** stdout + stderr interleaved in emission order. */
  readonly text: string;
  /** True once the streaming cap was hit (further output was not streamed). */
  readonly truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Accumulate the transient `brainstrike.shell-output` data parts of a turn into
 * `toolCallId → { text, truncated }`. stdout and stderr are interleaved in the
 * order they streamed (matching what the user saw live). These parts are NEVER
 * persisted (see SHELL_OUTPUT_DATA_NAME), so on a reloaded thread this map is
 * empty and the tool card falls back to the persisted final result. Pure +
 * unit-tested.
 */
export function collectShellOutputs(
  parts: readonly unknown[]
): Record<string, ShellOutputAccumulation> {
  const byToolCall: Record<string, { text: string; truncated: boolean }> = {};

  for (const part of parts) {
    if (!(isRecord(part) && part['name'] === SHELL_OUTPUT_DATA_NAME)) {
      continue;
    }
    const data = part['data'];
    if (!isRecord(data)) {
      continue;
    }
    const toolCallId = data['toolCallId'];
    const chunk = data['chunk'];
    if (typeof toolCallId !== 'string' || typeof chunk !== 'string') {
      continue;
    }
    const existing = byToolCall[toolCallId] ?? { text: '', truncated: false };
    existing.text += chunk;
    if (data['truncated'] === true) {
      existing.truncated = true;
    }
    byToolCall[toolCallId] = existing;
  }

  return byToolCall;
}

/**
 * Incremental variant of {@link collectShellOutputs} for the streaming path,
 * where the message's parts array is append-only and re-derived per streamed
 * update. Only parts appended since the previous call are processed
 * (O(new parts) per update instead of O(all parts) — the full rebuild is
 * quadratic over a long-running command). Identity contract:
 *
 * - No new shell slices since the last call → the PREVIOUS record identity is
 *   returned, so context providers fed from it do not re-render consumers on
 *   unrelated text deltas.
 * - New slices for one tool → a new record, but entries for untouched tools
 *   keep their identity.
 * - A parts array SHORTER than what was already processed (fresh message in
 *   the same accumulator) resets and reprocesses from scratch.
 *
 * Correctness rests on the assistant-ui streaming contract: parts are
 * append-only and never reordered; already-emitted indexes may be REPLACED in
 * place (the growing text part is), but shell-output data parts are immutable
 * once emitted — so each index is scanned exactly once, and no identity check
 * on the prefix is possible (the mutating text part would fail it every
 * chunk). One accumulator serves ONE message: key it by message id at the
 * call site (a remount/useMemo boundary), do not share across messages.
 */
export function createShellOutputAccumulator(): (
  parts: readonly unknown[]
) => Record<string, ShellOutputAccumulation> {
  let processedCount = 0;
  let result: Record<string, ShellOutputAccumulation> = {};

  return (parts) => {
    if (parts.length < processedCount) {
      processedCount = 0;
      result = {};
    }

    let next: Record<string, { text: string; truncated: boolean }> | null = null;
    for (let index = processedCount; index < parts.length; index += 1) {
      const part = parts[index];
      if (!(isRecord(part) && part['name'] === SHELL_OUTPUT_DATA_NAME)) {
        continue;
      }
      const data = part['data'];
      if (!isRecord(data)) {
        continue;
      }
      const toolCallId = data['toolCallId'];
      const chunk = data['chunk'];
      if (typeof toolCallId !== 'string' || typeof chunk !== 'string') {
        continue;
      }
      next ??= { ...result };
      const existing = next[toolCallId] ?? { text: '', truncated: false };
      next[toolCallId] = {
        text: existing.text + chunk,
        truncated: existing.truncated || data['truncated'] === true,
      };
    }

    processedCount = parts.length;
    if (next !== null) {
      result = next;
    }
    return result;
  };
}
