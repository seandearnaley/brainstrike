import type { Command, CommandContext } from '@brainstrike/commands';
import { usePGliteDatabase } from '@brainstrike/db';
import { useToast } from '@brainstrike/ui';
import type { SlashCommand } from '@brainstrike/ui/assistant-ui-panel';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useMemo, useRef } from 'react';
import {
  buildAppActionRegistryParts,
  buildAppCommandContext,
  createAppCommandRegistry,
} from './command-registry';
import {
  mergeSlashCommands,
  runSlashCommand,
  selectSlashCommandSource,
} from './slash-command-source';
import { useGlobalCommandHandlers } from './use-global-command-handlers';
import { useSkillSlashCommands } from './use-skill-slash-commands';
import { useUserDefinedSlashCommands } from './use-user-defined-slash-commands';

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
 *
 * Concatenated with `useUserDefinedSlashCommands` (desktop-only prompt-template
 * commands scanned from `.brainstrike/commands` / `.claude/commands`): app
 * commands first (run-and-toast), then user commands (expand-into-composer).
 * `threadId` is the active assistant thread, threaded to user commands so their
 * `execute` can read the live composer draft and write the expansion back.
 */
export function useAssistantSlashCommands(threadId: string | undefined): readonly SlashCommand[] {
  const db = usePGliteDatabase();
  const { toast } = useToast();
  const handlers = useGlobalCommandHandlers(db);

  // Stable for the window's lifetime (capability detection reads preload bridges
  // that exist before React mounts) — build once, single source of truth.
  const parts = useMemo(() => buildAppActionRegistryParts(), []);

  // Targetless: the composer captures no right-click target.
  const registry = useMemo(
    () => createAppCommandRegistry({ handlers, parts, target: null }),
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
    (command: Command): Promise<void> => runSlashCommand(command, context, { logger, toast }),
    [context, toast]
  );

  // Map to the presentational SlashCommand shape, pre-binding execute. Derived
  // during render — no setState-in-effect.
  const appCommands = useMemo<readonly SlashCommand[]>(
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

  const userCommands = useUserDefinedSlashCommands(threadId);
  // User-invocable Agent Skills (desktop-only): a third entry kind whose
  // execute stages a `:skill[name]` directive into the composer. Namespaced
  // `skill:<name>` ids make app/user collisions impossible in practice, but the
  // same warn-once drop applies on principle.
  const skillCommands = useSkillSlashCommands(threadId);

  // App-lifetime warn-once set for app-vs-user/skill id collisions (F4).
  const warnedCollisionIds = useRef<Set<string>>(new Set());

  return useMemo<readonly SlashCommand[]>(() => {
    const withUserCommands = mergeSlashCommands(appCommands, userCommands, {
      logger,
      warnedCollisionIds: warnedCollisionIds.current,
    });
    return mergeSlashCommands(withUserCommands, skillCommands, {
      logger,
      warnedCollisionIds: warnedCollisionIds.current,
    });
  }, [appCommands, skillCommands, userCommands]);
}
