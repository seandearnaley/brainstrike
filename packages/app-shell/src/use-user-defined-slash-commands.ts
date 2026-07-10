import {
  expandUserCommandTemplate,
  extractUserCommandArgString,
  type UserSlashCommandDescriptor,
  type UserSlashCommandRoot,
  type UserSlashCommandsListResult,
} from '@brainstrike/assistant-contract';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import type { SlashCommand } from '@brainstrike/ui/assistant-ui-panel';
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';

const logger = createLogger('UserSlashCommands');

const EMPTY_RESULT: UserSlashCommandsListResult = { commands: [], roots: [] };

type UserCommandsBridge = () => Promise<UserSlashCommandsListResult>;

/**
 * Resolve the desktop discovery bridge, or `null` on web (no preload). Capability
 * gating by bridge presence — never `isElectron()`. A present-but-malformed
 * bridge is a wiring bug: log loudly rather than silently degrade.
 */
function resolveUserCommandsBridge(): UserCommandsBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = window.userCommands;
  if (!bridge) {
    return null;
  }
  if (typeof bridge.list !== 'function') {
    logger.error('window.userCommands bridge is malformed; slash commands disabled', {
      hasList: typeof bridge.list,
    });
    return null;
  }
  return bridge.list;
}

/**
 * Resolve which root a command's `@path` template tokens bind to:
 * - a root-scoped command binds to its own `sourceRootId`;
 * - a global command binds to the single mounted root when there is exactly one;
 * - a global command in a multi-root (or no-root) workspace has no unambiguous
 *   root, so it returns `undefined` — the template `@path` stays literal text the
 *   user can fix with the `@` popover (NO silent guessing).
 */
function resolveMentionRootId(
  command: UserSlashCommandDescriptor,
  roots: readonly UserSlashCommandRoot[]
): string | undefined {
  if (command.sourceRootId) {
    return command.sourceRootId;
  }
  return roots.length === 1 ? roots[0]?.id : undefined;
}

/**
 * Expand a selected user command against the LIVE composer text and WRITE the
 * expansion back into the composer (never auto-send). The live draft is the
 * app-shell mirror of assistant-ui's authoritative composer state (recorded via
 * `onComposerTextChange` → `recordDraft`), so reading it here is the documented
 * "Commands with Arguments" pattern: `execute` runs before the trigger text is
 * removed, so the typed args are still present.
 */
function applyUserCommand(
  command: UserSlashCommandDescriptor,
  roots: readonly UserSlashCommandRoot[],
  threadId: string | undefined
): void {
  if (!threadId) {
    logger.warn('Cannot apply slash command without an active thread', { id: command.id });
    return;
  }
  const store = useAssistantComposerCommandStore.getState();
  const draftText = store.draftTextByThreadId[threadId] ?? '';
  const argString = extractUserCommandArgString(draftText, command.id) ?? '';
  const expansion = expandUserCommandTemplate({
    argString,
    mentionRootId: resolveMentionRootId(command, roots),
    template: command.template,
  });
  if (expansion.trim().length === 0) {
    logger.warn('Slash command expanded to empty text; nothing written', { id: command.id });
    return;
  }
  store.enqueue({ mode: 'replace', text: expansion, threadId });
}

/**
 * User-defined prompt-template slash commands for the composer's "/" menu.
 *
 * Desktop-only by construction: on web `window.userCommands` is absent and this
 * returns an empty list (no `isElectron()` branch). The list is loaded from the
 * discovery IPC and re-loaded when the mounted roots change (so a newly-added
 * root's commands appear without a reload). Each entry's `execute` expands the
 * template into the composer — see {@link applyUserCommand}.
 */
export function useUserDefinedSlashCommands(threadId: string | undefined): readonly SlashCommand[] {
  const bridge = useMemo(resolveUserCommandsBridge, []);
  // Subscribe to the mounted roots ONLY as a refresh trigger.
  const activeRootIds = useFileExplorerStoreSelector((state) => state.activeRootIds);
  const [list, setList] = useState<UserSlashCommandsListResult>(EMPTY_RESULT);

  // Keep the latest threadId in a ref so `execute` reads the current thread at
  // call time without rebuilding every command closure on each thread switch.
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let cancelled = false;
    bridge()
      .then((result) => {
        if (!cancelled) {
          setList(result);
        }
      })
      .catch((error: unknown) => {
        logger.error('Failed to load user-defined slash commands', { error });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, activeRootIds]);

  return useMemo<readonly SlashCommand[]>(
    () =>
      list.commands.map((command) => ({
        execute: () => {
          applyUserCommand(command, list.roots, threadIdRef.current);
        },
        id: command.id,
        label: command.label,
      })),
    [list]
  );
}
