import type { ActionShortcut } from '@brainstrike/context-actions';
import { isMacPlatform } from '../command-palette/platform-accelerator';

/**
 * Platform-aware shortcut chip text (⌘P / Ctrl+P). Extracted from
 * ActionContextMenu (BST-1270) so menu surfaces outside the context-menu
 * system (e.g. the workspace "+" add-tab menu) render identical chips.
 */
export function formatShortcut(shortcut: ActionShortcut): string {
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  if (isMacPlatform()) {
    const modifiers = shortcut.modifiers.map((modifier) => {
      if (modifier === 'primary') {
        return '⌘';
      }
      if (modifier === 'ctrl') {
        return '⌃';
      }
      if (modifier === 'shift') {
        return '⇧';
      }
      return '⌥';
    });
    return `${modifiers.join('')}${key}`;
  }
  const modifiers = shortcut.modifiers.map((modifier) => {
    if (modifier === 'primary' || modifier === 'ctrl') {
      return 'Ctrl';
    }
    if (modifier === 'shift') {
      return 'Shift';
    }
    return 'Alt';
  });
  return [...modifiers, key].join('+');
}
