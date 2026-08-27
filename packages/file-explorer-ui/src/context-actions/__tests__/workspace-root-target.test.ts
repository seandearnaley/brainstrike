import { describe, expect, it } from 'vitest';
import { workspaceRootToTarget } from '../workspace-root-target';

describe('workspaceRootToTarget', () => {
  it('snapshots a desktop root with its absolute path and Main role', () => {
    expect(
      workspaceRootToTarget({
        displayName: 'brainstrike',
        isMain: true,
        path: '/Users/dev/GitHub/brainstrike',
        rootId: '0199a1f0-6c3e-7a11-9b2d-2b7f1f4a55aa',
      })
    ).toEqual({
      displayName: 'brainstrike',
      isMain: true,
      kind: 'workspace-root',
      path: '/Users/dev/GitHub/brainstrike',
      rootId: '0199a1f0-6c3e-7a11-9b2d-2b7f1f4a55aa',
    });
  });

  it('reports path: null when the root has no path distinct from its name (web FSA)', () => {
    // NEW normalization, not a rule borrowed from `RootSectionHeader` (whose
    // `path` prop is a plain truthiness check — callers omit it for FSA
    // roots; the header itself never compares `path` to a display name). A
    // web FSA `DirectoryHandle.path` IS its `name`; passing that through as
    // a "path" would make Copy Path copy a folder NAME on web.
    expect(
      workspaceRootToTarget({
        displayName: 'notes',
        isMain: false,
        path: 'notes',
        rootId: 'root-web-1',
      }).path
    ).toBeNull();
  });

  it('reports path: null for an absent path', () => {
    expect(
      workspaceRootToTarget({ displayName: 'notes', isMain: false, rootId: 'root-web-1' }).path
    ).toBeNull();
  });

  it('never treats the durable root id as a path', () => {
    // Regression guard for the ui-conventions rule: a RootId is commonly a
    // UUID. If a future edit derived `path` from `rootId`, this catches it.
    const target = workspaceRootToTarget({
      displayName: 'brainstrike',
      isMain: false,
      rootId: '0199a1f0-6c3e-7a11-9b2d-2b7f1f4a55aa',
    });
    expect(target.path).toBeNull();
    expect(target.rootId).toBe('0199a1f0-6c3e-7a11-9b2d-2b7f1f4a55aa');
  });
});
