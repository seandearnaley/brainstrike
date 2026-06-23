import type { Command, CommandContext } from '@brainstrike/commands';
import { useBrainstrikeDbClient } from '@brainstrike/db';
import { useToast } from '@brainstrike/ui';
import type { SlashCommand } from '@brainstrike/ui/assistant-ui-panel';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useMemo } from 'react';
import {
  buildAppActionRegistryParts,
  buildAppCommandContext,
  createAppCommandRegistry,
} from './command-registry';
import { runSlashCommand, selectSlashCommandSource } from './slash-command-source';
import { useGlobalCommandHandlers } from './use-global-command-handlers';

const logger = createLogger('AssistantSlashCommands');

/**
 * Projects the app's command registry into the composer's "/" slash menu. The
 * commands derive from the SAME `createAppCommandRegistry` seam the ⌘K palette
 * uses (single source of truth — never rebuilt here), so:
 *
 * - Capability gating is automatic: `registry.available(ctx)` hides desktop-only
 *   commands (e.g. `fs.reveal`/`shell`) on web, exactly as the palette and the
 *   right-click menu do. There is NO isElectron branch.
 * - The danger group is excluded inline — no destructive command runs from a
 *   one-keystroke "/" menu without a confirmation surface.
 *
 * The composer is presentational, so it never sees the registry/context: each
 * command's `execute` is pre-bound here to `command.run(ctx)`, and a failing
 * `ActionOutcome` ({ ok: false }) — or a thrown run — surfaces a toast + log
 * (the same no-silent-fallbacks handling as the palette). Slash commands are
 * targetless (the composer has no captured right-click target), so the registry
 * is built with `target: null` and only globals + targetless feature commands
 * appear.
 */
export function useAssistantSlashCommands(): readonly SlashCommand[] {
  const db = useBrainstrikeDbClient();
  const { toast } = useToast();
  const handlers = useGlobalCommandHandlers(db);

  // Stable for the window's lifetime (capability detection reads preload bridges
  // that exist before React mounts) — build once, single source of truth.
  const parts = useMemo(() => buildAppActionRegistryParts(), []);

  // Targetless: the composer captures no right-click target.
  const registry = useMemo(
    () => createAppCommandRegistry({ parts, handlers, target: null }),
    [parts, handlers]
  );
  const context = useMemo<CommandContext>(
    () => buildAppCommandContext({ parts, target: null }),
    [parts]
  );

  // Capability-gated + danger-excluded list, computed during render.
  const availableCommands = useMemo(
    () => selectSlashCommandSource(registry, context),
    [registry, context]
  );

  const runCommand = useCallback(
    (command: Command): Promise<void> => runSlashCommand(command, context, { toast, logger }),
    [context, toast]
  );

  // Map to the presentational SlashCommand shape, pre-binding execute. Derived
  // during render — no setState-in-effect.
  return useMemo<readonly SlashCommand[]>(
    () =>
      availableCommands.map((command) => ({
        id: command.id,
        label: command.label,
        ...(command.icon ? { icon: command.icon } : {}),
        execute: () => {
          void runCommand(command);
        },
      })),
    [availableCommands, runCommand]
  );
}
