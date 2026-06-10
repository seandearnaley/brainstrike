import type { AgentColorKey } from './types';

export const AGENT_COLOR_KEYS: readonly AgentColorKey[] = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
];

/** Color reserved for the builtin Brainstrike participant (outside round-robin). */
export const BUILTIN_AGENT_COLOR: AgentColorKey = 'chart-5';

export function colorForIndex(index: number): AgentColorKey {
  const key = AGENT_COLOR_KEYS[index % AGENT_COLOR_KEYS.length];
  if (!key) {
    throw new Error('AGENT_COLOR_KEYS must not be empty');
  }
  return key;
}
