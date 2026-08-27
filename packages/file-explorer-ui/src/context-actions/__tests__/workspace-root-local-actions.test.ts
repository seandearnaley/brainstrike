import type { ContextTarget, TargetOf } from '@brainstrike/context-actions';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkspaceRootLocalActions } from '../workspace-root-local-actions';

const mainRoot: TargetOf<'workspace-root'> = {
  displayName: 'brainstrike',
  isMain: true,
  kind: 'workspace-root',
  path: '/Users/dev/GitHub/brainstrike',
  rootId: 'root-1',
};
const secondaryRoot: TargetOf<'workspace-root'> = { ...mainRoot, isMain: false, rootId: 'root-2' };

const NO_SERVICES = {} as const;

function makeDeps() {
  return { onDisconnect: vi.fn(), onSetAsMain: vi.fn() };
}

describe('buildWorkspaceRootLocalActions', () => {
  it('exports Set as main and Disconnect, in that order', () => {
    expect(buildWorkspaceRootLocalActions(makeDeps()).map((action) => action.id)).toEqual([
      'workspace-root.set-as-main',
      'workspace-root.disconnect',
    ]);
  });

  it('HIDES Set as main for the root that is already Main', () => {
    const [setAsMain] = buildWorkspaceRootLocalActions(makeDeps());
    expect(setAsMain?.isVisible?.(mainRoot as ContextTarget)).toBe(false);
    expect(setAsMain?.isVisible?.(secondaryRoot as ContextTarget)).toBe(true);
  });

  it('routes Set as main to its own dep and nothing else', async () => {
    const deps = makeDeps();
    const [setAsMain] = buildWorkspaceRootLocalActions(deps);
    await expect(setAsMain?.run(secondaryRoot as ContextTarget, NO_SERVICES)).resolves.toEqual({
      ok: true,
    });
    expect(deps.onSetAsMain).toHaveBeenCalledExactlyOnceWith(secondaryRoot);
    expect(deps.onDisconnect).not.toHaveBeenCalled();
  });

  it('STAGES Disconnect — the run opens the confirmation, it never removes a root', async () => {
    // ui-conventions: destructive actions never mutate directly from a menu
    // run. The falsifier for a "just call removeRootDirectory" implementation.
    const deps = makeDeps();
    const disconnect = buildWorkspaceRootLocalActions(deps)[1];
    expect(disconnect?.group).toBe('danger');
    expect(disconnect?.label).toBe('Disconnect…');
    await expect(disconnect?.run(mainRoot as ContextTarget, NO_SERVICES)).resolves.toEqual({
      ok: true,
    });
    expect(deps.onDisconnect).toHaveBeenCalledExactlyOnceWith(mainRoot);
    expect(deps.onSetAsMain).not.toHaveBeenCalled();
  });
});
