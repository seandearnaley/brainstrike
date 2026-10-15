import { beforeEach, describe, expect, it, vi } from 'vitest';

const openAppMock = vi.fn();
const setActiveTabMock = vi.fn();

vi.mock('@brainstrike/file-explorer-ui/workspace-tab-selection-store', () => ({
  TERMINAL_APP_ID: 'terminal',
  useWorkspaceTabSelectionStore: { getState: () => ({ openApp: openAppMock }) },
}));
vi.mock('@brainstrike/app-state/stores/panel-layout-store', () => ({
  usePanelLayoutStore: { getState: () => ({ setActiveTab: setActiveTabMock }) },
}));

import { useTerminalTargetStore } from '../stores/terminal-target-store';

const TARGET = { cwd: '/repo/.claude/worktrees/bright-fox', rootId: 'root-1' } as const;

describe('useTerminalTargetStore', () => {
  beforeEach(() => {
    openAppMock.mockReset();
    setActiveTabMock.mockReset();
    useTerminalTargetStore.getState().reset();
  });

  it('starts with no pin', () => {
    expect(useTerminalTargetStore.getState().target).toBeNull();
  });

  it('pins the target, reveals the workspace route, and opens the Terminal tab', () => {
    useTerminalTargetStore.getState().openTerminalAt(TARGET);

    expect(useTerminalTargetStore.getState().target).toEqual(TARGET);
    expect(setActiveTabMock).toHaveBeenCalledExactlyOnceWith('explorer');
    expect(openAppMock).toHaveBeenCalledExactlyOnceWith('terminal');
  });

  it('re-requesting the SAME target still re-opens the tab (idempotent write, not a no-op)', () => {
    useTerminalTargetStore.getState().openTerminalAt(TARGET);
    useTerminalTargetStore.getState().openTerminalAt(TARGET);

    expect(openAppMock).toHaveBeenCalledTimes(2);
    expect(setActiveTabMock).toHaveBeenCalledTimes(2);
  });

  it('reset drops the pin without touching the tab surfaces', () => {
    useTerminalTargetStore.getState().openTerminalAt(TARGET);
    openAppMock.mockReset();
    setActiveTabMock.mockReset();

    useTerminalTargetStore.getState().reset();

    expect(useTerminalTargetStore.getState().target).toBeNull();
    // Falsifier: clearing the pin must NOT close, re-open or re-route anything —
    // the user may be looking at the panel and just wants it to follow focus.
    expect(openAppMock).not.toHaveBeenCalled();
    expect(setActiveTabMock).not.toHaveBeenCalled();
  });
});
