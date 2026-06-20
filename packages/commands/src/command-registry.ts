import type { Command, CommandContext, CommandRegistry } from './types';

/**
 * Mirrors context-actions `isUsable`: a command is available only when every
 * required capability is present in the context's capability set AND its
 * optional `isAvailable` predicate passes. A missing capability HIDES the
 * command (the registry simply omits it) — it is never surfaced disabled.
 */
function isAvailableInContext(command: Command, ctx: CommandContext): boolean {
  for (const capability of command.requiredCapabilities ?? []) {
    if (!ctx.capabilities.has(capability)) {
      return false;
    }
  }
  return command.isAvailable?.(ctx) ?? true;
}

/**
 * Builds an immutable command registry over a fixed command list. Ids must be
 * unique — a duplicate id is a wiring bug (two commands competing for the same
 * keybinding/identity), so it THROWS rather than silently keeping the last.
 */
export function createCommandRegistry(commands: readonly Command[]): CommandRegistry {
  const byId = new Map<string, Command>();
  for (const command of commands) {
    if (byId.has(command.id)) {
      throw new Error(`Duplicate command id registered: "${command.id}"`);
    }
    byId.set(command.id, command);
  }
  const all = [...commands];

  return {
    listAll: () => all,
    available: (ctx) => all.filter((command) => isAvailableInContext(command, ctx)),
    byId: (id) => byId.get(id),
  };
}
