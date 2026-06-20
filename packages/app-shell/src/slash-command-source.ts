import type { Command, CommandContext, CommandRegistry } from '@brainstrike/commands';

/**
 * The capability-gated, danger-excluded command source for the composer's "/"
 * slash menu. Pure projection (no React, no UI imports) so the gating + danger
 * filter are unit-tested directly:
 *
 * - `registry.available(ctx)` already hides capability-absent commands (e.g.
 *   `fs.reveal`/`shell` on web), exactly as the ⌘K palette and the right-click
 *   menu do — there is no isElectron branch.
 * - We additionally drop the `danger` group so no destructive command runs from
 *   a one-keystroke "/" menu without a confirmation surface.
 */
export function selectSlashCommandSource(
  registry: CommandRegistry,
  context: CommandContext
): readonly Command[] {
  return registry.available(context).filter((command) => command.group !== 'danger');
}
