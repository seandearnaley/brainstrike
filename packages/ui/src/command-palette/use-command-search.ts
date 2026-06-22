import type { Command } from '@brainstrike/commands';

/**
 * Case-insensitive substring matcher over a command's label and keywords. MVP
 * (no fuzzy dependency — mirrors the model-picker's `filterModels`). A blank
 * query matches everything; otherwise EVERY whitespace-delimited token in the
 * query must appear (as a substring) in the command's label or one of its
 * keywords. This is pure and synchronous so the palette can derive its filtered
 * list during render with no effect/setState round-trip.
 */
export function filterCommands(commands: readonly Command[], query: string): readonly Command[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return commands;
  }
  const tokens = trimmed.split(/\s+/);
  return commands.filter((command) => {
    const haystack = [command.label, ...(command.keywords ?? [])].join(' ').toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}
