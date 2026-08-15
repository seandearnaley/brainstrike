import { useHotkeys } from 'react-hotkeys-hook';
import { TERMINAL_APP_ID, type WorkspaceApp } from './workspace-app';
import { isDesktopRenderer } from './workspace-tab-utils';

/**
 * Cmd/Ctrl+T opens (or focuses) the Terminal workspace app (BST-1270).
 * Desktop-only — web must leave the browser's native new-tab shortcut
 * untouched (same platform split as Ctrl/Cmd+W in useWorkspaceTabHotkeys) —
 * and inert unless the Terminal app is REGISTERED, so the chord never dead-
 * ends on a renderer without the pty bridge. The platform check runs lazily
 * inside the handler so the answer reflects keystroke-time state.
 */
export function useTerminalHotkey(
  apps: readonly WorkspaceApp[],
  onOpenApp: (appId: string) => void
): void {
  const terminalRegistered = apps.some((app) => app.id === TERMINAL_APP_ID);
  useHotkeys(
    'mod+t',
    (event) => {
      if (!(isDesktopRenderer() && terminalRegistered)) {
        return;
      }
      event.preventDefault();
      onOpenApp(TERMINAL_APP_ID);
    },
    {},
    [terminalRegistered, onOpenApp]
  );
}
