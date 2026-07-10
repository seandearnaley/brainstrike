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
