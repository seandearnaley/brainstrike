import type { Command, CommandContext, CommandRegistry } from '@brainstrike/commands';
import type { ScopedLogger } from '@brainstrike/utils/logger';

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

/**
 * Narrow destructive-toast callback shape — kept UI-free so this module (and its
 * test) never drags `@brainstrike/ui`. The app passes the real `useToast` toast.
 */
export type SlashCommandFailureToast = (input: {
  variant: 'destructive';
  title: string;
  description: string;
}) => void;

/**
 * Runs a slash command and surfaces its failure — the no-silent-fallbacks seam.
 * Pure (no React) so the failure path is unit-tested directly. A `{ ok: false }`
 * outcome OR a thrown/rejected `run` both surface a destructive toast + a
 * `logger.error`; the failure is never swallowed. A successful run is silent.
 */
export async function runSlashCommand(
  command: Command,
  context: CommandContext,
  deps: { readonly toast: SlashCommandFailureToast; readonly logger: ScopedLogger }
): Promise<void> {
  let outcome: { ok: boolean; error?: string };
  try {
    outcome = await command.run(context);
  } catch (error) {
    outcome = {
      error: error instanceof Error ? error.message : 'Command failed unexpectedly',
      ok: false,
    };
  }
  if (outcome.ok) {
    return;
  }
  const description = outcome.error ?? `"${command.label}" could not be completed.`;
  deps.logger.error('Slash command failed', { description, id: command.id });
  deps.toast({ description, title: 'Command failed', variant: 'destructive' });
}
