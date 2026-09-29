/**
 * Cmd/Ctrl+T → Terminal workspace app (BST-1270). Desktop-only (web leaves
 * the browser's native new-tab shortcut untouched) and inert unless the
 * Terminal app is registered — capability gating, no dead chord.
 */

import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { fireEvent, renderHook } from '@testing-library/react';
import { TerminalSquare } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTerminalHotkey } from '../use-terminal-hotkey';
import { TERMINAL_APP_ID, type WorkspaceApp } from '../workspace-app';

const TERMINAL_APP: WorkspaceApp = {
  icon: TerminalSquare,
  id: TERMINAL_APP_ID,
  label: 'Terminal',
  placement: 'pinned',
  render: () => null,
};

function pressModT(): void {
  fireEvent.keyDown(document.body, { code: 'KeyT', ctrlKey: true, key: 't' });
}

describe('useTerminalHotkey', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('opens the Terminal app on mod+t when registered on desktop, revealing the workspace route', () => {
    Reflect.set(window, 'electronAPI', {});
    usePanelLayoutStore.setState({ activeTab: 'git' });
    const onOpenApp = vi.fn();
    renderHook(() => useTerminalHotkey([TERMINAL_APP], onOpenApp));

    pressModT();
    expect(onOpenApp).toHaveBeenCalledExactlyOnceWith(TERMINAL_APP_ID);
    // From a non-workspace shell route (Git/Notes/Browser) the workspace
    // surface is mounted-but-hidden — the chord must reveal it too.
    expect(usePanelLayoutStore.getState().activeTab).toBe('explorer');
  });

  it('is inert when Terminal is not registered (web / capability absent)', () => {
    Reflect.set(window, 'electronAPI', {});
    const onOpenApp = vi.fn();
    renderHook(() => useTerminalHotkey([], onOpenApp));

    pressModT();
    expect(onOpenApp).not.toHaveBeenCalled();
  });

  it('is inert on web renderers even with Terminal registered', () => {
    const onOpenApp = vi.fn();
    renderHook(() => useTerminalHotkey([TERMINAL_APP], onOpenApp));

    pressModT();
    expect(onOpenApp).not.toHaveBeenCalled();
  });
});
