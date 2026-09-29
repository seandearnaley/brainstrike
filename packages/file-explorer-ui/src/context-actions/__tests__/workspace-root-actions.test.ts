import type { ActionServices, ContextTarget } from '@brainstrike/context-actions';
import { describe, expect, it, vi } from 'vitest';
import {
  copyWorkspaceRootPathAction,
  revealWorkspaceRootAction,
  workspaceRootActions,
} from '../workspace-root-actions';

const desktopRoot: ContextTarget = {
  displayName: 'brainstrike',
  isMain: true,
  kind: 'workspace-root',
  path: '/Users/dev/GitHub/brainstrike',
  rootId: '0199a1f0-6c3e-7a11-9b2d-2b7f1f4a55aa',
};

const webRoot: ContextTarget = {
  displayName: 'notes',
  isMain: false,
  kind: 'workspace-root',
  path: null,
  rootId: 'root-web-1',
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

describe('workspaceRootActions', () => {
  it('exports exactly the two capability-gated global root actions', () => {
    expect(workspaceRootActions.map((action) => action.id)).toEqual([
      'workspace-root.copy-path',
      'workspace-root.reveal',
    ]);
    for (const action of workspaceRootActions) {
      expect(action.appliesTo).toEqual(['workspace-root']);
    }
  });

  it('copies the root path', async () => {
    const services = makeServices();
    const outcome = await copyWorkspaceRootPathAction.run(desktopRoot, services);
    expect(services.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(
      '/Users/dev/GitHub/brainstrike'
    );
    expect(outcome).toEqual({ message: 'Folder path copied', ok: true });
  });

  it('reveals the root in the OS file manager', async () => {
    const services = makeServices();
    const outcome = await revealWorkspaceRootAction.run(desktopRoot, services);
    expect(services.platformFs.showItemInFolder).toHaveBeenCalledExactlyOnceWith(
      '/Users/dev/GitHub/brainstrike'
    );
    expect(services.platformFs.openPath).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: true });
  });

  it('HIDES both actions for a pathless root instead of failing at click time', () => {
    // The falsifier for a `isEnabled`-instead-of-`isVisible` implementation:
    // a disabled row would still render on web, which ui-conventions forbids.
    expect(copyWorkspaceRootPathAction.isVisible?.(webRoot)).toBe(false);
    expect(revealWorkspaceRootAction.isVisible?.(webRoot)).toBe(false);
    expect(copyWorkspaceRootPathAction.isVisible?.(desktopRoot)).toBe(true);
    expect(revealWorkspaceRootAction.isVisible?.(desktopRoot)).toBe(true);
    expect(copyWorkspaceRootPathAction.isEnabled).toBeUndefined();
    expect(revealWorkspaceRootAction.isEnabled).toBeUndefined();
  });

  it('declares the capabilities that gate them off web', () => {
    expect(copyWorkspaceRootPathAction.requiredCapabilities).toEqual(['clipboard']);
    expect(revealWorkspaceRootAction.requiredCapabilities).toEqual(['fs.reveal']);
  });

  it('refuses rather than throwing if run is reached with no path', async () => {
    const services = makeServices();
    await expect(copyWorkspaceRootPathAction.run(webRoot, services)).resolves.toEqual({
      error: 'This folder has no filesystem path.',
      ok: false,
    });
    await expect(revealWorkspaceRootAction.run(webRoot, services)).resolves.toEqual({
      error: 'This folder has no filesystem path.',
      ok: false,
    });
    expect(services.clipboard.writeText).not.toHaveBeenCalled();
    expect(services.platformFs.showItemInFolder).not.toHaveBeenCalled();
  });

  it('labels Reveal with the platform file-manager name, never a hardcoded OS', () => {
    const label = revealWorkspaceRootAction.label;
    if (typeof label !== 'function') {
      throw new Error('Reveal must derive its label from the platform');
    }
    expect(label(desktopRoot)).toMatch(/^Reveal in (Finder|File Explorer)$/);
  });
});
