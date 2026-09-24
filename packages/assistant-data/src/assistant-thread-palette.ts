/** Semantic thread colors shared by renderer metadata and the desktop child host. */
export const ASSISTANT_THREAD_COLOR_IDS = [
  'blue',
  'emerald',
  'amber',
  'rose',
  'violet',
  'slate',
  'cyan',
  'lime',
  'orange',
  'fuchsia',
  'indigo',
  'red',
  'teal',
  'green',
  'yellow',
  'pink',
  'purple',
  'zinc',
] as const;

export type AssistantThreadColorId = (typeof ASSISTANT_THREAD_COLOR_IDS)[number];

const COLOR_ID_SET = new Set<string>(ASSISTANT_THREAD_COLOR_IDS);

export function isAssistantThreadColorId(value: unknown): value is AssistantThreadColorId {
  return typeof value === 'string' && COLOR_ID_SET.has(value);
}
