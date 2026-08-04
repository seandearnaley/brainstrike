import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import type { ActionServices, ContextTarget } from '@brainstrike/context-actions';
import { createActionRegistry, createTestActionRegistry } from '@brainstrike/context-actions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addWorktreeAsRootAction,
  changesActions,
  openChangedFileAction,
  openWorktreeAction,
  revealChangedFileAction,
} from '../changes-context-actions';

const changedFileTarget: ContextTarget = {
  kind: 'changed-file',
  path: 'src/index.ts',
  repositoryRoot: '/repo',
  rootId: 'root-1',
  worktreePath: '/repo',
};

const inRootWorktreeTarget: ContextTarget = {
  branch: 'main',
  containment: ['root-1'],
  kind: 'worktree',
  name: 'repo',
  path: '/repo',
  repositoryRoot: '/repo',
  trust: 'validated',
  trustReason: null,
};

const outsideRootWorktreeTarget: ContextTarget = {
  ...inRootWorktreeTarget,
  containment: 'outside-roots',
  path: '/elsewhere/repo-worktree',
  trust: 'unvalidated',
  trustReason: 'gitdir target did not resolve back to this repository',
};

function makeServices() {
  return {
    clipboard: { writeText: vi.fn().mockResolvedValue({ ok: true }) },
    platformFs: {
      openPath: vi.fn().mockResolvedValue({ ok: true }),
      showItemInFolder: vi.fn().mockResolvedValue({ ok: true }),
    },
  } satisfies ActionServices;
}

describe('changesActions', () => {
  beforeEach(() => {
    usePanelLayoutStore.setState({ activeTab: 'git' });
  });

  it('exports every Changes surface action with a globally unique id', () => {
    expect(changesActions.map((action) => action.id)).toEqual([
      'changes.open-file',
      'changes.reveal-file',
      'changes.open-worktree',
      'changes.add-worktree-as-root',
    ]);
    // createActionRegistry throws on a duplicate id, so registering alongside
    // the other packages' action arrays is a real invariant, not just a list.
    expect(() =>
      createActionRegistry({
        actions: [...changesActions],
        capabilities: new Set(['fs.openPath', 'fs.reveal']),
        services: {},
      })
    ).not.toThrow();
  });

  it('opens a changed file through the shared platformFs.openPath seam', async () => {
    const services = makeServices();
    const outcome = await openChangedFileAction.run(changedFileTarget, services);
    expect(services.platformFs.openPath).toHaveBeenCalledWith('/repo/src/index.ts');
    expect(outcome).toEqual({ ok: true });
  });

  it('reveals a changed file through the shared platformFs.showItemInFolder seam', async () => {
    const services = makeServices();
    const outcome = await revealChangedFileAction.run(changedFileTarget, services);
    expect(services.platformFs.showItemInFolder).toHaveBeenCalledWith('/repo/src/index.ts');
    expect(outcome).toEqual({ ok: true });
  });

  it('hides open/reveal for a changed file with no resolvable worktree root', () => {
    const target = { ...changedFileTarget, worktreePath: null };
    expect(openChangedFileAction.isVisible?.(target)).toBe(false);
    expect(revealChangedFileAction.isVisible?.(target)).toBe(false);
  });

  it('fails explicitly (never silently) when the platform service is absent', async () => {
    const outcome = await openChangedFileAction.run(changedFileTarget, {});
    expect(outcome).toEqual({ error: 'Platform file-system service unavailable', ok: false });
  });

  it('opens a worktree through the shared platformFs.openPath seam', async () => {
    const services = makeServices();
    const outcome = await openWorktreeAction.run(inRootWorktreeTarget, services);
    expect(services.platformFs.openPath).toHaveBeenCalledWith('/repo');
    expect(outcome).toEqual({ ok: true });
  });

  it('is HIDDEN (not disabled) for changed-file/worktree actions when their capability is absent', () => {
    const { registry } = createTestActionRegistry({
      actions: [...changesActions],
      capabilities: [],
    });
    const changedFileIds = registry
      .actionsFor(changedFileTarget)
      .flatMap((group) => group.actions.map((action) => action.id));
    const worktreeIds = registry
      .actionsFor(outsideRootWorktreeTarget)
      .flatMap((group) => group.actions.map((action) => action.id));
    expect(changedFileIds).toEqual([]);
    expect(worktreeIds).toEqual(['changes.add-worktree-as-root']);
  });

  it('offers "Add as Workspace Root" only for an out-of-root worktree', () => {
    expect(addWorktreeAsRootAction.isVisible?.(outsideRootWorktreeTarget)).toBe(true);
    expect(addWorktreeAsRootAction.isVisible?.(inRootWorktreeTarget)).toBe(false);
  });

  it('"Add as Workspace Root" switches to the Explorer tab and says what to click next', async () => {
    expect(usePanelLayoutStore.getState().activeTab).toBe('git');
    const outcome = await addWorktreeAsRootAction.run(outsideRootWorktreeTarget, {});
    expect(usePanelLayoutStore.getState().activeTab).toBe('explorer');
    expect(outcome).toEqual({
      message: 'Opened Explorer — click "Add Folder" to grant access to this worktree',
      ok: true,
    });
  });
});
