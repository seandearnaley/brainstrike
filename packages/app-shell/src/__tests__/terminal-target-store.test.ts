import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  openTerminalAtTarget,
  useTerminalTargetStore,
} from '../terminal-panel/terminal-target-store';

const TARGET = {
  cwd: '/workspace/repo/.worktrees/nested',
  rootId: 'root-containing-repo',
} as const;

describe('terminal target store', () => {
  beforeEach(() => {
    useTerminalTargetStore.getState().release();
    __resetWorkspaceTabSelectionStoreForTests();
  });

  it('pins the exact cwd and containing root while opening the Terminal app', () => {
    openTerminalAtTarget(TARGET);

    expect(useTerminalTargetStore.getState().target).toEqual(TARGET);
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: 'terminal',
      kind: 'app',
    });
  });

  it('replaces a prior cwd even when both targets use the same containing root', () => {
    openTerminalAtTarget(TARGET);
    openTerminalAtTarget({ ...TARGET, cwd: '/workspace/repo/.worktrees/other' });

    expect(useTerminalTargetStore.getState().target).toEqual({
      cwd: '/workspace/repo/.worktrees/other',
      rootId: TARGET.rootId,
    });
  });

  it('releases the pin so Terminal can follow the focused folder again', () => {
    openTerminalAtTarget(TARGET);

    useTerminalTargetStore.getState().release();

    expect(useTerminalTargetStore.getState().target).toBeNull();
  });
});
