import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  type AssistantThreadCatalogRepository,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import type { GlobalCommandHandlers } from '@brainstrike/context-actions/commands';
import { useTheme } from '@brainstrike/ui';
import { useCallback, useMemo } from 'react';
import {
  createHostAssistantThreadRepository,
  useAssistantThreadHost,
} from './assistant-thread-host-context';
import { useConnectFolder } from './workspace-connect/use-connect-folder';

/**
 * Resolves the targetless global command handlers (new thread, folder picker,
 * settings, theme) from app state the layout root already owns.
 * Each is OPTIONAL: a handler we cannot wire (e.g. no agent host is attached)
 * is simply absent, which keeps its command HIDDEN — never a faked
 * no-op (the no-silent-fallbacks contract).
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
export function useGlobalCommandHandlers(): GlobalCommandHandlers {
  const { openPicker } = useConnectFolder();
  const openSettings = usePanelLayoutStore((state) => state.openSettings);
  const { theme, setTheme } = useTheme();
  const createThread = useAssistantThreadStore((state) => state.createThread);

  // A new thread is created by the host's thread owner.
  const host = useAssistantThreadHost();
  const repository = useMemo<AssistantThreadCatalogRepository | null>(
    () => (host ? createHostAssistantThreadRepository(host) : null),
    [host]
  );

  // Bound only when the repository exists, so the closure captures a non-null
  // repository (no in-body null guard needed). When there is no host
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
      // When there is no host repository, newThread is null and is OMITTED
      // here. createGlobalCommands' isAvailable (`newThread !== undefined`)
      // then HIDES `thread.new` — it is never a faked no-op (the
      // no-silent-fallbacks contract).
      ...(newThread ? { newThread } : {}),
      // `openPicker` is itself gated on the FSA capability probe inside
      // useConnectFolder (BST-1393 review finding) — omitted, not a faked
      // no-op, on a browser without File System Access.
      ...(openPicker ? { openFolder: openPicker } : {}),
      openSettings,
      toggleTheme,
    }),
    [newThread, openPicker, openSettings, toggleTheme]
  );
}
