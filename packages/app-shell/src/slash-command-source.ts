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
 * Concatenate app commands with user-defined commands, dropping any user command
 * whose id COLLIDES with an app command (F4). The pinned adapter's `onExecute`
 * is find-FIRST, so a listed user row sharing an app id (e.g. a repo file
 * `thread.new.md` → id `thread.new`) would execute the APP command from the
 * user's own row — a mislead, plus duplicate React keys. App commands win; the
 * colliding user command is filtered out (never merely shadowed) with a
 * warn-once (the `warnedCollisionIds` set is caller-owned for app-lifetime
 * dedupe + test isolation). Generic over `{ id }` so it stays UI-free.
 */
export function mergeSlashCommands<T extends { readonly id: string }>(
  appCommands: readonly T[],
  userCommands: readonly T[],
  deps: { readonly logger: ScopedLogger; readonly warnedCollisionIds: Set<string> }
): readonly T[] {
  const appIds = new Set(appCommands.map((command) => command.id));
  const filteredUserCommands = userCommands.filter((command) => {
    if (!appIds.has(command.id)) {
      return true;
    }
    if (!deps.warnedCollisionIds.has(command.id)) {
      deps.warnedCollisionIds.add(command.id);
      deps.logger.warn(
        'User slash command id collides with a built-in app command; keeping the app command',
        { id: command.id }
      );
    }
    return false;
  });
  return [...appCommands, ...filteredUserCommands];
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
