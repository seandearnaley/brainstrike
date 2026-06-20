import type { GlobalCommandHandlers } from '@brainstrike/commands';
import type { DbHandle } from '@brainstrike/db';
import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import { useTheme } from '@brainstrike/ui';
import { useCallback, useMemo } from 'react';
import {
  type AssistantThreadRepository,
  createPgliteAssistantThreadRepository,
} from './assistant-memory-repository';
import { WORKSPACE_MEMORY_RESOURCE_ID } from './assistant-memory-resource';
import { useAssistantThreadStore } from './assistant-thread-store';
import { useQuickOpenStore } from './stores/quick-open-store';

/**
 * Resolves the targetless global command handlers (new thread, settings, theme)
 * from app state the layout root already owns. Each is OPTIONAL: a handler we
 * cannot wire (e.g. the assistant memory DB is not ready) is simply absent,
 * which keeps its command HIDDEN — never a faked no-op (the no-silent-fallbacks
 * contract). `openQuickOpen` IS supplied here (PR-6.3): it opens the ⌘P
 * quick-open store, un-gating the `palette.quickOpen` global command.
 *
 * Shared by the ⌘K command palette host AND the composer's "/" slash menu so
 * both project the SAME global commands from one source of truth.
 */
export function useGlobalCommandHandlers(db: DbHandle | null): GlobalCommandHandlers {
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const { theme, setTheme } = useTheme();
  const createThread = useAssistantThreadStore((state) => state.createThread);
  const openQuickOpen = useQuickOpenStore((state) => state.open);

  const repository = useMemo<AssistantThreadRepository | null>(
    () => (db ? createPgliteAssistantThreadRepository(db) : null),
    [db]
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

  const openSettings = useCallback(() => {
    setActiveTab('settings');
  }, [setActiveTab]);

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
      openSettings,
      toggleTheme,
      // ⌘P quick-open is wired here in PR-6.3: opening the store flips the
      // QuickOpenHost's palette open. This un-gates the previously hidden
      // `palette.quickOpen` global command (it now has a real handler).
      openQuickOpen,
    }),
    [newThread, openSettings, toggleTheme, openQuickOpen]
  );
}
