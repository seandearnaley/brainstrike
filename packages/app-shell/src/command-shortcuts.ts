import type { ActionShortcut } from '@brainstrike/context-actions';
import { hasAppMenuSettings } from './hooks/use-app-menu-settings';
import { canClaimWindowChords } from './tab-chords/window-chord-capability';
import { resolveWorkspaceConnectBridge } from './workspace-connect/workspace-connect-bridge';

/**
 * The key bindings live in this window, by the palette command they run, so
 * the palette shows a shortcut only where pressing it works. Each binding is
 * gated on the capability that owns it: the tab chords (`match-tab-chord`),
 * the app menu's Settings… item and the File menu's Open Folder… item.
 * Resolve once: the preload bridges exist before React mounts.
 */
export function resolveCommandShortcuts(): ReadonlyMap<string, ActionShortcut> {
  const shortcuts = new Map<string, ActionShortcut>();
  // A browser keeps every tab chord, Ctrl+PageDown included, for its own tabs.
  if (canClaimWindowChords()) {
    shortcuts.set('tab.close', { key: 'W', modifiers: ['primary'] });
    shortcuts.set('tab.reopen-closed', { key: 'T', modifiers: ['primary', 'shift'] });
    // Ctrl on every platform, macOS included.
    shortcuts.set('tab.next', { key: 'Tab', modifiers: ['ctrl'] });
    shortcuts.set('tab.previous', { key: 'Tab', modifiers: ['ctrl', 'shift'] });
  }
  if (hasAppMenuSettings()) {
    shortcuts.set('nav.settings', { key: ',', modifiers: ['primary'] });
  }
  if (resolveWorkspaceConnectBridge()) {
    shortcuts.set('global.open-folder', { key: 'O', modifiers: ['primary'] });
  }
  return shortcuts;
}
