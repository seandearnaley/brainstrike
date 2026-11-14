/**
 * BST-2516: a thread's binding names its folder's path as a hint beside its root id. When the
 * hint is not where the catalog now mounts that root (the folder moved, and its record was
 * pointed at the new place), the run is refused in words the person can act on, as a typed
 * refusal, never as "Something went wrong".
 */
import {
  type BoundaryFailure,
  BoundaryFailureError,
  describeBoundaryFailure,
} from '@brainstrike/assistant-contract/boundary-failure';
import { describe, expect, it } from 'vitest';
import { DesktopWorkspaceBindingAuthority } from '../agent-host-platform/desktop-workspace-binding';

const ROOT_ID = 'survey-root';
const NEW_PLACE = '/Users/me/Projects/survey-moved';
const OLD_PLACE = '/Users/me/Projects/survey';

/** The catalog mounts the root at the new place, and its mount is readable there. */
function authorityMountedAt(place: string): DesktopWorkspaceBindingAuthority {
  return new DesktopWorkspaceBindingAuthority({
    borrowRoot: async (root) => ({
      canonicalPath: root.path,
      listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
      retire: async () => undefined,
      rootId: root.rootId,
      signal: new AbortController().signal,
    }),
    // No scratch folder here: the moved folder is one of the person's.
    mountScratchFolders: async () => undefined,
    readLiveWorktreePath: async () => null,
    readRootNames: async () => new Map(),
    readRoots: async () => [{ displayName: 'survey-moved', path: place, rootId: ROOT_ID }],
  });
}

async function refusalOf(work: Promise<unknown>): Promise<BoundaryFailure> {
  const failure = await work.then(
    () => undefined,
    (cause: unknown) => cause
  );
  if (!(failure instanceof BoundaryFailureError)) {
    throw new Error(`Expected a typed refusal, got ${String(failure)}`);
  }
  return failure.failure;
}

describe('the desktop binding authority', () => {
  it('refuses a thread whose folder hint is not where its root is mounted, saying where the folder was and what to do', async () => {
    const authority = authorityMountedAt(NEW_PLACE);

    const failure = await refusalOf(
      authority.validateWorkspaceBinding({
        binding: {
          operatingRootDisplayName: 'survey',
          operatingRootId: ROOT_ID,
          operatingRootPath: OLD_PLACE,
        },
        signal: new AbortController().signal,
        threadId: 'thread-1',
      })
    );

    expect(failure).toMatchObject({ code: 'workspace.binding-root-moved', kind: 'refusal' });
    expect(describeBoundaryFailure(failure)).toBe(
      `This thread's folder is no longer at ${OLD_PLACE}. Choose it again from the where-control.`
    );
    await authority.close();
  });

  it('admits a thread whose folder hint is where its root is mounted', async () => {
    const authority = authorityMountedAt(NEW_PLACE);

    await expect(
      authority.validateWorkspaceBinding({
        binding: {
          operatingRootDisplayName: 'survey-moved',
          operatingRootId: ROOT_ID,
          operatingRootPath: NEW_PLACE,
        },
        signal: new AbortController().signal,
        threadId: 'thread-1',
      })
    ).resolves.toBeUndefined();
    await authority.close();
  });
});
