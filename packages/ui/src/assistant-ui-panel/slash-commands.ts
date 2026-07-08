import type { Unstable_UseSlashCommandAdapterOptions } from '@assistant-ui/react';
import type { ComponentType } from 'react';

/**
 * An app command projected into the composer's "/" slash menu. The composer is
 * presentational (`packages/ui`), so it never builds the app command registry —
 * the available commands are PASSED IN as a prop (mirroring how the ⌘K palette
 * receives its already-resolved `commands`). The app (app-shell) derives these
 * from `createAppCommandRegistry().available(ctx)` (capability-gated, danger
 * group excluded) and pre-binds `execute` to the command's `run(ctx)` so the
 * panel just invokes `execute()` and the app surfaces the `ActionOutcome`.
 */
export interface SlashCommand {
  /** Pre-bound action: runs the command and surfaces its outcome (toast+log on failure). */
  readonly execute: () => void;
  /** Optional leading icon rendered in the popover item. */
  readonly icon?: ComponentType<{ className?: string }> | undefined;
  /** Namespaced, stable command id (e.g. 'thread.new'); used as the library item id. */
  readonly id: string;
  /** Display label shown in the popover (e.g. 'New thread'). */
  readonly label: string;
}

/**
 * Maps the app's passed slash commands to the library's
 * `unstable_useSlashCommandAdapter` command shape. The library keys items by
 * `id` (renamed from `name` in @assistant-ui/react 0.12.26) and renders a
 * `/${id}` fallback label when none is provided — we always pass the human
 * label. `icon` is intentionally omitted here: the library's `icon` is a
 * string identifier, but our popover renders the React icon component itself
 * (resolved by `id`), so the icon stays with the `SlashCommand` and never
 * round-trips through the adapter.
 *
 * `removeOnExecute: true` matches the pre-0.12.26 `Unstable_SlashCommandRoot`
 * behavior exactly (its docs: "the /command text is removed from the
 * composer"). The new hook defaults `removeOnExecute` to `false` (it now
 * favors leaving a directive chip behind as an audit trail), which would be a
 * silent behavior regression for our app-command triggers if left unset.
 */
export function toSlashCommandAdapterOptions(
  commands: readonly SlashCommand[]
): Unstable_UseSlashCommandAdapterOptions {
  return {
    commands: commands.map((command) => ({
      execute: command.execute,
      id: command.id,
      label: command.label,
    })),
    removeOnExecute: true,
  };
}

/**
 * Builds a stable `id → icon component` lookup for the popover item renderer.
 * Commands without an icon are omitted, so a lookup miss is a plain
 * (icon-less) item rather than a render of `undefined`.
 */
export function buildSlashCommandIconMap(
  commands: readonly SlashCommand[]
): ReadonlyMap<string, ComponentType<{ className?: string }>> {
  const map = new Map<string, ComponentType<{ className?: string }>>();
  for (const command of commands) {
    if (command.icon) {
      map.set(command.id, command.icon);
    }
  }
  return map;
}
