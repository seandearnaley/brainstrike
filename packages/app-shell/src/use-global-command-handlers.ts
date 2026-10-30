import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import type { GlobalCommandHandlers } from '@brainstrike/context-actions/commands';
import { useTheme } from '@brainstrike/ui';
import { useCallback, useMemo } from 'react';
import { useAssistantThreadHost } from './assistant-thread-host-context';
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
  const { mode, setMode } = useTheme();
  const startNewThread = useAssistantThreadStore((state) => state.startNewThread);

  // New Thread opens the new-thread screen; the host's thread owner creates
  // the thread on its first send. Without a host this is null and the
  // handler is omitted below.
  const host = useAssistantThreadHost();
  const newThread = useMemo<(() => void) | null>(
    () => (host ? () => startNewThread(WORKSPACE_MEMORY_RESOURCE_ID) : null),
    [host, startNewThread]
  );

  const toggleTheme = useCallback(() => {
    // Resolve `system` toward its effective value, then flip — so a single
    // invocation always produces a visible change.
    const effective =
      mode === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : mode;
    setMode(effective === 'dark' ? 'light' : 'dark');
  }, [mode, setMode]);

  return useMemo<GlobalCommandHandlers>(
    () => ({
      // When there is no thread host, newThread is null and is OMITTED
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
