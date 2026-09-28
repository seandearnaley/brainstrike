import type { ContextTarget } from '@brainstrike/context-actions';
import {
  bridgeActionToCommand,
  type Command,
  type CommandCapability,
  type CommandContext,
  type CommandRegistry,
  createCommandRegistry,
  createGlobalCommands,
  createTabCommands,
  type GlobalCommandHandlers,
  type TabCommandStrip,
} from '@brainstrike/context-actions/commands';
import {
  type AppActionRegistryParts,
  buildAppActionRegistryParts,
} from './context-action-registry';

/**
 * The inputs the ⌘K command registry projects from. `parts` are the SAME
 * actions/capabilities/services the context-action registry uses (single source
 * of truth — built once via `buildAppActionRegistryParts`). `handlers` are the
 * app's targetless global handlers (new thread, settings, theme); an absent
 * handler keeps its command hidden, never a faked no-op. `target` is the surface
 * focused when the palette opened — snapshotted into every bridged command's
 * `run`, so the registry MUST be rebuilt whenever the open target changes.
 */
export interface AppCommandRegistryInput {
  /**
   * The ⌘K palette's focus-scoped tab strip (BST-1842). Present only for the
   * palette: a caller without it (the composer's "/" menu) gets no tab commands.
   */
  readonly getTabStrip?: () => TabCommandStrip | undefined;
  readonly handlers: GlobalCommandHandlers;
  readonly parts: AppActionRegistryParts;
  readonly target: ContextTarget | null;
}

/**
 * Composes the global commands and the bridged feature actions into one
 * immutable command registry for the captured open target. Bridged commands
 * snapshot the target eagerly (see `bridgeActionToCommand`), so this is called
 * fresh on every palette open — the target is current for the session it shows.
 *
 * Capability gating happens inside the registry's `available(ctx)`: a bridged
 * command that requires a capability absent from the context's set is hidden
 * (e.g. `fs.reveal` on web), exactly as the right-click menu hides it. There is
 * no isElectron branch — presence of the platform bridge is the only signal.
 */
export function createAppCommandRegistry({
  getTabStrip,
  parts,
  handlers,
  target,
}: AppCommandRegistryInput): CommandRegistry {
  const globals: Command[] = [
    ...createGlobalCommands(handlers),
    // Without a strip getter every tab command stays hidden (`isAvailable`).
    ...createTabCommands(getTabStrip ?? (() => undefined)),
  ];
  const bridged: Command[] = [];
  for (const action of parts.actions) {
    const command = bridgeActionToCommand(action, () => target);
    if (command) {
      bridged.push(command);
    }
  }
  return createCommandRegistry([...globals, ...bridged]);
}

/**
 * The execution context handed to a command's `run`. Reuses the SAME capability
 * set + services the context-action registry exposes; the captured target rides
 * along for targetless globals that ignore it and for any non-bridged command
 * that inspects it via `isAvailable`.
 */
export function buildAppCommandContext({
  parts,
  target,
}: {
  readonly parts: AppActionRegistryParts;
  readonly target: ContextTarget | null;
}): CommandContext {
  return {
    // CapabilityKey ⊆ CommandCapability, so the context-actions set widens cleanly.
    capabilities: parts.capabilities as ReadonlySet<CommandCapability>,
    services: parts.services,
    ...(target ? { target } : {}),
  };
}

export { buildAppActionRegistryParts };
