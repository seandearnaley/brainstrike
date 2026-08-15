import { useCallback } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import type { FileTab } from '../hooks/use-tab-manager';
import type { WorkspaceTabSelection } from '../stores/workspace-tab-selection-store';
import { isDesktopRenderer } from './workspace-tab-utils';

interface WorkspaceTabHotkeyHandlers {
  readonly onCloseApp: (appId: string) => void;
  readonly onCloseFileTab: (tabId: string) => void;
  readonly onSelectFileTab: (tabId: string) => void | Promise<void>;
}

/**
 * Workspace tab keyboard chords (BST-1258 extraction from the provider).
 *
 * Electron gets VS Code-style Ctrl/Cmd+W for closing the active tab — a file
 * tab OR (now that app tabs are closable) an app tab. Web intentionally leaves
 * the browser's native close-tab shortcut untouched. Ctrl/Cmd+PageUp/PageDown
 * cycle file tabs. Deps arrays (4th arg) are required by react-hotkeys-hook v5
 * to avoid stale closures; the platform check runs lazily inside the handler
 * so the answer reflects the actual state at keystroke time.
 */
export function useWorkspaceTabHotkeys(
  selection: WorkspaceTabSelection,
  tabs: readonly FileTab[],
  { onCloseApp, onCloseFileTab, onSelectFileTab }: WorkspaceTabHotkeyHandlers
): void {
  useHotkeys(
    'ctrl+w, cmd+w',
    (e) => {
      // Web: native Ctrl/Cmd+W closes the browser tab; do not intercept.
      if (!isDesktopRenderer()) {
        return;
      }
      if (selection.kind === 'file') {
        e.preventDefault();
        onCloseFileTab(selection.tabId);
        return;
      }
      if (selection.kind === 'app') {
        e.preventDefault();
        onCloseApp(selection.appId);
      }
      // Empty selection: intentional fall-through — the host (Electron's window
      // accelerator) keeps owning Ctrl/Cmd+W, matching VS Code's behavior of
      // closing the window once no editors remain.
    },
    {}, // no options; the deps array is the 4th arg (v5 signature is keys, cb, options?, deps?)
    [selection, onCloseFileTab, onCloseApp]
  );

  const cycleFileTab = useCallback(
    (direction: 'next' | 'prev') => {
      if (tabs.length < 2 || selection.kind !== 'file') {
        return;
      }
      const currentIndex = tabs.findIndex((t) => t.id === selection.tabId);
      if (currentIndex === -1) {
        return;
      }
      const nextIndex =
        direction === 'next'
          ? (currentIndex + 1) % tabs.length
          : (currentIndex - 1 + tabs.length) % tabs.length;
      const next = tabs[nextIndex];
      if (next) {
        void onSelectFileTab(next.id);
      }
    },
    [tabs, selection, onSelectFileTab]
  );
  useHotkeys(
    'ctrl+pageup, cmd+pageup',
    (e) => {
      e.preventDefault();
      cycleFileTab('prev');
    },
    {},
    [cycleFileTab]
  );
  useHotkeys(
    'ctrl+pagedown, cmd+pagedown',
    (e) => {
      e.preventDefault();
      cycleFileTab('next');
    },
    {},
    [cycleFileTab]
  );
}
