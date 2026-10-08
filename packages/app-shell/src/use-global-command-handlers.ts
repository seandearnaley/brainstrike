import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  type AssistantThreadRepository,
  createPgliteAssistantThreadRepository,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import type { GlobalCommandHandlers } from '@brainstrike/context-actions/commands';
import type { DbHandle } from '@brainstrike/db/react';
import { useTheme } from '@brainstrike/ui';
import { useCallback, useMemo } from 'react';
import { useAssistantThreadHost, withAssistantThreadHost } from './assistant-thread-host-context';
import { useQuickOpenStore } from './stores/quick-open-store';
import { useConnectFolder } from './workspace-connect/use-connect-folder';

/**
 * Resolves the targetless global command handlers (new thread, folder picker,
 * quick open, settings, theme) from app state the layout root already owns.
 * Each is OPTIONAL: a handler we cannot wire (e.g. the assistant memory DB is
 * not ready) is simply absent, which keeps its command HIDDEN — never a faked
 * no-op (the no-silent-fallbacks contract). `openQuickOpen` IS supplied here
 * (PR-6.3): it opens the ⌘P quick-open store, un-gating the
 * `palette.quickOpen` global command.
 *
 * Shared by the ⌘K command palette host AND the composer's "/" slash menu so
 * both project the SAME global commands from one source of truth.
 *
 * INVARIANT (BST-1393): `openFolder`'s `useConnectFolder()` call means this
 * hook now requires a `FileSystemProvider` ancestor — `useFileSystem()`
 * throws without one. True today for both existing consumers
 * (`CommandPaletteHost` and the slash-menu's `useAssistantSlashCommands`,
 * both verified to render inside `AppLayout`'s `FileSystemProvider`), but is
 * NOT enforced by this hook's own signature. A future THIRD consumer mounted
 * above that provider would crash on render — check this before adding one.
 */
export function useGlobalCommandHandlers(db: DbHandle | null): GlobalCommandHandlers {
  const { openPicker } = useConnectFolder();
  const openSettings = usePanelLayoutStore((state) => state.openSettings);
  const { theme, setTheme } = useTheme();
  const createThread = useAssistantThreadStore((state) => state.createThread);
  const openQuickOpen = useQuickOpenStore((state) => state.open);

  // A new thread is created by the host's existing thread owner when the app
  // has one; with no host the history repository is unchanged.
  const host = useAssistantThreadHost();
  const repository = useMemo<AssistantThreadRepository | null>(
    () => (db ? withAssistantThreadHost(createPgliteAssistantThreadRepository(db), host) : null),
    [db, host]
  );

  // Bound only when the repository exists, so the closure captures a non-null
  // repository (no in-body null guard needed). When `db`/`repository` is null
  // this is null and the handler is omitted below.
  const newThread = useMemo<(() => Promise<void>) | null>(() => {
    if (!repository) {
      return null;
    }
    return async () => {
      await createThread(repository, WORKSPACE_MEMORY_RESOURCE_ID);
    };
  }, [repository, createThread]);

  const toggleTheme = useCallback(() => {
    // Resolve `system` toward its effective value, then flip — so a single
    // invocation always produces a visible change.
    const effective =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
    setTheme(effective === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return useMemo<GlobalCommandHandlers>(
    () => ({
      // When the assistant memory DB / repository is not ready, newThread is
      // null and is OMITTED here. createGlobalCommands' isAvailable
      // (`newThread !== undefined`) then HIDES `thread.new` — it is never a
      // faked no-op (the no-silent-fallbacks contract). Once the DB is ready a
      // re-render supplies the handler and the command appears.
      ...(newThread ? { newThread } : {}),
      // `openPicker` is itself gated on the FSA capability probe inside
      // useConnectFolder (BST-1393 review finding) — omitted, not a faked
      // no-op, on a browser without File System Access.
      ...(openPicker ? { openFolder: openPicker } : {}),
      // ⌘P quick-open is wired here in PR-6.3: opening the store flips the
      // QuickOpenHost's palette open. This un-gates the previously hidden
      // `palette.quickOpen` global command (it now has a real handler).
      openQuickOpen,
      openSettings,
      toggleTheme,
    }),
    [newThread, openPicker, openQuickOpen, openSettings, toggleTheme]
  );
}
