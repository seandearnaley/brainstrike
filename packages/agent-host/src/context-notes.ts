import type { HostTool, HostToolState } from './ports.js';

/**
 * The notes the run's admitted tools contribute before a step, from the
 * thread's committed tool state, in tool order. Undefined when none applies.
 */
export function hostContextNotes(
  tools: Readonly<Record<string, HostTool>>,
  state: Pick<HostToolState, 'entries' | 'read'>
): string | undefined {
  const notes = Object.values(tools).flatMap((tool) => {
    const note = tool.contextNote?.(state);
    return note ? [note] : [];
  });
  return notes.length > 0 ? notes.join('\n\n') : undefined;
}
